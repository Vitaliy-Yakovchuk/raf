import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  assert.equal(git(f.root, f.environment, "ls-files", "--stage", "raf-main").split(/\s/u)[1], commit);
  assert.match(git(f.root, f.environment, "ls-files", "--stage", "raf-main"), /^160000 /u);
  assert.ok(statSync(join(f.main, ".git")).isFile(), "main remains a registered submodule");
  assert.equal(git(f.root, f.environment, "submodule", "status", "raf-main").includes(commit), true);
  assert.equal(realpathSync(git(f.main, f.environment, "rev-parse", "--show-toplevel")), realpathSync(f.main));
  const mainGitDirectory = realpathSync(git(f.main, f.environment, "rev-parse", "--absolute-git-dir"));
  const sourceDirectory = realpathSync(join(f.root, ".git", "modules", "raf-main"));
  const productionDirectory = split ? realpathSync(join(sourceDirectory, "raf-hotfix", "main.git")) : sourceDirectory;
  assert.equal(mainGitDirectory, productionDirectory);
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

test("[hotfix-gates] real build/regression/CLI/runtime/SQLite/tmux smoke binds all evidence to exact commit and inputs", { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  await f.startMain();
  const before = f.liveIdentity();
  const verified = await f.verified();
  const snapshot = assertSealed(f, verified);
  assert.equal(verified.commit, git(verified.workspace.cwd, f.environment, "rev-parse", "HEAD"));
  assert.equal(verified.tree, git(verified.workspace.cwd, f.environment, "rev-parse", "HEAD^{tree}"));
  assert.match(verified.fingerprint, /^[0-9a-f]{64}$/u);
  assert.deepEqual(verified.gates.map(gate => gate.name).sort(), [...requiredGates].sort());
  for (const gate of verified.gates) {
    assert.equal(gate.status, "passed", gate.name);
    assert.equal(gate.code, 0, gate.name);
    assert.equal(gate.commit, verified.commit);
    assert.equal(gate.fingerprint, verified.fingerprint);
    assert.ok([f.hotfix, snapshot.root].includes(gate.cwd), "gates use shared hotfix or its byte-equivalent sealed copy");
    assert.equal(gate.home, f.home);
    assert.ok(gate.command.length > 0);
    assert.ok(existsSync(gate.logPath));
  }
  for (const file of verified.files) assert.equal(sha(join(verified.workspace.cwd, file.path)), file.sha256);
  for (const file of verified.configuration) assert.equal(sha(join(f.root, file.path)), file.sha256);
  assert.ok(verified.files.some(file => file.path === "src/production-runtime.ts"));
  assert.ok(verified.files.some(file => file.path.startsWith("dist/")));
  assert.ok(verified.configuration.some(file => file.path === "conf/projects.json"));
  assert.ok(existsSync(join(f.home, ".raf", "state.sqlite")), "Real smoke initialized an isolated SQLite store");
  assert.ok(existsSync(verified.evidencePath));
  const messageGate = verified.gates.find(gate => gate.name === "agent-message")!;
  const nonce = messageGate.command[messageGate.command.indexOf("--text") + 1];
  assert.ok(nonce);
  await until(() => existsSync(f.inbox) && readFileSync(f.inbox, "utf8").includes(nonce) ? true : undefined, f.budget, f.poll);
  assert.equal(readFileSync(f.inbox, "utf8").split(nonce).length - 1, 1);
  assert.deepEqual(f.liveIdentity(), before);
});

for (const fault of ["build", "runtime-import", "message", "service-ready", "regression"] as const) {
  test(`[hotfix-gates] failed ${fault} never changes live files/ref/index`, { timeout: timeoutMs }, async t => {
    const f = await fixture(t);
    await f.startMain();
    const { workspace } = await f.candidate();
    const paths: string[] = [];
    if (fault === "build") {
      writeFileSync(join(workspace.cwd, "scripts", "build.ts"), "process.stderr.write('fixture build refusal');process.exit(23);\n");
      paths.push("scripts/build.ts");
    }
    if (fault === "runtime-import") {
      writeFileSync(join(workspace.cwd, "src", "production-runtime.ts"), "export const broken = (;\n");
      paths.push("src/production-runtime.ts");
    }
    if (fault === "service-ready") {
      writeFileSync(join(workspace.cwd, "bin", "service.ts"), "process.exit(0);\n");
      paths.push("bin/service.ts");
    }
    if (paths.length) await commitHotfix(f.host, { workspace, paths, message: `fixture fault ${fault}` });
    const before = f.liveIdentity();
    await assert.rejects(verifyHotfixCandidate(f.host, {
      workspace,
      regression: { executable: process.execPath, args: ["-e", fault === "regression" ? "process.exit(29)" : "process.exit(0)"] },
      mainAddress: fault === "message" ? "unregistered-fixture-main" : "main",
      message: `refused-${randomUUID()}`
    }), /build|runtime|import|smoke|message|ready|service|regression|gate/iu);
    assert.deepEqual(f.liveIdentity(), before);
  });
}

test("[hotfix-gates] uncommitted source is rejected before any verification can bless it", { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  const { workspace } = await f.candidate();
  const before = f.liveIdentity();
  writeFileSync(join(workspace.cwd, "hotfix-fixture", "a.mjs"), 'export const marker = "dirty";\n');
  await assert.rejects(verifyHotfixCandidate(f.host, { workspace, regression: { executable: process.execPath, args: ["-e", "process.exit(0)"] }, mainAddress: "main", message: "dirty" }), /dirty|uncommitted|clean/iu);
  assert.deepEqual(f.liveIdentity(), before);
});

for (const status of ["failed", "skipped", "timeout", "absent"] as const) {
  test(`[hotfix-gates] ${status} gate evidence cannot authorize activation`, { timeout: timeoutMs }, async t => {
    const f = await fixture(t);
    await f.startMain();
    const verified = await f.verified();
    const gates = status === "absent" ? verified.gates.filter(gate => gate.name !== "agent-message") : verified.gates.map(gate => gate.name === "agent-message" ? { ...gate, status, code: status === "failed" ? 31 : null } : gate);
    const before = f.liveIdentity();
    await assert.rejects(activateHotfix(f.host, { ...verified, gates }), /evidence|gate|fingerprint|snapshot|verif|missing|timeout|skipped/iu);
    assert.deepEqual(f.liveIdentity(), before);
  });
}

