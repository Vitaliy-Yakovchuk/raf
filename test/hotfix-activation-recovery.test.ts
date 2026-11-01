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

const checkpoints: readonly HotfixCheckpoint[] = ["before-intent", "after-intent", "before-switch", "after-switch", "after-refs", "after-index", "after-smoke", "before-cleanup", "after-cleanup"];

for (const phase of checkpoints) {
  test(`[hotfix-recovery] SIGKILL at ${phase}, new process recovery and retry converge without duplicate delivery`, { timeout: timeoutMs }, async t => {
    const f = await fixture(t, true);
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

test("[hotfix-recovery] recovery reconciles only the sealed target while a later shared HEAD and dirty work survive", { timeout: timeoutMs }, async t => {
  const f = await fixture(t, true);
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
