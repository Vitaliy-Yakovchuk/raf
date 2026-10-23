import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import type { HotfixHost, HotfixWorkspace } from "../src/hotfix-worktree.ts";
import { commitHotfix, prepareHotfixWorktree } from "../src/hotfix-worktree.ts";
import { verifyHotfixCandidate, type VerifiedHotfix } from "../src/hotfix-activation.ts";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const confSource = process.env.HOTFIX_FIXTURE_CONF ?? join(dirname(source), "conf");
export const timeoutMs = JSON.parse(readFileSync(join(confSource, "flow.json"), "utf8")).unitTests.timeoutMs as number;

export function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function filesUnder(root: string): Record<string, string> {
  if (!existsSync(root)) return {};
  const result: Record<string, string> = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) for (const [name, hash] of Object.entries(filesUnder(path))) result[join(entry.name, name)] = hash;
    else if (entry.isFile()) result[entry.name] = sha(path);
    else result[entry.name] = `non-regular:${lstatSync(path).ino}`;
  }
  return result;
}

export async function until<T>(read: () => T | undefined, budget: number, poll: number): Promise<T> {
  const end = Date.now() + budget;
  do {
    const value = read();
    if (value !== undefined) return value;
    await delay(poll);
  } while (Date.now() < end);
  throw new Error("Fixture readiness deadline exceeded");
}