for (const mutation of ["source", "artifact", "configuration", "commit", "same-tree-HEAD", "sealed-source", "sealed-artifact", "sealed-configuration", "forged-report"] as const) {
  test(`[hotfix-snapshot] ${mutation} after green invalidates activation`, { timeout: timeoutMs }, async t => {
    const f = await fixture(t);
    await f.startMain();
    const verified = await f.verified();
    if (mutation.startsWith("sealed-")) {
      const snapshot = assertSealed(f, verified);
      const file = mutation === "sealed-source" ? "hotfix-fixture/a.mjs" : mutation === "sealed-configuration" ? verified.configuration[0]?.path : verified.files.find(file => file.path.startsWith("dist/"))?.path;
      assert.ok(file);
      writeFileSync(join(mutation === "sealed-configuration" ? snapshot.configurationRoot : snapshot.root, file), "changed sealed copy\n");
    }
    if (mutation === "source") writeFileSync(join(verified.workspace.cwd, "hotfix-fixture", "a.mjs"), 'export const marker = "changed-after-green";\n');
    if (mutation === "artifact") {
      const artifact = verified.files.find(file => file.path.startsWith("dist/"));
      assert.ok(artifact, "Build must bind generated artifacts");
      writeFileSync(join(verified.workspace.cwd, artifact.path), "changed artifact\n");
    }
    if (mutation === "configuration") {
      const path = join(f.root, "conf", "raf.json");
      writeFileSync(path, readFileSync(path, "utf8") + "\n");
    }
    if (mutation === "commit") {
      writeFileSync(join(verified.workspace.cwd, "hotfix-fixture", "a.mjs"), 'export const marker = "new-commit";\n');
      await commitHotfix(f.host, { workspace: verified.workspace, paths: ["hotfix-fixture/a.mjs"], message: "after verified commit" });
    }
    if (mutation === "same-tree-HEAD") {
      git(f.hotfix, f.environment, "commit", "--allow-empty", "-m", "another writer advances HEAD without changing the tree");
      assert.equal(git(f.hotfix, f.environment, "rev-parse", "HEAD^{tree}"), verified.tree);
      assert.notEqual(git(f.hotfix, f.environment, "rev-parse", "HEAD"), verified.commit);
    }
    const before = f.liveIdentity();
    const input = mutation === "forged-report" ? { ...verified, fingerprint: "0".repeat(64), evidencePath: join(f.root, "forged-evidence.json") } : verified;
    if (mutation === "forged-report") writeFileSync(input.evidencePath, JSON.stringify({ ...input, status: "succeeded" }));
    await assert.rejects(activateHotfix(f.host, input), /dirty|snapshot|fingerprint|evidence|commit|config|chang|verif/iu);
    assert.deepEqual(f.liveIdentity(), before);
  });
}

test("[hotfix-atomic] real filesystem primitive exchanges the whole directory; unsupported and cross-device cases have no fallback", { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  const current = join(f.root, "switch-current");
  const prepared = join(f.root, "switch-prepared");
  for (const [path, marker] of [[current, "old"], [prepared, "new"]]) {
    mkdirSync(path);
    writeFileSync(join(path, "a"), marker);
    writeFileSync(join(path, "b"), marker);
  }
  const provider = createAtomicHotfixSwitch();
  const capability = await provider.probe(current, prepared);
  assert.equal(capability.supported, true, "Coordinator must provide the real supported activation filesystem");
  assert.equal(capability.sameDevice, true);
  await provider.exchange(current, prepared);
  assert.equal(readFileSync(join(current, "a"), "utf8"), "new");
  assert.equal(readFileSync(join(current, "b"), "utf8"), "new");
  assert.equal(readFileSync(join(prepared, "a"), "utf8"), "old");
  await provider.exchange(current, prepared);
  assert.equal(readFileSync(join(current, "a"), "utf8"), "old");
});

for (const refusal of ["unsupported", "EXDEV"] as const) {
  test(`[hotfix-atomic] ${refusal} refuses activation without checkout/reset/copy fallback`, { timeout: timeoutMs }, async t => {
    const f = await fixture(t);
    await f.startMain();
    const verified = await f.verified();
    let exchanges = 0;
    const failingExternalProvider: AtomicHotfixSwitch = {
      async probe() { return { supported: refusal !== "unsupported", sameDevice: true }; },
      async exchange() { exchanges++; throw Object.assign(new Error("fixture EXDEV"), { code: "EXDEV" }); }
    };
    const before = f.liveIdentity();
    await assert.rejects(activateHotfix(f.host, verified, { switchProvider: failingExternalProvider }), /unsupported|EXDEV|atomic|device/iu);
    assert.equal(exchanges, refusal === "unsupported" ? 0 : 1);
    assert.deepEqual(f.liveIdentity(), before);
  });
}

for (const local of ["tracked", "untracked", "index"] as const) {
  test(`[hotfix-concurrency] local ${local} survives rejected publication byte for byte`, { timeout: timeoutMs }, async t => {
    const f = await fixture(t);
    await f.startMain();
    const verified = await f.verified();
    const path = join(f.main, "hotfix-fixture", local === "untracked" ? "local-sentinel.txt" : "a.mjs");
    writeFileSync(path, "owner-local-change\n");
    if (local === "index") git(f.main, f.environment, "add", "hotfix-fixture/a.mjs");
    const before = f.liveIdentity();
    const sentinel = sha(path);
    await assert.rejects(activateHotfix(f.host, verified), /dirty|index|local|clean|untracked/iu);
    assert.equal(sha(path), sentinel);
    assert.deepEqual(f.liveIdentity(), before);
  });
}

