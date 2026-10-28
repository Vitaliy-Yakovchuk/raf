import test from "node:test";
import assert from "node:assert/strict";
import type { HotfixCheckpoint, HotfixGateName, VerifiedHotfix } from "../src/hotfix-activation.ts";
import {
  createMainSymlinkRelease,
  createMainSymlinkSwitch,
  mainSymlinkActivationOptions,
  type MainReleaseIntent,
  type MainReleasePorts,
  type MainReleaseRequest,
  type MainReleaseSnapshot,
  type MainSlot,
  type MainSymlinkStorage,
} from "../src/main-symlink-release.ts";

const root = "/isolated/orchestrator";
const home = "/isolated/qa-home";
const oid = (value: string) => value.repeat(40);
const fingerprint = (value: string) => value.repeat(64);
const gateNames: HotfixGateName[] = [
  "build", "regression", "runtime-import", "help", "agent-ps", "agent-message",
  "service-start", "service-ready", "service-status", "service-stop",
];

function candidate(kind: "develop" | "hotfix" = "develop", commit = oid("b"), baseCommit = oid("a")): VerifiedHotfix {
  const cwd = `${root}/raf-${kind}`;
  const digest = fingerprint(commit[0]);
  return {
    workspace: {
      runId: "release-fixture", orchestratorRoot: root, project: "raf", targetBranch: "main",
      cwd, baseCommit, repositoryIdentity: "raf-repository", gitDirectory: `${root}/.git/modules/raf`,
      commonDirectory: `${root}/.git/modules/raf`, ownershipPath: `${cwd}/ownership.json`,
    },
    commit, tree: oid(commit[0] === "b" ? "c" : "d"), fingerprint: digest,
    files: [
      { path: "src/version.ts", sha256: fingerprint("1"), mode: 0o644 },
      { path: "dist/cli.js", sha256: fingerprint("2"), mode: 0o755 },
    ],
    configuration: [{ path: "conf/projects.json", sha256: fingerprint("3") }],
    gates: gateNames.map(name => ({
      name, status: "passed", code: 0, command: ["fixture-gate", name], cwd, home,
      commit, fingerprint: digest, logPath: `${home}/logs/${name}.json`,
    })),
    evidencePath: `${home}/evidence.json`,
  };
}

function initialSnapshot(): MainReleaseSnapshot {
  return {
    active: "a",
    slots: {
      a: { root: `${root}/raf-main-a`, commit: oid("a"), fingerprint: fingerprint("a") },
      b: { root: `${root}/raf-main-b`, commit: oid("0"), fingerprint: fingerprint("0") },
    },
    mainRef: oid("a"), head: oid("a"), indexTree: oid("d"),
    gitlink: { path: "raf-main-a", commit: oid("a"), repository: "raf-repository" },
    gitmodules: { path: "raf-main-a", repository: "raf-repository" },
    foreignIndexFingerprint: fingerprint("f"),
    activationComplete: true, handoverComplete: true, readers: { a: [], b: [] },
  };
}

