import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { probeRunnerAvailability } from '../src/runner-availability.ts';
import { listModelAvailability, selectModel, type ModelCatalog, type RoutingSnapshot } from '../src/model-routing.ts';
import { agentRunFixture, assertFailedLaunchCleaned } from './agent-run-fixture.ts';

const runners = ['codex', 'claude', 'grok', 'agy'] as const;
const checked = { codex: '0.163.0', claude: '2.1.308', grok: '1.0.67', agy: '1.4.5' };
const older = { codex: '0.162.0', claude: '2.1.307', grok: '1.0.66', agy: '1.4.4' };
const newer = { codex: '0.164.0', claude: '2.1.309', grok: '1.0.68', agy: '1.4.6' };
type Runner = typeof runners[number];
const warning = (installed: string, verified: string) => `версія ${installed} не збігається з перевіреною ${verified}, протокол не перевірено`;
const versionOutput = (runner: Runner, version: string) => runner === 'claude' ? `${version} (Claude Code)\n` : runner === 'codex' ? `codex-cli ${version}\n` : `${version}\n`;
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const putJson = async (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2));
const catalog = await json(new URL('../../conf/models.json', import.meta.url).pathname) as ModelCatalog;

for (const runner of runners) {
  for (const [relation, versions] of [['exact', checked], ['older', older], ['newer', newer]] as const) {
    test(`[version-warning] ${runner}: ${relation} CLI stays available with the exact observation warning`, async () => {
      const settings = Object.freeze({ runner, executable: runner, version: checked[runner] });
      const before = JSON.stringify(settings);
      const installed = versions[runner];
      const calls: unknown[] = [];
      const probe = () => probeRunnerAvailability(settings, {
        env: { PATH: '/isolated/version-warning/bin' },
        ports: { isExecutableFile: async path => path === `/isolated/version-warning/bin/${runner}` },
        execute: async command => {
          calls.push(command);
          return { exitCode: 0, stdout: versionOutput(runner, installed), stderr: '' };
        },
      });
      const expected = relation === 'exact' ? [] : [warning(installed, checked[runner])];
      const first = await probe();
      assert.equal(first.available, true, 'version inequality alone cannot block an executable CLI');
      assert.deepEqual(Reflect.get(first, 'warnings'), expected);
      const snapshot: RoutingSnapshot = {
        runnerEnabled: { [runner]: true },
        cliAvailable: { [runner]: first.available },
        cliWarnings: { [runner]: Reflect.get(first, 'warnings') },
        quotas: [],
      };
      const rows = listModelAvailability(catalog, snapshot).filter(row => row.runner === runner);
      assert.equal(rows.length, catalog.models.filter(row => row.runner === runner).length);
      for (const row of rows) assert.deepEqual(row.warnings, expected);
      assert.equal(Reflect.get(first, 'path'), `/isolated/version-warning/bin/${runner}`);
      assert.deepEqual(await probe(), first, 'repeated observations do not accumulate duplicate warnings');
      assert.equal(JSON.stringify(settings), before, 'the verified protocol version is immutable');
      assert.deepEqual(calls.map(call => ({ executable: Reflect.get(call as object, 'executable'), args: Reflect.get(call as object, 'args') })), [
        { executable: `/isolated/version-warning/bin/${runner}`, args: ['--version'] },
        { executable: `/isolated/version-warning/bin/${runner}`, args: ['--version'] },
      ]);
    });
  }

  test(`[version-warning] ${runner}: every catalog model receives warnings while switches and quotas remain authoritative`, async () => {
    const observed = await probeRunnerAvailability({ runner, executable: runner, version: checked[runner] }, {
      env: { PATH: '/isolated/version-warning/bin' },
      ports: { isExecutableFile: async () => true },
      execute: async () => ({ exitCode: 0, stdout: versionOutput(runner, newer[runner]), stderr: '' }),
    });
    const expected = [warning(newer[runner], checked[runner])];
    const local = structuredClone(catalog);
    local.runners.forEach(row => { row.initialEnabled = row.id === runner; });
    const snapshot: RoutingSnapshot = {
      runnerEnabled: Object.fromEntries(runners.map(id => [id, id === runner])),
      cliAvailable: Object.fromEntries(runners.map(id => [id, true])),
      cliWarnings: { [runner]: Reflect.get(observed, 'warnings') },
      quotas: [],
    };
    const ownModels = local.models.filter(row => row.runner === runner);
    assert.ok(ownModels.length > 0);
    const initialModelSwitches = ownModels.map(row => row.enabled);
    ownModels.forEach(row => { row.enabled = true; });
    const before = JSON.stringify({ local, snapshot });
    const rows = listModelAvailability(local, snapshot).filter(row => row.runner === runner);
    assert.deepEqual(rows.map(row => row.model).sort(), ownModels.map(row => row.id).sort());
    for (const row of rows) {
      assert.equal(row.available, true);
      assert.equal(row.quota, 'unknown', 'version warning is not a measured quota');
      assert.deepEqual(row.warnings, expected);
      assert.ok(row.reasons.every(reason => !reason.includes(expected[0])), 'version warning is separate from quota unknown and other availability reasons');
      const selection = selectModel(local, snapshot, { complexity: row.configuredComplexity });
      assert.equal(selection.status, 'selected', 'runner must remain in normal model selection');
      if (selection.status === 'selected') {
        assert.equal(selection.runner, runner);
        assert.equal(selection.quota, 'unknown');
        assert.ok(!selection.reason.includes(expected[0]), 'selection reason is separate from warning');
      }
    }
    assert.equal(JSON.stringify({ local, snapshot }), before);
    for (const quota of ['available', 'exhausted', 'unknown'] as const) {
      const withQuota = structuredClone(snapshot);
      withQuota.quotas = ownModels.map(model => ({ runner, pool: model.quotaPool ?? model.id, status: quota }));
      for (const row of listModelAvailability(local, withQuota).filter(row => row.runner === runner)) {
        assert.equal(row.quota, quota);
        assert.equal(row.available, quota !== 'exhausted');
        assert.deepEqual(row.warnings, expected);
        if (quota === 'exhausted') assert.ok(row.reasons.some(reason => /quota.*exhausted/i.test(reason)));
      }
      if (quota === 'exhausted') assert.equal(selectModel(local, withQuota, { complexity: 'mechanical' }).status, 'waiting');
    }
    const runnerOff = structuredClone(snapshot);
    runnerOff.runnerEnabled[runner] = false;
    for (const row of listModelAvailability(local, runnerOff).filter(row => row.runner === runner)) {
      assert.equal(row.available, false);
      assert.ok(row.reasons.some(reason => /runner.*disabled/i.test(reason)));
      assert.deepEqual(row.warnings, expected);
    }
    ownModels.forEach(model => { model.enabled = false; });
    for (const row of listModelAvailability(local, snapshot).filter(row => row.runner === runner)) {
      assert.equal(row.available, false);
      assert.ok(row.reasons.some(reason => /model.*disabled/i.test(reason)));
      assert.deepEqual(row.warnings, expected);
    }
    ownModels.forEach((model, index) => { model.enabled = initialModelSwitches[index]; });
  });

  for (const fault of ['missing', 'not-executable', 'spawn-failure', 'nonzero-expected', 'nonzero-other', 'empty', 'unparseable'] as const) {
    test(`[version-warning] ${runner}: ${fault} is a real unavailable CLI, never a version warning`, async t => {
      const directory = await mkdtemp(join(tmpdir(), 'raf-version-warning-'));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const path = join(directory, runner);
      if (fault === 'not-executable') await writeFile(path, 'unexecutable fixture', { mode: 0o600 });
      let executed = false;
      const result = await probeRunnerAvailability({ runner, executable: runner, version: checked[runner] }, {
        env: { PATH: directory },
        ...(fault === 'missing' || fault === 'not-executable' ? {} : { ports: { isExecutableFile: async () => true } }),
        execute: async () => {
          executed = true;
          if (fault === 'spawn-failure') throw new Error('fixture spawn ENOENT: invalid interpreter');
          return {
            exitCode: fault.startsWith('nonzero') ? 17 : 0,
            stdout: fault === 'empty' ? '' : fault === 'unparseable' ? 'CLI version unavailable\n' : versionOutput(runner, fault === 'nonzero-other' ? newer[runner] : checked[runner]),
            stderr: fault.startsWith('nonzero') ? 'fixture version command failed' : '',
          };
        },
      });
      assert.equal(result.available, false);
      assert.ok(Reflect.get(result, 'reason')?.trim(), 'unavailability has an explicit primary reason');
      assert.deepEqual(Reflect.get(result, 'warnings') ?? [], [], 'do not invent an installed version');
      if (fault === 'missing' || fault === 'not-executable') assert.equal(executed, false);
    });
  }
}