test("[hotfix-concurrency] two publisher processes from one base produce one winner and a stale loser", { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  await f.startMain();
  const a = await f.verified("new-a");
  const b = await f.verified("new-b");
  const sealedA = a.snapshot;
  const sealedB = assertSealed(f, b);
  assert.ok(sealedA);
  assert.notEqual(sealedA.root, sealedB.root);
  assert.equal(a.workspace.cwd, b.workspace.cwd);
  assert.equal(a.workspace.gitDirectory, b.workspace.gitDirectory);
  assert.equal(readFileSync(join(sealedA.root, "hotfix-fixture/a.mjs"), "utf8"), 'export const marker = "new-a";\n');
  const hotfixBefore = hotfixIdentity(f);
  const body = `import {activateHotfix} from ${JSON.stringify(activationModule)};
const p=hotfixFixturePayload;
process.send({ready:true});await new Promise(resolve=>process.once('message',resolve));
try {const result=await activateHotfix(p.host,p.candidate);process.send({ok:true,result});}
catch(error){process.send({ok:false,error:error.message});}process.disconnect();`;
  const left = f.forkModule(body, { host: f.host, candidate: a });
  const right = f.forkModule(body, { host: f.host, candidate: b });
  await Promise.all([childMessage(left, m => m.ready, f.budget), childMessage(right, m => m.ready, f.budget)]);
  const results = [childMessage(left, m => typeof m.ok === "boolean", timeoutMs), childMessage(right, m => typeof m.ok === "boolean", timeoutMs)];
  left.send("go");
  right.send("go");
  const outcomes = await Promise.all(results);
  assert.equal(outcomes.filter(value => value.ok).length, 1);
  const winner = outcomes[0].ok ? a : b;
  const loser = outcomes[0].ok ? b : a;
  assert.equal(winner, b, "new shared HEAD invalidates the older sealed proof before publication");
  assert.match(outcomes.find(value => !value.ok).error, /stale|base|conflict|chang/iu);
  assertMain(f, winner.commit, winner === a ? "new-a" : "new-b");
  const before = f.liveIdentity();
  await assert.rejects(activateHotfix(f.host, loser), /stale|base|conflict|chang/iu);
  assert.deepEqual(f.liveIdentity(), before);
  assert.deepEqual(hotfixIdentity(f), hotfixBefore);
});

for (const kind of ["cli", "service", "worker", "hook", "notice"] as readonly HotfixReaderKind[]) {
  test(`[hotfix-reader] ${kind} process retains one generation across deferred import and switch`, { timeout: timeoutMs }, async t => {
    const f = await fixture(t);
    await f.startMain();
    const verified = await f.verified();
    const hotfixBefore = hotfixIdentity(f);
    const body = `import {acquireHotfixReader} from ${JSON.stringify(activationModule)};
import {pathToFileURL} from 'node:url';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
const p=hotfixFixturePayload;const lease=await acquireHotfixReader(p.host,p.kind);
const first=await import(pathToFileURL(join(lease.generationRoot,'hotfix-fixture/a.mjs')));
process.send({first:first.marker,root:lease.generationRoot,commit:lease.commit});
await new Promise(resolve=>process.once('message',resolve));
const second=await import(pathToFileURL(join(lease.generationRoot,'hotfix-fixture/b.mjs')));
const ps=execFileSync(process.execPath,[join(lease.generationRoot,'bin/raf.ts'),'agent','ps'],{env:process.env,encoding:'utf8'});
process.send({pair:[first.marker,second.marker],ps:JSON.parse(ps)});
await lease.release();process.disconnect();`;
    const reader = f.forkModule(body, { host: f.host, kind });
    const first = await childMessage(reader, m => m.first, f.budget);
    assert.equal(first.first, "old");
    assert.equal(first.commit, f.baseCommit);
    const activated = await activateHotfix(f.host, verified);
    assert.equal(activated.status, "activated");
    const cleanup = await cleanupHotfixActivation(f.host);
    assert.equal(cleanup.removed.includes(first.root), false);
    assert.ok(existsSync(first.root));
    const finished = childMessage(reader, m => m.pair, f.budget);
    reader.send("continue");
    const result = await finished;
    assert.deepEqual(result.pair, ["old", "old"]);
    assert.ok(result.ps.some((session: { addressId: string }) => session.addressId === "main"));
    const next = await acquireHotfixReader(f.host, kind);
    assert.equal(next.commit, verified.commit);
    for (const name of ["a.mjs", "b.mjs"]) assert.equal(readFileSync(join(next.generationRoot, "hotfix-fixture", name), "utf8"), 'export const marker = "new";\n');
    await next.release();
    assertMain(f, verified.commit, "new");
    assert.deepEqual(hotfixIdentity(f), hotfixBefore);
  });
}

const checkpoints: readonly HotfixCheckpoint[] = ["before-intent", "after-intent", "before-switch", "after-switch", "after-refs", "after-index", "after-smoke", "before-cleanup", "after-cleanup"];
for (const phase of checkpoints) {
  test(`[hotfix-recovery] SIGKILL at ${phase}, new process recovery and retry converge without duplicate delivery`, { timeout: timeoutMs }, async t => {
    const f = await fixture(t);
    await f.startMain();
    const verified = await f.verified();
    const hotfixBefore = hotfixIdentity(f);
    const nonce = `recover-${randomUUID()}`;
    const delivered = await f.mainCommand(["agent", "message", "--to", "main", "--text", nonce]);
    assert.equal(delivered.code, 0, delivered.stderr);
    const body = `import {activateHotfix} from ${JSON.stringify(activationModule)};
const p=hotfixFixturePayload;
await activateHotfix(p.host,p.candidate,{checkpoint:async phase=>{
 if(phase===p.phase){process.send({phase});await new Promise(()=>{});}
}});process.disconnect();`;
    const publisher = f.forkModule(body, { host: f.host, candidate: verified, phase });
    await childMessage(publisher, m => m.phase === phase, timeoutMs);
    if (["after-switch", "after-refs", "after-index"].includes(phase)) {
      const enteringBody = `import {acquireHotfixReader} from ${JSON.stringify(activationModule)};
import fs from 'node:fs';import {join} from 'node:path';
const p=hotfixFixturePayload;
try {const lease=await acquireHotfixReader(p.host,'cli');
const pair=['a.mjs','b.mjs'].map(name=>fs.readFileSync(join(lease.generationRoot,'hotfix-fixture',name),'utf8'));
process.send({observed:pair});await lease.release();}
catch(error){process.send({refused:error.message});}process.disconnect();`;
      const entering = f.forkModule(enteringBody, { host: f.host });
      const observed = await childMessage(entering, m => m.observed || m.refused, f.budget);
      if (observed.observed) {
        assert.equal(observed.observed[0], observed.observed[1], "A reader entering an uncertain phase sees a complete generation");
        assert.equal(observed.observed[0], 'export const marker = "old";\n', "An uncertain publication can only admit the complete previous generation");
      } else assert.match(observed.refused, /activation|transition|recover|busy|lock|wait|deadline/iu);
    }
    const exited = once(publisher, "exit");
    publisher.kill("SIGKILL");
    await exited;
    const recoveryBody = `import {recoverHotfixActivation} from ${JSON.stringify(activationModule)};
const p=hotfixFixturePayload;const result=await recoverHotfixActivation(p.host);process.send({recovered:result});process.disconnect();`;
    const restarted = f.forkModule(recoveryBody, { host: f.host });
    const recovered = await childMessage(restarted, m => m.recovered, timeoutMs);
    assert.equal(recovered.recovered.pending, false);
    const commit = git(f.main, f.environment, "rev-parse", "HEAD");
    assert.ok([f.baseCommit, verified.commit].includes(commit));
    assertMain(f, commit, commit === f.baseCommit ? "old" : "new");
    const second = await recoverHotfixActivation(f.host);
    assert.equal(second.pending, false);
    assert.equal(second.commit, commit);
    const result = await activateHotfix(f.host, verified);
    assert.ok(["activated", "already-active"].includes(result.status));
    assertMain(f, verified.commit, "new");
    const repeat = await activateHotfix(f.host, verified);
    assert.equal(repeat.status, "already-active");
    assert.equal((await f.mainCommand(["agent", "ps"])).code, 0);
    await until(() => existsSync(f.inbox) && readFileSync(f.inbox, "utf8").includes(nonce) ? true : undefined, f.budget, f.poll);
    assert.equal(readFileSync(f.inbox, "utf8").split(nonce).length - 1, 1);
    await cleanupHotfixActivation(f.host);
    await cleanupHotfixActivation(f.host);
    assert.ok(existsSync(verified.evidencePath));
    assert.deepEqual(hotfixIdentity(f), hotfixBefore, "recovery never relocates or resets the shared hotfix worktree");
  });
}

