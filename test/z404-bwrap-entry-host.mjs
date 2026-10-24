import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { dirname, join, resolve, delimiter, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { prepareCodexSandbox } from '../src/codex-sandbox.ts';
import { resolveRunnerExecutable } from '../src/runner-availability.ts';
import { checkPrerequisites, stand, command, ok, ownCompactAliases, transitionMs, pollMs } from './helpers/z404-host-fixture.ts';
import { traceEvidence } from './helpers/z404-trace-evidence.ts';

const [mode, target] = process.argv.slice(2);
assert.ok(['setup', 'verify'].includes(mode) && target, 'usage: node test/z404-bwrap-entry-host.mjs setup|verify <own-evidence-directory>');
const evidenceDirectory = resolve(target);
await fs.mkdir(evidenceDirectory, { recursive: true });
const summary = { stage: 'setup', cases: [], startedAt: new Date().toISOString(), modelPromptSent: false };
async function save(name, data) {
  const path = join(evidenceDirectory, name), temporary = `${path}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(data, null, 2) + '\n'); await fs.rename(temporary, path);
}

function policy(invocation) {
  const tables = invocation.args.flatMap((arg, index, args) => ['-c', '--config'].includes(arg) && /^permissions\.[^.]+\.filesystem=/.test(args[index + 1] ?? '') ? [args[index + 1]] : []);
  assert.equal(tables.length, 1, 'runner/tool expose one effective native filesystem policy');
  const body = tables[0].slice(tables[0].indexOf('=') + 1);
  const pairs = [...body.slice(1, -1).matchAll(/("(?:\\.|[^"\\])*")\s*=\s*("(?:\\.|[^"\\])*")/g)];
  assert.ok(pairs.length > 0, 'native permissions must be observable');
  return pairs.map(([, path, access]) => [JSON.parse(path), JSON.parse(access)]).sort(([a], [b]) => a.localeCompare(b));
}

async function positive(prerequisites, layout, entry, poison = false) {
  const id = `[Z.404 H01 ${layout} ${entry}${poison ? ' unselected-PATH-backend' : ''}]`;
  const f = await stand(layout === 'long');
  let prepared;
  const record = { id, accepted: false, cleaned: false, workerStarted: false, ipv6Unavailable: f.ipv6Unavailable };
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
    assert.deepEqual(input, original, 'preparation does not mutate selection, environment or scope');
    for (const value of ['workspace-write', 'never']) assert.ok(prepared.invocation.args.includes(value), `${value} retained`);
    assert.doesNotMatch(prepared.invocation.args.join(' '), /danger-full-access|dangerously-bypass|disable-sandbox/);
    const selection = input.invocation.args.flatMap((arg, index, args) => arg === '--model' || (arg === '-c' && args[index + 1]?.startsWith('model_reasoning_effort=')) ? [args[index + 1]] : []);
    assert.ok(selection.length >= 2 && selection.every(value => prepared.invocation.args.includes(value)), 'raf model and effort retained');
    const runnerPolicy = policy(prepared.invocation), toolPolicy = policy(prepared.toolSandbox);
    assert.deepEqual(runnerPolicy, toolPolicy, 'preflight/live tools retain the runner filesystem policy');
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
    const result = await command(prepared.toolSandbox.executable, [...prepared.toolSandbox.args, process.execPath, probeFile, JSON.stringify(probe)], f.workspace, prepared.environment);
    record.toolExit = { code: result.code, signal: result.signal, timedOut: result.timedOut };
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
    record.failureKind = 'assertions';
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
  const f = await stand(false);
  const record = { id: '[Z.404 H02] actual installed Codex selects system bwrap without RAF filter', passed: false, cleaned: false };
  try {
    await f.control();
    const bin = join(f.root, 'path-helper'); await fs.mkdir(bin);
    const helper = join(bin, 'bwrap'), helperMarker = join(f.workspace, 'PATH-helper-executed');
    const filter = join(f.workspace, 'network.bpf'), traceFile = join(evidenceDirectory, 'raw-bypass.strace');
    await fs.writeFile(helper, `#!/bin/sh\nprintf executed > '${helperMarker}'\nexec /usr/bin/bwrap "$@"\n`, { mode: 0o700 });
    const environment = { ...f.environment, PATH: `${bin}${delimiter}${f.environment.PATH}` };
    const program = `const fs=require('node:fs'),net=require('node:net');fs.writeFileSync(process.argv[2],Buffer.alloc(80));const c=net.connect(JSON.parse(process.argv[1]));let data='';c.on('data',b=>data+=b);c.on('error',e=>{console.error(e.code);process.exitCode=1});c.on('end',()=>{if(data!=='host-sentinel')process.exitCode=2;else console.log('HOST_TCP_REACHABLE')});`;
    const table = `{":root"="read",${JSON.stringify(f.workspace)}="write"}`;
    const args = ['-f', '-s', '65535', '-e', 'trace=execve,openat,seccomp,unshare', '-o', traceFile,
      prerequisites.native, 'sandbox', 'linux', '-C', f.workspace, '-P', 'linux',
      '-c', 'sandbox_mode="workspace-write"', '-c', 'default_permissions="linux"',
      '-c', `permissions.linux.filesystem=${table}`, '-c', 'permissions.linux.network.enabled=true',
      '--', process.execPath, '-e', program, JSON.stringify(f.ports[0]), filter, helper];
    const result = await command('strace', args, f.workspace, environment);
    ok(result, 'raw deliberately unfiltered Codex control'); assert.equal(result.stdout.trim(), 'HOST_TCP_REACHABLE');
    record.trace = traceEvidence((await fs.readFile(traceFile, 'utf8')).split('\n'), helper, filter);
    assert.equal(record.trace.systemBwrapExecuted, true, 'exact successful system bwrap execve required');
    assert.equal(record.trace.systemSandboxWithoutRafFlags, true, 'inspect actual sandbox payload argv, not help or another execve');
    assert.equal(record.trace.helperExecuted, false, 'pathname in node argv is not helper execution');
    assert.equal(record.trace.filterRead, false, 'O_WRONLY creation is not filter loading');
    await assert.rejects(fs.stat(helperMarker), { code: 'ENOENT' });
    assert.equal((await fs.stat(filter)).size, 80);
    const untraced = await command(prerequisites.native, args.slice(args.indexOf(prerequisites.native) + 1), f.workspace, environment);
    ok(untraced, 'same raw control without tracer'); assert.equal(untraced.stdout.trim(), 'HOST_TCP_REACHABLE');
    record.untracedMatched = true;
    record.passed = true;
  } catch (error) { record.error = { message: error.message, stack: error.stack }; }
  finally {
    try { await f.control(); }
    catch (error) { record.passed = false; record.controlError = error.message; }
    try { await f.dispose(); record.cleaned = true; }
    catch (error) { record.passed = false; record.cleanupError = error.message; }
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
    const filters = [...new Set(lines.flatMap(line => {
      const match = line.match(/openat\(AT_FDCWD, ("(?:\\.|[^"\\])*\/network\.bpf")/);
      return match ? [JSON.parse(match[1])] : [];
    }))];
    const launcherHelpers = lines.flatMap(line => {
      const match = line.match(/execve\(("\/tmp\/raf-tools-[^"\n]+\/codex")/);
      return match ? [join(dirname(JSON.parse(match[1])), 'bwrap')] : [];
    });
    record.filterEvidence = filters.map(filter => {
      const helpers = [join(dirname(filter), 'bwrap'), ...launcherHelpers];
      const observations = helpers.map(helper => traceEvidence(lines, helper, filter));
      return { filter, helpers, ...observations[0], helperExecuted: observations.some(item => item.helperExecuted) };
    });
    record.preflight = response;
    if (!response.accepted) {
      assert.match(response.error.message, /host loopback TCP reachable/, 'only actual TCP protective refusal counts here; missing setup/capability is not the bypass reproduction');
      assert.ok(record.filterEvidence.some(item => item.systemSandboxWithoutRafFlags && !item.helperExecuted && !item.filterRead), 'actual Codex→system bwrap and RAF BPF creation without loading must be observed');
      record.guardRefusedBeforeWorker = true;
    } else {
      record.guardRefusedBeforeWorker = false;
      record.note = 'Effective preflight accepted after repair; positive untraced matrix still must pass every live boundary.';
    }
    record.residualAliases = await ownCompactAliases([f.root, f.home]);
    assert.deepEqual(record.residualAliases, []);
    record.passed = true;
  } catch (error) { record.error = { message: error.message, stack: error.stack }; }
  finally {
    try { await f.control(); }
    catch (error) { record.passed = false; record.controlError = error.message; }
    try { await f.dispose(); record.cleaned = true; }
    catch (error) { record.passed = false; record.cleanupError = error.message; }
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
    summary.stage = 'assertions';
    summary.cases.push(await rawBypass(prerequisites));
    summary.cases.push(await tracedPreparation(prerequisites));
    for (const layout of ['short', 'long']) for (const entry of ['bare', 'npm', 'native', 'configured']) {
      summary.cases.push(await positive(prerequisites, layout, entry));
      await save('summary.json', summary);
    }
    summary.cases.push(await positive(prerequisites, 'long', 'native', true));
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
