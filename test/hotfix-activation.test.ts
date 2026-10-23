import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { acquireHotfixReader, activateHotfix, cleanupHotfixActivation, createAtomicHotfixSwitch, recoverHotfixActivation, verifyHotfixCandidate, type AtomicHotfixSwitch, type HotfixCheckpoint, type HotfixGateName, type HotfixReaderKind } from "../src/hotfix-activation.ts";
import { commitHotfix, prepareHotfixWorktree } from "../src/hotfix-worktree.ts";
import { childMessage, filesUnder, fixture, git, sha, timeoutMs, until } from "./hotfix-fixture.ts";

const activationModule = new URL("../src/hotfix-activation.ts", import.meta.url).href;
const requiredGates: readonly HotfixGateName[] = ["build", "regression", "runtime-import", "help", "agent-ps", "agent-message", "service-start", "service-ready", "service-status", "service-stop"];

function assertMain(f: Awaited<ReturnType<typeof fixture>>, commit: string, marker: string) {
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
  assert.equal(mainGitDirectory, realpathSync(join(f.root, ".git", "modules", "raf-main")));
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
  assert.equal(verified.commit, git(verified.workspace.cwd, f.environment, "rev-parse", "HEAD"));
  assert.equal(verified.tree, git(verified.workspace.cwd, f.environment, "rev-parse", "HEAD^{tree}"));
  assert.match(verified.fingerprint, /^[0-9a-f]{64}$/u);
  assert.deepEqual(verified.gates.map(gate => gate.name).sort(), [...requiredGates].sort());
  for (const gate of verified.gates) {
    assert.equal(gate.status, "passed", gate.name);
    assert.equal(gate.code, 0, gate.name);
    assert.equal(gate.commit, verified.commit);
    assert.equal(gate.fingerprint, verified.fingerprint);
    assert.equal(gate.cwd, verified.workspace.cwd);
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

for (const mutation of ["source", "artifact", "configuration", "commit", "forged-report"] as const) {
  test(`[hotfix-snapshot] ${mutation} after green invalidates activation`, { timeout: timeoutMs }, async t => {
    const f = await fixture(t);
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
  const body = `import {activateHotfix} from ${JSON.stringify(activationModule)};
const p=JSON.parse(process.env.HOTFIX_FIXTURE_PAYLOAD);
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
  assert.match(outcomes.find(value => !value.ok).error, /stale|base|conflict|chang/iu);
  assertMain(f, winner.commit, winner === a ? "new-a" : "new-b");
  const before = f.liveIdentity();
  await assert.rejects(activateHotfix(f.host, loser), /stale|base|conflict|chang/iu);
  assert.deepEqual(f.liveIdentity(), before);
});

for (const kind of ["cli", "service", "worker", "hook", "notice"] as readonly HotfixReaderKind[]) {
  test(`[hotfix-reader] ${kind} process retains one generation across deferred import and switch`, { timeout: timeoutMs }, async t => {
    const f = await fixture(t);
    await f.startMain();
    const verified = await f.verified();
    const body = `import {acquireHotfixReader} from ${JSON.stringify(activationModule)};
import {pathToFileURL} from 'node:url';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
const p=JSON.parse(process.env.HOTFIX_FIXTURE_PAYLOAD);const lease=await acquireHotfixReader(p.host,p.kind);
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
  });
}

const checkpoints: readonly HotfixCheckpoint[] = ["before-intent", "after-intent", "before-switch", "after-switch", "after-refs", "after-index", "after-smoke", "before-cleanup", "after-cleanup"];
for (const phase of checkpoints) {
  test(`[hotfix-recovery] SIGKILL at ${phase}, new process recovery and retry converge without duplicate delivery`, { timeout: timeoutMs }, async t => {
    const f = await fixture(t);
    await f.startMain();
    const verified = await f.verified();
    const nonce = `recover-${randomUUID()}`;
    const delivered = await f.mainCommand(["agent", "message", "--to", "main", "--text", nonce]);
    assert.equal(delivered.code, 0, delivered.stderr);
    const body = `import {activateHotfix} from ${JSON.stringify(activationModule)};
const p=JSON.parse(process.env.HOTFIX_FIXTURE_PAYLOAD);
await activateHotfix(p.host,p.candidate,{checkpoint:async phase=>{
 if(phase===p.phase){process.send({phase});await new Promise(()=>{});}
}});process.disconnect();`;
    const publisher = f.forkModule(body, { host: f.host, candidate: verified, phase });
    await childMessage(publisher, m => m.phase === phase, timeoutMs);
    if (["after-switch", "after-refs", "after-index"].includes(phase)) {
      const enteringBody = `import {acquireHotfixReader} from ${JSON.stringify(activationModule)};
import fs from 'node:fs';import {join} from 'node:path';
const p=JSON.parse(process.env.HOTFIX_FIXTURE_PAYLOAD);
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
const p=JSON.parse(process.env.HOTFIX_FIXTURE_PAYLOAD);const result=await recoverHotfixActivation(p.host);process.send({recovered:result});process.disconnect();`;
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
  assertMain(f, verified.commit, "new");
});