test("[hotfix-state-origin] candidate and forged env cannot access fixture production DB; real activated and retained generations can", { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  const initial = f.cli(f.main, ["agent", "ps"], true);
  assert.equal(initial.code, 0, initial.stderr);
  const candidate = await prepareHotfixWorktree(f.host, randomUUID());
  const before = filesUnder(join(f.workingHome, ".raf"));
  const alias = join(f.root, "pretend-main");
  symlinkSync(candidate.cwd, alias);
  for (const cwd of [candidate.cwd, alias]) {
    const denied = f.cli(cwd, ["agent", "ps"], true, { RAF_GENERATION_ROOT: f.main, RAF_PRODUCTION_SNAPSHOT: f.baseCommit, RAF_ACTIVATION_FINGERPRINT: "0".repeat(64), RAF_BRANCH: "main" });
    assert.notEqual(denied.code, 0);
    assert.match(denied.stdout + denied.stderr, /STATE_CONTEXT_REFUSED/u);
    assert.deepEqual(filesUnder(join(f.workingHome, ".raf")), before);
  }
  await f.startMain();
  const previous = await acquireHotfixReader(f.host, "cli");
  const verified = await f.verified();
  const activated = await activateHotfix(f.host, verified);
  assert.equal(f.cli(activated.generationRoot, ["agent", "ps"], true).code, 0);
  assert.equal(f.cli(previous.generationRoot, ["agent", "ps"], true).code, 0);
  const stateBeforeTamper = filesUnder(join(f.workingHome, ".raf"));
  writeFileSync(join(activated.generationRoot, "hotfix-fixture", "a.mjs"), 'export const marker = "tampered-production";\n');
  const denied = f.cli(activated.generationRoot, ["agent", "ps"], true);
  assert.notEqual(denied.code, 0);
  assert.match(denied.stdout + denied.stderr, /STATE_CONTEXT_REFUSED/u);
  assert.deepEqual(filesUnder(join(f.workingHome, ".raf")), stateBeforeTamper);
  await previous.release();
});

test("[hotfix-cleanup] live old generation and foreign resources survive; final release permits bounded idempotent cleanup", { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  await f.startMain();
  const old = await acquireHotfixReader(f.host, "worker");
  const foreign = join(f.root, "foreign-owner-sentinel");
  writeFileSync(foreign, "foreign\n");
  const verified = await f.verified();
  const activated = await activateHotfix(f.host, verified);
  const before = await cleanupHotfixActivation(f.host);
  assert.equal(before.removed.includes(old.generationRoot), false);
  assert.ok(existsSync(old.generationRoot));
  assert.ok(existsSync(activated.generationRoot));
  await old.release();
  await cleanupHotfixActivation(f.host);
  const repeated = await cleanupHotfixActivation(f.host);
  assert.equal(existsSync(old.generationRoot), false);
  assert.deepEqual(repeated.removed, []);
  assert.ok(existsSync(activated.generationRoot));
  assert.equal(readFileSync(foreign, "utf8"), "foreign\n");
  assert.ok(existsSync(verified.evidencePath));
  assertMain(f, verified.commit, "new");
});

test("[hotfix-cleanup] activation failure remains the primary cause when cleanup also fails", { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  await f.startMain();
  const verified = await f.verified();
  const before = f.liveIdentity();
  let cleanupVisited = false;
  await assert.rejects(activateHotfix(f.host, verified, { checkpoint: async phase => {
    if (phase === "before-switch") throw new Error("PRIMARY_FIXTURE_SWITCH_FAILURE");
    if (phase === "before-cleanup") { cleanupVisited = true; throw new Error("SECONDARY_FIXTURE_CLEANUP_FAILURE"); }
  } }), error => {
    assert.match(String(error), /PRIMARY_FIXTURE_SWITCH_FAILURE/u);
    assert.doesNotMatch(String(error), /^Error: SECONDARY_FIXTURE_CLEANUP_FAILURE$/u);
    return true;
  });
  assert.equal(cleanupVisited, true);
  await recoverHotfixActivation(f.host);
  assert.deepEqual(f.liveIdentity(), before);
});

