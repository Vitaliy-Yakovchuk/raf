import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { reconcileReportedCommitIndex } from "../src/report-commit-index.ts";

interface Entry {
  mode: string;
  oid: string;
  stage: number;
}

interface Fixture {
  temporaryRoot: string;
  repositoryRoot: string;
  agentIndex: string;
  base: string;
  commits: string[];
}

const additions = [
  "new/first.ts",
  "new/second.ts",
  "new/third.ts",
  "new/file with spaces.ts",
  "new/fifth.ts",
  "new/sixth.ts",
  "new/seventh.ts",
  "new/eighth.ts",
];
const reportedPaths = [
  "tasks.md",
  "first-only.txt",
  "second-only.txt",
  "removed.txt",
  ...additions,
];

function git(f: Fixture, args: string[], index?: string): string {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const result = spawnSync("git", [
    "-C", f.repositoryRoot,
    "--literal-pathspecs",
    "-c", "core.hooksPath=/dev/null",
    ...args,
  ], {
    encoding: "utf8",
    env: {
      ...environment,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "0",
      ...(index ? { GIT_INDEX_FILE: index } : {}),
    },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `Git fixture command ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}

function write(f: Fixture, path: string, content: string): void {
  const target = join(f.repositoryRoot, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function indexEntries(f: Fixture): Record<string, Entry> {
  return Object.fromEntries(git(f, ["ls-files", "--stage", "-z"])
    .split("\0").filter(Boolean).map(record => {
      const separator = record.indexOf("\t");
      const [mode, oid, stage] = record.slice(0, separator).split(" ");
      return [record.slice(separator + 1), { mode, oid, stage: Number(stage) }];
    }));
}

function treeEntries(f: Fixture, ref: string): Record<string, Entry> {
  return Object.fromEntries(git(f, ["ls-tree", "-r", "-z", ref])
    .split("\0").filter(Boolean).map(record => {
      const separator = record.indexOf("\t");
      const [mode, , oid] = record.slice(0, separator).split(" ");
      return [record.slice(separator + 1), { mode, oid, stage: 0 }];
    }));
}

function worktreeSnapshot(f: Fixture): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  function visit(directory: string): void {
    for (const name of readdirSync(directory).sort()) {
      if (directory === f.repositoryRoot && name === ".git") continue;
      const path = join(directory, name);
      const stat = lstatSync(path);
      const key = relative(f.repositoryRoot, path);
      if (stat.isDirectory()) {
        entries[key] = { type: "directory", mode: stat.mode };
        visit(path);
      } else if (stat.isSymbolicLink()) {
        entries[key] = { type: "symlink", target: readlinkSync(path), mode: stat.mode };
      } else {
        entries[key] = { type: "file", bytes: readFileSync(path).toString("base64"), mode: stat.mode };
      }
    }
  }
  visit(f.repositoryRoot);
  return entries;
}

function commitThroughAgentIndex(f: Fixture, paths: string[], message: string): string {
  git(f, ["read-tree", "HEAD"], f.agentIndex);
  git(f, ["add", "--", ...paths], f.agentIndex);
  git(f, ["commit", "-m", message], f.agentIndex);
  return git(f, ["rev-parse", "HEAD"]).trim();
}

function fixture(): Fixture {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "raf-report-commit-index-"));
  const f: Fixture = {
    temporaryRoot,
    repositoryRoot: join(temporaryRoot, "repository"),
    agentIndex: join(temporaryRoot, "agent.index"),
    base: "",
    commits: [],
  };
  try {
    mkdirSync(f.repositoryRoot);
    git(f, ["init", "--initial-branch=main"]);
    git(f, ["config", "user.name", "Report index fixture"]);
    git(f, ["config", "user.email", "fixture@example.invalid"]);
    git(f, ["config", "commit.gpgSign", "false"]);
    git(f, ["config", "core.fileMode", "true"]);
    write(f, "tasks.md", "- [ ] 1.1 Agent task\n- [ ] 1.2 Open sentinel\n");
    for (const path of ["first-only.txt", "second-only.txt", "removed.txt", "unreported.txt"]) {
      write(f, path, `base ${path}\n`);
    }
    git(f, ["add", "--", "tasks.md", "first-only.txt", "second-only.txt", "removed.txt", "unreported.txt"]);
    git(f, ["commit", "-m", "base before reported commits"]);
    f.base = git(f, ["rev-parse", "HEAD"]).trim();

    write(f, "tasks.md", "- [x] 1.1 Agent task\n- [ ] 1.2 Open sentinel\n");
    write(f, "first-only.txt", "agent first commit\n");
    for (const path of additions.slice(0, 4)) write(f, path, `first commit ${path}\n`);
    chmodSync(join(f.repositoryRoot, additions[0]), 0o755);
    f.commits.push(commitThroughAgentIndex(f,
      ["tasks.md", "first-only.txt", ...additions.slice(0, 4)], "agent report commit one"));

    write(f, "tasks.md", "- [x] 1.1 Agent task\n  - Agent proof from second commit\n- [ ] 1.2 Open sentinel\n");
    write(f, "second-only.txt", "agent second commit\n");
    write(f, additions[0], "agent updated an addition in second commit\n");
    for (const path of additions.slice(4)) write(f, path, `second commit ${path}\n`);
    rmSync(join(f.repositoryRoot, "removed.txt"));
    f.commits.push(commitThroughAgentIndex(f,
      ["tasks.md", "second-only.txt", "removed.txt", additions[0], ...additions.slice(4)], "agent report commit two"));

    assert.equal(git(f, ["rev-parse", `${f.commits[0]}^`]).trim(), f.base);
    assert.equal(git(f, ["rev-parse", `${f.commits[1]}^`]).trim(), f.commits[0]);
    assert.deepEqual(indexEntries(f), treeEntries(f, f.base), "the real index must still contain the first parent tree");
    assert.equal(treeEntries(f, "HEAD")[additions[0]].mode, "100755");
    write(f, "tasks.md", `${git(f, ["show", "HEAD:tasks.md"])}  - Foreign unstaged proof\n`);
    write(f, additions[0], "foreign unstaged contents, not the HEAD blob\n");
    write(f, "untracked.txt", "foreign untracked sentinel\n");
    return f;
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

async function observeReconciliation(f: Fixture, commits: readonly string[] = f.commits): Promise<unknown> {
  const before = worktreeSnapshot(f);
  const head = git(f, ["rev-parse", "HEAD"]);
  let failure: unknown;
  try {
    await reconcileReportedCommitIndex({ repositoryRoot: f.repositoryRoot, commits });
  } catch (error) {
    failure = error;
  }
  assert.deepEqual(worktreeSnapshot(f), before, "reconciliation must not write, restore, delete or stage worktree bytes");
  assert.equal(git(f, ["rev-parse", "HEAD"]), head, "reconciliation must not create commits or move HEAD");
  return failure;
}

function expectedReconciledEntries(f: Fixture, before: Record<string, Entry>): Record<string, Entry> {
  const expected = { ...before };
  const currentHead = treeEntries(f, "HEAD");
  for (const path of reportedPaths) {
    if (currentHead[path]) expected[path] = currentHead[path];
    else delete expected[path];
  }
  return expected;
}

test("[report-index Z.370] two report commits reconcile stale entries against the parent of the first commit", async t => {
  const f = fixture();
  t.after(() => rmSync(f.temporaryRoot, { recursive: true, force: true }));
  const expected = expectedReconciledEntries(f, indexEntries(f));
  const failure = await observeReconciliation(f);

  assert.deepEqual(indexEntries(f), expected,
    "all reported paths must equal HEAD, including first-only changes, repeated changes and a committed removal");
  assert.ifError(failure);
});

test("[report-index Z.370] eight absent additions become HEAD entries and the next ordinary commit cannot revert agent work", async t => {
  const f = fixture();
  t.after(() => rmSync(f.temporaryRoot, { recursive: true, force: true }));
  const beforeHead = treeEntries(f, "HEAD");
  for (const path of additions) assert.equal(indexEntries(f)[path], undefined);
  const failure = await observeReconciliation(f);

  for (const path of additions) {
    assert.deepEqual(indexEntries(f)[path], beforeHead[path], `missing addition ${path} must become its HEAD blob and mode`);
  }
  assert.ifError(failure);
  write(f, "next.txt", "next agent commits only this file\n");
  git(f, ["add", "--", "next.txt"]);
  git(f, ["commit", "-m", "ordinary next commit"]);
  assert.deepEqual(git(f, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"])
    .split("\0").filter(Boolean), ["next.txt"], "an ordinary commit must not revert tasks or delete additions");
  const afterHead = treeEntries(f, "HEAD");
  for (const path of reportedPaths) assert.deepEqual(afterHead[path], beforeHead[path], path);
});

test("[report-index Z.370] different staged blobs and staged deletion on reported paths retain foreign ownership", async t => {
  const f = fixture();
  t.after(() => rmSync(f.temporaryRoot, { recursive: true, force: true }));
  write(f, "first-only.txt", "foreign staged contents\n");
  write(f, additions[1], "foreign staged addition\n");
  write(f, "tasks.md", git(f, ["show", `${f.commits[0]}:tasks.md`]));
  git(f, ["add", "--", "first-only.txt", additions[1], "tasks.md"]);
  git(f, ["update-index", "--force-remove", "--", "second-only.txt"]);
  write(f, "first-only.txt", "foreign unstaged contents after staging\n");
  const before = indexEntries(f);
  const expected = expectedReconciledEntries(f, before);
  const preserved = ["first-only.txt", additions[1], "tasks.md", "second-only.txt"];
  for (const path of preserved) {
    if (before[path]) expected[path] = before[path];
    else delete expected[path];
  }
  const failure = await observeReconciliation(f);

  for (const path of preserved) assert.deepEqual(indexEntries(f)[path], before[path], `foreign staged entry ${path} must survive exactly`);
  assert.deepEqual(indexEntries(f), expected, "preserve foreign entries while reconciling the other stale report paths");
  assert.ifError(failure);
});

test("[report-index Z.370] reconciliation targets current HEAD and leaves paths outside both report commits untouched", async t => {
  const f = fixture();
  t.after(() => rmSync(f.temporaryRoot, { recursive: true, force: true }));
  write(f, "tasks.md", `${git(f, ["show", "HEAD:tasks.md"])}  - Later committed proof\n`);
  write(f, "unreported.txt", "later commit outside agent report\n");
  commitThroughAgentIndex(f, ["tasks.md", "unreported.txt"], "another writer advances HEAD after report commits");
  write(f, "second-only.txt", "foreign staged report path\n");
  write(f, "outside-staged.txt", "unrelated staged addition\n");
  git(f, ["add", "--", "second-only.txt", "outside-staged.txt"]);
  rmSync(join(f.repositoryRoot, "first-only.txt"));
  const before = indexEntries(f);
  const expected = expectedReconciledEntries(f, before);
  expected["second-only.txt"] = before["second-only.txt"];
  assert.notDeepEqual(treeEntries(f, "HEAD")["tasks.md"], treeEntries(f, f.commits[1])["tasks.md"]);
  assert.notDeepEqual(before["unreported.txt"], treeEntries(f, "HEAD")["unreported.txt"]);
  const failure = await observeReconciliation(f);

  assert.deepEqual(indexEntries(f)["tasks.md"], treeEntries(f, "HEAD")["tasks.md"], "use current HEAD, not the last report commit");
  assert.deepEqual(indexEntries(f), expected, "only paths in the two report commits may be reconciled");
  assert.ifError(failure);
});

test("[report-index Z.370] replay preserves the reconciled index and creates no extra commits", async t => {
  const f = fixture();
  t.after(() => rmSync(f.temporaryRoot, { recursive: true, force: true }));
  const expected = expectedReconciledEntries(f, indexEntries(f));
  const firstFailure = await observeReconciliation(f);
  assert.deepEqual(indexEntries(f), expected, "first acceptance must reconcile the index before replay");
  assert.ifError(firstFailure);
  const replayFailure = await observeReconciliation(f);

  assert.deepEqual(indexEntries(f), expected, "replaying an accepted report preserves all entries");
  assert.ifError(replayFailure);
});