type ProductionFixture = Awaited<ReturnType<typeof agentRunFixture>>;
const commands = ['agent run', 'agent close', 'runner list', 'runner enable', 'runner disable', 'help'];
const timeouts = { startupMs: 10000, transitionMs: 10000, overallMs: 30000 };

async function productionFixture(t: Parameters<typeof agentRunFixture>[0], runner: 'codex' | 'claude', mode = 'ready') {
  const fixture = await agentRunFixture(t, mode, timeouts, runner, { commands, productionQa: true, tasks: 2 });
  const root = join(fixture.directory, 'orchestrator');
  const confPath = join(root, 'conf', 'raf.json');
  const flowPath = join(root, 'conf', 'flow.json');
  const flow = await json(flowPath);
  for (const thresholds of Object.values(flow.resources) as { maxNormalizedLoad: number }[]) thresholds.maxNormalizedLoad = Number.MAX_VALUE;
  await putJson(flowPath, flow);
  const configuration = await json(confPath);
  const protocol = configuration.runnerProtocols.find((row: { runner: string }) => row.runner === runner);
  assert.ok(protocol, 'fixture must provide the selected protocol');
  const executable = join(fixture.directory, 'bin', runner);
  if (runner === 'codex') {
    const script = await readFile(executable, 'utf8');
    assert.ok(script.includes('0.0.1'), 'documented fake codex version marker');
    await writeFile(executable, script.replaceAll('0.0.1', checked.codex));
    protocol.version = checked.codex;
    await putJson(confPath, configuration);
  }
  const modelsPath = join(root, 'conf', 'models.json');
  const models = await json(modelsPath);
  for (const row of models.runners) row.initialEnabled = row.id === runner;
  await putJson(modelsPath, models);
  return { fixture, confPath, executable, installed: protocol.version as string };
}