test("[hotfix-production-readers] service/worker/session identity and signed message delivery survive successful publication", { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  await ensureProductionMainStore({ root: f.root });
  await f.startMain();
  const runId = randomUUID();
  const { launchHotfix } = await import("../src/hotfix-worktree.ts");
  const runner = await launchHotfix(f.host, { runId, addressId: `hotfix-${runId.slice(0, 8)}`, features: ["hotfix-fixture"], tasks: ["hotfix-fixture:1.1"], runner: "codex", origin: "agent-run" });
  const verified = await f.verified();
  const started = await f.mainCommand(["service", "start"]);
  assert.equal(started.code, 0, started.stderr);
  const before = JSON.parse((await f.mainCommand(["agent", "ps"])).stdout);
  const session = before.find((value: { runId: string }) => value.runId === runId);
  assert.ok(session);
  const first = `before-switch-${randomUUID()}`;
  const second = `after-switch-${randomUUID()}`;
  assert.equal((await f.mainCommand(["agent", "message", "--to", "main", "--text", first])).code, 0);
  await activateHotfix(f.host, verified);
  assert.equal((await f.mainCommand(["agent", "message", "--to", "main", "--text", second])).code, 0);
  const status = await f.mainCommand(["service", "status"]);
  const ps = await f.mainCommand(["agent", "ps"]);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(ps.code, 0, ps.stderr);
  const surviving = JSON.parse(ps.stdout).filter((value: { runId: string }) => value.runId === runId);
  assert.equal(surviving.length, 1);
  assert.equal(surviving[0].process.runnerSessionId, session.process.runnerSessionId);
  process.kill(runner.pid, 0);
  await until(() => existsSync(f.inbox) && [first, second].every(nonce => readFileSync(f.inbox, "utf8").includes(nonce)) ? true : undefined, f.budget, f.poll);
  const inbox = readFileSync(f.inbox, "utf8");
  for (const nonce of [first, second]) assert.equal(inbox.split(nonce).length - 1, 1);
  assert.match(inbox, /main/iu);
  assert.equal((await f.mainCommand(["service", "stop"])).code, 0);
  assertMain(f, verified.commit, "new", true);
});

test("[hotfix-snapshot] sealing waits for the shared writer and captures its complete committed HEAD", { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  const { workspace } = await f.candidate();
  const liveBefore = f.liveIdentity();
  const body = String.raw`import {withHotfixWriter} from ${JSON.stringify(hostModule)};
import {writeFileSync} from 'node:fs';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
const p=hotfixFixturePayload;
const git=(...args)=>execFileSync('git',['-C',p.workspace.cwd,...args],{env:process.env,encoding:'utf8'}).trim();
await withHotfixWriter(p.host,async()=>{
 const released=new Promise(resolve=>process.once('message',resolve));process.send({holding:true});await released;
 for(const name of ['a.mjs','b.mjs'])writeFileSync(join(p.workspace.cwd,'hotfix-fixture',name),'export const marker = "writer-complete";\n');
 git('add','hotfix-fixture/a.mjs','hotfix-fixture/b.mjs');git('commit','-m','coordinated writer');process.send({committed:git('rev-parse','HEAD')});
});process.disconnect();`;
  const writer = f.forkModule(body, { host: f.host, workspace });
  await childMessage(writer, value => value.holding, f.budget);
  const phases: string[] = [];
  let finished = false;
  const sealing = sealHotfixSnapshot(f.host, workspace, { checkpoint: async phase => { phases.push(phase); } })
    .then(snapshot => ({ snapshot }), error => ({ error }))
    .finally(() => { finished = true; });
  await delay(f.poll);
  const admittedWhileWriting = finished || phases.length > 0;
  const committed = childMessage(writer, value => value.committed, f.budget);
  writer.send("finish");
  const written = await committed;
  const outcome = await sealing;
  assert.equal(admittedWhileWriting, false, "snapshot capture participates in the same writer barrier as commits/refresh");
  assert.ok("snapshot" in outcome, "sealing succeeds after the writer releases its complete commit");
  assert.deepEqual(phases, ["before-copy", "after-copy"]);
  assert.equal(outcome.snapshot.commit, written.committed);
  for (const name of ["a.mjs", "b.mjs"]) assert.equal(readFileSync(join(outcome.snapshot.root, "hotfix-fixture", name), "utf8"), 'export const marker = "writer-complete";\n');
  assert.deepEqual(f.liveIdentity(), liveBefore);
});

test("[hotfix-snapshot] the shared writer cannot enter during copy and resumes without changing the sealed bytes", { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  const { workspace, committed } = await f.candidate();
  const body = String.raw`import {withHotfixWriter} from ${JSON.stringify(hostModule)};
import {writeFileSync} from 'node:fs';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
const p=hotfixFixturePayload;
const go=new Promise(resolve=>process.once('message',resolve));process.send({ready:true});await go;process.send({attempting:true});
await withHotfixWriter(p.host,async()=>{
 for(const name of ['a.mjs','b.mjs'])writeFileSync(join(p.workspace.cwd,'hotfix-fixture',name),'export const marker = "next-writer";\n');
 execFileSync('git',['-C',p.workspace.cwd,'add','hotfix-fixture/a.mjs','hotfix-fixture/b.mjs'],{env:process.env});
 execFileSync('git',['-C',p.workspace.cwd,'commit','-m','next coordinated writer'],{env:process.env});
 process.send({committed:true});
});process.disconnect();`;
  const writer = f.forkModule(body, { host: f.host, workspace });
  await childMessage(writer, value => value.ready, f.budget);
  let writerCommitted = false;
  writer.on("message", (value: any) => { if (value.committed) writerCommitted = true; });
  let completed: Promise<unknown> | undefined;
  const phases: string[] = [];
  let admittedDuringCopy = false;
  const snapshot = await sealHotfixSnapshot(f.host, workspace, { checkpoint: async phase => {
    phases.push(phase);
    if (phase === "before-copy") {
      const attempting = childMessage(writer, value => value.attempting, f.budget);
      completed = childMessage(writer, value => value.committed, timeoutMs);
      completed.catch(() => {});
      writer.send("write");
      await attempting;
    }
    await delay(f.poll);
    admittedDuringCopy ||= writerCommitted;
  } });
  assert.ok(completed, "the writer attempted entry while copying");
  await completed;
  assert.deepEqual(phases, ["before-copy", "after-copy"]);
  assert.equal(admittedDuringCopy, false, "the barrier covers the entire source/config copy and final identity check");
  assert.equal(snapshot.commit, committed.commit);
  assert.notEqual(git(f.hotfix, f.environment, "rev-parse", "HEAD"), snapshot.commit);
  for (const name of ["a.mjs", "b.mjs"]) {
    assert.equal(readFileSync(join(snapshot.root, "hotfix-fixture", name), "utf8"), 'export const marker = "new";\n');
    assert.equal(readFileSync(join(f.hotfix, "hotfix-fixture", name), "utf8"), 'export const marker = "next-writer";\n');
  }
});