function failure(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function assertOrdered(events: readonly string[], expected: readonly string[]): void {
  let previous = -1;
  for (const event of expected) {
    const position = events.indexOf(event);
    assert.ok(position > previous, `expected ${event} after preceding required events`);
    previous = position;
  }
}

function fixture(kind: "develop" | "hotfix" = "develop") {
  const state = initialSnapshot();
  const sealed = candidate(kind);
  const sourceWorkspace = structuredClone(sealed.workspace);
  sealed.workspace.cwd = state.slots.b.root;
  sealed.gates = sealed.gates.map(gate => ({ ...gate, cwd: state.slots.b.root }));
  const published = new Map<MainSlot, VerifiedHotfix>([["a", candidate("develop", oid("a"))]]);
  const events: string[] = [];
  const writes: string[] = [];
  const sharedCalls = { verify: [] as unknown[][], activate: [] as unknown[][], recover: [] as unknown[][] };
  const snapshotChecks: VerifiedHotfix[] = [];
  const sharedRecords = [{ id: "before", owner: "A" }];
  const agent = { pid: 8123, address: "fixture-agent", session: "%17", runId: "agent-run", tmp: "/isolated/tmp/agent", report: "/isolated/tmp/agent/result.json" };
  const sourceBytes = new Map([["raf-develop", "develop-bytes"], ["raf-hotfix", "hotfix-bytes"]]);
  const slotBytes: Record<MainSlot, string> = { a: "A-source+A-build", b: "B-previous" };
  const temporary = new Map<string, string>();
  let intent: MainReleaseIntent | undefined;
  let lockDepth = 0;
  let failVerify: string | undefined;
  let failSnapshot: string | undefined;
  let failRename: string | undefined;
  let failAfterSwitch: string | undefined;
  let compatible = true;
  let handover = true;
  let supported = true;
  let sameDevice = true;
  let crashAt: HotfixCheckpoint | undefined;
  const storage: MainSymlinkStorage = {
    logicalPath: `${root}/raf-main`,
    async inspect() { events.push("inspect"); return structuredClone(state); },
    async withPublicationLock(operation) {
      assert.equal(lockDepth, 0, "one activation lock must serialize the publication");
      lockDepth++;
      events.push("lock");
      try { return await operation(); }
      finally { events.push("unlock"); lockDepth--; }
    },
    async prepareVerified(value, destination) {
      events.push(`prepare:${destination}`);
      writes.push(`slot:${destination}`);
      slotBytes[destination] = `prepared:${kind}`;
      return sealed;
    },
    async assertSnapshot(value) {
      events.push("assert-snapshot"); snapshotChecks.push(value);
      if (failSnapshot) throw failure(failSnapshot);
    },
    async readIntent() { return intent; },
    async writeIntent(value) {
      assert.equal(lockDepth, 1, "intent must be durable under the publication lock");
      events.push("intent"); intent = structuredClone(value);
    },
    async probeRename() { events.push("probe"); return { supported, sameDevice }; },
    async createTemporarySymlink(target) {
      assert.equal(lockDepth, 1, "switch must run under the shared activation lock");
      const path = `${root}/.raf-main-next`;
      events.push(`symlink:${target}`); temporary.set(path, target); return path;
    },
    async renameSymlink(path, logical) {
      assert.equal(logical, storage.logicalPath);
      assert.equal(path.slice(0, path.lastIndexOf("/")), root, "same parent as raf-main");
      assert.equal(lockDepth, 1);
      if (failRename) throw failure(failRename);
      const target = temporary.get(path);
      assert.ok(target, "rename needs a prepared symlink");
      assert.ok(intent, "durable intent must precede rename");
      const destination = target === state.slots.a.root ? "a" : target === state.slots.b.root ? "b" : undefined;
      assert.ok(destination, "only a registered main slot may become the target");
      state.active = destination;
      temporary.delete(path);
      writes.push("rename"); events.push("rename");
    },
    async removeTemporarySymlink(path) { events.push("remove-temporary"); temporary.delete(path); },
    async reconcileGit(value, active) {
      assert.equal(lockDepth, 1);
      events.push("reconcile-git");
      const next = active === value.destination ? value.candidate : published.get(active)!;
      state.slots[active].commit = next.commit;
      state.slots[active].fingerprint = next.fingerprint;
      state.mainRef = next.commit; state.head = next.commit; state.indexTree = next.tree;
      state.gitlink = { path: `raf-main-${active}`, commit: next.commit, repository: "raf-repository" };
      state.gitmodules = { path: `raf-main-${active}`, repository: "raf-repository" };
      published.set(active, structuredClone(next));
      writes.push("git");
    },
    async clearIntent(id) { assert.equal(intent?.id, id); events.push("clear-intent"); intent = undefined; },
    async resolvePublished(path, digest) {
      return [...published.entries()].some(([slot, value]) => state.slots[slot].root === path && value.fingerprint === digest);
    },
    async loadPublished(slot) {
      const value = published.get(slot);
      assert.ok(value, "rollback uses retained published evidence"); return value;
    },
  };
  const ports: MainReleasePorts = {
    host: { orchestratorRoot: root, qaHome: home, environment: {}, sandboxExecutable: "fixture-sandbox" },
    storage,
    shared: {
      async verify(host, request) {
        sharedCalls.verify.push([host, request]); events.push("shared-verify");
        if (failVerify) throw failure(failVerify);
        return sealed;
      },
      async activate(host, value, options = {}) {
        sharedCalls.activate.push([host, value, options]); events.push("shared-activate");
        assert.equal(lockDepth, 1, "adapter delegates under the publication lock");
        assert.equal(value.workspace.repositoryIdentity, "raf-repository");
        const previous = structuredClone(state);
        const destination: MainSlot = state.active === "a" ? "b" : "a";
        const transition: MainReleaseIntent = { id: `release-${value.commit}`, previous, candidate: value, destination };
        await options.checkpoint?.("before-intent");
        await storage.writeIntent(transition);
        await options.checkpoint?.("after-intent");
        assert.ok(options.switchProvider, "the existing engine must receive the symlink provider");
        await options.checkpoint?.("before-switch");
        await options.switchProvider.exchange(storage.logicalPath, state.slots[destination].root);
        await options.checkpoint?.("after-switch");
        await storage.reconcileGit(transition, state.active);
        await options.checkpoint?.("after-refs");
        await options.checkpoint?.("after-index");
        if (failAfterSwitch) throw failure(failAfterSwitch);
        await options.checkpoint?.("after-smoke");
        await storage.clearIntent(transition.id);
        return { status: "activated", commit: value.commit, fingerprint: value.fingerprint, generationRoot: state.slots[state.active].root };
      },
      async recover(host) {
        sharedCalls.recover.push([host]); events.push("shared-recover");
        assert.equal(lockDepth, 1);
        if (!intent) return { status: "idle", commit: state.mainRef, fingerprint: state.slots[state.active].fingerprint, pending: false };
        const pending = intent;
        await storage.reconcileGit(pending, state.active);
        await storage.clearIntent(pending.id);
        return { status: "recovered", commit: state.mainRef, fingerprint: state.slots[state.active].fingerprint, pending: false };
      },
    },
    async compatibility() { events.push("compatibility"); return { compatible, reason: compatible ? undefined : "SCHEMA_INCOMPATIBLE" }; },
    async confirmHandover(active) {
      events.push(`handover:${active}`);
      state.handoverComplete = handover;
      return handover;
    },
    async checkpoint(phase) { events.push(phase); if (crashAt === phase) throw failure("SIMULATED_CRASH"); },
  };
  const request: MainReleaseRequest = {
    source: { kind, workspace: sourceWorkspace },
    regression: { executable: "node", args: ["--test", "test/release-pure.test.ts"] },
    mainAddress: "qa-main", message: "release-controlled-smoke",
  };
  return {
    state, sealed, storage, ports, request, events, writes, sharedCalls, snapshotChecks, slotBytes,
    sourceBytes, sharedRecords, agent, temporary,
    get intent() { return intent; },
    failVerification(code: string) { failVerify = code; },
    invalidateSnapshot(code: string) { failSnapshot = code; },
    failAtomicRename(code: string) { failRename = code; },
    setProbe(support: boolean, device: boolean) { supported = support; sameDevice = device; },
    setCompatibility(value: boolean) { compatible = value; },
    setHandover(value: boolean) { handover = value; },
    setPostSwitchFailure(code: string | undefined) { failAfterSwitch = code; },
    crash(phase: HotfixCheckpoint | undefined) { crashAt = phase; },
    retire(slot: MainSlot) { published.delete(slot); },
  };
}

function assertConsistent(f: ReturnType<typeof fixture>, active: MainSlot, value: VerifiedHotfix): void {
  assert.equal(f.state.active, active);
  assert.equal(f.state.mainRef, value.commit);
  assert.equal(f.state.head, value.commit);
  assert.equal(f.state.indexTree, value.tree);
  assert.equal(f.state.slots[active].fingerprint, value.fingerprint);
  assert.deepEqual(f.state.gitlink, { path: `raf-main-${active}`, commit: value.commit, repository: "raf-repository" });
  assert.deepEqual(f.state.gitmodules, { path: `raf-main-${active}`, repository: "raf-repository" });
  assert.equal(f.state.foreignIndexFingerprint, fingerprint("f"));
}

for (const kind of ["develop", "hotfix"] as const) {
  test(`release ${kind} A→B delegates exact snapshot to the one hotfix engine`, async () => {
    const f = fixture(kind);
    const api = createMainSymlinkRelease(f.ports);
    const before = structuredClone(f.agent);
    const sources = [...f.sourceBytes];
    const prepared = await api.prepare(f.request);
    assert.equal(prepared.destination, "b");
    assert.equal(prepared.source.kind, kind);
    assert.strictEqual(prepared.candidate, f.sealed);
    assert.equal(f.state.active, "a");
    assert.equal(f.slotBytes.a, "A-source+A-build");
    const result = await api.publish(prepared);
    assert.equal(result.status, "activated");
    assert.equal(result.commit, f.sealed.commit);
    assert.equal(result.fingerprint, f.sealed.fingerprint);
    assert.equal(result.generationRoot, `${root}/raf-main-b`);
    assert.equal(result.handoverComplete, true);
    assert.equal(f.sharedCalls.verify.length, 1);
    assert.equal(f.sharedCalls.activate.length, 1);
    assert.strictEqual(f.sharedCalls.activate[0][1], f.sealed, "no rebuild, second candidate or substituted artifacts");
    assertConsistent(f, "b", f.sealed);
    assert.deepEqual(f.agent, before);
    assert.deepEqual([...f.sourceBytes], sources, "persistent develop/hotfix remains intact");
    assert.equal(f.slotBytes.a, "A-source+A-build");
    assert.equal(f.intent, undefined);
  });
}

test("prepare forwards all common verification inputs with isolated QA host", async () => {
  const f = fixture();
  const api = createMainSymlinkRelease(f.ports);
  await api.prepare(f.request);
  const [host, request] = f.sharedCalls.verify[0] as [MainReleasePorts["host"], Parameters<MainReleasePorts["shared"]["verify"]>[1]];
  assert.strictEqual(host, f.ports.host);
  assert.equal(host.qaHome, home);
  assert.deepEqual(request.regression, f.request.regression);
  assert.equal(request.mainAddress, "qa-main");
  assert.equal(request.message, "release-controlled-smoke");
  assert.equal(request.workspace.baseCommit, oid("a"));
  assert.equal(request.workspace.cwd, `${root}/raf-${f.request.source.kind}`);
  assertOrdered(f.events, ["inspect", "shared-verify", "prepare:b"]);
});

test('publication admits its own durable intent during the common engine second snapshot check', async () => {
  const f = fixture();
  const inspect = f.storage.inspect.bind(f.storage);
  f.storage.inspect = async () => ({ ...await inspect(), activationComplete: !await f.storage.readIntent() });
  f.ports.shared.activate = async (_host, candidate, options = {}) => {
    const publication = options.publication!;
    await publication.assertSnapshot();
    await publication.writeIntent();
    assert.equal((await f.storage.inspect()).activationComplete, false);
    await publication.assertSnapshot();
    await options.switchProvider!.exchange(publication.currentDirectory, publication.preparedDirectory);
    await publication.reconcileGit();
    await publication.clearIntent();
    return { status: 'activated', commit: candidate.commit, fingerprint: candidate.fingerprint, generationRoot: publication.preparedDirectory };
  };
  const api = createMainSymlinkRelease(f.ports);
  const result = await api.publish(await api.prepare(f.request));
  assert.equal(result.active, 'b');
  assert.equal(f.state.active, 'b');
  assert.equal(await f.storage.readIntent(), undefined);
});

for (const blocker of ["activation", "handover", "cli", "worker", "imports", "legacy-agent-channel"] as const) {
  test(`inactive slot is preserved before any write while ${blocker} remains`, async () => {
    const f = fixture();
    if (blocker === "activation") f.state.activationComplete = false;
    else if (blocker === "handover") f.state.handoverComplete = false;
    else f.state.readers.b = [blocker];
    const before = structuredClone(f.state);
    const api = createMainSymlinkRelease(f.ports);
    await assert.rejects(() => api.prepare(f.request), { code: "MAIN_SLOT_BUSY" });
    assert.deepEqual(f.state, before);
    assert.deepEqual(f.writes, []);
    assert.equal(f.slotBytes.b, "B-previous");
    assert.equal(f.sharedCalls.verify.length, 0);
  });
}

for (const name of gateNames) {
  test(`common ${name} failure leaves active source/build/ref/index unchanged`, async () => {
    const f = fixture();
    f.failVerification(`GATE_FAILED:${name}`);
    const before = structuredClone(f.state);
    const api = createMainSymlinkRelease(f.ports);
    await assert.rejects(() => api.prepare(f.request), { code: `GATE_FAILED:${name}` });
    assert.deepEqual(f.state, before);
    assert.equal(f.slotBytes.a, "A-source+A-build");
    assert.equal(f.sharedCalls.activate.length, 0);
    assert.equal(f.writes.includes("rename"), false);
  });
}

for (const missing of ["skipped", "timeout", "missing"] as const) {
  test(`common verification ${missing} evidence is propagated without publication`, async () => {
    const f = fixture("hotfix");
    f.failVerification(`GATE_${missing.toUpperCase()}`);
    const api = createMainSymlinkRelease(f.ports);
    await assert.rejects(() => api.prepare(f.request), { code: `GATE_${missing.toUpperCase()}` });
    assert.equal(f.state.active, "a");
    assert.equal(f.sharedCalls.activate.length, 0);
  });
}

for (const mutation of ["HEAD", "source", "artifacts", "configuration", "file-mode"] as const) {
  test(`changed ${mutation} after gates invalidates sealed snapshot`, async () => {
    const f = fixture("hotfix");
    const api = createMainSymlinkRelease(f.ports);
    const prepared = await api.prepare(f.request);
    f.invalidateSnapshot(`SNAPSHOT_CHANGED:${mutation}`);
    const before = structuredClone(f.state);
    await assert.rejects(() => api.publish(prepared), { code: `SNAPSHOT_CHANGED:${mutation}` });
    assert.deepEqual(f.state, before);
    assert.equal(f.sharedCalls.activate.length, 0);
    assert.equal(f.slotBytes.a, "A-source+A-build");
  });
}

test("winning concurrent publisher makes prepared base stale before intent/rename", async () => {
  const f = fixture();
  const api = createMainSymlinkRelease(f.ports);
  const prepared = await api.prepare(f.request);
  f.state.mainRef = oid("e");
  f.state.head = oid("e");
  const before = structuredClone(f.state);
  await assert.rejects(() => api.publish(prepared), { code: "MAIN_BASE_STALE" });
  assert.deepEqual(f.state, before);
  assert.equal(f.sharedCalls.activate.length, 0);
  assert.equal(f.intent, undefined);
});

for (const changed of ["index", "gitlink", "gitmodules", "foreign-index"] as const) {
  test(`Git ${changed} changed since prepare is not overwritten`, async () => {
    const f = fixture();
    const api = createMainSymlinkRelease(f.ports);
    const prepared = await api.prepare(f.request);
    if (changed === "index") f.state.indexTree = oid("e");
    if (changed === "gitlink") f.state.gitlink.commit = oid("e");
    if (changed === "gitmodules") f.state.gitmodules.repository = "foreign-repository";
    if (changed === "foreign-index") f.state.foreignIndexFingerprint = fingerprint("9");
    const before = structuredClone(f.state);
    await assert.rejects(() => api.publish(prepared), { code: "MAIN_GIT_CHANGED" });
    assert.deepEqual(f.state, before);
    assert.equal(f.sharedCalls.activate.length, 0);
  });
}

test("compatibility refusal precedes intent, rename and shared activation", async () => {
  const f = fixture();
  const api = createMainSymlinkRelease(f.ports);
  const prepared = await api.prepare(f.request);
  f.setCompatibility(false);
  const before = structuredClone(f.state);
  await assert.rejects(() => api.publish(prepared), { code: "SCHEMA_INCOMPATIBLE" });
  assert.deepEqual(f.state, before);
  assert.equal(f.sharedCalls.activate.length, 0);
  assert.equal(f.intent, undefined);
});

for (const mode of ["unsupported", "cross-device", "EXDEV", "ENOTSUP"] as const) {
  test(`atomic ${mode} refuses without copy/unlink or active-file fallback`, async () => {
    const f = fixture();
    if (mode === "unsupported") f.setProbe(false, true);
    if (mode === "cross-device") f.setProbe(true, false);
    if (mode === "EXDEV" || mode === "ENOTSUP") f.failAtomicRename(mode);
    const api = createMainSymlinkRelease(f.ports);
    const prepared = await api.prepare(f.request);
    const before = structuredClone(f.state);
    await assert.rejects(() => api.publish(prepared), {
      code: mode === "unsupported" ? "ATOMIC_SWITCH_UNSUPPORTED" : mode === "cross-device" ? "EXDEV" : mode,
    });
    assert.deepEqual(f.state, before);
    assert.equal(f.slotBytes.a, "A-source+A-build");
    assert.equal(f.writes.includes("rename"), false);
    assert.equal(f.writes.includes("git"), false);
  });
}

test("symlink adapter performs one same-parent atomic rename using the common switch port", async () => {
  const f = fixture();
  const provider = createMainSymlinkSwitch(f.storage);
  assert.deepEqual(await provider.probe(f.storage.logicalPath, `${root}/raf-main-b`), { supported: true, sameDevice: true });
  const options = mainSymlinkActivationOptions(f.storage, f.ports.checkpoint);
  assert.ok(options.switchProvider);
  await f.storage.withPublicationLock(async () => {
    await f.storage.writeIntent({ id: "direct-provider", previous: initialSnapshot(), candidate: f.sealed, destination: "b" });
    await provider.exchange(f.storage.logicalPath, `${root}/raf-main-b`);
  });
  assert.equal(f.state.active, "b");
  assert.deepEqual(f.writes, ["rename"]);
  assert.equal(f.events.filter(event => event.startsWith("symlink:")).length, 1);
  assert.equal(f.temporary.size, 0);
});

for (const phase of ["after-intent", "before-switch", "after-switch", "after-refs", "after-index"] as const) {
  test(`crash at ${phase} delegates recovery once and converges idempotently`, async () => {
    const f = fixture();
    const api = createMainSymlinkRelease(f.ports);
    const prepared = await api.prepare(f.request);
    f.crash(phase);
    await assert.rejects(() => api.publish(prepared), { code: "SIMULATED_CRASH" });
    assert.ok(f.intent, "pending transaction survives publisher failure");
    const afterRename = ["after-switch", "after-refs", "after-index"].includes(phase);
    assert.equal(f.state.active, afterRename ? "b" : "a");
    const fresh = createMainSymlinkRelease(f.ports);
    f.crash(undefined);
    const recovered = await fresh.recover();
    assert.equal(recovered.status, "recovered");
    assert.equal(recovered.pending, false);
    assert.equal(f.sharedCalls.recover.length, 1);
    assert.equal(f.intent, undefined);
    assertConsistent(f, afterRename ? "b" : "a", afterRename ? f.sealed : candidate("develop", oid("a")));
    const writes = f.writes.length;
    assert.equal((await fresh.recover()).status, "idle");
    assert.equal(f.writes.length, writes, "recovery retry does not publish a second release");
    assert.equal(f.state.foreignIndexFingerprint, fingerprint("f"));
  });
}

test("unresolved intent blocks preparing another candidate before overwriting a slot", async () => {
  const f = fixture();
  const api = createMainSymlinkRelease(f.ports);
  const prepared = await api.prepare(f.request);
  f.crash("after-switch");
  await assert.rejects(() => api.publish(prepared), { code: "SIMULATED_CRASH" });
  const writes = f.writes.length;
  await assert.rejects(() => api.prepare(f.request), { code: "MAIN_RECOVERY_REQUIRED" });
  assert.equal(f.writes.length, writes);
});

for (const cause of ["post-switch-smoke", "handover"] as const) {
  test(`rollback after ${cause} returns A while preserving shared records and agents`, async () => {
    const f = fixture();
    const api = createMainSymlinkRelease(f.ports);
    const prepared = await api.prepare(f.request);
    if (cause === "post-switch-smoke") f.setPostSwitchFailure("ACTIVE_SMOKE_FAILED");
    else f.setHandover(false);
    await assert.rejects(() => api.publish(prepared), { code: cause === "handover" ? "MAIN_HANDOVER_INCOMPLETE" : "ACTIVE_SMOKE_FAILED" });
    f.sharedRecords.push({ id: "written-by-B", owner: "B" });
    const records = structuredClone(f.sharedRecords);
    const agent = structuredClone(f.agent);
    f.setPostSwitchFailure(undefined); f.setHandover(true);
    await api.recover();
    const rolled = await api.rollback(prepared);
    assert.equal(rolled.active, "a");
    assert.equal(rolled.handoverComplete, true);
    assertConsistent(f, "a", candidate("develop", oid("a")));
    assert.deepEqual(f.sharedRecords, records, "rollback may not restore a pre-release database snapshot");
    assert.deepEqual(f.agent, agent);
    assert.equal(f.slotBytes.a, "A-source+A-build");
  });
}

test("incompatible rollback refuses before changing B or restoring state", async () => {
  const f = fixture();
  const api = createMainSymlinkRelease(f.ports);
  const prepared = await api.prepare(f.request);
  await api.publish(prepared);
  f.setCompatibility(false);
  f.sharedRecords.push({ id: "new-record", owner: "B" });
  const before = structuredClone(f.state);
  await assert.rejects(() => api.rollback(prepared), { code: "SCHEMA_INCOMPATIBLE" });
  assert.deepEqual(f.state, before);
  assert.equal(f.sharedRecords.at(-1)?.id, "new-record");
});

test("second B→A cycle waits for old A reader then repeats exact gates", async () => {
  const f = fixture();
  const api = createMainSymlinkRelease(f.ports);
  await api.publish(await api.prepare(f.request));
  f.state.readers.a = ["legacy-agent-channel", "worker-import"];
  const bytes = f.slotBytes.a;
  await assert.rejects(() => api.prepare(f.request), { code: "MAIN_SLOT_BUSY" });
  assert.equal(f.slotBytes.a, bytes);
  f.state.readers.a = [];
  const next = candidate("develop", oid("e"), oid("b"));
  Object.assign(f.sealed, next);
  f.request.source.workspace = structuredClone(next.workspace);
  f.sealed.workspace = { ...next.workspace, cwd: f.state.slots.a.root };
  f.sealed.gates = next.gates.map(gate => ({ ...gate, cwd: f.state.slots.a.root }));
  const prepared = await api.prepare(f.request);
  assert.equal(prepared.destination, "a");
  assert.equal(prepared.previous.mainRef, oid("b"));
  const second = await api.publish(prepared);
  assert.equal(second.active, "a");
  assert.equal(f.sharedCalls.verify.length, 2);
  assert.equal(f.sharedCalls.activate.length, 2);
  assertConsistent(f, "a", next);
});

for (const origin of ["develop", "hotfix", "unpublished-slot", "substituted-symlink"] as const) {
  test(`production origin rejects ${origin} despite main naming/ancestry`, async () => {
    const f = fixture();
    const api = createMainSymlinkRelease(f.ports);
    const path = origin === "unpublished-slot" ? `${root}/raf-main-b` : origin === "substituted-symlink" ? `${root}/raf-main` : `${root}/raf-${origin}`;
    await assert.rejects(() => api.resolveProduction(path, f.sealed.fingerprint), { code: "MAIN_GENERATION_UNPUBLISHED" });
    assert.deepEqual(f.sharedRecords, [{ id: "before", owner: "A" }]);
  });
}

test("only published and retained pinned snapshots prove production origin", async () => {
  const f = fixture();
  const api = createMainSymlinkRelease(f.ports);
  await api.publish(await api.prepare(f.request));
  assert.deepEqual(await api.resolveProduction(`${root}/raf-main-b`, f.sealed.fingerprint), {
    root: `${root}/raf-main-b`, commit: f.sealed.commit, fingerprint: f.sealed.fingerprint,
  });
  f.state.readers.a = ["pinned-cli"];
  assert.equal((await api.resolveProduction(`${root}/raf-main-a`, fingerprint("a"))).commit, oid("a"));
  await assert.rejects(() => api.resolveProduction(`${root}/raf-main-b`, fingerprint("9")), { code: "MAIN_GENERATION_UNPUBLISHED" });
});

for (const blocker of ["new-reader", "lost-handover"] as const) {
  test(`publish repeats slot admission when ${blocker} appears after preparation`, async () => {
    const f = fixture();
    const api = createMainSymlinkRelease(f.ports);
    const prepared = await api.prepare(f.request);
    if (blocker === "new-reader") f.state.readers.b = ["late-cli"];
    else f.state.handoverComplete = false;
    const before = structuredClone(f.state);
    await assert.rejects(() => api.publish(prepared), { code: "MAIN_SLOT_BUSY" });
    assert.deepEqual(f.state, before);
    assert.equal(f.sharedCalls.activate.length, 0);
  });
}

test("publication rechecks fingerprint and compatibility under the same lock before activation", async () => {
  const f = fixture();
  const api = createMainSymlinkRelease(f.ports);
  const prepared = await api.prepare(f.request);
  const offset = f.events.length;
  await api.publish(prepared);
  const events = f.events.slice(offset);
  assert.equal(events[0], "lock");
  assertOrdered(events, ["inspect", "shared-activate", "intent", "rename", "after-smoke", "handover:b"]);
  assertOrdered(events, ["assert-snapshot", "shared-activate"]);
  assertOrdered(events, ["compatibility", "shared-activate"]);
  assert.equal(events.at(-1), "unlock");
  assert.ok(f.snapshotChecks.includes(prepared.candidate));
});

test("recovery preserves unrelated staged Orchestrator data added after the crash", async () => {
  const f = fixture();
  const api = createMainSymlinkRelease(f.ports);
  const prepared = await api.prepare(f.request);
  f.crash("after-switch");
  await assert.rejects(() => api.publish(prepared), { code: "SIMULATED_CRASH" });
  f.state.foreignIndexFingerprint = fingerprint("9");
  f.crash(undefined);
  await createMainSymlinkRelease(f.ports).recover();
  assert.equal(f.state.foreignIndexFingerprint, fingerprint("9"));
  assert.equal(f.state.mainRef, f.sealed.commit);
  assert.equal(f.state.gitlink.commit, f.sealed.commit);
});

test("switch options preserve common checkpoint callbacks without introducing another engine", async () => {
  const f = fixture();
  const options = mainSymlinkActivationOptions(f.storage, f.ports.checkpoint);
  assert.strictEqual(options.checkpoint, f.ports.checkpoint);
  assert.ok(options.switchProvider);
  assert.deepEqual(await options.switchProvider.probe(f.storage.logicalPath, `${root}/raf-main-b`), { supported: true, sameDevice: true });
});

for (const mismatch of ["logical-gitlink", "logical-gitmodules", "wrong-repository"] as const) {
  test(`initial ${mismatch} layout is refused before preparing B`, async () => {
    const f = fixture();
    if (mismatch === "logical-gitlink") f.state.gitlink.path = "raf-main";
    if (mismatch === "logical-gitmodules") f.state.gitmodules.path = "raf-main";
    if (mismatch === "wrong-repository") f.state.gitlink.repository = "foreign-repository";
    const before = structuredClone(f.state);
    const api = createMainSymlinkRelease(f.ports);
    await assert.rejects(() => api.prepare(f.request), { code: "MAIN_GIT_INCONSISTENT" });
    assert.deepEqual(f.state, before);
    assert.deepEqual(f.writes, []);
    assert.equal(f.sharedCalls.verify.length, 0);
  });
}

test("retired slot name and old fingerprint no longer prove production origin", async () => {
  const f = fixture();
  const api = createMainSymlinkRelease(f.ports);
  await api.publish(await api.prepare(f.request));
  f.retire("a");
  await assert.rejects(() => api.resolveProduction(`${root}/raf-main-a`, fingerprint("a")), { code: "MAIN_GENERATION_UNPUBLISHED" });
});

test('registered active main symlink admits its physical module in QA and production without admitting an unregistered target', async t => {
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const { join } = await import('node:path');
  const { resolveStateContext } = await import('../src/state-migration-guard.ts');
  const root = mkdtempSync(join(tmpdir(), 'main-origin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['conf', 'raf-main-a/src', 'raf-main-b/src', 'foreign/src', 'account', 'qa']) mkdirSync(join(root, name), { recursive: true });
  for (const slot of ['raf-main-a', 'raf-main-b', 'foreign']) writeFileSync(join(root, slot, 'src/production-entry.ts'), 'export {};\n');
  for (const slot of ['raf-main-a', 'raf-main-b', 'foreign']) execFileSync('git', ['init', '--quiet', join(root, slot)]);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  git(root, 'init', '--quiet');
  for (const slot of ['raf-main-a', 'raf-main-b']) {
    git(join(root, slot), 'add', '.');
    git(join(root, slot), '-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', 'commit', '--quiet', '-m', 'initial');
    git(join(root, slot), 'branch', '-M', 'main');
  }
  const commit = git(join(root, 'raf-main-a'), 'rev-parse', 'HEAD');
  git(root, 'update-index', '--add', '--cacheinfo', '160000', commit, 'raf-main-a');
  git(root, 'config', '-f', '.gitmodules', 'submodule.raf-main.path', 'raf-main-a');
  const config = { version: 1, profiles: { raf: { production: 'main', environments: { runtime: 'main' } } },
    projects: { raf: { profile: 'raf', path: 'raf-main', branchPaths: { main: 'raf-main' }, mainCopies: ['raf-main-a', 'raf-main-b'] } } };
  writeFileSync(join(root, 'conf/projects.json'), JSON.stringify(config));
  writeFileSync(join(root, 'conf/raf.json'), JSON.stringify({ version: 1, state: { fileName: 'state.sqlite' } }));
  symlinkSync('raf-main-a', join(root, 'raf-main'));
  for (const mode of ['qa', 'production']) {
    const home = join(root, mode === 'qa' ? 'qa' : 'account');
    const context = resolveStateContext({ orchestratorRoot: root, modulePath: join(root, 'raf-main-a/src/production-entry.ts'),
      homeDirectory: home, operatingSystemHome: join(root, 'account'), entryPoint: 'cli',
      environment: { HOME: home, ...(mode === 'qa' ? { RAF_QA_HOME: home } : {}) } });
    assert.equal(context.codeRoot, join(root, 'raf-main-a'));
    assert.equal(context.mode, mode);
  }
});
