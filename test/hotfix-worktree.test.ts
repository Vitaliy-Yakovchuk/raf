import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, readFileSync, readlinkSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { cleanupHotfixWorktree, commitHotfix, launchHotfix, prepareHotfixWorktree, runHotfixSandboxCommand } from "../src/hotfix-worktree.ts";
import { assertWorkspace, filesUnder, fixture, git, sha, timeoutMs, until } from "./hotfix-fixture.ts";

test("[hotfix-pure] two detached candidates retain main and independent index/HEAD", { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  const before = f.liveIdentity();
  const [a, b] = await Promise.all([prepareHotfixWorktree(f.host, randomUUID()), prepareHotfixWorktree(f.host, randomUUID())]);
  assertWorkspace(a, f);
  assertWorkspace(b, f);
  assert.notEqual(a.runId, b.runId);
  assert.notEqual(a.cwd, b.cwd);
  assert.notEqual(a.gitDirectory, b.gitDirectory);
  assert.equal(a.repositoryIdentity, b.repositoryIdentity);
  assert.equal(a.commonDirectory, b.commonDirectory);
  assert.notEqual(statSync(join(a.gitDirectory, "index")).ino, statSync(join(b.gitDirectory, "index")).ino);
  assert.notEqual(statSync(join(a.cwd, "src", "production-runtime.ts")).ino, statSync(join(f.main, "src", "production-runtime.ts")).ino);
  assert.notEqual(statSync(join(a.cwd, "src", "production-runtime.ts")).ino, statSync(join(b.cwd, "src", "production-runtime.ts")).ino);
  assert.deepEqual(f.liveIdentity(), before);
  assert.deepEqual(git(f.main, f.environment, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n").sort(), ["refs/heads/develop", "refs/heads/main"]);
});

test("[hotfix-pure] trusted own-path commit updates only the detached candidate", { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  const a = await prepareHotfixWorktree(f.host, randomUUID());
  const b = await prepareHotfixWorktree(f.host, randomUUID());
  const before = f.liveIdentity();
  const other = { head: git(b.cwd, f.environment, "rev-parse", "HEAD"), index: sha(join(b.gitDirectory, "index")), files: filesUnder(join(b.cwd, "src")) };
  writeFileSync(join(a.cwd, "hotfix-fixture", "a.mjs"), 'export const marker = "candidate-only";\n');
  const result = await commitHotfix(f.host, { workspace: a, paths: ["hotfix-fixture/a.mjs"], message: "own isolated fix" });
  assert.notEqual(result.commit, f.baseCommit);
  assert.equal(result.commit, git(a.cwd, f.environment, "rev-parse", "HEAD"));
  assert.equal(result.tree, git(a.cwd, f.environment, "rev-parse", "HEAD^{tree}"));
  assert.equal(git(a.cwd, f.environment, "show", "--format=", "--name-only", "HEAD"), "hotfix-fixture/a.mjs");
  assert.equal(git(a.cwd, f.environment, "status", "--porcelain"), "");
  assert.deepEqual(f.liveIdentity(), before);
  assert.deepEqual({ head: git(b.cwd, f.environment, "rev-parse", "HEAD"), index: sha(join(b.gitDirectory, "index")), files: filesUnder(join(b.cwd, "src")) }, other);
});

for (const runner of ["codex", "claude"] as const) for (const origin of ["agent-run", "direct-main"] as const) {
  test(`[hotfix-launch] ${runner}/${origin} carries the physical identity through production, worker, trust and brief`, { timeout: timeoutMs }, async t => {
    const f = await fixture(t);
    await f.startMain();
    const before = f.liveIdentity();
    const trustBefore = [sha(join(f.home, ".codex", "config.toml")), sha(join(f.home, ".claude.json"))];
    const runId = randomUUID();
    const launched = await launchHotfix(f.host, { runId, addressId: `hotfix-${runId.slice(0, 8)}`, features: ["hotfix-fixture"], tasks: ["hotfix-fixture:1.1"], runner, origin });
    assertWorkspace(launched.workspace, f);
    assert.equal(launched.runId, runId);
    assert.equal(launched.workspace.runId, runId);
    assert.equal(readlinkSync(`/proc/${launched.pid}/cwd`), launched.workspace.cwd);
    assert.equal(readlinkSync(`/proc/${launched.workerPid}/cwd`), launched.workspace.cwd);
    for (const path of [launched.taskContextPath, launched.workerContextPath]) {
      const context = JSON.parse(readFileSync(path, "utf8"));
      assert.deepEqual(context.workspace, launched.workspace);
    }
    const records = readFileSync(f.runnerLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const started = records.find(record => record.kind === "start" && record.pid === launched.pid);
    assert.ok(started, "A real terminal child was started");
    assert.equal(started.cwd, launched.workspace.cwd);
    assert.equal(started.home, f.home);
    assert.equal(records.filter(record => record.kind === "trusted").length, 1);
    const brief = readFileSync(launched.briefPath, "utf8");
    assert.ok(brief.includes(launched.workspace.cwd));
    assert.ok(brief.includes(launched.workspace.baseCommit));
    assert.match(brief, /push/iu);
    assert.match(brief, /актив|activat/iu);
    assert.ok(launched.reportPath.startsWith(join(f.home, ".raf", "tmp") + "/"));
    const invocation = JSON.parse(readFileSync(launched.invocationPath, "utf8"));
    assert.ok(JSON.stringify(invocation).includes(launched.workspace.cwd));
    assert.equal(JSON.stringify(invocation).includes("danger-full-access"), false);
    assert.equal(JSON.stringify(invocation).includes("dangerously-skip-permissions"), false);
    assert.deepEqual([sha(join(f.home, ".codex", "config.toml")), sha(join(f.home, ".claude.json"))], trustBefore);
    assert.deepEqual(f.liveIdentity(), before);
    const ps = await f.mainCommand(["agent", "ps"]);
    assert.equal(ps.code, 0, ps.stderr);
    assert.ok(JSON.parse(ps.stdout).some((session: { runId: string }) => session.runId === runId));
  });
}

test("[hotfix-launch] two production hotfix runs keep separate physical identities and native sessions", { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  await f.startMain();
  const before = f.liveIdentity();
  const runs = [randomUUID(), randomUUID()];
  const launched = await Promise.all(runs.map((runId, index) => launchHotfix(f.host, {
    runId, addressId: `hotfix-${runId.slice(0, 8)}`, features: ["hotfix-fixture"],
    tasks: [`hotfix-fixture:1.${index + 1}`], runner: "codex", origin: "agent-run"
  })));
  for (const run of launched) {
    assertWorkspace(run.workspace, f);
    assert.equal(readlinkSync(`/proc/${run.pid}/cwd`), run.workspace.cwd);
    assert.equal(readlinkSync(`/proc/${run.workerPid}/cwd`), run.workspace.cwd);
    assert.equal(JSON.parse(readFileSync(run.workerContextPath, "utf8")).workspace.runId, run.runId);
  }
  assert.notEqual(launched[0].workspace.cwd, launched[1].workspace.cwd);
  assert.notEqual(launched[0].workspace.gitDirectory, launched[1].workspace.gitDirectory);
  assert.notEqual(launched[0].runnerSessionId, launched[1].runnerSessionId);
  assert.equal(launched[0].workspace.repositoryIdentity, launched[1].workspace.repositoryIdentity);
  const ps = await f.mainCommand(["agent", "ps"]);
  assert.equal(ps.code, 0, ps.stderr);
  const sessions = JSON.parse(ps.stdout);
  for (const runId of runs) assert.equal(sessions.filter((session: { runId: string }) => session.runId === runId).length, 1);
  assert.deepEqual(f.liveIdentity(), before);
});

test("[hotfix-sandbox] actual native sandbox allows own bytes and denies main, refs, index, config, other worktree and aliases", { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  const a = await prepareHotfixWorktree(f.host, randomUUID());
  const b = await prepareHotfixWorktree(f.host, randomUUID());
  const live = f.liveIdentity();
  const mainGit = git(f.main, f.environment, "rev-parse", "--absolute-git-dir");
  const own = join(a.cwd, "hotfix-fixture", "owned.txt");
  const allowed = await runHotfixSandboxCommand(f.host, a, { executable: process.execPath, args: ["-e", "require('fs').writeFileSync(process.argv[1],'own')", own] });
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.equal(readFileSync(own, "utf8"), "own");
  const targets = [join(f.main, "src", "production-runtime.ts"), join(a.commonDirectory, "refs", "heads", "main"), join(mainGit, "index"), join(mainGit, "HEAD"), join(a.commonDirectory, "config"), join(b.gitDirectory, "index"), join(b.cwd, "hotfix-fixture", "a.mjs"), join(f.root, ".git", "index")];
  for (const [index, target] of targets.entries()) {
    assert.ok(existsSync(target), `Denied probe must target an existing resource: ${target}`);
    const before = sha(target);
    const alias = join(a.cwd, `alias-${index}`);
    symlinkSync(target, alias);
    for (const path of [target, alias]) {
      const denied = await runHotfixSandboxCommand(f.host, a, { executable: process.execPath, args: ["-e", "require('fs').appendFileSync(process.argv[1],'forbidden')", path] });
      assert.notEqual(denied.code, 0, `Sandbox permitted ${path}`);
      assert.match(denied.stderr, /EACCES|EPERM|EROFS|denied|not permitted/iu);
      assert.equal(sha(target), before);
    }
  }
  const hardAlias = join(a.cwd, "main-source-hardlink");
  linkSync(join(f.main, "src", "production-runtime.ts"), hardAlias);
  const hardDenied = await runHotfixSandboxCommand(f.host, a, { executable: process.execPath, args: ["-e", "require('fs').appendFileSync(process.argv[1],'forbidden')", hardAlias] });
  assert.notEqual(hardDenied.code, 0);
  assert.deepEqual(f.liveIdentity(), live);
});

test("[hotfix-identity] forged ownership, foreign repository and lost registration fail closed", { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  const workspace = await prepareHotfixWorktree(f.host, randomUUID());
  const live = f.liveIdentity();
  for (const forged of [{ ...workspace, runId: randomUUID() }, { ...workspace, cwd: f.main }, { ...workspace, repositoryIdentity: "foreign-repository" }, { ...workspace, gitDirectory: join(f.root, ".git") }]) {
    await assert.rejects(commitHotfix(f.host, { workspace: forged, paths: ["hotfix-fixture/a.mjs"], message: "must refuse" }), /identity|ownership|repository|worktree|refus/iu);
    await assert.rejects(cleanupHotfixWorktree(f.host, forged), /identity|ownership|repository|worktree|refus/iu);
  }
  const gitFile = join(workspace.cwd, ".git");
  renameSync(gitFile, `${gitFile}.lost`);
  await assert.rejects(commitHotfix(f.host, { workspace, paths: ["hotfix-fixture/a.mjs"], message: "lost worktree" }), /identity|registration|worktree|git/iu);
  assert.deepEqual(f.liveIdentity(), live);
});

test("[hotfix-commit] path traversal, symlink and staged foreign paths cannot enter trusted commit", { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  const workspace = await prepareHotfixWorktree(f.host, randomUUID());
  const live = f.liveIdentity();
  symlinkSync(f.main, join(workspace.cwd, "outside"));
  for (const path of ["../raf-main/src/production-runtime.ts", join(f.main, "src", "production-runtime.ts"), "outside/src/production-runtime.ts"]) {
    await assert.rejects(commitHotfix(f.host, { workspace, paths: [path], message: "escape" }), /path|boundar|symlink|outside|refus/iu);
  }
  writeFileSync(join(workspace.cwd, "hotfix-fixture", "a.mjs"), 'export const marker = "own";\n');
  writeFileSync(join(workspace.cwd, "hotfix-fixture", "b.mjs"), 'export const marker = "foreign-staged";\n');
  git(workspace.cwd, f.environment, "add", "hotfix-fixture/b.mjs");
  const index = sha(join(workspace.gitDirectory, "index"));
  await assert.rejects(commitHotfix(f.host, { workspace, paths: ["hotfix-fixture/a.mjs"], message: "own only" }), /stag|index|foreign|path|refus/iu);
  assert.equal(sha(join(workspace.gitDirectory, "index")), index);
  assert.equal(git(workspace.cwd, f.environment, "rev-parse", "HEAD"), workspace.baseCommit);
  assert.deepEqual(f.liveIdentity(), live);
});

test("[hotfix-isolation] intermediate SyntaxError and partial second module cannot interrupt real message/ps/service", { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  await f.startMain();
  assert.equal((await f.mainCommand(["service", "start"])).code, 0);
  const workspace = await prepareHotfixWorktree(f.host, randomUUID());
  const live = f.liveIdentity();
  writeFileSync(join(workspace.cwd, "src", "production-runtime.ts"), "export function broken( {\n");
  writeFileSync(join(workspace.cwd, "hotfix-fixture", "a.mjs"), 'export const marker = "half-new";\n');
  const nonce = `syntax-barrier-${randomUUID()}`;
  const ps = await f.mainCommand(["agent", "ps"]);
  const sent = await f.mainCommand(["agent", "message", "--to", "main", "--text", nonce]);
  const status = await f.mainCommand(["service", "status"]);
  for (const result of [ps, sent, status]) assert.equal(result.code, 0, result.stderr);
  assert.ok(JSON.parse(ps.stdout).some((session: { addressId: string }) => session.addressId === "main"));
  await until(() => existsSync(f.inbox) && readFileSync(f.inbox, "utf8").includes(nonce) ? true : undefined, f.budget, f.poll);
  const inbox = readFileSync(f.inbox, "utf8");
  assert.equal(inbox.split(nonce).length - 1, 1);
  assert.match(inbox, /main/iu);
  assert.deepEqual(f.liveIdentity(), live);
  assert.equal((await f.mainCommand(["service", "stop"])).code, 0);
});

test("[hotfix-cleanup] active runner and foreign worktree survive; finished cleanup is idempotent", { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  await f.startMain();
  const runId = randomUUID();
  const active = await launchHotfix(f.host, { runId, addressId: `hotfix-${runId.slice(0, 8)}`, features: ["hotfix-fixture"], tasks: ["hotfix-fixture:1.1"], runner: "codex", origin: "agent-run" });
  const other = await prepareHotfixWorktree(f.host, randomUUID());
  const finished = await prepareHotfixWorktree(f.host, randomUUID());
  writeFileSync(join(finished.cwd, "hotfix-fixture", "a.mjs"), 'export const marker = "retain-commit";\n');
  const committed = await commitHotfix(f.host, { workspace: finished, paths: ["hotfix-fixture/a.mjs"], message: "retain evidence" });
  const cleanup = await cleanupHotfixWorktree(f.host, active.workspace);
  assert.ok(cleanup.retained.includes(active.workspace.cwd));
  assert.ok(existsSync(active.workspace.cwd));
  process.kill(active.pid, 0);
  await cleanupHotfixWorktree(f.host, finished);
  await cleanupHotfixWorktree(f.host, finished);
  assert.equal(existsSync(finished.cwd), false);
  assert.equal(git(f.main, f.environment, "cat-file", "-t", committed.commit), "commit");
  assert.ok(existsSync(other.cwd));
  assert.ok(existsSync(active.workspace.cwd));
  assert.ok(git(f.main, f.environment, "worktree", "list", "--porcelain").includes(other.cwd));
});