for (const phase of ["before-copy", "after-copy"] as const) {
  for (const mutation of ["source", "artifact", "configuration", "new-HEAD"] as const) {
    test(`[hotfix-snapshot] uncoordinated ${mutation} at ${phase} rejects a mixed seal without reverting the writer`, { timeout: timeoutMs }, async t => {
      const f = await fixture(t);
      const { workspace } = await f.candidate();
      let expectedHotfix: ReturnType<typeof hotfixIdentity> | undefined;
      let expectedLive: ReturnType<typeof f.liveIdentity> | undefined;
      await assert.rejects(sealHotfixSnapshot(f.host, workspace, { checkpoint: async checkpoint => {
        if (checkpoint !== phase) return;
        if (mutation === "source" || mutation === "new-HEAD") writeFileSync(join(f.hotfix, "hotfix-fixture/a.mjs"), 'export const marker = "uncoordinated";\n');
        if (mutation === "artifact") writeFileSync(join(f.hotfix, "dist/catalog.json"), "uncoordinated artifact\n");
        if (mutation === "configuration") {
          const config = join(f.root, "conf/raf.json");
          writeFileSync(config, readFileSync(config, "utf8") + "\n");
        }
        if (mutation === "new-HEAD") {
          git(f.hotfix, f.environment, "add", "hotfix-fixture/a.mjs");
          git(f.hotfix, f.environment, "commit", "-m", "uncoordinated new HEAD");
        }
        expectedHotfix = hotfixIdentity(f);
        expectedLive = f.liveIdentity();
      } }), /dirty|snapshot|fingerprint|commit|config|chang|source|artifact/iu);
      assert.ok(expectedHotfix, "the refusal concerns the requested mutation during capture");
      assert.deepEqual(hotfixIdentity(f), expectedHotfix);
      assert.deepEqual(f.liveIdentity(), expectedLive);
    });
  }
}

test("[hotfix-concurrency] duplicate publishers of the same sealed proof exchange main once", { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  await f.startMain();
  const verified = await f.verified();
  const hotfixBefore = hotfixIdentity(f);
  const exchangeLog = join(f.root, "exchanges.jsonl");
  const body = String.raw`import {activateHotfix,createAtomicHotfixSwitch} from ${JSON.stringify(activationModule)};
import {appendFileSync} from 'node:fs';
const p=hotfixFixturePayload;const real=createAtomicHotfixSwitch();
const switchProvider={probe:(...args)=>real.probe(...args),exchange:async(...args)=>{appendFileSync(p.log,JSON.stringify(args)+'\n');await real.exchange(...args);}};
const go=new Promise(resolve=>process.once('message',resolve));process.send({ready:true});await go;
try{process.send({result:await activateHotfix(p.host,p.verified,{switchProvider})});}
catch(error){process.send({error:error.message});}process.disconnect();`;
  const children = [0, 1].map(() => f.forkModule(body, { host: f.host, verified, log: exchangeLog }));
  await Promise.all(children.map(child => childMessage(child, value => value.ready, f.budget)));
  const outcomes = children.map(child => childMessage(child, value => value.result || value.error, timeoutMs));
  for (const child of children) child.send("publish");
  const results = await Promise.all(outcomes);
  assert.equal(results.filter(value => value.result?.status === "activated").length, 1);
  for (const result of results) {
    if (result.error) assert.match(result.error, /stale|base|conflict|chang|busy/iu);
    else assert.ok(["activated", "already-active"].includes(result.result.status));
  }
  assert.equal(readFileSync(exchangeLog, "utf8").trim().split("\n").length, 1);
  assertMain(f, verified.commit, "new");
  assert.deepEqual(hotfixIdentity(f), hotfixBefore);
});

test("[hotfix-cleanup] activation and cleanup preserve the permanent hotfix inode, next commit, index and dirty work", { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  await f.startMain();
  const verified = await f.verified();
  const snapshot = assertSealed(f, verified);
  const before = hotfixIdentity(f);
  await activateHotfix(f.host, verified);
  assert.deepEqual(hotfixIdentity(f), before);
  const later = await f.candidate("next-fix");
  writeFileSync(join(f.hotfix, "hotfix-fixture/owner-untracked.txt"), "future writer\n");
  writeFileSync(join(f.hotfix, "hotfix-fixture/a.mjs"), "future staged work\n");
  git(f.hotfix, f.environment, "add", "hotfix-fixture/a.mjs");
  writeFileSync(join(f.hotfix, "hotfix-fixture/b.mjs"), "future unstaged work\n");
  const expected = hotfixIdentity(f);
  assert.equal(expected.head, later.committed.commit);
  assert.equal(expected.inode, before.inode);
  for (let repeat = 0; repeat < 2; repeat++) {
    const result = await cleanupHotfixActivation(f.host);
    assert.equal(result.removed.includes(f.hotfix), false);
    assert.deepEqual(hotfixIdentity(f), expected);
  }
  assert.equal(readFileSync(join(snapshot.root, "hotfix-fixture/a.mjs"), "utf8"), 'export const marker = "new";\n');
  assertMain(f, verified.commit, "new");
});