export function command(executable: string, args: readonly string[], cwd: string, environment: Record<string, string>): { code: number; stdout: string; stderr: string } {
  try {
    return { code: 0, stdout: execFileSync(executable, [...args], { cwd, env: environment, encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }), stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string; code?: string };
    if (e.status === undefined || e.status === null) throw error;
    return { code: e.status, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
  }
}

export function git(cwd: string, environment: Record<string, string>, ...args: string[]): string {
  const result = command("git", ["-C", cwd, ...args], cwd, environment);
  assert.equal(result.code, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

export async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "raf-hotfix-z329-"));
  const home = join(root, "qa-home");
  const workingHome = join(root, "working-home");
  const main = join(root, "raf-main");
  const binary = join(root, "fixture-bin");
  for (const path of [home, workingHome, binary, join(root, "conf")]) mkdirSync(path, { recursive: true });
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    RAF_QA_HOME: home,
    HOTFIX_FIXTURE_CONF: join(root, "conf"),
    XDG_CONFIG_HOME: join(home, ".config"),
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    TMUX_TMPDIR: join(home, "tmux"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_GLOBAL: join(root, "fixture.gitconfig"),
    GIT_AUTHOR_NAME: "Hotfix fixture",
    GIT_AUTHOR_EMAIL: "hotfix@example.invalid",
    GIT_COMMITTER_NAME: "Hotfix fixture",
    GIT_COMMITTER_EMAIL: "hotfix@example.invalid",
    TZ: "UTC",
    LANG: "C.UTF-8"
  };
  writeFileSync(environment.GIT_CONFIG_GLOBAL, "");
  mkdirSync(environment.TMUX_TMPDIR, { recursive: true });
  cpSync(confSource, join(root, "conf"), { recursive: true });
  const projectsPath = join(root, "conf", "projects.json");
  const projects = JSON.parse(readFileSync(projectsPath, "utf8"));
  projects.projects = { raf: projects.projects.raf, orchestrator: projects.projects.orchestrator };
  projects.projects.raf.branchPaths = { main: "raf-main", develop: "raf-develop", hotfix: "raf-hotfix" };
  writeFileSync(projectsPath, JSON.stringify(projects));
  const config = JSON.parse(readFileSync(join(root, "conf", "raf.json"), "utf8"));
  const native = config.runnerProtocols.find((p: { runner: string }) => p.runner === "codex");
  const budget = native.timeouts.transitionMs as number;
  const poll = native.timeouts.pollMs as number;
  const realCodex = execFileSync("which", ["codex"], { env: environment, encoding: "utf8" }).trim();
  git(root, environment, "init", "-b", "main");
  mkdirSync(main);
  for (const name of ["src", "bin", "scripts", "dist", "test", "package.json", "package-lock.json", ".gitignore"]) {
    if (existsSync(join(source, name))) cpSync(join(source, name), join(main, name), { recursive: true });
  }
  if (existsSync(join(source, "node_modules"))) cpSync(join(source, "node_modules"), join(main, "node_modules"), { recursive: true, dereference: true });
  mkdirSync(join(main, "hotfix-fixture"));
  writeFileSync(join(main, "hotfix-fixture", "a.mjs"), 'export const marker = "old";\n');
  writeFileSync(join(main, "hotfix-fixture", "b.mjs"), 'export const marker = "old";\n');
  git(main, environment, "init", "-b", "main");
  git(main, environment, "add", "src", "bin", "scripts", "test", "package.json", "package-lock.json", ".gitignore", "hotfix-fixture");
  git(main, environment, "add", "-f", "dist");
  git(main, environment, "commit", "-m", "isolated raf baseline");
  git(root, environment, "-c", "protocol.file.allow=always", "submodule", "add", "./raf-main", "raf-main");
  git(root, environment, "submodule", "absorbgitdirs");
  git(root, environment, "add", ".gitmodules", "raf-main", "conf");
  git(root, environment, "commit", "-m", "isolated orchestrator baseline");
  const baseCommit = git(main, environment, "rev-parse", "HEAD");
  git(main, environment, "worktree", "add", "-b", "develop", join(root, "raf-develop"), baseCommit);
  const hotfix = join(root, "raf-hotfix");
  git(main, environment, "worktree", "add", "-b", "hotfix", hotfix, baseCommit);
  const change = join(root, "openspec", "changes", "hotfix-fixture");
  mkdirSync(change, { recursive: true });
  writeFileSync(join(change, "proposal.md"), "## Why\nIsolated hotfix fixture.\n\n## What Changes\nTemporary markers.\n\n## Impact\nFixture only.\n");
  writeFileSync(join(change, "tasks.md"), "- [ ] 1.1 Update fixture markers\n- [ ] 1.2 Independent fixture markers\n");
  writeFileSync(join(change, ".openspec.yaml"), "schema: spec-driven\nskip_specs: true\n");
  mkdirSync(environment.CODEX_HOME, { recursive: true });
  mkdirSync(environment.CLAUDE_CONFIG_DIR, { recursive: true });
  writeFileSync(join(environment.CODEX_HOME, "config.toml"), "");
  writeFileSync(join(home, ".claude.json"), "{}");
  const runnerLog = join(root, "runner.jsonl");
  const inbox = join(root, "main-inbox.txt");
  const queue = join(root, "main-request.json");
  const response = join(root, "main-response.json");
  const ready = join(root, "main-ready");
  for (const runner of ["codex", "claude"]) {
    const protocol = config.runnerProtocols.find((entry: { runner: string }) => entry.runner === runner);
    const screen = {
      runner,
      version: runner === "codex" ? `codex-cli ${protocol.version}` : `${protocol.version} (Claude Code)`,
      trust: protocol.markers.workspace_trust_required[0] + "\n" + protocol.navigation.find((entry: { state: string }) => entry.state === "workspace_trust_required").match,
      ready: protocol.markers.ready[0],
      composer: runner === "codex" ? "› " : "$ "
    };
    const runnerSource = String.raw`#!/usr/bin/env node
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
if(process.argv.includes('app-server')) {
 const child=spawn(${JSON.stringify(realCodex)},process.argv.slice(2),{stdio:'inherit'});
 child.on('error',error=>{process.stderr.write(error.message);process.exit(1);});
 child.on('exit',(code,signal)=>{if(signal)process.kill(process.pid,signal);else process.exit(code??1);});
} else {
const screen=${JSON.stringify(screen)};
if(process.argv.includes('--version')) { console.log(screen.version); process.exit(0); }
const log = value => fs.appendFileSync(${JSON.stringify(runnerLog)}, JSON.stringify({...value,runner:screen.runner,pid:process.pid})+'\n');
const assigned=process.argv.indexOf('--session-id');
const id = assigned>=0 ? process.argv[assigned+1] : randomUUID();
log({kind:'start',pid:process.pid,cwd:process.cwd(),argv:process.argv.slice(2),home:process.env.HOME});
process.stdin.setRawMode?.(true); process.stdin.resume();
const show=text=>process.stdout.write('\x1b[2J\x1b[H'+text);
process.stdout.write('\x1b[?2004h');show(screen.trust+'\n');
let trusted=false, trustInput='', buffer='',pending=false;
process.stdin.on('data', data => {
 const text=data.toString(); log({kind:'input',text});
 if(!trusted) {
   trustInput+=text;
   if(/[\r\n]/u.test(text)) { trusted=true;buffer='';log({kind:'trusted',keys:trustInput});show(screen.ready+'\n'+screen.composer); }
   return;
 }
 if(pending && /[\r\n]/u.test(text)) { show((screen.runner==='codex' ? '• Working (esc to interrupt)' : 'Working… esc to interrupt')+'\n'+screen.composer); return; }
 buffer+=text;
 if(buffer.includes('/exit')) process.exit(0);
 if(buffer.includes('/status') && /[\r\n]/u.test(text)) { show((screen.runner==='codex'?'Session: ':'Session ID: ')+id+'\n'+screen.ready+'\n'+screen.composer); buffer=''; return; }
 if(buffer.includes('\x1b[201~')) {
   const body=buffer.split('\x1b[200~').at(-1).split('\x1b[201~')[0];
   log({kind:'brief',text:body});pending=true;buffer='';
   const pasted=screen.runner==='codex' ? '[Pasted Content '+body.length+' chars]' : '[Pasted text #1 +'+(body.match(/\n/g)||[]).length+' lines]';
   show(screen.composer+pasted+'\n'+screen.ready);return;
 }
 process.stdout.write(text);
});
}
`;
    writeFileSync(join(binary, runner), runnerSource, { mode: 0o755 });
  }
  const pane = join(root, "main-pane.mjs");
  writeFileSync(pane, `import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const cli=${JSON.stringify(join(main, "bin", "raf.ts"))};
process.stdin.setRawMode?.(true); process.stdin.resume();
process.stdin.on('data', data=>fs.appendFileSync(${JSON.stringify(inbox)},data));
try {execFileSync(process.execPath,[cli,'main','attach'],{stdio:['ignore','pipe','pipe'],env:process.env,timeout:${JSON.stringify(timeoutMs)}}); fs.writeFileSync(${JSON.stringify(ready)},'ready');}
catch(error){fs.writeFileSync(${JSON.stringify(ready)},'ERROR '+error.stderr);process.exit(1);}
setInterval(()=>{if(!fs.existsSync(${JSON.stringify(queue)}))return;
 const request=JSON.parse(fs.readFileSync(${JSON.stringify(queue)},'utf8'));fs.unlinkSync(${JSON.stringify(queue)});
 let result;try{result={code:0,stdout:execFileSync(process.execPath,[cli,...request],{env:process.env,encoding:'utf8',timeout:${JSON.stringify(timeoutMs)},maxBuffer:16777216}),stderr:''};}
 catch(error){result={code:error.status??1,stdout:String(error.stdout??''),stderr:String(error.stderr??'')};}
 fs.writeFileSync(${JSON.stringify(response)},JSON.stringify(result));
},${JSON.stringify(poll)});
`);
  const socket = join(home, "main.sock");
  const childProcesses = new Set<ChildProcess>();
  t.after(async () => {
    command(process.execPath, [join(main, "bin", "raf.ts"), "service", "stop"], main, environment);
    await Promise.all([...childProcesses].map(child => new Promise<void>(resolveExit => {
      if (child.exitCode !== null || child.signalCode !== null) { resolveExit(); return; }
      child.once("exit", () => resolveExit());
      child.kill("SIGKILL");
    })));
    command("tmux", ["-S", socket, "kill-server"], root, environment);
    command("tmux", ["-S", join(home, ".raf", "tmp", "tmux", "server.sock"), "kill-server"], root, environment);
    rmSync(root, { recursive: true, force: true });
  });
  const host: HotfixHost = { orchestratorRoot: root, qaHome: home, environment: { ...environment, PATH: `${binary}:${environment.PATH}` }, sandboxExecutable: realCodex };
  const osHomePreload = join(root, "os-home.mjs");
  writeFileSync(osHomePreload, `import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';const original=os.userInfo;os.userInfo=(options)=>({...original(options),homedir:${JSON.stringify(workingHome)}});syncBuiltinESMExports();`);
  async function startMain() {
    const result = command("tmux", ["-S", socket, "new-session", "-d", "-s", "hotfix-fixture-main", "-x", "200", "-y", "60", process.execPath, pane], root, environment);
    assert.equal(result.code, 0, result.stderr);
    const state = await until(() => existsSync(ready) ? readFileSync(ready, "utf8") : undefined, budget, poll);
    assert.equal(state, "ready", state);
  }
  async function mainCommand(args: readonly string[]) {
    assert.equal(existsSync(queue), false, "Fixture command queue is serialized");
    rmSync(response, { force: true });
    writeFileSync(queue, JSON.stringify(args));
    return until(() => {
      if (!existsSync(response)) return undefined;
      try { return JSON.parse(readFileSync(response, "utf8")) as { code: number; stdout: string; stderr: string }; } catch { return undefined; }
    }, timeoutMs, poll);
  }
  function liveIdentity() {
    const gitDirectory = git(main, environment, "rev-parse", "--absolute-git-dir");
    return {
      head: git(main, environment, "rev-parse", "HEAD"),
      ref: git(main, environment, "rev-parse", "refs/heads/main"),
      index: sha(join(gitDirectory, "index")),
      source: filesUnder(join(main, "src")),
      artifacts: filesUnder(join(main, "dist")),
      markers: filesUnder(join(main, "hotfix-fixture")),
      config: filesUnder(join(root, "conf")),
      gitConfig: sha(join(root, ".git", "modules", "raf-main", "config"))
    };
  }
  function cli(cwd: string, args: readonly string[], production = false, extra: Record<string, string> = {}) {
    const env = { ...environment, ...extra, HOME: production ? workingHome : home };
    if (production) delete (env as Record<string, string | undefined>).RAF_QA_HOME;
    return command(process.execPath, ["--import", osHomePreload, join(cwd, "bin", "raf.ts"), ...args], cwd, env);
  }
  async function candidate(marker = "new") {
    const workspace = await prepareHotfixWorktree(host, randomUUID());
    for (const name of ["a.mjs", "b.mjs"]) writeFileSync(join(workspace.cwd, "hotfix-fixture", name), `export const marker = ${JSON.stringify(marker)};\n`);
    const committed = await commitHotfix(host, { workspace, paths: ["hotfix-fixture/a.mjs", "hotfix-fixture/b.mjs"], message: `fixture ${marker}` });
    return { workspace, committed };
  }
  async function verified(marker = "new"): Promise<VerifiedHotfix> {
    const { workspace } = await candidate(marker);
    return verifyHotfixCandidate(host, {
      workspace,
      regression: { executable: process.execPath, args: ["--test", "--test-isolation=none", "--test-name-pattern", "^\\[hotfix-pure\\]", "test/hotfix-worktree.test.ts"] },
      mainAddress: "main",
      message: `hotfix-smoke-${randomUUID()}`
    });
  }
  function forkModule(body: string, payload: unknown) {
    const script = join(root, `child-${randomUUID()}.mjs`);
    writeFileSync(script, body);
    const child = spawn(process.execPath, [script], { cwd: root, env: { ...environment, HOTFIX_FIXTURE_PAYLOAD: JSON.stringify(payload) }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    childProcesses.add(child);
    return child;
  }
  return { root, home, workingHome, main, hotfix, host, environment, baseCommit, runnerLog, inbox, budget, poll, socket, startMain, mainCommand, liveIdentity, cli, candidate, verified, forkModule, osHomePreload };
}

export async function childMessage(child: ChildProcess, predicate: (value: any) => boolean, budget: number): Promise<any> {
  return new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => done(new Error("Child checkpoint deadline exceeded")), budget);
    function done(error?: Error, value?: unknown) {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) reject(error); else resolveMessage(value);
    }
    function onMessage(value: unknown) { if (predicate(value)) done(undefined, value); }
    function onExit(code: number | null, signal: string | null) { done(new Error(`Child exited before checkpoint: ${code}/${signal}`)); }
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

export function assertWorkspace(workspace: HotfixWorkspace, f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal(workspace.project, "raf");
  assert.equal(workspace.targetBranch, "main");
  assert.equal(workspace.baseCommit, f.baseCommit);
  assert.equal(realpathSync(workspace.cwd), workspace.cwd);
  assert.equal(workspace.cwd, f.hotfix);
  assert.notEqual(workspace.cwd, f.main);
  assert.equal(git(workspace.cwd, f.environment, "rev-parse", "--show-toplevel"), workspace.cwd);
  git(workspace.cwd, f.environment, "merge-base", "--is-ancestor", workspace.baseCommit, "HEAD");
  assert.equal(git(workspace.cwd, f.environment, "rev-parse", "--abbrev-ref", "HEAD"), "hotfix");
  assert.equal(git(workspace.cwd, f.environment, "rev-parse", "--absolute-git-dir"), workspace.gitDirectory);
  assert.equal(realpathSync(git(workspace.cwd, f.environment, "rev-parse", "--path-format=absolute", "--git-common-dir")), realpathSync(workspace.commonDirectory));
  assert.equal(realpathSync(workspace.commonDirectory), realpathSync(git(f.main, f.environment, "rev-parse", "--path-format=absolute", "--git-common-dir")));
}
