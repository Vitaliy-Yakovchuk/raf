import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [fixture] = process.argv.slice(2);
assert.ok(fixture && path.isAbsolute(fixture));
const summary = JSON.parse(fs.readFileSync(path.join(fixture, 'summary.json'), 'utf8'));
assert.equal(summary.cleanup.complete, true);
assert.equal(summary.status, 'passed');
const main = path.join(fixture, 'root/raf-main');
const git = spawnSync('git', ['-C', main, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
assert.equal(git.status, 0); assert.equal(git.stdout.trim(), summary.reviewed);
const base = fs.mkdtempSync('/srv/dev/p45-diag-'), home = path.join(base, 'home');
fs.mkdirSync(path.join(home, '.raf'), { recursive: true });
const state = path.join(home, '.raf/state.sqlite');
fs.copyFileSync(path.join(fixture, 'ev/empty-seed.sqlite'), state);
const countsFile = path.join(base, 'operations.json');
const shim = path.join(base, 'instrument.mjs');
const modules = {
  'state-store.ts': ['openStateStore'],
  'state-migration-guard.ts': ['productionStateContext', 'verifyStateContext'],
};
fs.writeFileSync(shim, `import {registerHooks} from 'node:module';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const rows=[];
globalThis.__qaPsDiagnostic=(name,call)=>{const at=performance.now(),start=process.cpuUsage();try{return call();}finally{const cpu=process.cpuUsage(start);rows.push({name,wallMs:performance.now()-at,cpuUserMs:cpu.user/1000,cpuSystemMs:cpu.system/1000});}};
const modules=${JSON.stringify(modules)}, root=${JSON.stringify(main)};
registerHooks({resolve(specifier,context,next){const result=next(specifier,context);if(context.parentURL?.startsWith('ps-diagnostic:'))return result;if(!result.url.startsWith('file:'))return result;const file=fileURLToPath(result.url);const name=file.slice(file.lastIndexOf('/')+1);return file.startsWith(root+'/src/')&&modules[name]?{url:'ps-diagnostic:'+result.url,shortCircuit:true}:result;},load(url,context,next){if(!url.startsWith('ps-diagnostic:'))return next(url,context);const real=url.slice('ps-diagnostic:'.length),name=real.slice(real.lastIndexOf('/')+1);return {format:'module',shortCircuit:true,source:'export * from '+JSON.stringify(real)+';import * as actual from '+JSON.stringify(real)+';'+modules[name].map(fn=>'export const '+fn+'=(...args)=>globalThis.__qaPsDiagnostic('+JSON.stringify(name+'::'+fn)+',()=>actual.'+fn+'(...args));').join('')};}});
process.once('exit',()=>fs.writeFileSync(${JSON.stringify(countsFile)},JSON.stringify(rows,null,2)+'\\n'));
`);
const env = { PATH: process.env.PATH, HOME: home, RAF_QA_HOME: home, TMPDIR: base, XDG_CONFIG_HOME: path.join(base, 'config'),
  XDG_CACHE_HOME: path.join(base, 'cache'), GIT_CONFIG_GLOBAL: path.join(fixture, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
const args = ['--cpu-prof', '--cpu-prof-dir=' + base, '--cpu-prof-name=agent-ps.cpuprofile', '--import', shim, path.join(main, 'bin/raf.ts'), 'agent', 'ps'];
const at = new Date().toISOString();
const result = spawnSync(process.execPath, args, { cwd: main, env, encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
fs.writeFileSync(path.join(base, 'stdout'), result.stdout ?? ''); fs.writeFileSync(path.join(base, 'stderr'), result.stderr ?? '');
fs.writeFileSync(path.join(base, 'command.json'), JSON.stringify({ reviewed: summary.reviewed, fixture, startedAt: at, finishedAt: new Date().toISOString(),
  command: [process.execPath, ...args], cwd: main, cliExitCode: result.status, signal: result.signal, error: result.error?.message ?? null,
  mode: 'Separate empty-state diagnostic with V8 CPU sampling and real module operation wrappers; excluded from speed acceptance series' }, null, 2) + '\n');
console.log(JSON.stringify({ base, cliExitCode: result.status }));
assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), []);
assert.ok(fs.existsSync(countsFile));
