import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { readdirSync, readFileSync, readlinkSync, writeFileSync, renameSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve, delimiter, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { prepareCodexSandbox } from '../src/codex-sandbox.ts';
import { resolveRunnerExecutable } from '../src/runner-availability.ts';
import { checkPrerequisites, stand, command, ok, ownCompactAliases, transitionMs, pollMs, rawSandboxPrefix } from './helpers/z404-host-fixture.ts';

const [mode, target, selectedCase, ...extra] = process.argv.slice(2);
assert.ok(['setup', 'verify'].includes(mode) && target, 'usage: node test/z404-bwrap-entry-host.mjs setup|verify <own-evidence-directory> [short/native]');
assert.ok(extra.length === 0 && (!selectedCase || (mode === 'verify' && selectedCase === 'short/native')), 'only the explicit short/native diagnostic selection is supported');
const evidenceDirectory = resolve(target);
await fs.mkdir(evidenceDirectory, { recursive: true });
const summary = { stage: 'setup', cases: [], startedAt: new Date().toISOString(), modelPromptSent: false, selectedCase: selectedCase ?? 'all' };
async function save(name, data) {
  const path = join(evidenceDirectory, name), temporary = `${path}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(data, null, 2) + '\n'); await fs.rename(temporary, path);
}

function processTree(rootPid, knownPipes = []) {
  if (!rootPid) return { rootPid: null, processes: [] };
  try {
    const processes = [];
    for (const name of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        const pipes = [0, 1, 2].flatMap(fd => {
          try {
            const target = readlinkSync(`/proc/${name}/fd/${fd}`);
            return /^pipe:\[\d+\]$/.test(target) ? [{ fd, target }] : [];
          } catch { return []; }
        });
        const namespacePids = readFileSync(`/proc/${name}/status`, 'utf8').match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/).map(Number) ?? [];
        processes.push({ namespacePids, pid: Number(name), state: fields[0], ppid: Number(fields[1]),
          processGroup: Number(fields[2]), session: Number(fields[3]), startTicks: fields[19], pipes });
      } catch {}
    }
    const own = new Set([rootPid]);
    const pipes = new Set([...knownPipes, ...(processes.find(item => item.pid === rootPid)?.pipes ?? []).map(item => item.target)]);
    let added;
    do {
      added = false;
      for (const item of processes) {
        if (!own.has(item.pid) && (own.has(item.ppid) || item.processGroup === rootPid || item.pipes.some(pipe => pipes.has(pipe.target)))) {
          own.add(item.pid); added = true;
        }
      }
    } while (added);
    return { rootPid, observedAt: new Date().toISOString(), processes: processes.filter(item => own.has(item.pid)) };
  } catch (error) { return { rootPid, diagnosticError: error.code ?? error.message }; }
}

function progressMarkers(stderr) {
  return stderr.split('\n').filter(line => line.startsWith('Z404_PROGRESS ')).flatMap(line => {
    try { return [JSON.parse(line.slice('Z404_PROGRESS '.length))]; } catch { return []; }
  });
}

async function toolCommand(executable, args, cwd, environment, timeoutEvidence) {
  const child = spawn(executable, [...args], { cwd, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false, spawnError, exitEvent, timeoutIdentity;
  let startedIdentity, pipes = [];
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('exit', (code, signal) => { exitEvent = { code, signal, observedAt: new Date().toISOString() }; });
  const terminate = () => {
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    timeoutIdentity = { ...processTree(child.pid, pipes), exitEvent: exitEvent ?? null,
      stdoutClosed: child.stdout.closed, stderrClosed: child.stderr.closed };
    try {
      const markers = progressMarkers(stderr);
      const path = join(evidenceDirectory, timeoutEvidence), temporary = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify({ stdout, stderr, spawnError: spawnError ? { name: spawnError.name, message: spawnError.message, code: spawnError.code } : null,
        code: exitEvent?.code ?? null, signal: exitEvent?.signal ?? null, timedOut, startedIdentity, timeoutIdentity,
        lastMarker: markers.at(-1) ?? null, markers, beforeTermination: true }, null, 2) + '\n');
      renameSync(temporary, path);
    } catch (error) { timeoutIdentity.evidenceError = error.code ?? error.message; }
    finally { terminate(); }
  }, transitionMs);
  startedIdentity = processTree(child.pid);
  pipes = (startedIdentity.processes?.find(item => item.pid === child.pid)?.pipes ?? []).map(item => item.target);
  try {
    const exit = await new Promise(done => {
      child.once('error', error => { spawnError = error; });
      child.once('close', (code, signal) => done({ code, signal }));
    });
    clearTimeout(timer);
    const markers = progressMarkers(stderr);
    const result = { ...exit, stdout, stderr, timedOut, spawnError: spawnError ? { name: spawnError.name, message: spawnError.message, code: spawnError.code } : undefined,
      startedIdentity, timeoutIdentity: timeoutIdentity ?? null, exitEvent: exitEvent ?? null,
      lastMarker: markers.at(-1) ?? null, markers };
    await save(timeoutEvidence.replace(/-timeout\.json$/, '-tool.json'), { ...result, spawnError: result.spawnError ?? null });
    return result;
  } finally { clearTimeout(timer); terminate(); }
}

function effective(invocation) {
  const values = {};
  const flags = { '--sandbox': 'sandbox_mode', '-s': 'sandbox_mode', '--ask-for-approval': 'approval_policy', '-a': 'approval_policy', '--model': 'model', '-m': 'model', '-P': 'default_permissions', '--permission-profile': 'default_permissions' };
  for (let index = 0; index < invocation.args.length; index++) {
    const arg = invocation.args[index];
    if (arg === '--') break;
    const [flag, ...inline] = arg.split('=');
    if (['-c', '--config'].includes(flag)) {
      const assignment = inline.length ? inline.join('=') : invocation.args[++index];
      assert.ok(assignment?.includes('='), 'complete config override');
      const split = assignment.indexOf('='), key = assignment.slice(0, split).trim(), value = assignment.slice(split + 1).trim();
      values[key] = value.startsWith('"') ? JSON.parse(value) : /^'[^']*'$/.test(value) ? value.slice(1, -1) : value;
    } else if (flags[flag]) {
      values[flags[flag]] = inline.length ? inline.join('=') : invocation.args[++index];
    }
    assert.doesNotMatch(flag, /dangerously-bypass|disable-sandbox/, 'no sandbox bypass flag before the payload');
  }
  return values;
}

function policy(values) {
  assert.ok(values.default_permissions, 'explicit effective native permissions profile');
  const body = values[`permissions.${values.default_permissions}.filesystem`];
  assert.ok(body?.startsWith('{') && body.endsWith('}'), 'effective filesystem table, not an overridden profile');
  const pairs = [...body.slice(1, -1).matchAll(/("(?:\\.|[^"\\])*")\s*=\s*("(?:\\.|[^"\\])*")/g)];
  assert.ok(pairs.length > 0, 'native permissions must be observable');
  return pairs.map(([, path, access]) => [JSON.parse(path), JSON.parse(access)]).sort(([a], [b]) => a.localeCompare(b));
}

function execs(lines) {
  return lines.flatMap((line, index) => {
    const match = line.match(/^\s*(\d+)\s+execve\(("(?:\\.|[^"\\])*"), (\[.*\]), .*\) = 0$/);
    if (!match) return [];
    return [{ pid: match[1], executable: JSON.parse(match[2]), args: JSON.parse(match[3]), line: index + 1 }];
  });
}

function exactArgs(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function backendEvidence(lines, payload, helpers, filters, prerequisites) {
  const events = execs(lines);
  const backends = ['/usr/bin/bwrap', prerequisites.binaries.find(item => item.kind === 'bundled-bwrap').path];
  const roles = events.filter(event => [...backends, ...helpers].includes(event.executable)).map(event => {
    const separator = event.args.indexOf('--');
    const command = separator < 0 ? [] : event.args.slice(separator + 1);
    const flags = separator < 0 ? event.args.slice(1) : event.args.slice(1, separator);
    const role = separator < 0 && flags.some(arg => ['--help', '--version'].includes(arg)) ? 'help'
      : ['/usr/bin/true', '/bin/true'].includes(command[0]) ? 'capability'
      : exactArgs(command, payload) ? 'target-payload'
      : command.includes('--apply-seccomp-then-exec') || flags.includes('--argv0') ? 'daemon-or-outer'
      : 'other';
    return { ...event, role, flags, command };
  });
  const node = events.filter(event => event.executable === payload[0] && exactArgs(event.args, payload));
  const reads = lines.flatMap((line, index) => {
    const match = line.match(/^\s*(\d+)\s+openat\(AT_FDCWD, ("(?:\\.|[^"\\])*"), O_RDONLY[^)]*\) = (\d+)$/);
    return match && filters.includes(JSON.parse(match[2])) ? [{ pid: match[1], filter: JSON.parse(match[2]), fd: Number(match[3]), line: index + 1 }] : [];
  });
  const installs = lines.flatMap((line, index) => {
    const match = line.match(/^\s*(\d+)\s+seccomp\(SECCOMP_SET_MODE_FILTER,.*\) = 0$/);
    return match ? [{ pid: match[1], line: index + 1 }] : [];
  });
  const targets = roles.filter(event => event.role === 'target-payload' && backends.includes(event.executable));
  const carriers = roles.filter(event => event.role === 'daemon-or-outer' && backends.includes(event.executable)
    && event.command.includes('--apply-seccomp-then-exec') && exactArgs(event.command.slice(-payload.length), payload));
  const unfiltered = targets.filter(event => !event.flags.some(arg => ['--unshare-net', '--unshare-all', '--seccomp', '--add-seccomp-fd'].includes(arg)));
  return {
    roles, node, targetBackends: targets, outerPayloadCarriers: carriers, unfilteredTargetBackends: unfiltered,
    helperExecutions: roles.filter(event => helpers.includes(event.executable)),
    filterReads: reads, seccompInstallations: installs,
    rafFilterApplied: 'not-established-by-execve-open-or-unrelated-seccomp',
  };
}

function refusalKind(message, f) {
  const match = message.match(/cannot enforce sandbox read-only path (\/tmp\/raf-tools-\d+\/\S+) because it crosses writable symlink/);
  if (match) return { kind: 'product-compact-helper-writable-symlink', path: match[1] };
  if (/Refusing to create helper binaries under temporary dir/.test(message) && message.includes(f.home)) return { kind: 'product-agent-CODEX_HOME-under-TMPDIR' };
  if (/host loopback TCP reachable/.test(message)) return { kind: 'tcp-guard-refusal' };
  return { kind: 'setup-capability-or-unclassified-failure' };
}

async function positive(prerequisites, layout, entry, poison = false) {
  const id = `[Z.404 H01 ${layout} ${entry}${poison ? ' unselected-PATH-backend' : ''}]`;
  const f = await stand(layout === 'long');
  let prepared;
  const record = { id, expectedAccepted: true, accepted: false, cleaned: false, workerStarted: false, ipv6Unavailable: f.ipv6Unavailable, homeLayout: f.homeLayout };
  try {
    await f.control();
    assert.equal(f.environment.HOME, f.environment.RAF_QA_HOME);
    assert.equal(f.environment.HOME, f.environment.TMPDIR);
    assert.equal((await fs.readdir(f.environment.CODEX_HOME)).length, 0, 'each case starts with fresh CODEX_HOME');
    for (const path of [f.home, f.runDirectory]) assert.equal(Buffer.byteLength(path) >= 108, layout === 'long', 'matched short and long controls');
    const executables = { bare: 'codex', npm: prerequisites.npm, native: prerequisites.native, configured: prerequisites.configuredExecutable };
    const input = f.request(executables[entry]);
    if (entry === 'configured') {
      const selected = await resolveRunnerExecutable('codex', executables[entry], f.environment);
      assert.equal(selected.status, 'resolved'); input.invocation.executable = selected.path;
    }
    const poisonMarker = join(f.workspace, 'unselected-bwrap-ran');
    if (poison) {
      const bin = join(f.root, 'poison-bin'); await fs.mkdir(bin);
      await fs.writeFile(join(bin, 'bwrap'), `#!${process.execPath}\nimport fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(poisonMarker)},'executed'); process.stderr.write('unselected backend must not execute'); process.exit(95);\n`, { mode: 0o700 });
      input.environment = { ...input.environment, PATH: `${bin}${delimiter}${input.environment.PATH}` };
    }
    const original = structuredClone(input);
    record.selectors = Object.fromEntries(['HOME', 'RAF_QA_HOME', 'TMPDIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'PATH', 'GIT_CONFIG_GLOBAL'].map(key => [key, input.environment[key]]));
    record.executable = input.invocation.executable;
    prepared = await prepareCodexSandbox(input);
    record.accepted = true;
    record.toolSandboxInvocation = { executable: prepared.toolSandbox.executable, args: [...prepared.toolSandbox.args] };
    const selected = effective(input.invocation), runner = effective(prepared.invocation), tool = effective(prepared.toolSandbox);
    record.effectivePolicy = { selected, runner, tool };
    assert.deepEqual(input, original, 'preparation does not mutate selection, environment or scope');
    assert.ok(selected.model && selected.model_reasoning_effort, 'fixture uses the configured model and effort');
    assert.equal(runner.approval_policy, 'never', 'runner: effective approval policy retained');
    for (const key of ['model', 'model_reasoning_effort']) assert.equal(runner[key], selected[key], `runner: effective ${key} retained`);
    for (const [kind, values] of [['runner', runner], ['toolSandbox', tool]]) {
      assert.equal(values.sandbox_mode, 'workspace-write', `${kind}: effective workspace-write retained`);
    }
    const runnerPolicy = policy(runner), toolPolicy = policy(tool);
    assert.deepEqual(runnerPolicy, toolPolicy, 'preflight/live tools retain the runner filesystem policy');
    assert.deepEqual(Object.fromEntries(Object.entries(runner).filter(([key]) => key.startsWith('permissions.'))),
      Object.fromEntries(Object.entries(tool).filter(([key]) => key.startsWith('permissions.'))), 'all filesystem/network overrides retained');
    for (const [path, access] of runnerPolicy) {
      if (access !== 'write') continue;
      assert.notEqual(path, ':root');
      if (isAbsolute(path)) {
        const delta = relative(path, f.questions);
        assert.ok(delta === '..' || delta.startsWith(`..${sep}`) || isAbsolute(delta), 'standalone file and its ancestors are never native write roots');
      }
    }
    for (const path of prepared.policyPaths) {
      const delta = relative(f.runDirectory, await fs.realpath(path));
      assert.ok(delta && delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta), 'policy belongs to this run');
    }
    await fs.writeFile(join(f.runDirectory, 'brief-delivered'), 'only after positive preflight'); record.workerStarted = true;
    const probe = {
      workspace: f.workspace, runDirectory: f.runDirectory, questions: f.questions,
      endpoints: f.endpoints, denyReads: f.denyReads, denyWrites: f.denyWrites, denyDirectories: f.denyDirectories, ports: f.ports,
      payload: `z404-${randomUUID()}`, token: randomUUID(), transitionMs, pollMs,
    };
    const probeFile = fileURLToPath(new URL('./helpers/z404-tool-probe.mjs', import.meta.url));
    const result = await toolCommand(prepared.toolSandbox.executable, [...prepared.toolSandbox.args, process.execPath, probeFile, JSON.stringify(probe)], f.workspace, prepared.environment, `${layout}-${entry}${poison ? '-unselected' : ''}-timeout.json`);
    record.toolExit = { code: result.code, signal: result.signal, timedOut: result.timedOut, spawnError: result.spawnError ?? null };
    record.toolResult = { ...result, spawnError: result.spawnError ?? null };
    await save(`${layout}-${entry}${poison ? '-unselected' : ''}.json`, record);
    ok(result, `${id}: positive tool start and complete assertions, never expected rejection`);
    record.observations = JSON.parse(result.stdout);
    assert.equal(record.observations.ownIpc.length, 2);
    assert.deepEqual(record.observations.tmux.map(item => item.kind), ['default', 'named']);
    assert.ok(record.observations.tmux.every(item => item.payload === probe.payload));
    assert.equal(await fs.readFile(f.questions, 'utf8'), 'question-updated-in-place');
    assert.equal(JSON.parse(await fs.readFile(join(f.runDirectory, 'report.json'), 'utf8')).payload, probe.payload);
    const commit = await command('git', ['log', '-1', '--format=%s'], f.workspace, f.environment); ok(commit, 'own Git control');
    assert.equal(commit.stdout.trim(), 'own sandbox commit');
    if (poison) await assert.rejects(fs.stat(poisonMarker), { code: 'ENOENT' });
    record.passed = true;
  } catch (error) {
    record.passed = false; record.error = { message: error.message, code: error.code, stack: error.stack };
    record.failureKind = record.accepted ? 'assertions' : refusalKind(error.message, f).kind;
    record.guardRefusedBeforeWorker = /host loopback TCP reachable/.test(error.message) && !record.workerStarted;
  } finally {
    try {
      await f.control();
      await prepared?.cleanup(); await prepared?.cleanup();
      for (const path of prepared?.policyPaths ?? []) await assert.rejects(fs.lstat(path), { code: 'ENOENT' });
      record.residualAliases = await ownCompactAliases([f.root, f.home]);
      assert.deepEqual(record.residualAliases, [], 'cleanup releases only this stand compact aliases');
      if (record.observations) {
        for (const directory of [f.workspace, f.runDirectory]) for (const name of ['z404-own.sock', 'z404-child.sock']) await assert.rejects(fs.lstat(join(directory, name)), { code: 'ENOENT' });
        assert.equal(JSON.parse(await fs.readFile(join(f.runDirectory, 'report.json'), 'utf8')).status, 'succeeded', 'cleanup retains own result');
      }
      await f.control();
    } catch (error) { record.passed = false; record.cleanupError = error.message; }
    try { await f.dispose(); record.cleaned = true; }
    catch (error) { record.passed = false; record.cleanupError = error.message; }
    await save(`${layout}-${entry}${poison ? '-unselected' : ''}.json`, record);
  }
  return record;
}

