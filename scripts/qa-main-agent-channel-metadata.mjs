import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

export function negativePeerCommand(peer) {
  return ['agent', 'close', '--id', peer];
}

export async function drainStandServiceReader(options) {
  const pid = options.service.pid;
  assert.ok(Number.isInteger(pid) && pid > 0, 'The stand must own a verified host service reader');
  const start = await options.processStart(pid);
  assert.ok(start && await options.alive(pid, start), 'The host service identity must still be live before draining');
  const result = await options.request('service-before-live-split-stop', ['service', 'stop']);
  assert.equal(result.cliExitCode, 0, result.stderr || result.error);
  assert.equal(JSON.parse(result.stdout).state, 'stopped', 'The host service must acknowledge a graceful stop');
  await options.wait('host service reader exit before migration', async () => !await options.alive(pid, start));
  return { pid, start, result };
}

export function normalizeStandReflog(directory, git) {
  return git(directory, 'reflog', 'expire', '--expire=never', '--expire-unreachable=never', 'HEAD');
}

export function metadataTree(directory) {
  const stat = fs.lstatSync(directory);
  const entry = { mode: stat.mode, dev: stat.dev, ino: stat.ino, nlink: stat.nlink };
  if (stat.isSymbolicLink()) return { ...entry, target: fs.readlinkSync(directory) };
  if (stat.isFile()) return { ...entry, size: stat.size, sha256: createHash('sha256').update(fs.readFileSync(directory)).digest('hex') };
  if (!stat.isDirectory()) throw Error('Unexpected metadata type: ' + directory);
  return { ...entry, children: Object.fromEntries(fs.readdirSync(directory).sort().map(name => [name, metadataTree(path.join(directory, name))])) };
}

