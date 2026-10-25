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

export function nativeActorPlan(actor) {
  const instructions = `Controlled live QA actor ${actor}. Model and effort already selected by raf; never replace them. Do not implement, run tests, edit tasks, write report, archive, or retry failed/unknown commands. The provided helper makes only its own isolated fixture commits in develop and Orchestrator; these are authorized. In native exec tool perform this exact sequence. For EVERY functions.exec call set the first line to // @exec: {"max_output_tokens": 60000} followed by an actual newline, AND request max_output_tokens:60000 on the inner tools.exec_command/write_stdin. For functions.wait request max_tokens:60000. Both the outer tool and its inner command need the larger limit, including message/ps outputs: preserve exact outputs without truncation. Emit command stdout with text(result.output) once and command metadata separately, rather than JSON.stringify of the whole tool result. A complete parseable JSON output without an explicit tool truncation marker is complete even when large. Never print a full probe JSON report; the helper emits a small sha256 receipt for the complete host-copied file. First execute node qa/sym64-probe.mjs 0 <exact report_path from your brief>; wait for completion, polling a running native tool session as necessary. Then execute the issued raf_command agent message --to sym64-${actor === 'a' ? 'b' : 'a'} --text sym64-${actor}-after-B as ONE simple native tool command, using the original issued absolute raf_command unchanged. Next execute the issued raf_command agent ps in a separate native tool call. Then execute the issued raf_command ${negativePeerCommand('sym64-' + (actor === 'a' ? 'b' : 'a')).join(' ')} as a separate simple native command; this unauthorized subcommand must return a nonzero code, preserve its exact result and continue only for that expected denial. Next execute node qa/sym64-probe.mjs 1 <exact report_path>; wait for completion. Next repeat separate simple native message with text sym64-${actor}-after-A and agent ps using that same original prefix, followed by the same separate unauthorized ${negativePeerCommand('sym64-' + (actor === 'a' ? 'b' : 'a')).join(' ')} with required nonzero code. Execute node qa/sym64-probe.mjs 2 <exact report_path> and wait. After it completes repeat separate simple native message with text sym64-${actor}-after-rollback and agent ps using that same original prefix, followed by the same separate unauthorized ${negativePeerCommand('sym64-' + (actor === 'a' ? 'b' : 'a')).join(' ')} with required nonzero code. Execute node qa/sym64-probe.mjs 3 <exact report_path> and wait. Do not acknowledge received messages with tool calls, only chat. If any expected-success command fails, stop and preserve the error. The probe helper owns allowed negative actions only inside this isolated fixture. Do not change the helper or evade its checks. After helper 3 returns a final actual exit_code 0, make one separate functions.exec call emitting only text({sym64NativeCompleted:3,runId:"<the basename of the directory containing your exact report_path>",finalCliExitCode:0}); substitute your real runId. This is a native tool receipt, not a report file. Never emit this receipt while a tool session/cell is still running or after a failed/unknown result. Then give a final chat status and keep the native session alive for host cleanup.`;
  return { item: `Controlled live QA actor ${actor}. Read qa/sym64-instructions-${actor}.txt and execute its complete native sequence. The host owns reports, fixture commits and final review; do not implement, run tests, edit tasks or write a report. Keep this brief and the issued raf_command unchanged across every switch.`, instructions };
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
