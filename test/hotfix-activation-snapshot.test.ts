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
import { activationModule, hostModule, requiredGates, hotfixIdentity, assertSealed, assertMain } from "./hotfix-activation-assertions.ts";

for (const mutation of ["source", "artifact", "configuration", "commit", "forged-report"] as const) {
  test(`[hotfix-snapshot] ${mutation} after green invalidates activation`, { timeout: timeoutMs }, async t => {
    const f = await fixture(t, true);
    await f.startMain();
    const verified = await f.verified();
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
    const before = f.liveIdentity();
    const input = mutation === "forged-report" ? { ...verified, fingerprint: "0".repeat(64), evidencePath: join(f.root, "forged-evidence.json") } : verified;
    if (mutation === "forged-report") writeFileSync(input.evidencePath, JSON.stringify({ ...input, status: "succeeded" }));
    await assert.rejects(activateHotfix(f.host, input), /dirty|snapshot|fingerprint|evidence|commit|config|chang|verif/iu);
    assert.deepEqual(f.liveIdentity(), before);
  });
}

test("[hotfix-snapshot] sealing waits for the shared writer and captures its complete committed HEAD", { timeout: timeoutMs }, async t => {
  const f = await fixture(t, true);
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

test("[hotfix-snapshot] the shared writer cannot enter during manifest capture and may then advance hotfix", { timeout: timeoutMs }, async t => {
  const f = await fixture(t, true);
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
  assert.equal(admittedDuringCopy, false, "the barrier covers manifest capture and the final identity check");
  assert.equal(snapshot.commit, committed.commit);
  assert.notEqual(git(f.hotfix, f.environment, "rev-parse", "HEAD"), snapshot.commit);
  for (const name of ["a.mjs", "b.mjs"]) {
    assert.equal(snapshot.root, f.hotfix);
    assert.equal(readFileSync(join(f.hotfix, "hotfix-fixture", name), "utf8"), 'export const marker = "next-writer";\n');
  }
});

for (const phase of ["before-copy", "after-copy"] as const) {
  for (const mutation of ["source", "artifact", "configuration", "new-HEAD"] as const) {
    test(`[hotfix-snapshot] uncoordinated ${mutation} at ${phase} rejects a mixed seal without reverting the writer`, { timeout: timeoutMs }, async t => {
      const f = await fixture(t, true);
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

test("[hotfix-snapshot] advanced main requires refresh and all fresh gates; an old proof never blesses the merge", { timeout: timeoutMs }, async t => {
  const f = await fixture(t, true);
  await f.startMain();
  const old = await f.verified();
  const originalHotfix = hotfixIdentity(f);
  writeFileSync(join(f.main, "hotfix-fixture/main-only.txt"), "new main input\n");
  git(f.main, f.environment, "add", "hotfix-fixture/main-only.txt");
  git(f.main, f.environment, "commit", "-m", "concurrent main advance");
  const mainHead = git(f.main, f.environment, "rev-parse", "HEAD");
  git(f.root, f.environment, "add", realpathSync(f.main));
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

for (const mutation of ["source", "artifact", "configuration", "new-HEAD"] as const) {
  test(`[hotfix-gates] shared ${mutation} changing during regression cannot receive a green proof`, { timeout: timeoutMs }, async t => {
    const f = await fixture(t, true);
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
