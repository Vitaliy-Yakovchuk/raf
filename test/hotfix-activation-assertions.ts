import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { acquireHotfixReader, activateHotfix, cleanupHotfixActivation, createAtomicHotfixSwitch, recoverHotfixActivation, sealHotfixSnapshot, verifyHotfixCandidate, type AtomicHotfixSwitch, type HotfixCheckpoint, type HotfixGateName, type HotfixReaderKind, type VerifiedHotfix } from "../src/hotfix-activation.ts";
import { commitHotfix, prepareHotfixWorktree } from "../src/hotfix-worktree.ts";
import { ensureProductionMainStore } from "../src/main-production-store.ts";
import { childMessage, command, filesUnder, fixture, git, sha, timeoutMs, until } from "./hotfix-fixture.ts";

const activationModule = new URL("../src/hotfix-activation.ts", import.meta.url).href;
const hostModule = new URL("../src/hotfix-host.ts", import.meta.url).href;
const requiredGates: readonly HotfixGateName[] = ["build", "regression", "runtime-import", "help", "agent-ps", "agent-message", "service-start", "service-ready", "service-status", "service-stop"];

function hotfixIdentity(f: Awaited<ReturnType<typeof fixture>>) {
  const gitDirectory = git(f.hotfix, f.environment, "rev-parse", "--absolute-git-dir");
  const info = statSync(f.hotfix);
  return {
    device: info.dev,
    inode: info.ino,
    gitDirectory,
    commonDirectory: realpathSync(git(f.hotfix, f.environment, "rev-parse", "--path-format=absolute", "--git-common-dir")),
    branch: git(f.hotfix, f.environment, "rev-parse", "--abbrev-ref", "HEAD"),
    head: git(f.hotfix, f.environment, "rev-parse", "HEAD"),
    ref: git(f.hotfix, f.environment, "rev-parse", "refs/heads/hotfix"),
    index: sha(join(gitDirectory, "index")),
    status: git(f.hotfix, f.environment, "status", "--porcelain", "--untracked-files=all"),
    files: filesUnder(join(f.hotfix, "hotfix-fixture")),
    registration: git(f.hotfix, f.environment, "worktree", "list", "--porcelain").split("\n\n").find(record => record.includes("branch refs/heads/hotfix"))
  };
}

function assertSealed(f: Awaited<ReturnType<typeof fixture>>, verified: VerifiedHotfix) {
  const snapshot = verified.snapshot;
  assert.ok(snapshot, "successful verification includes the sealed shared-hotfix snapshot");
  assert.notEqual(realpathSync(snapshot.root), realpathSync(f.hotfix));
  assert.notEqual(realpathSync(snapshot.root), realpathSync(f.main));
  assert.notEqual(realpathSync(snapshot.configurationRoot), realpathSync(f.root));
  assert.equal(snapshot.sourceCwd, f.hotfix);
  assert.equal(realpathSync(snapshot.sourceGitDirectory), realpathSync(verified.workspace.gitDirectory));
  assert.equal(realpathSync(snapshot.sourceCommonDirectory), realpathSync(verified.workspace.commonDirectory));
  assert.equal(snapshot.baseCommit, verified.workspace.baseCommit);
  assert.equal(snapshot.commit, verified.commit);
  assert.equal(snapshot.tree, verified.tree);
  assert.equal(snapshot.fingerprint, verified.fingerprint);
  assert.deepEqual(snapshot.files, verified.files);
  assert.deepEqual(snapshot.configuration, verified.configuration);
  assert.equal(existsSync(join(snapshot.root, ".git")), false, "an internal sealed copy is not a per-run Git worktree");
  const registrations = git(f.hotfix, f.environment, "worktree", "list", "--porcelain");
  assert.equal(registrations.includes(`worktree ${snapshot.root}\n`), false);
  assert.equal(registrations.split("\n").filter(line => line.startsWith("worktree ")).length, 3, "only permanent main/develop/hotfix Git worktrees exist");
  for (const file of verified.files) {
    const sealed = join(snapshot.root, file.path);
    const original = join(f.hotfix, file.path);
    assert.equal(sha(sealed), file.sha256, file.path);
    assert.equal(sha(original), file.sha256, file.path);
    const copied = statSync(sealed);
    const source = statSync(original);
    assert.ok(copied.dev !== source.dev || copied.ino !== source.ino, `${file.path} has no mutable hardlink to shared hotfix`);
    if (file.mode !== undefined) assert.equal(copied.mode & 0o111, file.mode & 0o111);
  }
  for (const file of verified.configuration) {
    const sealed = join(snapshot.configurationRoot, file.path);
    const original = join(f.root, file.path);
    assert.equal(sha(sealed), file.sha256, file.path);
    const copied = statSync(sealed);
    const source = statSync(original);
    assert.ok(copied.dev !== source.dev || copied.ino !== source.ino, `${file.path} has no mutable hardlink to live configuration`);
  }
  return snapshot;
}

