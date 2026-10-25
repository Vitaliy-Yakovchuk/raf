import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { until, type AgentRunFixture } from './agent-run-fixture.ts';
const exec = promisify(execFile);
export async function publicAdapterMain(f: AgentRunFixture, cfg: any, budget: number) {
  const directory = join(f.directory, 'public-main');
  await fs.mkdir(directory, { recursive: true });
  const worker = join(directory, 'main.mjs');
  await fs.writeFile(worker, String.raw`
import fs from 'node:fs';
import {execFile} from 'node:child_process';
const c=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const directory=process.argv[3], budget=Number(process.argv[4]);
const run=args=>new Promise(resolve=>execFile(process.execPath,[c.sourceRoot+'/bin/raf.ts',...args],{cwd:c.sourceRoot,env:process.env,encoding:'utf8',timeout:budget,maxBuffer:64*1024*1024},(error,stdout,stderr)=>resolve({exitCode:error?(typeof error.code==='number'?error.code:null):0,signal:error?.signal??null,error:error?.message,stdout,stderr})));
const atomic=(p,v)=>{fs.writeFileSync(p+'.part',JSON.stringify(v));fs.renameSync(p+'.part',p);};
atomic(directory+'/attached.json',await run(['main','attach']));
process.stdin.resume();
setInterval(()=>{for(const name of fs.readdirSync(directory).filter(n=>n.endsWith('.request'))){const p=directory+'/'+name;const args=JSON.parse(fs.readFileSync(p));fs.renameSync(p,p+'.running');run(args).then(result=>{atomic(p+'.result',result);fs.renameSync(p+'.running',p+'.done');});}},25);
`);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: cfg.home, RAF_QA_HOME: cfg.home, RAF_ORCHESTRATOR_ROOT: cfg.root, TMPDIR: f.directory, TMUX_TMPDIR: f.directory, PATH: join(f.directory, 'bin') + ':' + process.env.PATH, RAF_AGENT_RUN_FIXTURE: join(f.directory, 'fixture.json') };
  delete env.TMUX;
  delete env.TMUX_PANE;
  await exec(cfg.tmux, ['-L', cfg.tmuxLabel, '-f', '/dev/null', 'new-session', '-d', '-s', 'adapter-main', process.execPath, worker, join(f.directory, 'fixture.json'), directory, String(budget)], { env });
  const attached = await until(async () => fs.readFile(join(directory, 'attached.json'), 'utf8').then(JSON.parse, () => null), Boolean, 'Real private main attach', budget);
  assert.equal(attached.exitCode, 0, JSON.stringify(attached));
  const command = async (args: string[]) => {
    const p = join(directory, randomUUID() + '.request');
    await fs.writeFile(p + '.part', JSON.stringify(args));
    await fs.rename(p + '.part', p);
    const result = await until(async () => fs.readFile(p + '.result', 'utf8').then(JSON.parse, () => null), Boolean, 'Single public main CLI request', budget);
    assert.equal(result.signal, null, JSON.stringify(result));
    return { exitCode: result.exitCode, result, stderr: '' };
  };
  return { command, attached, directory };
}
