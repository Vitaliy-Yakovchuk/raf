import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import { prepareProductionQaFixture } from './production-qa-fixture.ts';
import { buildRunnerInvocation, nativeSandboxArgs } from '../src/runner-protocols.ts';
import { prepareCodexRafCommandAccess } from '../src/codex-raf-command-access.ts';
import type { PreparedCodexRafCommandAccess } from '../src/codex-raf-command-access.ts';
import type { ProcessIdentity, SessionRecord } from '../src/session-state.ts';

const confRoot = fileURLToPath(new URL('../../conf/', import.meta.url));
const configuration = JSON.parse(await readFile(join(confRoot, 'raf.json'), 'utf8'));
export const outputTimeout = JSON.parse(await readFile(join(confRoot, 'flow.json'), 'utf8')).unitTests.timeoutMs;
assert.ok(Number.isSafeInteger(outputTimeout) && outputTimeout > 0);
export const outputSettings = configuration.runnerProtocols.find((entry: any) => entry.runner === 'codex');
assert.ok(outputSettings);
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
export const digest = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
export type Captured = { code: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: Buffer };
export type SpawnTrace = { executable: string; args: readonly string[]; env: Readonly<Record<string, string>> };

export async function capture(executable: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string>>, input?: string, traces?: SpawnTrace[]): Promise<Captured> {
  traces?.push({ executable, args: [...args], env: { ...env } });
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), outputTimeout);
    child.stdout.on('data', data => out.push(Buffer.from(data)));
    child.stderr.on('data', data => err.push(Buffer.from(data)));
    child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') reject(error); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }); });
    child.stdin.end(input);
  });
}

export async function filesBelow(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return (await Promise.all(entries.map(async entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? await filesBelow(path) : [path];
  }))).flat().sort();
}

export function hookCommand(prepared: PreparedCodexRafCommandAccess): string {
  const config = prepared.invocation.args.find(value => value.startsWith('hooks.PreToolUse='));
  assert.ok(config, 'prepared invocation must install the production PreToolUse hook');
  const match = config.match(/\bcommand\s*=\s*("(?:\\.|[^"\\])*")/);
  assert.ok(match, 'hook command must be a TOML basic string with JSON escapes');
  return JSON.parse(match[1]);
}