function assertMain(f: Awaited<ReturnType<typeof fixture>>, commit: string, marker: string, split = false) {
  assert.equal(git(f.main, f.environment, "rev-parse", "HEAD"), commit);
  assert.equal(git(f.main, f.environment, "rev-parse", "refs/heads/main"), commit);
  assert.equal(git(f.main, f.environment, "diff", "--cached", "--name-only"), "");
  assert.equal(git(f.main, f.environment, "status", "--porcelain"), "");
  assert.equal(git(f.main, f.environment, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  const mainPath = relative(f.root, realpathSync(f.main));
  const logicalEntry = git(f.root, f.environment, "ls-files", "--stage", "raf-main");
  if (lstatSync(f.main).isSymbolicLink()) {
    assert.match(logicalEntry, /^120000 [a-f0-9]+ 0\traf-main$/u);
    assert.equal(git(f.root, f.environment, "show", ":raf-main"), readlinkSync(f.main));
    assert.equal(git(f.root, f.environment, "config", "-f", ".gitmodules", "--get", "submodule.raf-main.path"), mainPath);
  } else assert.match(logicalEntry, /^160000 /u);
  assert.equal(git(f.root, f.environment, "ls-files", "--stage", mainPath), `160000 ${commit} 0\t${mainPath}`);
  assert.ok(statSync(join(f.main, ".git")).isFile(), "main remains a registered submodule");
  assert.equal(git(f.root, f.environment, "submodule", "status", mainPath).includes(commit), true);
  assert.equal(realpathSync(git(f.main, f.environment, "rev-parse", "--show-toplevel")), realpathSync(f.main));
  const mainGitDirectory = realpathSync(git(f.main, f.environment, "rev-parse", "--absolute-git-dir"));
  const sourceDirectory = realpathSync(join(f.root, ".git", "modules", "raf-main"));
  const productionDirectory = split ? realpathSync(join(sourceDirectory, "raf-hotfix", "main.git")) : sourceDirectory;
  if (lstatSync(f.main).isSymbolicLink() && mainGitDirectory !== productionDirectory) {
    assert.equal(realpathSync(resolve(mainGitDirectory, "../..")), productionDirectory);
    assert.equal(readFileSync(join(mainGitDirectory, "gitdir"), "utf8").trim(), join(realpathSync(f.main), ".git"));
  } else assert.equal(mainGitDirectory, productionDirectory);
  assert.equal(realpathSync(git(f.main, f.environment, "rev-parse", "--path-format=absolute", "--git-common-dir")), productionDirectory);
  assert.equal(realpathSync(git(f.hotfix, f.environment, "rev-parse", "--path-format=absolute", "--git-common-dir")), sourceDirectory);
  const indexEntries = git(f.main, f.environment, "ls-files", "--stage").split("\n").map(line => line.replace(/ 0\t/u, "\t"));
  const commitEntries = git(f.main, f.environment, "ls-tree", "-r", commit).split("\n").map(line => line.replace(/ blob /u, " "));
  assert.deepEqual(indexEntries, commitEntries, "main index contains exactly the activated commit tree");
  const mainWorktrees = git(f.main, f.environment, "worktree", "list", "--porcelain")
    .split("\n\n")
    .map(record => record.split("\n"))
    .filter(lines => lines.includes("branch refs/heads/main"));
  assert.equal(mainWorktrees.length, 1, "exactly one registered worktree owns main");
  const mainWorktree = mainWorktrees[0]!;
  assert.ok(mainWorktree.includes(`HEAD ${commit}`), "registered main points to the expected commit");
  const registeredPath = mainWorktree.find(line => line.startsWith("worktree "))?.slice("worktree ".length);
  assert.ok(registeredPath, "registered main has a worktree path");
  assert.equal(realpathSync(git(registeredPath, f.environment, "rev-parse", "--absolute-git-dir")), mainGitDirectory);
  for (const name of ["a.mjs", "b.mjs"]) assert.equal(readFileSync(join(f.main, "hotfix-fixture", name), "utf8"), `export const marker = ${JSON.stringify(marker)};\n`);
}

export { activationModule, hostModule, requiredGates, hotfixIdentity, assertSealed, assertMain };
