import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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

for (const mutation of ["models", "registry-profile"] as const) {
  test(`[hotfix-conf-churn] ${mutation} configuration change after green invalidates activation`, { timeout: timeoutMs }, async t => {
    const f = await fixture(t, true);
    await f.startMain();
    const verified = await f.verified();
    const path = join(f.root, mutation === "models" ? "conf/models.json" : registry);
    const document = JSON.parse(readFileSync(path, "utf8"));
    if (mutation === "models") document.fixtureChange = randomUUID();
    else document.projects.raf.profiles.node.argv = [...document.projects.raf.profiles.node.argv, "--fixture-change"];
    writeFileSync(path, JSON.stringify(document, null, 2) + "\n");
    const before = f.liveIdentity();
    await assert.rejects(activateHotfix(f.host, verified), /fingerprint|snapshot|config|chang/iu);
    assert.deepEqual(f.liveIdentity(), before);
  });
}