test("[hotfix-snapshot] advanced main requires refresh and all fresh gates; an old proof never blesses the merge", { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  await f.startMain();
  const old = await f.verified();
  const originalHotfix = hotfixIdentity(f);
  writeFileSync(join(f.main, "hotfix-fixture/main-only.txt"), "new main input\n");
  git(f.main, f.environment, "add", "hotfix-fixture/main-only.txt");
  git(f.main, f.environment, "commit", "-m", "concurrent main advance");
  const mainHead = git(f.main, f.environment, "rev-parse", "HEAD");
  git(f.root, f.environment, "add", "raf-main");
  git(f.root, f.environment, "commit", "-m", "record concurrent main gitlink");
  const mainBefore = f.liveIdentity();
  await assert.rejects(activateHotfix(f.host, old), /stale|base|conflict|chang/iu);
  assert.deepEqual(f.liveIdentity(), mainBefore);
  assert.deepEqual(hotfixIdentity(f), originalHotfix);
  const refreshed = await prepareHotfixWorktree(f.host, randomUUID());
  assert.equal(refreshed.cwd, f.hotfix);
  assert.equal(refreshed.baseCommit, mainHead);
  git(f.hotfix, f.environment, "merge-base", "--is-ancestor", old.commit, "HEAD");
  git(f.hotfix, f.environment, "merge-base", "--is-ancestor", mainHead, "HEAD");
  const refreshedBefore = hotfixIdentity(f);
  await assert.rejects(activateHotfix(f.host, old), /stale|base|snapshot|fingerprint|commit|chang/iu);
  assert.deepEqual(hotfixIdentity(f), refreshedBefore);
  const fresh = await f.verifyWorkspace(refreshed);
  assertSealed(f, fresh);
  assert.notEqual(fresh.commit, old.commit);
  assert.notEqual(fresh.fingerprint, old.fingerprint);
  assert.deepEqual(fresh.gates.map(gate => gate.name).sort(), [...requiredGates].sort());
  for (const gate of fresh.gates) {
    assert.equal(gate.status, "passed");
    assert.equal(gate.code, 0);
    assert.equal(gate.commit, fresh.commit);
    assert.equal(gate.fingerprint, fresh.fingerprint);
    assert.ok(!old.gates.some(previous => previous.logPath === gate.logPath), "all gates have fresh evidence");
  }
  await activateHotfix(f.host, fresh);
  assertMain(f, fresh.commit, "new");
  assert.equal(readFileSync(join(f.main, "hotfix-fixture/main-only.txt"), "utf8"), "new main input\n");
  assert.equal(hotfixIdentity(f).inode, originalHotfix.inode);
});

test("[hotfix-recovery] recovery reconciles only the sealed target while a later shared HEAD and dirty work survive", { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  await f.startMain();
  const verified = await f.verified();
  const body = `import {activateHotfix} from ${JSON.stringify(activationModule)};
const p=hotfixFixturePayload;
await activateHotfix(p.host,p.verified,{checkpoint:async phase=>{if(phase==='after-switch'){process.send({switched:true});await new Promise(()=>{});}}});`;
  const publisher = f.forkModule(body, { host: f.host, verified });
  await childMessage(publisher, value => value.switched, timeoutMs);
  const exited = once(publisher, "exit");
  publisher.kill("SIGKILL");
  await exited;
  writeFileSync(join(f.hotfix, "hotfix-fixture/a.mjs"), 'export const marker = "not-verified";\n');
  await commitHotfix(f.host, { workspace: verified.workspace, paths: ["hotfix-fixture/a.mjs"], message: "writer after interrupted activation" });
  const laterHead = git(f.hotfix, f.environment, "rev-parse", "HEAD");
  writeFileSync(join(f.hotfix, "hotfix-fixture/owner-untracked.txt"), "pending writer\n");
  writeFileSync(join(f.hotfix, "hotfix-fixture/b.mjs"), "pending staged writer\n");
  git(f.hotfix, f.environment, "add", "hotfix-fixture/b.mjs");
  const expected = hotfixIdentity(f);
  const recoveryBody = `import {recoverHotfixActivation} from ${JSON.stringify(activationModule)};
const p=hotfixFixturePayload;process.send({result:await recoverHotfixActivation(p.host)});process.disconnect();`;
  const recovery = f.forkModule(recoveryBody, { host: f.host });
  const recovered = await childMessage(recovery, value => value.result, timeoutMs);
  assert.equal(recovered.result.pending, false);
  assert.ok([f.baseCommit, verified.commit].includes(recovered.result.commit));
  assert.notEqual(recovered.result.commit, laterHead);
  assertMain(f, recovered.result.commit, recovered.result.commit === f.baseCommit ? "old" : "new");
  assert.deepEqual(hotfixIdentity(f), expected);
  await recoverHotfixActivation(f.host);
  await cleanupHotfixActivation(f.host);
  assert.deepEqual(hotfixIdentity(f), expected);
  assert.equal(readFileSync(join(f.hotfix, "hotfix-fixture/a.mjs"), "utf8"), 'export const marker = "not-verified";\n');
});

test("[hotfix-cycle] main to the same hotfix to atomic main to develop repeats without losing local work", { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  await f.startMain();
  const develop = join(f.root, "raf-develop");
  const hotfixBefore = hotfixIdentity(f);
  const local = join(develop, "developer-untracked.txt");
  writeFileSync(local, "developer work\n");
  const sourceCommits: string[] = [];
  for (const marker of ["cycle-one", "cycle-two"]) {
    const workspace = await prepareHotfixWorktree(f.host, randomUUID());
    assert.equal(workspace.cwd, f.hotfix);
    assert.equal(workspace.baseCommit, git(f.main, f.environment, "rev-parse", "HEAD"));
    assert.equal(statSync(f.hotfix).ino, hotfixBefore.inode);
    for (const name of ["a.mjs", "b.mjs"]) writeFileSync(join(f.hotfix, "hotfix-fixture", name), `export const marker = ${JSON.stringify(marker)};\n`);
    const own = await commitHotfix(f.host, { workspace, paths: ["hotfix-fixture/a.mjs", "hotfix-fixture/b.mjs"], message: marker });
    const verified = await f.verifyWorkspace(workspace);
    assertSealed(f, verified);
    git(f.hotfix, f.environment, "merge-base", "--is-ancestor", own.commit, verified.commit);
    const expectedHotfix = hotfixIdentity(f);
    await activateHotfix(f.host, verified);
    assertMain(f, verified.commit, marker);
    assert.deepEqual(hotfixIdentity(f), expectedHotfix);
    sourceCommits.push(verified.commit);
    git(develop, f.environment, "merge", "--ff-only", verified.commit);
    assert.equal(git(develop, f.environment, "rev-parse", "HEAD"), verified.commit);
    for (const name of ["a.mjs", "b.mjs"]) assert.equal(readFileSync(join(develop, "hotfix-fixture", name), "utf8"), `export const marker = ${JSON.stringify(marker)};\n`);
    assert.equal(readFileSync(local, "utf8"), "developer work\n");
    await cleanupHotfixActivation(f.host);
    assert.deepEqual(hotfixIdentity(f), expectedHotfix);
    if (marker === "cycle-one") {
      writeFileSync(join(f.main, "hotfix-fixture/main-next.txt"), "next main input\n");
      git(f.main, f.environment, "add", "hotfix-fixture/main-next.txt");
      git(f.main, f.environment, "commit", "-m", "main advances before the next correction");
      git(f.root, f.environment, "add", "raf-main");
      git(f.root, f.environment, "commit", "-m", "record next main gitlink");
    }
  }
  assert.notEqual(sourceCommits[0], sourceCommits[1]);
  git(develop, f.environment, "merge-base", "--is-ancestor", sourceCommits[0], sourceCommits[1]);
  assert.equal(readFileSync(join(develop, "hotfix-fixture/main-next.txt"), "utf8"), "next main input\n");
  assert.equal(hotfixIdentity(f).gitDirectory, hotfixBefore.gitDirectory);
});

