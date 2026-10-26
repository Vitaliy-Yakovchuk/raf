import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { cleanupHotfixWorktree, commitHotfix, launchHotfix, prepareHotfixWorktree, runHotfixSandboxCommand, type HotfixWorkspace } from "../src/hotfix-worktree.ts";
import { resolveStateContext } from "../src/state-migration-guard.ts";
import { assertWorkspace, filesUnder, fixture, git, sha, timeoutMs, until } from "./hotfix-fixture.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;
const options = { timeout: timeoutMs, concurrency: false };
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const head = (f: Fixture, cwd = f.hotfix) => git(cwd, f.environment, "rev-parse", "HEAD");
const index = (f: Fixture, cwd = f.hotfix) => git(cwd, f.environment, "rev-parse", "--path-format=absolute", "--git-path", "index");
const records = (f: Fixture) => existsSync(f.runnerLog) ? readFileSync(f.runnerLog, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];

function live(f: Fixture) {
  const develop = join(f.root, "raf-develop");
  return {
    main: f.liveIdentity(),
    mainGit: git(f.main, f.environment, "rev-parse", "--absolute-git-dir"),
    mainTop: realpathSync(git(f.main, f.environment, "rev-parse", "--show-toplevel")),
    developHead: head(f, develop),
    developIndex: sha(index(f, develop)),
    developSource: filesUnder(join(develop, "src")),
    gitlink: git(f.root, f.environment, "ls-files", "--stage", "raf-main"),
    parentHead: head(f, f.root),
    parentIndex: sha(index(f, f.root))
  };
}