async function setVerified(confPath: string, runner: Runner, version: string) {
  const configuration = await json(confPath);
  configuration.runnerProtocols.find((row: { runner: string }) => row.runner === runner).version = version;
  await putJson(confPath, configuration);
}

async function confDigest(fixture: ProductionFixture) {
  const directory = join(fixture.directory, 'orchestrator', 'conf');
  const names = (await readdir(directory, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile());
  const files = await Promise.all(names.map(async entry => {
    const path = join(entry.parentPath, entry.name);
    return [path.slice(directory.length), createHash('sha256').update(await readFile(path)).digest('hex')];
  }));
  return files.sort((a, b) => a[0].localeCompare(b[0]));
}

function commandResult(outcome: Awaited<ReturnType<ProductionFixture['run']>>) {
  const envelope = outcome.result;
  assert.equal(typeof envelope?.exitCode, 'number', 'fixture returns a production CLI envelope');
  assert.equal(outcome.exitCode, envelope.exitCode, JSON.stringify(outcome));
  const payload = envelope.stdout || envelope.stderr;
  return { exitCode: envelope.exitCode, result: payload ? JSON.parse(payload) : null, stderr: envelope.stderr };
}

async function assertBriefDelivered(fixture: ProductionFixture, id: string, reportPath: string, runner: Runner) {
  const marker = (await readFile(join(fixture.control, `${id}.brief`), 'utf8')).trim();
  assert.match(marker, /^[1-9]\d*$/, 'brief marker records the accepting runner PID');
  const raw = await readFile(join(fixture.control, `input-${marker}.log`), 'utf8');
  if (runner === 'claude') {
    assert.match(raw, /\x1b\[200~/, 'Claude requested bracketed paste before brief delivery');
    assert.match(raw, /\x1b\[201~[\r\n]/, 'Claude received a complete paste followed by submission');
  }
  const input = raw.replace(/\x1b\[(?:200|201)~/g, '').replace(/\r/g, '\n');
  const offset = input.search(/\{\s*"project"\s*:/);
  assert.ok(offset >= 0, 'the accepting runner received the raw assignment JSON');
  const brief = JSON.parse(input.slice(offset).trim());
  assert.equal(brief.agent_id, id);
  assert.equal(brief.report_path, reportPath);
  assert.ok(brief.assignments?.length > 0, 'the delivered brief contains assigned work');
  assert.match(input.slice(offset), /\n\s*$/, 'brief delivery includes submission');
}

for (const runner of ['codex', 'claude'] as const) {
  for (const relation of ['exact', 'older', 'newer'] as const) {
    test(`[version-warning] production ${runner}: ${relation} version reaches worker, identity, brief and agent run JSON`, async t => {
      const { fixture, confPath, installed } = await productionFixture(t, runner);
      const verified = relation === 'exact' ? installed : relation === 'older' ? newer[runner] : older[runner];
      await setVerified(confPath, runner, verified);
      const before = await confDigest(fixture);
      const expected = relation === 'exact' ? [] : [warning(installed, verified)];
      const id = `version-${runner}-${relation}`;
      const outcome = commandResult(await fixture.run(id));
      assert.equal(outcome.exitCode, 0, JSON.stringify(outcome));
      assert.equal(outcome.result.status, 'running');
      assert.deepEqual(outcome.result.warnings, expected, 'production response and runner list agree without duplicate warnings');
      assert.equal(outcome.result.selection.quota, 'unknown');
      assert.equal(outcome.result.selection.runner, runner);
      assert.ok(outcome.result.runId);
      assert.ok(outcome.result.reportPath);
      assert.equal(outcome.result.process.runner, runner);
      assert.ok(outcome.result.process.runnerSessionId, 'native identity was established before the brief');
      await assertBriefDelivered(fixture, id, outcome.result.reportPath, runner);
      assert.deepEqual(await confDigest(fixture), before, 'all conf bytes, version, operationalEvidence and liveTaskVerified stay unchanged');
    });
  }

  test(`[version-warning] production ${runner}: disabled runner still denies selection`, async t => {
    const { fixture, confPath } = await productionFixture(t, runner);
    await setVerified(confPath, runner, older[runner]);
    const modelsPath = join(fixture.directory, 'orchestrator', 'conf', 'models.json');
    const models = await json(modelsPath);
    for (const row of models.runners) row.initialEnabled = false;
    await putJson(modelsPath, models);
    const before = await confDigest(fixture);
    const outcome = commandResult(await fixture.run(`version-disabled-${runner}`));
    assert.notEqual(outcome.exitCode, 0);
    const state = await fixture.inspect();
    assert.equal(state.claims.length, 0);
    assert.equal(state.admission.length, 0);
    assert.deepEqual(await confDigest(fixture), before);
  });

  test(`[version-warning] production ${runner}: a later launch observes the updated executable version`, async t => {
    const { fixture, confPath, executable, installed } = await productionFixture(t, runner);
    await setVerified(confPath, runner, older[runner]);
    const before = await confDigest(fixture);
    const first = commandResult(await fixture.run(`version-before-update-${runner}`));
    assert.equal(first.exitCode, 0, JSON.stringify(first));
    assert.deepEqual(first.result.warnings, [warning(installed, older[runner])]);
    await assertBriefDelivered(fixture, `version-before-update-${runner}`, first.result.reportPath, runner);
    if (runner === 'codex') {
      const script = await readFile(executable, 'utf8');
      assert.ok(script.includes(installed));
      await writeFile(executable, script.replaceAll(installed, newer[runner]));
    } else {
      const mockConfigurationPath = join(fixture.directory, 'fixture.json');
      const mockConfiguration = await json(mockConfigurationPath);
      mockConfiguration.claudeVersion = newer[runner];
      await putJson(mockConfigurationPath, mockConfiguration);
    }
    const outcome = commandResult(await fixture.run(`version-updated-${runner}`, 'implement', ['1.2']));
    assert.equal(outcome.exitCode, 0, JSON.stringify(outcome));
    assert.equal(outcome.result.status, 'running');
    assert.deepEqual(outcome.result.warnings, [warning(newer[runner], older[runner])]);
    await assertBriefDelivered(fixture, `version-updated-${runner}`, outcome.result.reportPath, runner);
    assert.deepEqual(await confDigest(fixture), before);
  });

  for (const fault of ['missing', 'not-executable', 'spawn-failure', 'nonzero-expected', 'nonzero-other', 'empty', 'unparseable'] as const) {
    test(`[version-warning] production ${runner}: ${fault} blocks launch with no claims or admission leak`, async t => {
      const { fixture, confPath, executable, installed } = await productionFixture(t, runner);
      await setVerified(confPath, runner, installed);
      const before = await confDigest(fixture);
      if (fault === 'missing') await rm(executable);
      else if (fault === 'not-executable') await chmod(executable, 0o600);
      else if (fault === 'spawn-failure') await writeFile(executable, '#!/nonexistent/raf-version-interpreter\n');
      else {
        const stdout = fault === 'empty' ? '' : fault === 'unparseable' ? 'version unavailable' : versionOutput(runner, fault === 'nonzero-other' ? newer[runner] : installed).trim();
        await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' '${stdout}'\nexit ${fault.startsWith('nonzero') ? 17 : 0}\n`);
      }
      const outcome = commandResult(await fixture.run(`version-${fault}-${runner}`));
      assert.notEqual(outcome.exitCode, 0, 'bad binary is a launch refusal');
      const state = await fixture.inspect();
      assert.equal(state.claims.length, 0);
      assert.equal(state.admission.length, 0);
      assert.deepEqual(await confDigest(fixture), before);
    });
  }
}

test('[version-warning] production codex: a real unknown screen after identity request keeps its primary failure and cleanup', async t => {
  const { fixture, confPath } = await productionFixture(t, 'codex', 'readiness-unknown');
  await setVerified(confPath, 'codex', older.codex);
  const before = await confDigest(fixture);
  const rawOutcome = await fixture.run('version-unknown-screen');
  const outcome = commandResult(rawOutcome);
  assert.equal(outcome.exitCode, 1);
  const failure = JSON.stringify(outcome.result);
  assert.match(failure, /unknown_screen|Approve unknown action|Unknown native/i, 'primary reason is the observed screen');
  assert.doesNotMatch(failure, /RUNNER_PROTOCOL_UNAVAILABLE|версія не перевірена/i, 'version inequality is not the failure');
  await assertFailedLaunchCleaned(fixture, rawOutcome, 'version mismatch with unknown screen');
  const logs = (await readdir(fixture.control)).filter(name => /^input-.*\.log$/.test(name));
  assert.ok(logs.length > 0);
  const input = (await Promise.all(logs.map(name => readFile(join(fixture.control, name), 'utf8')))).join('');
  assert.match(input, /\/status/);
  const afterStatus = input.slice(input.lastIndexOf('/status') + '/status'.length);
  assert.doesNotMatch(afterStatus, /[\r\n]/, 'the mock shows the unknown screen on status text; do not submit or confirm it');
  assert.ok(!(await readdir(fixture.control)).includes('version-unknown-screen.brief'));
  assert.deepEqual(await confDigest(fixture), before);
});
