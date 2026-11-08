import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { activateHotfix, verifyHotfixCandidate } from "../src/hotfix-activation.ts";
import { configurationDigest } from "../src/hotfix-host.ts";
import { fixture, sha, timeoutMs } from "./hotfix-fixture.ts";
import { assertMain, assertSealed } from "./hotfix-activation-assertions.ts";

const registry = "conf/test-runs.json";

function registration(root: string, name: string): string {
  const path = join(root, registry);
  return `const fs=require('node:fs');const path=${JSON.stringify(path)};const registry=JSON.parse(fs.readFileSync(path,'utf8'));registry.projects.raf.groups[${JSON.stringify(name)}]={profileId:'node',files:['test/hotfix-worktree.test.ts']};fs.writeFileSync(path,JSON.stringify(registry,null,2)+'\\n');`;
}

function register(root: string, name: string) {
  const path = join(root, registry);
  const document = JSON.parse(readFileSync(path, "utf8"));
  document.projects.raf.groups[name] = { profileId: "node", files: ["test/hotfix-worktree.test.ts"] };
  writeFileSync(path, JSON.stringify(document, null, 2) + "\n");
}

test("[hotfix-conf-churn] a sealed snapshot keeps gates and activation when conf/test-runs.json changes in orchestratorRoot", { timeout: timeoutMs }, async t => {
  const f = await fixture(t, true);
  await f.startMain();
  const { workspace } = await f.candidate();
  const registryPath = join(f.root, registry);
  const original = readFileSync(registryPath);
  const proof = join(f.root, "sealed-registry-sha.txt");
  const script = `const fs=require('node:fs');const crypto=require('node:crypto');const sealed=process.env.RAF_SEALED_CONFIGURATION_ROOT;if(!sealed){console.error('sealed configuration was not given to the gate');process.exit(2);}const bytes=fs.readFileSync(sealed+'/conf/test-runs.json');fs.writeFileSync(${JSON.stringify(proof)},crypto.createHash('sha256').update(bytes).digest('hex'));const document=JSON.parse(fs.readFileSync(${JSON.stringify(registryPath)},'utf8'));document.projects.raf.profiles.node.argv=document.projects.raf.profiles.node.argv.concat('--live-registry-after-seal');document.liveAfterSeal=${JSON.stringify(randomUUID())};fs.writeFileSync(${JSON.stringify(registryPath)},JSON.stringify(document,null,2)+'\\n');`;
  const verified = await verifyHotfixCandidate(f.host, {
    workspace,
    regression: { executable: process.execPath, args: ["-e", script] },
    mainAddress: "main",
    message: `sealed-conf-${randomUUID()}`
  });
  assert.equal(readFileSync(proof, "utf8"), createHash("sha256").update(original).digest("hex"), "the gate read the sealed registry, not the live file");
  const snapshot = verified.snapshot;
  assert.ok(snapshot, "verification keeps the sealed snapshot");
  const entry = snapshot.configuration.find(file => file.path === registry);
  assert.ok(entry, "the registry stays among the configuration inputs");
  assert.equal(entry.sha256, configurationDigest(registry, original), "the proof records the sealed registry");
  assert.notEqual(configurationDigest(registry, readFileSync(registryPath)), entry.sha256, "the live registry changed after the seal");
  for (const gate of verified.gates) {
    assert.equal(gate.status, "passed");
    assert.equal(gate.fingerprint, verified.fingerprint);
  }
  const result = await activateHotfix(f.host, verified);
  assert.equal(result.status, "activated");
  assert.equal(result.fingerprint, verified.fingerprint);
  assertMain(f, verified.commit, "new");
});

test("[hotfix-conf-churn] a workspace code change after the seal still reports Hotfix snapshot fingerprint changed", { timeout: timeoutMs }, async t => {
  const f = await fixture(t, true);
  await f.startMain();
  const verified = await f.verified();
  const before = f.liveIdentity();
  writeFileSync(join(verified.workspace.cwd, "hotfix-fixture", "a.mjs"), 'export const marker = "changed-after-seal";\n');
  await assert.rejects(activateHotfix(f.host, verified), /Hotfix snapshot fingerprint changed/);
  assert.deepEqual(f.liveIdentity(), before);
});

test("[hotfix-conf-churn] agent group registrations in conf/test-runs.json during gates and before publication keep the proof", { timeout: timeoutMs }, async t => {
  const f = await fixture(t, true);
  await f.startMain();
  const { workspace } = await f.candidate();
  const digestBefore = sha(join(f.root, registry));
  const verified = await verifyHotfixCandidate(f.host, {
    workspace,
    regression: { executable: process.execPath, args: ["-e", registration(f.root, `fixture-change/registered-during-gates-${randomUUID()}`)] },
    mainAddress: "main",
    message: `conf-churn-${randomUUID()}`
  });
  assert.notEqual(sha(join(f.root, registry)), digestBefore, "the regression gate registered a group");
  const snapshot = assertSealed(f, verified);
  const entry = snapshot.configuration.find(file => file.path === registry);
  assert.ok(entry, "the registry stays among the configuration inputs");
  assert.equal(entry.sha256, configurationDigest(registry, readFileSync(join(f.root, registry))));
  for (const gate of verified.gates) {
    assert.equal(gate.status, "passed");
    assert.equal(gate.fingerprint, verified.fingerprint);
  }
  register(f.root, `fixture-change/registered-after-green-${randomUUID()}`);
  const result = await activateHotfix(f.host, verified);
  assert.equal(result.status, "activated");
  assert.equal(result.fingerprint, verified.fingerprint);
  assertMain(f, verified.commit, "new");
});

test("[hotfix-conf-churn] models configuration change after green invalidates activation", { timeout: timeoutMs }, async t => {
  const f = await fixture(t, true);
  await f.startMain();
  const verified = await f.verified();
  const path = join(f.root, "conf/models.json");
  const document = JSON.parse(readFileSync(path, "utf8"));
  document.fixtureChange = randomUUID();
  writeFileSync(path, JSON.stringify(document, null, 2) + "\n");
  const before = f.liveIdentity();
  await assert.rejects(activateHotfix(f.host, verified), /fingerprint|snapshot|config|chang/iu);
  assert.deepEqual(f.liveIdentity(), before);
});

test("[hotfix-conf-churn] a test-runs profile change after green still activates on the sealed registry", { timeout: timeoutMs }, async t => {
  const f = await fixture(t, true);
  await f.startMain();
  const verified = await f.verified();
  const path = join(f.root, registry);
  const document = JSON.parse(readFileSync(path, "utf8"));
  document.projects.raf.profiles.node.argv = [...document.projects.raf.profiles.node.argv, "--fixture-change"];
  writeFileSync(path, JSON.stringify(document, null, 2) + "\n");
  const result = await activateHotfix(f.host, verified);
  assert.equal(result.status, "activated");
  assert.equal(result.fingerprint, verified.fingerprint);
  assertMain(f, verified.commit, "new");
});