function shared(f: Fixture, a: HotfixWorkspace, b: HotfixWorkspace) {
  assertWorkspace(a, f);
  assertWorkspace(b, f);
  assert.equal(a.cwd, b.cwd);
  assert.equal(a.gitDirectory, b.gitDirectory);
  assert.equal(a.commonDirectory, b.commonDirectory);
  assert.notEqual(a.runId, b.runId);
  assert.equal(index(f), join(a.gitDirectory, "index"));
  assert.equal(git(f.hotfix, f.environment, "symbolic-ref", "HEAD"), "refs/heads/hotfix");
  const registered = git(f.main, f.environment, "worktree", "list", "--porcelain").split("\n\n").filter(entry => entry.includes("branch refs/heads/hotfix"));
  assert.equal(registered.length, 1);
  assert.match(registered[0], new RegExp(`^worktree ${f.hotfix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
}

function ownCommit(f: Fixture, cwd: string, path: string, text: string) {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), text);
  git(cwd, f.environment, "add", "--", path);
  git(cwd, f.environment, "commit", "-m", `fixture ${path}`, "--", path);
  return head(f, cwd);
}

function failureCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(`${(error as Error & { code?: string }).code ?? ""} ${error.message}`, new RegExp(code));
    return true;
  };
}

function fields(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([name, child]) => [...(name === key ? [child] : []), ...fields(child, key)]);
}

test("[hotfix-pure] registered hotfix is one shared cwd, branch and index for concurrent runs", options, async t => {
  const f = await fixture(t);
  const before = live(f);
  const worktrees = git(f.main, f.environment, "worktree", "list", "--porcelain");
  const [a, b] = await Promise.all([prepareHotfixWorktree(f.host, randomUUID()), prepareHotfixWorktree(f.host, randomUUID())]);
  shared(f, a, b);
  assert.equal(git(f.main, f.environment, "worktree", "list", "--porcelain"), worktrees);
  assert.deepEqual(live(f), before);
  for (const path of [...Object.keys(filesUnder(join(f.hotfix, "src"))).map(path => "src/"+path), ...Object.keys(filesUnder(join(f.hotfix, "dist"))).map(path => "dist/"+path)]) {
    const hot = statSync(join(f.hotfix, path));
    const main = statSync(join(f.main, path));
    assert.ok(hot.dev !== main.dev || hot.ino !== main.ino, `${path} shares a mutable inode with live`);
  }
});

test("[hotfix-pure] each own commit advances the common HEAD without touching live refs or indexes", options, async t => {
  const f = await fixture(t);
  const a = await prepareHotfixWorktree(f.host, randomUUID());
  const b = await prepareHotfixWorktree(f.host, randomUUID());
  const before = live(f);
  writeFileSync(join(a.cwd, "hotfix-fixture/a.mjs"), 'export const marker = "agent-a";\n');
  const first = await commitHotfix(f.host, { workspace: a, paths: ["hotfix-fixture/a.mjs"], message: "agent a only" });
  assert.equal(head(f, b.cwd), first.commit);
  assert.equal(git(f.hotfix, f.environment, "diff-tree", "--no-commit-id", "--name-only", "-r", first.commit), "hotfix-fixture/a.mjs");
  writeFileSync(join(b.cwd, "hotfix-fixture/b.mjs"), 'export const marker = "agent-b";\n');
  const second = await commitHotfix(f.host, { workspace: b, paths: ["hotfix-fixture/b.mjs"], message: "agent b only" });
  assert.equal(head(f, a.cwd), second.commit);
  assert.equal(git(f.hotfix, f.environment, "rev-parse", `${second.commit}^`), first.commit);
  assert.equal(git(f.hotfix, f.environment, "diff-tree", "--no-commit-id", "--name-only", "-r", second.commit), "hotfix-fixture/b.mjs");
  assert.deepEqual(live(f), before);
});

test("[hotfix-pure] refresh fast-forwards a clean hotfix to current main", options, async t => {
  const f = await fixture(t);
  const next = ownCommit(f, f.main, "hotfix-fixture/main-only.txt", "new main\n");
  const before = live(f);
  const workspace = await prepareHotfixWorktree(f.host, randomUUID());
  assert.equal(workspace.cwd, f.hotfix);
  assert.equal(head(f), next);
  assert.equal(readFileSync(join(f.hotfix, "hotfix-fixture/main-only.txt"), "utf8"), "new main\n");
  assert.deepEqual(live(f), before);
});

test("[hotfix-pure] refresh merges current main while retaining unpublished hotfix commits", options, async t => {
  const f = await fixture(t);
  const original = ownCommit(f, f.hotfix, "hotfix-fixture/agent.txt", "unpublished\n");
  const nextMain = ownCommit(f, f.main, "hotfix-fixture/main.txt", "main advance\n");
  const before = live(f);
  await prepareHotfixWorktree(f.host, randomUUID());
  git(f.hotfix, f.environment, "merge-base", "--is-ancestor", original, "HEAD");
  git(f.hotfix, f.environment, "merge-base", "--is-ancestor", nextMain, "HEAD");
  assert.equal(readFileSync(join(f.hotfix, "hotfix-fixture/agent.txt"), "utf8"), "unpublished\n");
  assert.equal(readFileSync(join(f.hotfix, "hotfix-fixture/main.txt"), "utf8"), "main advance\n");
  assert.deepEqual(live(f), before);
});

test("[hotfix-pure] included main is a no-op preserving foreign tracked, staged and untracked edits", options, async t => {
  const f = await fixture(t);
  const a = await prepareHotfixWorktree(f.host, randomUUID());
  ownCommit(f, f.hotfix, "hotfix-fixture/local.txt", "existing commit\n");
  writeFileSync(join(f.hotfix, "hotfix-fixture/a.mjs"), "foreign staged\n");
  git(f.hotfix, f.environment, "add", "--", "hotfix-fixture/a.mjs");
  writeFileSync(join(f.hotfix, "hotfix-fixture/b.mjs"), "foreign unstaged\n");
  writeFileSync(join(f.hotfix, "foreign-untracked.txt"), "preserve\n");
  const before = { head: head(f), index: sha(index(f)), files: filesUnder(join(f.hotfix, "hotfix-fixture")), untracked: sha(join(f.hotfix, "foreign-untracked.txt")), live: live(f) };
  const b = await prepareHotfixWorktree(f.host, randomUUID());
  shared(f, a, b);
  assert.deepEqual({ head: head(f), index: sha(index(f)), files: filesUnder(join(f.hotfix, "hotfix-fixture")), untracked: sha(join(f.hotfix, "foreign-untracked.txt")), live: live(f) }, before);
});

test("[hotfix-pure] conflicting refresh stays open and retains both histories and unrelated work", options, async t => {
  const f = await fixture(t);
  const hot = ownCommit(f, f.hotfix, "hotfix-fixture/a.mjs", "hotfix side\n");
  const main = ownCommit(f, f.main, "hotfix-fixture/a.mjs", "main side\n");
  const untouched = sha(join(f.hotfix, "hotfix-fixture/b.mjs"));
  const before = live(f);
  await assert.rejects(prepareHotfixWorktree(f.host, randomUUID()));
  assert.equal(head(f), hot);
  assert.equal(head(f, f.main), main);
  assert.equal(sha(join(f.hotfix, "hotfix-fixture/b.mjs")), untouched);
  assert.equal(git(f.hotfix, f.environment, "stash", "list"), "");
  assert.deepEqual(live(f), before);
});

for (const problem of ["missing-registration", "missing-directory", "symlink"] as const) {
  test(`[hotfix-identity] ${problem} is refused without fallback or runner launch`, options, async t => {
    const f = await fixture(t);
    let expected = "BRANCH_MISMATCH";
    if (problem === "missing-registration") {
      const path = join(f.root, "conf/projects.json");
      const conf = json(path);
      delete conf.projects.raf.branchPaths.hotfix;
      writeFileSync(path, JSON.stringify(conf));
      expected = "UNKNOWN_BRANCH";
    } else if (problem === "missing-directory") {
      renameSync(f.hotfix, f.hotfix+"-missing");
      expected = "WORKSPACE_UNAVAILABLE";
    } else {
      renameSync(f.hotfix, f.hotfix+"-original");
      symlinkSync(f.hotfix+"-original", f.hotfix);
    }
    const before = live(f);
    const worktrees = git(f.main, f.environment, "worktree", "list", "--porcelain");
    const runners = records(f);
    await assert.rejects(prepareHotfixWorktree(f.host, randomUUID()), failureCode(expected));
    await assert.rejects(launchHotfix(f.host, { runId: randomUUID(), addressId: "refused", features: ["hotfix-fixture"], tasks: ["hotfix-fixture:1.1"], runner: "codex", origin: "agent-run" }), failureCode(expected));
    assert.deepEqual(records(f), runners);
    assert.equal(git(f.main, f.environment, "worktree", "list", "--porcelain"), worktrees);
    assert.deepEqual(live(f), before);
  });
}

for (const origin of ["agent-run", "direct-main"] as const) for (const runner of ["codex", "claude"] as const) {
  test(`[hotfix-launch] ${origin}/${runner} preserves the registered route through worker, trust and brief`, options, async t => {
    const f = await fixture(t);
    await f.startMain();
    const before = live(f);
    const userConfig = { codex: sha(join(f.home, ".codex/config.toml")), claude: sha(join(f.home, ".claude.json")) };
    const runs = [];
    for (const task of ["1.1", "1.2"]) runs.push(await launchHotfix(f.host, { runId: randomUUID(), addressId: `hotfix-${runner}-${task}`, features: ["hotfix-fixture"], tasks: [`hotfix-fixture:${task}`], runner, origin }));
    const [a, b] = runs;
    shared(f, a.workspace, b.workspace);
    assert.notEqual(a.runId, b.runId);
    assert.notEqual(a.runnerSessionId, b.runnerSessionId);
    assert.notEqual(a.pid, b.pid);
    assert.notEqual(dirname(a.reportPath), dirname(b.reportPath));
    assert.notEqual(a.reportPath, b.reportPath);
    for (const run of runs) {
      const task = json(run.taskContextPath);
      assert.equal(task.runId, run.runId);
      assert.equal(task.context.branch, "hotfix");
      assert.equal(task.workspace.cwd, f.hotfix);
      for (const path of [run.taskContextPath, run.workerContextPath, run.invocationPath]) {
        const document = json(path);
        if (path === run.invocationPath) {
          assert.ok(fields(document, "args").flat().includes(f.hotfix), "invocation lost hotfix write scope");
        } else {
          assert.ok(fields(document, "cwd").includes(f.hotfix), `${path} lost canonical cwd`);
          assert.ok(fields(document, "repositoryIdentity").includes(run.workspace.repositoryIdentity), `${path} lost repository identity`);
          assert.ok(fields(document, "gitDirectory").includes(run.workspace.gitDirectory), `${path} lost Git identity`);
        }
      }
      const brief = readFileSync(run.briefPath, "utf8");
      assert.ok(brief.includes(f.hotfix));
      assert.ok(brief.includes(run.reportPath));
      assert.match(brief, /спільн/iu);
      assert.match(brief, /коміт/iu);
      assert.match(brief, /push/iu);
      const trust = readFileSync(run.trustTranscriptPath, "utf8");
      assert.match(trust, runner === "codex" ? /Trust this folder/ : /trust this folder/);
      assert.ok(trust.includes(f.hotfix));
      assert.ok(fields(task.context, "writeBoundaries").flat().includes(f.hotfix));
      assert.ok(!fields(task.context, "writeBoundaries").flat().includes(f.main));
      assert.ok(resolve(run.reportPath).startsWith(join(f.home, ".raf", "tmp")+"/"));
    }
    const starts = records(f).filter(row => row.kind === "start" && row.runner === runner);
    assert.equal(starts.length, 2);
    assert.ok(starts.every(row => row.cwd === f.hotfix && row.home === f.home));
    assert.equal(records(f).filter(row => row.kind === "trusted" && row.runner === runner).length, 2);
    for (const row of records(f).filter(row => row.kind === "trusted" && row.runner === runner)) assert.equal(row.keys.replace(/\n/g, "\r"), runner === "codex" ? "\r" : "y\r");
    assert.deepEqual({ codex: sha(join(f.home, ".codex/config.toml")), claude: sha(join(f.home, ".claude.json")) }, userConfig);
    assert.deepEqual(live(f), before);
  });
}

test("[hotfix-commit] own explicit paths preserve foreign staged and unstaged changes", options, async t => {
  const f = await fixture(t);
  const workspace = await prepareHotfixWorktree(f.host, randomUUID());
  const before = live(f);
  const base = head(f);
  writeFileSync(join(f.hotfix, "hotfix-fixture/a.mjs"), "own change\n");
  writeFileSync(join(f.hotfix, "hotfix-fixture/b.mjs"), "foreign staged\n");
  git(f.hotfix, f.environment, "add", "--", "hotfix-fixture/b.mjs");
  writeFileSync(join(f.hotfix, "foreign.txt"), "foreign untracked\n");
  try {
    const own = await commitHotfix(f.host, { workspace, paths: ["hotfix-fixture/a.mjs"], message: "only own path" });
    assert.equal(git(f.hotfix, f.environment, "diff-tree", "--no-commit-id", "--name-only", "-r", own.commit), "hotfix-fixture/a.mjs");
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.match(error.message, /stag|index|чуж|індекс/iu);
    assert.equal(head(f), base);
  }
  assert.equal(git(f.hotfix, f.environment, "diff", "--cached", "--name-only"), "hotfix-fixture/b.mjs");
  assert.equal(readFileSync(join(f.hotfix, "hotfix-fixture/b.mjs"), "utf8"), "foreign staged\n");
  assert.equal(readFileSync(join(f.hotfix, "foreign.txt"), "utf8"), "foreign untracked\n");
  assert.deepEqual(live(f), before);
});

test("[hotfix-commit] simultaneous own-path commits serialize the shared index", options, async t => {
  const f = await fixture(t);
  const a = await prepareHotfixWorktree(f.host, randomUUID());
  const b = await prepareHotfixWorktree(f.host, randomUUID());
  const before = live(f);
  writeFileSync(join(f.hotfix, "hotfix-fixture/a.mjs"), "agent a\n");
  writeFileSync(join(f.hotfix, "hotfix-fixture/b.mjs"), "agent b\n");
  const commits = await Promise.all([commitHotfix(f.host, { workspace: a, paths: ["hotfix-fixture/a.mjs"], message: "a" }), commitHotfix(f.host, { workspace: b, paths: ["hotfix-fixture/b.mjs"], message: "b" })]);
  assert.notEqual(commits[0].commit, commits[1].commit);
  for (const [i, result] of commits.entries()) {
    git(f.hotfix, f.environment, "merge-base", "--is-ancestor", result.commit, "HEAD");
    assert.equal(git(f.hotfix, f.environment, "diff-tree", "--no-commit-id", "--name-only", "-r", result.commit), `hotfix-fixture/${i === 0 ? "a" : "b"}.mjs`);
  }
  assert.equal(git(f.hotfix, f.environment, "diff", "--cached", "--name-only"), "");
  assert.deepEqual(live(f), before);
});

test("[hotfix-commit] foreign index.lock is waited for and never removed", options, async t => {
  const f = await fixture(t);
  const workspace = await prepareHotfixWorktree(f.host, randomUUID());
  writeFileSync(join(f.hotfix, "hotfix-fixture/a.mjs"), "own\n");
  const lock = index(f)+".lock";
  writeFileSync(lock, "foreign lock\n", { flag: "wx" });
  let settled = false;
  const pending = commitHotfix(f.host, { workspace, paths: ["hotfix-fixture/a.mjs"], message: "wait for owner" });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await delay(f.poll * 2);
  assert.equal(settled, false);
  assert.equal(readFileSync(lock, "utf8"), "foreign lock\n");
  rmSync(lock);
  const result = await pending;
  assert.equal(head(f), result.commit);
});

for (const path of ["../raf-main/src/production-runtime.ts", ".git/config", "/etc/passwd"]) {
  test(`[hotfix-commit] rejects traversal or metadata path ${path}`, options, async t => {
    const f = await fixture(t);
    const workspace = await prepareHotfixWorktree(f.host, randomUUID());
    const before = { live: live(f), head: head(f), index: sha(index(f)) };
    await assert.rejects(commitHotfix(f.host, { workspace, paths: [path], message: "forbidden" }));
    assert.deepEqual({ live: live(f), head: head(f), index: sha(index(f)) }, before);
  });
}

test("[hotfix-sandbox] real sandbox permits shared hotfix and own tmp while protecting live Git and aliases", options, async t => {
  const f = await fixture(t);
  const a = await prepareHotfixWorktree(f.host, randomUUID().slice(0, 8));
  const b = await prepareHotfixWorktree(f.host, randomUUID().slice(0, 8));
  const own = join(f.home, ".raf/tmp", a.runId);
  const foreign = join(f.home, ".raf/tmp", b.runId);
  mkdirSync(own, { recursive: true });
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, "sentinel"), "foreign\n");
  symlinkSync(f.main, join(f.hotfix, "live-alias"));
  const common = realpathSync(a.commonDirectory);
  const before = live(f);
  const targets = [join(f.main, "src/production-runtime.ts"), join(f.main, "dist/catalog.json"), join(f.root, "raf-develop/src/production-runtime.ts"), index(f, f.main), index(f, join(f.root, "raf-develop")), join(common, "refs/heads/main"), join(common, "refs/heads/develop"), join(common, "config"), join(common, "HEAD"), join(common, "packed-refs"), join(f.root, ".git/index"), join(f.root, "conf/projects.json"), join(f.hotfix, "live-alias/src/production-runtime.ts"), join(foreign, "sentinel")];
  for (const target of targets) {
    const result = await runHotfixSandboxCommand(f.host, a, { executable: process.execPath, args: ["-e", "require('node:fs').appendFileSync(process.argv[1],'CORRUPTION')", target] });
    assert.notEqual(result.code, 0, `sandbox allowed ${target}`);
    assert.doesNotMatch(result.stderr, /CODEX_SANDBOX_UNAVAILABLE|sandbox.*unavailable/iu, "sandbox unavailable is setup failure, not successful denial");
  }
  const allowed = await runHotfixSandboxCommand(f.host, a, { executable: process.execPath, args: ["-e", "const fs=require('node:fs'); for(const p of process.argv.slice(1)) fs.writeFileSync(p,'own');", join(b.cwd, "shared-own.txt"), join(own, "own.txt")] });
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.equal(readFileSync(join(f.hotfix, "shared-own.txt"), "utf8"), "own");
  assert.equal(readFileSync(join(own, "own.txt"), "utf8"), "own");
  assert.equal(readFileSync(join(foreign, "sentinel"), "utf8"), "foreign\n");
  assert.deepEqual(live(f), before);
});

for (const entryPoint of ["cli", "runner-limits", "worker", "service-store", "notice", "hook"] as const) {
  test(`[hotfix-state-origin] registered hotfix remains QA-only at ${entryPoint}`, options, async t => {
    const f = await fixture(t);
    const workspace = await prepareHotfixWorktree(f.host, randomUUID());
    const before = filesUnder(f.workingHome);
    const request = { orchestratorRoot: f.root, modulePath: join(workspace.cwd, "src/production-entry.ts"), homeDirectory: f.workingHome, operatingSystemHome: f.workingHome, environment: {}, entryPoint };
    assert.throws(() => resolveStateContext(request), failureCode("STATE_CONTEXT_REFUSED"));
    assert.throws(() => resolveStateContext({ ...request, environment: { RAF_PRODUCTION_ROOT: f.main, RAF_PRODUCTION_GENERATION: f.baseCommit, RAF_QA_HOME: f.workingHome } }), failureCode("STATE_CONTEXT_REFUSED"));
    assert.deepEqual(filesUnder(f.workingHome), before);
    const qa = resolveStateContext({ ...request, homeDirectory: f.home, environment: { ...f.environment, RAF_QA_HOME: f.home } });
    assert.equal(qa.mode, "qa");
    assert.equal(qa.homeDirectory, f.home);
    assert.ok(qa.statePath.startsWith(f.home+"/"));
  });
}

test("[hotfix-state-origin] actual hotfix CLI refuses working HOME before SQLite and allows isolated QA", options, async t => {
  const f = await fixture(t);
  const workspace = await prepareHotfixWorktree(f.host, randomUUID());
  const before = filesUnder(f.workingHome);
  const refused = f.cli(workspace.cwd, ["agent", "ps"], true);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stdout+refused.stderr, /STATE_CONTEXT_REFUSED/);
  assert.deepEqual(filesUnder(f.workingHome), before);
  const qa = f.cli(workspace.cwd, ["agent", "ps"]);
  assert.equal(qa.code, 0, qa.stderr);
  assert.ok(Array.isArray(JSON.parse(qa.stdout)));
});

test("[hotfix-isolation] broken hotfix modules leave live ps, message and service operational", options, async t => {
  const f = await fixture(t);
  await f.startMain();
  const workspace = await prepareHotfixWorktree(f.host, randomUUID());
  const before = live(f);
  writeFileSync(join(workspace.cwd, "src/production-runtime.ts"), "export const syntaxError = ( ;\n");
  writeFileSync(join(workspace.cwd, "hotfix-fixture/a.mjs"), "export const incomplete = ;\n");
  const message = `hotfix-isolation-${randomUUID()}`;
  for (const args of [["agent", "ps"], ["agent", "message", "--to", "main", "--text", message], ["service", "start"], ["service", "status"], ["service", "stop"]]) {
    const result = await f.mainCommand(args);
    assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
  }
  assert.equal(readFileSync(f.inbox, "utf8").split(message).length-1, 1);
  assert.deepEqual(live(f), before);
});

test("[hotfix-cleanup] ending either run preserves shared branch, index, commits, foreign files and evidence", options, async t => {
  const f = await fixture(t);
  const a = await prepareHotfixWorktree(f.host, randomUUID());
  const b = await prepareHotfixWorktree(f.host, randomUUID());
  const committed = ownCommit(f, f.hotfix, "hotfix-fixture/committed.txt", "persistent\n");
  writeFileSync(join(f.hotfix, "hotfix-fixture/a.mjs"), "foreign staged\n");
  git(f.hotfix, f.environment, "add", "--", "hotfix-fixture/a.mjs");
  writeFileSync(join(f.hotfix, "untracked-foreign.txt"), "keep\n");
  const btmp = join(f.home, ".raf/tmp", b.runId);
  mkdirSync(btmp, { recursive: true });
  writeFileSync(join(btmp, "foreign.txt"), "still running\n");
  const evidence = join(f.root, "openspec/changes/hotfix-fixture/evidence.json");
  writeFileSync(evidence, JSON.stringify({ commit: committed }));
  const before = { live: live(f), index: sha(index(f)), files: filesUnder(join(f.hotfix, "hotfix-fixture")), foreign: sha(join(f.hotfix, "untracked-foreign.txt")), evidence: sha(evidence), worktrees: git(f.main, f.environment, "worktree", "list", "--porcelain") };
  for (const run of [a, a, b, b]) {
    const result = await cleanupHotfixWorktree(f.host, run);
    assert.ok(!result.removed.some(path => resolve(path) === f.hotfix || resolve(path) === run.gitDirectory || resolve(path) === index(f)));
    assert.ok(existsSync(f.hotfix));
    assert.equal(head(f), committed);
    assert.equal(git(f.hotfix, f.environment, "symbolic-ref", "HEAD"), "refs/heads/hotfix");
    assert.deepEqual({ live: live(f), index: sha(index(f)), files: filesUnder(join(f.hotfix, "hotfix-fixture")), foreign: sha(join(f.hotfix, "untracked-foreign.txt")), evidence: sha(evidence), worktrees: git(f.main, f.environment, "worktree", "list", "--porcelain") }, before);
    if (run.runId === a.runId) assert.equal(readFileSync(join(btmp, "foreign.txt"), "utf8"), "still running\n");
  }
  const next = await prepareHotfixWorktree(f.host, randomUUID());
  assert.equal(next.cwd, f.hotfix);
  assert.equal(head(f), committed);
  assert.equal(git(f.hotfix, f.environment, "for-each-ref", "--format=%(refname)", "refs/raf/hotfix"), "");
});

test("[hotfix-cleanup] spoofed workspace identity cannot delete another run or the shared worktree", options, async t => {
  const f = await fixture(t);
  const workspace = await prepareHotfixWorktree(f.host, randomUUID());
  const before = { live: live(f), head: head(f), index: sha(index(f)) };
  await assert.rejects(cleanupHotfixWorktree(f.host, { ...workspace, cwd: f.main }));
  await assert.rejects(cleanupHotfixWorktree(f.host, { ...workspace, repositoryIdentity: "foreign" }));
  assert.deepEqual({ live: live(f), head: head(f), index: sha(index(f)) }, before);
  assert.ok(existsSync(f.hotfix));
});

test("[hotfix-pure] fixture contains the complete brief tree without runtime fallback", options, async t => {
  const f = await fixture(t);
  const source = process.env.HOTFIX_FIXTURE_CONF ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../conf");
  const copied = filesUnder(join(f.root, "conf/briefs"));
  assert.deepEqual(copied, filesUnder(join(source, "briefs")));
  for (const path of ["completion.md", "tasks/hotfix.md", "tasks/test-scaffold.md", "runners/codex.md", "runners/claude.md"]) assert.ok(copied[path], `missing conf/briefs/${path}`);
});

test("[hotfix-sandbox] a hardlink alias cannot mutate a live inode", options, async t => {
  const f = await fixture(t);
  const workspace = await prepareHotfixWorktree(f.host, randomUUID().slice(0, 8));
  const target = join(f.main, "src/production-runtime.ts");
  const alias = join(f.hotfix, "live-hardlink.ts");
  linkSync(target, alias);
  const before = live(f);
  let refused = false;
  try {
    const result = await runHotfixSandboxCommand(f.host, workspace, { executable: process.execPath, args: ["-e", "require('node:fs').appendFileSync(process.argv[1],'CORRUPTION')", alias] });
    refused = result.code !== 0;
    assert.doesNotMatch(result.stderr, /CODEX_SANDBOX_UNAVAILABLE|sandbox.*unavailable/iu);
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /CODEX_SANDBOX_UNAVAILABLE|sandbox.*unavailable/iu);
    assert.match(error.message, /hardlink|inode|alias|identity|BRANCH_MISMATCH/iu);
    refused = true;
  }
  assert.equal(refused, true);
  assert.deepEqual(live(f), before);
});

test("[hotfix-cleanup] a completed launch releases only its resources while another runner remains alive", options, async t => {
  const f = await fixture(t);
  await f.startMain();
  const a = await launchHotfix(f.host, { runId: randomUUID(), addressId: "cleanup-a", features: ["hotfix-fixture"], tasks: ["hotfix-fixture:1.1"], runner: "claude", origin: "agent-run" });
  const b = await launchHotfix(f.host, { runId: randomUUID(), addressId: "cleanup-b", features: ["hotfix-fixture"], tasks: ["hotfix-fixture:1.2"], runner: "claude", origin: "direct-main" });
  writeFileSync(join(f.hotfix, "foreign-running.txt"), "still owned by b\n");
  const before = { head: head(f), index: sha(index(f)), live: live(f), foreignTmp: filesUnder(dirname(b.reportPath)) };
  process.kill(a.pid, "SIGTERM");
  await until(() => {
    try { process.kill(a.pid, 0); return undefined; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
  }, f.budget, f.poll);
  await until(() => {
    try { process.kill(a.workerPid, 0); return undefined; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
  }, f.budget, f.poll);
  const result = await cleanupHotfixWorktree(f.host, a.workspace);
  assert.ok(!result.removed.includes(f.hotfix));
  assert.doesNotThrow(() => process.kill(b.pid, 0));
  assert.doesNotThrow(() => process.kill(b.workerPid, 0));
  assert.deepEqual({ head: head(f), index: sha(index(f)), live: live(f), foreignTmp: filesUnder(dirname(b.reportPath)) }, before);
  assert.equal(readFileSync(join(f.hotfix, "foreign-running.txt"), "utf8"), "still owned by b\n");
  const ps = await f.mainCommand(["agent", "ps"]);
  assert.equal(ps.code, 0, ps.stderr);
  assert.ok(JSON.parse(ps.stdout).some((row: { runId: string }) => row.runId === b.runId));
  assert.ok(existsSync(f.hotfix));
});