export function capturePolicy(directories, runId, phase) {
  const audit = process.env.SYM64_AUDIT;
  if (!audit) throw Error('QA policy audit directory is required');
  const control = directories.find(directory => directory.endsWith('/raf-hotfix'));
  if (!control) throw Error('Protected control directory is required');
  const value = { runId, phase, control, production: metadataTree(path.join(control, 'main.git')) };
  const target = path.join(audit, 'policy-' + runId + '-' + phase + '.json');
  fs.writeFileSync(target, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}

export function captureStandSocketControls(root, main, actors) {
  assert.equal(main?.tmuxSocket, path.join(root, 'raf-develop/qa/peer.sock'), 'Registered main must exercise a writable workspace socket');
  assert.ok(main.runId && actors.length, 'Registered main and peer identities are required');
  const peers = [];
  for (const actor of actors) {
    assert.equal(actor.state, 'running', 'Peer must be live');
    const socket = actor.process?.evidence?.tmuxSocket;
    assert.ok(actor.runId && path.isAbsolute(socket ?? ''), 'Peer must have a registered tmux socket');
    if (!peers.some(peer => peer.path === socket)) peers.push({ name: peers.length ? 'peer-' + peers.length : 'peer', path: socket, runId: actor.runId });
  }
  return [...peers, { name: 'host-main', path: main.tmuxSocket, runId: main.runId }].map(control => {
    const stat = fs.lstatSync(control.path);
    assert.ok(stat.isSocket(), 'Registered endpoint must be an existing socket');
    return { ...control, socket: true, dev: stat.dev, ino: stat.ino };
  });
}

export function prepareStandAudit(develop) {
  const directory = path.join(develop, 'qa/sym64-cli-audit');
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

export function archiveStandAudit(directory, evidence) {
  const archive = path.join(evidence, 'cli-audit');
  fs.mkdirSync(archive, { recursive: true });
  const files = fs.readdirSync(directory).sort().map(name => {
    const source = path.join(directory, name), target = path.join(archive, name);
    assert.ok(fs.lstatSync(source).isFile(), 'CLI audit must contain only regular files');
    const content = fs.readFileSync(source);
    const sha256 = createHash('sha256').update(content).digest('hex');
    fs.writeFileSync(target, content, { flag: 'wx' });
    assert.equal(createHash('sha256').update(fs.readFileSync(target)).digest('hex'), sha256);
    return { name, bytes: content.length, sha256 };
  });
  return { directory, archive, files, grant: 'Existing raf-develop write boundary; no additional native grant' };
}

export function instrumentStandCli(cli) {
  const insertion = "if (result.stdout)";
  assert.ok(cli.includes(insertion));
  return cli.replace(insertion, `if (process.env.SYM64_AUDIT && process.argv[2] === 'agent' && ['message', 'ps'].includes(process.argv[3])) { const fs = await import('node:fs'); const p = await import('node:path'); fs.writeFileSync(p.join(process.env.SYM64_AUDIT, crypto.randomUUID()+'.json'), JSON.stringify({module:import.meta.url,argv:process.argv.slice(2),result})); }\n${insertion}`);
}

export function nativePsReceipt(result) {
  if (result.exit_code !== 0 || result.session_id !== undefined) throw Error('PS command has no final exit-zero result');
  const sessions = JSON.parse(result.output);
  if (!Array.isArray(sessions) || sessions.length < 2 || sessions.some(session => typeof session?.runId !== 'string')) throw Error('PS output is not the complete live session array');
  return { sym64PsOutputComplete: true, characters: result.output.length, sessions: sessions.length, exit_code: 0 };
}

export function nativeCloseDenialReceipt(result, root) {
  if (result.exit_code !== 1 || result.session_id !== undefined) throw Error('Close denial needs the actual final exit-one result');
  const value = JSON.parse(result.output);
  const match = /^EROFS: read-only file system, mkdir '(.+)'$/.exec(value.message ?? '');
  const target = match?.[1], prefix = root + '/.git/modules/raf-main/raf-hotfix/activation.lock.owner-';
  if (value.code !== 'PRODUCTION_ENTRY_FAILED' || !target?.startsWith(prefix) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(target.slice(prefix.length))) throw Error('Close failed without the exact protected activation EROFS denial');
  return { sym64UnauthorizedCloseDenied: true, exit_code: 1, code: 'EROFS', target };
}

export async function stopStandServices(root, options = {}) {
  assert.ok(path.isAbsolute(root) && fs.lstatSync(root).isDirectory(), 'Cleanup requires the exact owned stand root');
  const executable = fs.realpathSync(process.execPath);
  const identity = pid => {
    try {
      const command = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').filter(Boolean);
      if (command.length !== 2 || !command[1].startsWith(root + '/') || !command[1].endsWith('/bin/service.ts')) return null;
      const exe = fs.readlinkSync('/proc/' + pid + '/exe');
      if (exe !== executable) throw Error('Owned service has an unexpected executable');
      const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] === 'Z') return null;
      return { pid, start: fields[19], command, exe };
    } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
  };
  const scan = () => fs.readdirSync('/proc').filter(name => /^[0-9]+$/.test(name)).map(name => identity(Number(name))).filter(Boolean);
  const processes = scan().map(process => ({ ...process, signals: [] }));
  const same = entry => {
    const current = identity(entry.pid);
    return current && current.start === entry.start && JSON.stringify(current.command) === JSON.stringify(entry.command) && current.exe === entry.exe;
  };
  const waitForExit = async budget => {
    const end = Date.now() + budget;
    while (processes.some(same) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  };
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const entry of processes) if (same(entry)) {
      try { process.kill(entry.pid, signal); entry.signals.push(signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await waitForExit(signal === 'SIGTERM' ? options.graceMs ?? 5000 : 5000);
  }
  const remaining = scan();
  assert.deepEqual(remaining, [], 'Owned stand services must exit even when CLI cleanup fails');
  return { complete: true, processes, remaining };
}

export function nativeActorPlan(actor, root = '/fixture/orchestrator') {
  const instructions = `Controlled live QA actor ${actor}. Model and effort already selected by raf; never replace them. Do not implement, run tests, edit tasks, write report, archive, or retry failed/unknown commands. The provided helper makes only its own isolated fixture commits in develop and Orchestrator; these are authorized. In native exec tool perform this exact sequence. For EVERY functions.exec call set the first line to // @exec: {"max_output_tokens": 60000} followed by an actual newline, AND request max_output_tokens:60000 on the inner tools.exec_command/write_stdin. For functions.wait request max_tokens:60000. Both the outer tool and its inner command need the larger limit, including message/ps outputs: preserve exact outputs without truncation. Emit command stdout with text(result.output) once and command metadata separately, rather than JSON.stringify of the whole tool result. A complete parseable JSON output without an explicit tool truncation marker is complete even when large. Never print a full probe JSON report; the helper emits a small sha256 receipt for the complete host-copied file. First execute node qa/sym64-probe.mjs 0 <exact report_path from your brief>; wait for completion, polling a running native tool session as necessary. Then execute the issued raf_command agent message --to sym64-${actor === 'a' ? 'b' : 'a'} --text sym64-${actor}-after-B as ONE simple native tool command, using the original issued absolute raf_command unchanged. Next execute the issued raf_command agent ps in a separate native tool call. Then execute the issued raf_command ${negativePeerCommand('sym64-' + (actor === 'a' ? 'b' : 'a')).join(' ')} as a separate simple native command; this unauthorized subcommand must return a nonzero code, preserve its exact result and continue only for that expected denial. Next execute node qa/sym64-probe.mjs 1 <exact report_path>; wait for completion. Next repeat separate simple native message with text sym64-${actor}-after-A and agent ps using that same original prefix, followed by the same separate unauthorized ${negativePeerCommand('sym64-' + (actor === 'a' ? 'b' : 'a')).join(' ')} with required nonzero code. Execute node qa/sym64-probe.mjs 2 <exact report_path> and wait. After it completes repeat separate simple native message with text sym64-${actor}-after-rollback and agent ps using that same original prefix, followed by the same separate unauthorized ${negativePeerCommand('sym64-' + (actor === 'a' ? 'b' : 'a')).join(' ')} with required nonzero code. Execute node qa/sym64-probe.mjs 3 <exact report_path> and wait. Do not acknowledge received messages with tool calls, only chat. If any expected-success command fails, stop and preserve the error. The probe helper owns allowed negative actions only inside this isolated fixture. Do not change the helper or evade its checks. After helper 3 returns a final actual exit_code 0, make one separate functions.exec call emitting only text({sym64NativeCompleted:3,runId:"<the basename of the directory containing your exact report_path>",finalCliExitCode:0}); substitute your real runId. This is a native tool receipt, not a report file. Never emit this receipt while a tool session/cell is still running or after a failed/unknown result. Then give a final chat status and keep the native session alive for host cleanup.`;
  const psVerification = ` For EACH agent ps, keep its full original stdout via text(result.output), then in that SAME functions.exec emit text((${nativePsReceipt.toString()})(result)); use your actual result variable name. This verifier uses the actual completed tool result and parses the entire JSON array; if it throws, stop. A sym64PsOutputComplete:true receipt confirms complete JSON even if long nested launch commands look shortened to you. Do not infer truncation from length or visual appearance when this verification succeeds. Do not shorten, summarize, filter, redirect or rerun the actual ps command/output. Unauthorized close is an expected nonzero result; preserve its exact stderr and continue only for that expected denial, with no retry.`;
  return { item: `Controlled live QA actor ${actor}. Read qa/sym64-instructions-${actor}.txt and execute its complete native sequence. The host owns reports, fixture commits and final review; do not implement, run tests, edit tasks or write a report. Keep this brief and the issued raf_command unchanged across every switch.`, instructions: instructions + psVerification + ` For EVERY unauthorized close, preserve its exact actual output via text(result.output), then in the SAME functions.exec emit text((${nativeCloseDenialReceipt.toString()})(result, ${JSON.stringify(root)})); use your actual result variable name. EROFS on this exact protected activation lock IS the expected native filesystem denial. It is not an expected-success service operation. If this verifier succeeds, continue immediately to the next probe helper without retrying close. If the verifier throws, stop. Never treat arbitrary setup errors, missing files, audit-writer errors, timeouts or unknown/nonfinal results as a successful negative probe.` };
}

export async function releaseNativeStage(options) {
  for (const actor of options.actors) {
    options.writeControls(actor);
    options.gate(actor);
  }
  await Promise.all(options.actors.map(actor => options.wait(actor)));
}

export async function captureCompletedNativeActors(options) {
  for (const actor of options.actors) options.gate(actor);
  await Promise.all(options.actors.map(actor => options.wait(actor)));
  return options.capture();
}

export function nativeCompletionReceipt(transcript, runId) {
  const calls = new Set();
  const lines = transcript.trimEnd().split("\n");
  for (let index = 0; index < lines.length; index++) {
    let event;
    try { event = JSON.parse(lines[index]); } catch { if (index === lines.length - 1) break; throw Error('Invalid native event before completion'); }
    if (event.type !== 'response_item') continue;
    const payload = event.payload;
    if (payload?.type === 'custom_tool_call' && payload.name === 'exec') calls.add(payload.call_id);
    if (payload?.type !== 'custom_tool_call_output' || !calls.has(payload.call_id) || !Array.isArray(payload.output)) continue;
    for (const item of payload.output) {
      let receipt;
      try { receipt = JSON.parse(item.text); } catch { continue; }
      if (receipt?.sym64NativeCompleted === 3 && receipt.runId === runId && receipt.finalCliExitCode === 0) return { sourceLine: index + 1, timestamp: event.timestamp, callId: payload.call_id, receipt };
    }
  }
  return false;
}
