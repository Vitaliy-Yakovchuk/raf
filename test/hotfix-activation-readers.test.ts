import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { acquireHotfixReader, activateHotfix, cleanupHotfixActivation, createAtomicHotfixSwitch, recoverHotfixActivation, sealHotfixSnapshot, verifyHotfixCandidate, type AtomicHotfixSwitch, type HotfixCheckpoint, type HotfixGateName, type HotfixReaderKind, type VerifiedHotfix } from "../src/hotfix-activation.ts";
import { commitHotfix, prepareHotfixWorktree } from "../src/hotfix-worktree.ts";
import { ensureProductionMainStore } from "../src/main-production-store.ts";
import { childMessage, command, filesUnder, fixture, git, sha, timeoutMs, until } from "./hotfix-fixture.ts";
import { activationModule, hostModule, requiredGates, hotfixIdentity, assertSealed, assertMain } from "./hotfix-activation-assertions.ts";

test("[hotfix-atomic] real filesystem primitive exchanges the whole directory; unsupported and cross-device cases have no fallback", { timeout: timeoutMs }, async t => {
  const f = await fixture(t, true);
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
    const f = await fixture(t, true);
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

test("[hotfix-concurrency] two publisher processes from one base produce one winner and a stale loser", { timeout: timeoutMs }, async t => {
  const f = await fixture(t, true);
  await f.startMain();
  const a = await f.verified("new-a");
  const b = await f.verified("new-b");
  const sealedA = a.snapshot;
  const sealedB = assertSealed(f, b);
  assert.ok(sealedA);
  assert.equal(sealedA.root, sealedB.root);
  assert.equal(a.workspace.cwd, b.workspace.cwd);
  assert.equal(a.workspace.gitDirectory, b.workspace.gitDirectory);
  assert.equal(readFileSync(join(sealedA.root, "hotfix-fixture/a.mjs"), "utf8"), 'export const marker = "new-b";\n');
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
    const f = await fixture(t, true);
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
const ps=execFileSync(process.execPath,[join(p.host.orchestratorRoot,'raf-main/bin/raf.ts'),'agent','ps'],{env:process.env,encoding:'utf8'});
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

test("[hotfix-cleanup] live old generation and foreign resources survive; final release permits bounded idempotent cleanup", { timeout: timeoutMs }, async t => {
  const f = await fixture(t, true);
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
  assert.equal(existsSync(old.generationRoot), true, "fixed A/B slots survive reader release");
  assert.deepEqual(repeated.removed, []);
  assert.ok(existsSync(activated.generationRoot));
  assert.equal(readFileSync(foreign, "utf8"), "foreign\n");
  assert.ok(existsSync(verified.evidencePath));
  assertMain(f, verified.commit, "new");
});

test("[hotfix-production-readers] service/worker/session identity and signed message delivery survive successful publication", { timeout: timeoutMs }, async t => {
  const f = await fixture(t, true);
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

test("[hotfix-concurrency] duplicate publishers of the same sealed proof exchange main once", { timeout: timeoutMs }, async t => {
  const f = await fixture(t, true);
  await f.startMain();
  const verified = await f.verified();
  const hotfixBefore = hotfixIdentity(f);
  const exchangeLog = join(f.root, "exchanges.jsonl");
  const body = String.raw`import {activateHotfix,createAtomicHotfixSwitch} from ${JSON.stringify(activationModule)};
import {appendFileSync} from 'node:fs';
const {createMainSymlinkSwitch}=await import(new URL('./main-symlink-release.ts',${JSON.stringify(activationModule)}));
const {createProductionMainSymlinkStorage}=await import(new URL('./main-symlink-storage.ts',${JSON.stringify(activationModule)}));
const p=hotfixFixturePayload;const real=createMainSymlinkSwitch(createProductionMainSymlinkStorage(p.host));
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
  const f = await fixture(t, true);
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
  assert.equal(snapshot.root, f.hotfix);
  assertMain(f, verified.commit, "new");
});

test("[hotfix-cycle] main to the same hotfix to atomic main to develop repeats without losing local work", { timeout: timeoutMs }, async t => {
  const f = await fixture(t, true);
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
      git(f.root, f.environment, "add", realpathSync(f.main));
      git(f.root, f.environment, "commit", "-m", "record next main gitlink");
    }
  }
  assert.notEqual(sourceCommits[0], sourceCommits[1]);
  git(develop, f.environment, "merge-base", "--is-ancestor", sourceCommits[0], sourceCommits[1]);
  assert.equal(readFileSync(join(develop, "hotfix-fixture/main-next.txt"), "utf8"), "next main input\n");
  assert.equal(hotfixIdentity(f).gitDirectory, hotfixBefore.gitDirectory);
});

test("[hotfix-cycle] a develop conflict leaves transfer open and retains main, hotfix and the developer side", { timeout: timeoutMs }, async t => {
  const f = await fixture(t, true);
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
  const f = await fixture(t, true);
  await f.startMain();
  const verified = await f.verified();
  const hotfixHead = git(f.hotfix, f.environment, "rev-parse", "HEAD");
  writeFileSync(join(f.main, "hotfix-fixture/a.mjs"), 'export const marker = "main-conflict";\n');
  git(f.main, f.environment, "add", "hotfix-fixture/a.mjs");
  git(f.main, f.environment, "commit", "-m", "independent conflicting main correction");
  const mainHead = git(f.main, f.environment, "rev-parse", "HEAD");
  git(f.root, f.environment, "add", realpathSync(f.main));
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