export async function outputFixture(t: TestContext, options: { production?: boolean; instrumentation?: boolean; rafExecutable?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'raf-codex-output-'));
  const cwd = join(root, 'workspace'), home = join(root, 'home'), codexHome = join(root, 'codex-home');
  const stateDirectory = join(home, '.raf'), runDirectory = join(cwd, 'run');
  const statePath = join(stateDirectory, 'state.sqlite'), controlPath = join(root, 'control.json');
  const commandPath = join(root, 'raf-command.mjs'), callsPath = join(root, 'calls.jsonl'), tracePath = join(root, 'spawn.jsonl');
  const observerPath = join(root, 'observe.mjs');
  const preparedRuns: PreparedCodexRafCommandAccess[] = [];
  t.after(async () => {
    try { for (const prepared of preparedRuns) await prepared.cleanup(); }
    finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
  });
  await Promise.all([cwd, stateDirectory, codexHome, runDirectory].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  const configText = 'sandbox_mode = "workspace-write"\n';
  await writeFile(join(codexHome, 'config.toml'), configText);
  await writeFile(join(stateDirectory, 'secrets.json'), '{"canary":"Z101-HIDDEN-SECRET"}', { mode: 0o600 });
  await writeFile(observerPath, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify({argv:process.argv,env:process.env})+'\\n');`);
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? '', HOME: home, RAF_QA_HOME: home, CODEX_HOME: codexHome,
    TMPDIR: runDirectory, LANG: 'C.UTF-8',
    ...(options.instrumentation ? { NODE_OPTIONS: `--import=${observerPath}` } : {}),
  };
  const fixtureConf = join(root, 'conf');
  await mkdir(fixtureConf);
  for (const name of ['raf-constants.json', 'models.json', 'flow.json', 'raf.json']) await writeFile(join(fixtureConf, name), await readFile(join(confRoot, name)));
  await writeFile(join(fixtureConf, 'projects.json'), JSON.stringify({ version: 1, projects: { raf: { path: 'raf-main', profile: 'raf', branchPaths: { main: 'raf-main', develop: 'raf-develop' }, usesSharedLibs: false } }, profiles: { raf: { development: 'develop', integration: 'main', production: 'main' } } }));
  await prepareProductionQaFixture(t, { root, home });
  const codeRoot = join(root, 'raf-develop');
  const { openStateStore } = await import(pathToFileURL(join(codeRoot, 'src/state-store.ts')).href);
  const store = openStateStore(statePath);
  const runIds: string[] = [];
  if (options.production) {
    store.sessionRepository.transaction(tx => {
      for (let index = 0; index < 512; index++) {
        const runId = `z101-running-${String(index).padStart(4, '0')}-END`;
        runIds.push(runId);
        const identity: ProcessIdentity = { pid: 100000 + index, startedAt: '2026-10-23T00:00:00.000Z', runner: 'codex', runnerSessionId: `fixture-${index}`, tmuxSession: `owned-${index}`, evidence: { fixture: 'controlled OS observation port' } };
        const session: SessionRecord = { runId, addressId: `worker-${index}`, revision: 1, state: 'running', process: identity, observation: { state: 'alive', observedAt: '2026-10-23T00:00:00.000Z', identity }, activity: { type: 'implement', project: 'raf', features: ['visible-state-' + 'x'.repeat(512)], phase: 'implement', cwd } };
        tx.putSession(session);
      }
      tx.putSession({ runId: 'z101-finished-must-stay-hidden', addressId: 'finished', revision: 1, state: 'finished', finishedAt: '2026-10-23T00:00:00.000Z' });
    });
  }
  store.close();
  const artifactPath = join(root, 'catalog.json');
  const productionScript = `
const { openStateStore } = await import(${JSON.stringify(pathToFileURL(join(codeRoot, 'src/state-store.ts')).href)});
const { AgentControlService } = await import(${JSON.stringify(pathToFileURL(join(codeRoot, 'src/agent-control.ts')).href)});
const { createAppRuntime } = await import(${JSON.stringify(pathToFileURL(join(codeRoot, 'src/app-runtime.ts')).href)});
const { createServiceHandlers } = await import(${JSON.stringify(pathToFileURL(join(codeRoot, 'src/service-entry.ts')).href)});
const { buildCatalog, runCli } = await import(${JSON.stringify(pathToFileURL(join(codeRoot, 'src/bootstrap.ts')).href)});
const store = openStateStore(${JSON.stringify(statePath)});
const repository = store.sessionRepository;
const control = new AgentControlService({repository,
 scanner:{inspect:async identity=>({state:'alive',identity,observedAt:'2026-10-23T00:00:00.000Z'})},
 coordinator:{acceptPendingReport:async s=>s,observe:async(s,o)=>{const next={...s,observation:o};repository.transaction(tx=>tx.putSession(next));return next;},publish:async()=>{},updateActivity:async()=>{throw Error('unexpected update');},finalize:async()=>{throw Error('unexpected finalize');}},
 authority:{resolve:async()=>({kind:'system'})}, transport:{deliver:async()=>{throw Error('unexpected delivery');},close:async()=>{throw Error('unexpected close');},interrupt:async()=>{throw Error('unexpected interrupt');}},
 reminders:{sessionEnded:()=>{throw Error('unexpected end');}},projects:['raf'],agentTypes:['implement'],agentPhases:['implement']});
const context={orchestratorRoot:${JSON.stringify(root)},confRoot:${JSON.stringify(fixtureConf)},artifactPath:${JSON.stringify(artifactPath)},statePath:${JSON.stringify(statePath)},tmpRoot:${JSON.stringify(join(stateDirectory, 'tmp'))},mode:'test',commandStartedAtMs:0,resolveCaller:async()=>undefined};
const serviceHandlers=createServiceHandlers({orchestratorRoot:${JSON.stringify(root)},homeDirectory:${JSON.stringify(home)},service:${JSON.stringify(configuration.service)}});
const runtime=createAppRuntime(context,{additionalHandlers:serviceHandlers.handlers,loadConfiguration:async()=>({catalog:JSON.parse(readFileSync(${JSON.stringify(artifactPath)},'utf8')),models:JSON.parse(readFileSync(${JSON.stringify(join(fixtureConf, 'models.json'))},'utf8')),commandTiming:{emaAlpha:0.1}}),openStore:async()=>store,createServices:async()=>({control}),nextRunIdentity:()=>{throw Error('unexpected launch');},now:()=>0});
buildCatalog(${JSON.stringify(fixtureConf)},${JSON.stringify(artifactPath)},Object.keys(runtime.handlers));
try {const result=await runCli(process.argv.slice(2),${JSON.stringify(artifactPath)},runtime.handlers);process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.exitCode;} finally {await runtime.close();}
`;
  await writeFile(commandPath, `import {appendFileSync,readFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2))+'\\n');
