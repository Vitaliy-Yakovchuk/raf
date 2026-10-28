import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { copyProductionQaDependencies } from '../test/production-qa-fixture.ts';
import { eventually } from '../test/production-fixture.ts';
async function channelFixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "raf-launcher-"));
  const source = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
  const A = join(root, "raf-main-a");
  const B = join(root, "raf-main-b");
  const home = join(root, "qa-home");
  const work = join(root, "work");
  const environment = { ...process.env, HOME: home, RAF_QA_HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args: string[]) => execFileSync("git", ["-C", A, ...args], { env: environment, encoding: "utf8" }).trim();
  try {
    for (const directory of [join(root, "conf"), join(A, "bin"), home, work]) await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(join(A, "bin/raf.ts"), `import{writeFileSync}from'node:fs';writeFileSync(process.env.CHANNEL_READY,String(process.pid));const timer=setInterval(()=>{},60000);process.on('SIGUSR1',()=>{clearInterval(timer);process.exitCode=0;});`);
    git("init", "-b", "main");
    git("add", "bin");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "published fixture");
    execFileSync("git", ["-C", root, "init", "-b", "main"], { env: environment });
    execFileSync("git", ["-C", root, "-c", "protocol.file.allow=always", "submodule", "add", "--name", "raf-main", "./raf-main-a", "raf-main-a"], { env: environment });
    execFileSync("git", ["-C", root, "submodule", "absorbgitdirs"], { env: environment });
    git("worktree", "add", "-b", "develop", join(root, "raf-develop"), "HEAD");
    git("worktree", "add", "--detach", B, "HEAD");
    await fs.symlink(A, join(root, "raf-main"));
    await fs.writeFile(join(root, "conf/projects.json"), JSON.stringify({ version: 1, profiles: { fixture: { production: "main", environments: { runtime: "main" } } }, projects: { raf: { profile: "fixture", path: "raf-main", branchPaths: { main: "raf-main", develop: "raf-develop" }, mainCopies: ["raf-main-a", "raf-main-b"] } } }));
    const raf = JSON.parse(await fs.readFile(new URL('../../conf/raf.json',import.meta.url),'utf8'));
    await fs.writeFile(join(root, "conf/raf.json"), JSON.stringify({...raf,state:{...raf.state,fileName:'state.sqlite'}}));
    const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
    for (const directory of [A, join(root, "raf-develop")]) {
      await fs.cp(join(source, "src"), join(directory, "src"), { recursive: true });
      await fs.cp(join(source, "scripts"), join(directory, "scripts"), { recursive: true });
      await fs.writeFile(join(directory, "package.json"), '{"type":"module"}\n');
    }
    await fs.copyFile(join(source, "bin/service.ts"), join(A, "bin/service.ts"));
    git("add", "--", "src", "bin", "scripts", "package.json");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Complete published runtime fixture");
    execFileSync("git", ["-C", root, "add", "--", "raf-main-a", ".gitmodules"], { env: environment });
    const { ensureProductionMainStore } = await import("../src/main-production-store.ts");
    await ensureProductionMainStore({ root });
    copyProductionQaDependencies(A);
    copyProductionQaDependencies(join(root, "raf-develop"));
    return { root, A, B, home, work, source: join(root, "raf-develop"), git, common, environment };
  } catch (error) { await fs.rm(root, { recursive: true, force: true }); throw error; }
}


const f = await channelFixture();
let child;
try {
  const ready = join(f.root, 'channel-ready');
  const origin = join(f.source, 'src/main-switch-agent-launcher.ts');
  const issued = `node ${join(f.source, 'bin/raf.ts')} agent ps`;
  const input = { orchestratorRoot:f.root,homeDirectory:f.home,cwd:f.work,runId:'fixture-run',agentId:'fixture-agent',issuedCommands:[issued],command:issued };
  const script = `
const {runPublishedAgentChannel}=await import(${JSON.stringify(pathToFileURL(origin).href)});
const {openStateStore}=await import(${JSON.stringify(pathToFileURL(join(f.source,'src/state-store.ts')).href)});
const {productionStateContext}=await import(${JSON.stringify(pathToFileURL(join(f.source,'src/state-migration-guard.ts')).href)});
const {executeCommand,readMachineBootIdentity}=await import(${JSON.stringify(pathToFileURL(join(f.source,'src/os-runtime.ts')).href)});
const input=${JSON.stringify(input)};
const context=productionStateContext(input.orchestratorRoot,${JSON.stringify(origin)},input.homeDirectory,'hook');
const store=openStateStore(context.statePath,{context});
const scan=await executeCommand({executable:'ps',args:['-ww','-axo','pid=,lstart=,command=']});
const row=scan.stdout.split('\\n').map(line=>/^\\s*(\\d+)\\s+(\\w{3}\\s+\\w{3}\\s+\\d+\\s+\\d{2}:\\d{2}:\\d{2}\\s+\\d{4})\\s+(.+)$/.exec(line)).find(row=>row&&Number(row[1])===process.pid);
const boot=await readMachineBootIdentity();
store.sessionRepository.transaction(tx=>tx.putSession({runId:input.runId,addressId:input.agentId,revision:1,state:'running',activity:{cwd:input.cwd,type:'implement',project:'raf',features:[],phase:'implement'},launchContext:{assignment:{changes:[]},selection:{runner:'codex',model:'fixture',effort:'fixture',reason:'fixture'},briefPath:'fixture',reportPath:'fixture'},process:{pid:process.pid,startedAt:new Date(row[2]).toISOString(),runner:'codex',runnerSessionId:'fixture-native',tmuxSession:'fixture',evidence:{command:row[3],...boot}}}));
store.close();
process.exitCode=await runPublishedAgentChannel(input);
`;
  child = spawn(process.execPath,['--input-type=module','-e',script],{cwd:f.work,env:{...f.environment,CHANNEL_READY:ready},stdio:['ignore','pipe','pipe']});
  let stderr='',stdout=''; child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);
  const completion=new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject)});
  const workerPid=Number(await eventually(()=>fs.readFile(ready,'utf8').catch(()=>{if(child.exitCode!==null)throw new Error(stderr);return null;}),Boolean,'published child readiness'));
  const sample=async()=>{const raw=await fs.readFile('/proc/'+child.pid+'/stat','utf8');const fields=raw.slice(raw.lastIndexOf(')')+2).split(' ');return{at:performance.now(),user:Number(fields[11]),system:Number(fields[12]),start:fields[19]}};
  const before=await sample();console.log(JSON.stringify({stage:'waiting',pid:child.pid,workerPid}));
  await new Promise(resolve=>setTimeout(resolve,60000));const after=await sample();
  assert.equal(before.start,after.start);
  process.kill(workerPid,'SIGUSR1');const cliExitCode=await completion;
  const hz=Number(execFileSync('getconf',['CLK_TCK'],{encoding:'utf8'}).trim());
  const measurement={before,after,hz,wallMs:after.at-before.at,cpuMs:(after.user-before.user+after.system-before.system)*1000/hz,cliExitCode,stdout,stderr};
  await fs.writeFile('evidence/fix-raf-waiting-cli-cpu/'+process.argv[2]+'-published-channel-cpu.json',JSON.stringify(measurement,null,2)+'\n');console.log(JSON.stringify(measurement));assert.equal(cliExitCode,0,stderr);
} finally { if(child?.exitCode===null)child.kill();await fs.rm(f.root,{recursive:true,force:true}); }