test("[hotfix-cycle] a develop conflict leaves transfer open and retains main, hotfix and the developer side", { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  await f.startMain();
  const develop = join(f.root, "raf-develop");
  writeFileSync(join(develop, "hotfix-fixture/a.mjs"), 'export const marker = "developer";\n');
  git(develop, f.environment, "add", "hotfix-fixture/a.mjs");
  git(develop, f.environment, "commit", "-m", "independent developer correction");
  const developHead = git(develop, f.environment, "rev-parse", "HEAD");
  const local = join(develop, "developer-untracked.txt");
  writeFileSync(local, "keep developer work\n");
  const verified = await f.verified();
  await activateHotfix(f.host, verified);
  const mainBefore = f.liveIdentity();
  const hotfixBefore = hotfixIdentity(f);
  const transfer = command("git", ["-C", develop, "merge", "--no-edit", verified.commit], develop, f.environment);
  assert.notEqual(transfer.code, 0, "activation is not completion of a conflicting develop transfer");
  assert.equal(git(develop, f.environment, "rev-parse", "HEAD"), developHead);
  assert.equal(git(develop, f.environment, "rev-parse", "MERGE_HEAD"), verified.commit);
  assert.equal(git(develop, f.environment, "show", ":2:hotfix-fixture/a.mjs"), 'export const marker = "developer";');
  assert.equal(git(develop, f.environment, "show", ":3:hotfix-fixture/a.mjs"), 'export const marker = "new";');
  assert.equal(readFileSync(local, "utf8"), "keep developer work\n");
  assertMain(f, verified.commit, "new");
  assert.deepEqual(f.liveIdentity(), mainBefore);
  assert.deepEqual(hotfixIdentity(f), hotfixBefore);
});

test("[hotfix-concurrency] conflicting main refresh cannot activate an old seal or erase either side", { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  await f.startMain();
  const verified = await f.verified();
  const hotfixHead = git(f.hotfix, f.environment, "rev-parse", "HEAD");
  writeFileSync(join(f.main, "hotfix-fixture/a.mjs"), 'export const marker = "main-conflict";\n');
  git(f.main, f.environment, "add", "hotfix-fixture/a.mjs");
  git(f.main, f.environment, "commit", "-m", "independent conflicting main correction");
  const mainHead = git(f.main, f.environment, "rev-parse", "HEAD");
  git(f.root, f.environment, "add", "raf-main");
  git(f.root, f.environment, "commit", "-m", "record conflicting main gitlink");
  const mainBefore = f.liveIdentity();
  await assert.rejects(activateHotfix(f.host, verified), /stale|base|conflict|chang/iu);
  await assert.rejects(prepareHotfixWorktree(f.host, randomUUID()), /conflict|merge|CONFLICT/iu);
  assert.equal(git(f.hotfix, f.environment, "rev-parse", "HEAD"), hotfixHead);
  assert.equal(git(f.hotfix, f.environment, "rev-parse", "MERGE_HEAD"), mainHead);
  assert.equal(git(f.hotfix, f.environment, "show", ":2:hotfix-fixture/a.mjs"), 'export const marker = "new";');
  assert.equal(git(f.hotfix, f.environment, "show", ":3:hotfix-fixture/a.mjs"), 'export const marker = "main-conflict";');
  const conflicted = hotfixIdentity(f);
  await assert.rejects(activateHotfix(f.host, verified), /dirty|merge|conflict|base|stale|snapshot|fingerprint|chang/iu);
  assert.deepEqual(f.liveIdentity(), mainBefore);
  assert.deepEqual(hotfixIdentity(f), conflicted);
});

for (const mutation of ["source", "artifact", "configuration", "new-HEAD"] as const) {
  test(`[hotfix-gates] shared ${mutation} changing during regression cannot receive a green proof`, { timeout: timeoutMs }, async t => {
    const f = await fixture(t);
    await f.startMain();
    const { workspace } = await f.candidate();
    const target = mutation === "configuration" ? join(f.root, "conf/raf.json") : join(f.hotfix, mutation === "artifact" ? "dist/catalog.json" : "hotfix-fixture/a.mjs");
    const script = `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(target)},'\\n \\n');${mutation === "new-HEAD" ? `const {execFileSync}=require('node:child_process');execFileSync('git',['-C',${JSON.stringify(f.hotfix)},'add','hotfix-fixture/a.mjs']);execFileSync('git',['-C',${JSON.stringify(f.hotfix)},'commit','-m','writer during gates']);` : ""}`;
    const before = f.liveIdentity();
    await assert.rejects(verifyHotfixCandidate(f.host, {
      workspace,
      regression: { executable: process.execPath, args: ["-e", script] },
      mainAddress: "main",
      message: `changing-gates-${randomUUID()}`
    }), /dirty|snapshot|fingerprint|commit|config|chang|source|artifact/iu);
    const after = f.liveIdentity();
    assert.deepEqual({ ...after, config: before.config }, before, "input mutation never changes live source/ref/index");
    assert.ok(readFileSync(target, "utf8").endsWith("\n \n"), "a concurrent writer's mutation is preserved");
  });
}