${options.production ? productionScript : `
const all=JSON.parse(readFileSync(${JSON.stringify(controlPath)},'utf8'));
const c=all.variants?.[process.argv.at(-1)] ?? all;
if(c.waitFile){const {existsSync}=await import('node:fs');while(!existsSync(c.waitFile))await new Promise(r=>setTimeout(r,10));}
process.stdout.write(readFileSync(c.stdout));process.stderr.write(readFileSync(c.stderr));process.exitCode=c.code;
`}`);
  const rafCommand = `${shellQuote(options.rafExecutable ?? process.execPath)} ${shellQuote(commandPath)}`;
  const scope = { hidden: [stateDirectory], readable: [], tmuxDirectory: join(runDirectory, 'tmux'), excludedCommands: [`${rafCommand} agent ps`, `${rafCommand} agent message`] };
  const invocation = buildRunnerInvocation(outputSettings, { model: 'gpt-6.1-sol', effort: 'high' });
  const request = { invocation: { ...invocation, args: nativeSandboxArgs(outputSettings, invocation.args, scope) }, scope, cwd, runDirectory, environment, timeoutMs: outputTimeout };
  const traces: SpawnTrace[] = [];
  const prepare = async (directory = runDirectory) => {
    await mkdir(directory, { recursive: true });
    const prepared = await prepareCodexRafCommandAccess({ ...request, runDirectory: directory });
    assert.equal(prepared.unavailable, undefined, 'hook discovery is a fixture prerequisite');
    preparedRuns.push(prepared);
    return prepared;
  };
  const configure = async (stdout: Uint8Array, stderr: Uint8Array = Buffer.alloc(0), code = 0, waitFile?: string, key?: string) => {
    const out = join(root, `expected-${key ?? 'default'}.stdout`), err = join(root, `expected-${key ?? 'default'}.stderr`);
    await writeFile(out, stdout); await writeFile(err, stderr);
    const value = { stdout: out, stderr: err, code, waitFile };
    if (key) {
      const previous = JSON.parse(await readFile(controlPath, 'utf8').catch(() => '{}'));
      await writeFile(controlPath, JSON.stringify({ ...previous, variants: { ...previous.variants, [key]: value } }));
    } else await writeFile(controlPath, JSON.stringify(value));
  };
  const hook = async (prepared: PreparedCodexRafCommandAccess, command = `${rafCommand} agent ps`) => {
    const result = await capture('/bin/sh', ['-c', hookCommand(prepared)], cwd, prepared.environment, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd, session_id: 'z101-output-fixture' }), traces);
    if (result.code !== 0) return { result, response: undefined, replay: undefined };
    const response = JSON.parse(result.stdout.toString());
    const replay: string | undefined = response.hookSpecificOutput?.updatedInput?.command;
    return { result, response, replay };
  };
  const replay = async (prepared: PreparedCodexRafCommandAccess, command: string) => capture('/bin/sh', ['-c', command], cwd, prepared.environment, undefined, traces);
  const calls = async (): Promise<string[][]> => (await readFile(callsPath, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const hostPs = () => capture(process.execPath, [commandPath, 'agent', 'ps'], cwd, environment);
  return { root, cwd, home, codexHome, statePath, stateDirectory, runDirectory, commandPath, controlPath, callsPath, tracePath, environment, configText, rafCommand, request, runIds, traces, prepare, configure, hook, replay, calls, hostPs };
}
