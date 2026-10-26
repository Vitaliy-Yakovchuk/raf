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

test("[hotfix-gates] fixture main acknowledges consecutive signed messages through its native composer", { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  await f.startMain();
  for (const message of [`first-${randomUUID()}`, `second-${randomUUID()}`]) {
    const delivered = await f.mainCommand(["agent", "message", "--to", "main", "--text", message]);
    assert.equal(delivered.code, 0, delivered.stderr);
    assert.equal(JSON.parse(delivered.stdout).accepted, true);
    const received = readFileSync(f.inbox, "utf8");
    assert.equal(received.split(message).length - 1, 1, "the pane receives each signed message once");
  }
});

test("[hotfix-gates] real build/regression/CLI/runtime/SQLite/tmux smoke binds all evidence to exact commit and inputs", { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  await f.startMain();
  const before = f.liveIdentity();
  const verified = await f.verified();
  const snapshot = assertSealed(f, verified);
  assert.equal(verified.commit, git(verified.workspace.cwd, f.environment, "rev-parse", "HEAD"));
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