async function rawBypass(prerequisites) {
  const f = await stand(false, true);
  const record = { id: '[Z.404 H02] actual installed Codex selects system bwrap without RAF filter', passed: false, cleaned: false, failureKind: 'setup-control', homeLayout: f.homeLayout };
  try {
    await f.control();
    assert.equal(f.environment.HOME, f.environment.RAF_QA_HOME);
    assert.equal(f.environment.HOME, f.environment.TMPDIR);
    assert.ok(Buffer.byteLength(f.home) < 108 && Buffer.byteLength(f.environment.CODEX_HOME) < 108);
    assert.deepEqual(await fs.readdir(f.environment.CODEX_HOME), [], 'raw control owns a fresh CODEX_HOME without owner config/auth');
    record.selectors = Object.fromEntries(['HOME', 'RAF_QA_HOME', 'TMPDIR', 'CODEX_HOME'].map(key => [key, f.environment[key]]));
    const prefix = rawSandboxPrefix();
    const help = await command(prerequisites.native, [...prefix, '--help'], f.workspace, f.environment);
    record.helperInitialization = help;
    ok(help, 'Z404_SETUP raw sandbox CLI syntax and helper initialization');
    assert.match(help.stdout, /Usage: codex sandbox \[OPTIONS\] \[COMMAND\]/);
    assert.doesNotMatch(help.stderr, /could not create PATH aliases|Refusing to create helper binaries/,
      'Z404_SETUP: moving HOME alone does not establish usable helper initialization');
    const bin = join(f.root, 'path-helper'); await fs.mkdir(bin);
    const helper = join(bin, 'bwrap'), helperMarker = join(f.workspace, 'PATH-helper-executed');
    const filter = join(f.workspace, 'network.bpf'), traceFile = join(evidenceDirectory, 'raw-bypass.strace');
    await fs.writeFile(helper, `#!/bin/sh\nprintf executed > '${helperMarker}'\nexec /usr/bin/bwrap "$@"\n`, { mode: 0o700 });
    const environment = { ...f.environment, PATH: `${bin}${delimiter}${f.environment.PATH}` };
    const token = randomUUID();
    const program = `const fs=require('node:fs'),net=require('node:net');
const [address,filter,decoy,token]=process.argv.slice(1);fs.writeFileSync(filter,Buffer.alloc(80));
const c=net.connect(JSON.parse(address));let data='';c.setTimeout(${transitionMs},()=>c.destroy(Error('control deadline')));
c.on('data',b=>data+=b);c.on('error',e=>{if(!['EPERM','EACCES'].includes(e.code)){console.error(e);process.exitCode=3}else console.log(JSON.stringify({token,executable:process.execPath,outcome:'network-denied',code:e.code}))});
c.on('end',()=>{if(data!=='host-sentinel')process.exitCode=2;else console.log(JSON.stringify({token,executable:process.execPath,outcome:'host-tcp-reachable'}))});`;
    const payload = [process.execPath, '-e', program, JSON.stringify(f.ports[0]), filter, helper, token];
    const table = `{":root"="read",${JSON.stringify(f.workspace)}="write"}`;
    const args = [...prefix, '-C', f.workspace, '-P', 'linux',
      '-c', 'sandbox_mode="workspace-write"', '-c', 'default_permissions="linux"',
      '-c', `permissions.linux.filesystem=${table}`, '-c', 'permissions.linux.network.enabled=true',
      '--', ...payload];
    record.args = args;
    const traced = await command('strace', ['-f', '-s', '65535', '-e', 'trace=execve,openat,seccomp,unshare', '-o', traceFile,
      prerequisites.native, ...args], f.workspace, environment);
    record.tracedControl = traced;
    const marker = await fs.readFile(helperMarker, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const untraced = await command(prerequisites.native, args, f.workspace, environment);
    record.untracedControl = untraced;
    ok(traced, 'Z404_SETUP raw traced control must reach the exact Node payload');
    ok(untraced, 'Z404_SETUP same raw control without tracer');
    const observed = JSON.parse(traced.stdout), plain = JSON.parse(untraced.stdout);
    assert.equal(observed.token, token); assert.equal(observed.executable, process.execPath);
    assert.ok(['host-tcp-reachable', 'network-denied'].includes(observed.outcome));
    assert.deepEqual(plain, observed, 'traced/untraced exact payload outcomes match');
    record.untracedMatched = true; record.payload = observed;
    const lines = (await fs.readFile(traceFile, 'utf8')).split('\n');
    record.trace = backendEvidence(lines, payload, [helper], [filter], prerequisites);
    assert.ok(record.trace.node.length, 'exact successful Node execve, not a pathname in another argv');
    assert.ok(record.trace.targetBackends.length || record.trace.outerPayloadCarriers.length,
      'exact bwrap payload or explicit apply-seccomp carrier required; help/capability alone cannot prove it');
    assert.equal(record.trace.filterReads.length, 0, 'raw control does not load its dummy RAF BPF');
    assert.equal((await fs.stat(filter)).size, 80, 'payload-created BPF is distinct from filter read/installation');
    assert.equal(marker, record.trace.helperExecutions.length ? 'executed' : null);
    record.bypassReproduced = observed.outcome === 'host-tcp-reachable'
      && record.trace.unfilteredTargetBackends.some(event => event.executable === '/usr/bin/bwrap')
      && !record.trace.helperExecutions.some(event => event.role === 'target-payload');
    record.classification = record.bypassReproduced ? 'historical-target-helper-bypass-reproduced' : 'historical-bypass-not-reproduced';
    record.note = 'Help/capability/outer helper executions and generic seccomp events are recorded separately; no historical backend choice is required for control success.';
    record.failureKind = undefined; record.passed = true;
  } catch (error) {
    record.passed = false; record.error = { message: error.message, stack: error.stack };
    record.failureKind ??= 'setup-control-or-trace';
  }
  finally {
    try {
      await f.control();
      record.residualAliases = await ownCompactAliases([f.root, f.home]);
      assert.deepEqual(record.residualAliases, []);
    }
    catch (error) { record.passed = false; record.failureKind = 'setup-control-or-cleanup'; record.controlError = error.message; }
    try { await f.dispose(); record.cleaned = true; }
    catch (error) { record.passed = false; record.failureKind = 'setup-cleanup'; record.cleanupError = error.message; }
    await save('raw-bypass.json', record);
  }
  return record;
}

async function tracedPreparation(prerequisites) {
  const f = await stand(true);
  const record = { id: '[Z.404 H03] actual RAF preparation trace and protective refusal', passed: false, cleaned: false };
  try {
    await f.control();
    const input = join(evidenceDirectory, 'prepare-input.json'), output = join(evidenceDirectory, 'prepare-output.json');
    const trace = join(evidenceDirectory, 'prepare.strace');
    await save('prepare-input.json', f.request(prerequisites.native));
    const child = fileURLToPath(new URL('./helpers/z404-prepare-child.mjs', import.meta.url));
    const result = await command('strace', ['-f', '-s', '65535', '-e', 'trace=execve,openat,seccomp,unshare,symlink,symlinkat', '-o', trace,
      process.execPath, child, input, output], f.workspace, f.environment);
    ok(result, 'diagnostic child writes evidence; exit 0 alone is not preflight acceptance');
    const response = JSON.parse(await fs.readFile(output, 'utf8'));
    assert.equal(response.cleaned, true); assert.equal(response.workerStarted, false);
    const lines = (await fs.readFile(trace, 'utf8')).split('\n');
    const events = execs(lines);
    const filters = [...new Set(lines.flatMap(line => {
      const match = line.match(/openat\(AT_FDCWD, ("(?:\\.|[^"\\])*\/network\.bpf")/);
      return match ? [JSON.parse(match[1])] : [];
    }))];
    const helpers = [...new Set([
      ...filters.map(filter => join(dirname(filter), 'bwrap')),
      ...events.filter(event => event.executable.startsWith(`/tmp/raf-tools-${process.getuid()}/`)
        && event.executable.endsWith('/codex')).map(event => join(dirname(event.executable), 'bwrap')),
    ])];
    const candidates = events.flatMap(event => {
      const separator = event.args.indexOf('--'), payload = event.args.slice(separator + 1);
      if (separator < 0 || payload[0] !== process.execPath || payload[1] !== '-e'
        || !payload[2]?.includes('host loopback TCP reachable')) return [];
      let addresses;
      try { addresses = JSON.parse(payload[3]); } catch { return []; }
      return Array.isArray(addresses) && typeof addresses[0] === 'string' && addresses[0].startsWith(f.runDirectory + '/')
        ? [payload] : [];
    });
    record.trace = candidates.map(payload => backendEvidence(lines, payload, helpers, filters, prerequisites));
    record.preflight = response;
    record.observedExecs = events;
    record.filters = filters; record.helpers = helpers;
    record.guardRefusedBeforeWorker = false;
    if (!response.accepted) {
      assert.equal(response.error?.code, 'CODEX_SANDBOX_UNAVAILABLE', 'specific product preflight refusal required');
      const refusal = refusalKind(response.error?.message ?? '', f);
      record.classification = refusal.kind;
      if (refusal.kind === 'tcp-guard-refusal') {
        assert.ok(record.trace.some(item => item.node.length && item.unfilteredTargetBackends.length
          && !item.helperExecutions.some(event => event.role === 'target-payload') && !item.filterReads.length),
        'TCP bypass requires exact Node and unfiltered target bwrap; preparatory/outer flags are not target flags');
        record.guardRefusedBeforeWorker = true;
      } else if (refusal.kind === 'product-compact-helper-writable-symlink') {
        const aliases = lines.flatMap(line => {
          const match = line.match(/symlink\(("(?:\\.|[^"\\])*"), ("(?:\\.|[^"\\])*")\) = 0$/)
            ?? line.match(/symlinkat\(("(?:\\.|[^"\\])*"), AT_FDCWD, ("(?:\\.|[^"\\])*")\) = 0$/);
          return match ? [{ target: JSON.parse(match[1]), path: JSON.parse(match[2]) }] : [];
        });
        record.compactHelperSymlinks = aliases;
        assert.ok(aliases.some(alias => alias.path === refusal.path && alias.target.startsWith(f.runDirectory + '/')),
          'specific compact alias must originate in this product run, not an unrelated symlink error');
        record.failureKind = 'product-compatibility';
        assert.equal(response.accepted, true, 'Z.404.2 product red: compact-helper writable-symlink incompatibility; positive H01 remains required');
      } else if (refusal.kind === 'product-agent-CODEX_HOME-under-TMPDIR') {
        record.failureKind = 'product-compatibility';
        assert.equal(response.accepted, true, 'Z.404.2 product red: actual agent CODEX_HOME under TMPDIR is incompatible with installed CLI helper initialization');
      } else {
        record.failureKind = 'setup-capability-or-unclassified-failure';
        assert.fail('Z404_SETUP: unclassified refusal is neither protective green nor confirmed product red');
      }
    } else {
      record.classification = 'accepted-preflight';
      assert.ok(record.trace.some(item => item.node.length && (item.targetBackends.length || item.outerPayloadCarriers.length)),
        'accepted trace must reach the exact preflight Node payload and its bwrap, not just diagnostic child/help/capability');
      record.note = 'Accepted diagnostic preflight; independent untraced H01 must still pass every live boundary.';
    }
    record.residualAliases = await ownCompactAliases([f.root, f.home]);
    assert.deepEqual(record.residualAliases, []);
    record.passed = true;
  } catch (error) {
    record.passed = false; record.error = { message: error.message, stack: error.stack };
    record.failureKind ??= 'setup-control-or-trace';
  }
  finally {
    try {
      await f.control();
      record.residualAliases = await ownCompactAliases([f.root, f.home]);
      assert.deepEqual(record.residualAliases, []);
    }
    catch (error) { record.passed = false; record.failureKind = 'setup-control-or-cleanup'; record.controlError = error.message; }
    try { await f.dispose(); record.cleaned = true; }
    catch (error) { record.passed = false; record.failureKind = 'setup-cleanup'; record.cleanupError = error.message; }
    await save('traced-preparation.json', record);
  }
  return record;
}

try {
  const prerequisites = await checkPrerequisites();
  await save('prerequisites.json', prerequisites);
  const source = await command('git', ['rev-parse', 'HEAD'], dirname(fileURLToPath(import.meta.url)), process.env); ok(source, 'source SHA');
  summary.sourceHead = source.stdout.trim(); summary.prerequisites = 'verified';
  const dirty = await command('git', ['status', '--porcelain=v1', '--untracked-files=normal'], dirname(fileURLToPath(import.meta.url)), process.env); ok(dirty, 'source dirty context');
  summary.sourceStatus = dirty.stdout.split('\n').filter(Boolean);
  if (mode === 'verify') {
    const control = await rawBypass(prerequisites);
    summary.cases.push(control);
    if (!control.passed || !control.cleaned) throw new Error('Z404_SETUP: H02 raw control failed; product assertions not started');
    summary.stage = 'assertions';
    const traced = await tracedPreparation(prerequisites);
    summary.cases.push(traced);
    if (!traced.passed && traced.failureKind !== 'product-compatibility') {
      throw new Error('Z404_SETUP: H03 setup/capability/control/trace failure is not a confirmed product red');
    }
    for (const layout of ['short', 'long']) for (const entry of ['bare', 'npm', 'native', 'configured']) {
      if (selectedCase && `${layout}/${entry}` !== selectedCase) continue;
      summary.cases.push(await positive(prerequisites, layout, entry));
      await save('summary.json', summary);
    }
    if (!selectedCase) summary.cases.push(await positive(prerequisites, 'long', 'native', true));
    summary.passed = summary.cases.every(record => record.passed && record.cleaned);
    if (!summary.passed) process.exitCode = 1;
  } else summary.passed = true;
} catch (error) {
  summary.passed = false; summary.error = { message: error.message, stack: error.stack };
  const setupFailure = summary.stage === 'setup' || error.message.startsWith('Z404_SETUP:');
  summary.failureKind = setupFailure ? 'setup' : 'assertions'; process.exitCode = setupFailure ? 2 : 1;
} finally {
  summary.finishedAt = new Date().toISOString(); await save('summary.json', summary);
}
