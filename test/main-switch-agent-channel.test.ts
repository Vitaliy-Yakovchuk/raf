import assert from "node:assert/strict";
import test from "node:test";
import {
  assessAgentChannelSlotReuse,
  compileAgentChannelNativePolicy,
  routeAgentChannelCommand,
} from "../src/main-switch-agent-channel.ts";
import type {
  AgentChannelGrant,
  AgentChannelPorts,
  AgentChannelRequest,
  AgentNativePolicyInput,
  ChannelCommandOutput,
  ChannelIdentity,
  ChannelPublicationRegistry,
  ChannelSlotReader,
  PinnedChannelExecution,
  PublishedChannelGeneration,
} from "../src/main-switch-agent-channel.ts";

const root = "/fixture/orchestrator";
const slotA = `${root}/raf-main-a`;
const slotB = `${root}/raf-main-b`;
const issuedPrefix = `node ${slotA}/bin/raf.ts`;
const identity: ChannelIdentity = Object.freeze({
  agentId: "fixture-agent-A",
  runId: "fixture-run-A",
  runnerSessionId: "fixture-runner-A",
});

function generation(slot: string, version: string): PublishedChannelGeneration {
  return Object.freeze({
    publicationId: `publication-${version}`,
    slot,
    root: slot,
    entrypoint: `${slot}/bin/raf.ts`,
    executable: "/trusted/bin/node",
    commit: version.repeat(40),
    sourceFingerprint: `source-${version}`,
    buildFingerprint: `build-${version}`,
    catalogFingerprint: `catalog-${version}`,
  });
}

const A = generation(slotA, "a");
const B = generation(slotB, "b");
const nextA = generation(slotA, "c");

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: Error): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const grant: AgentChannelGrant = Object.freeze({
    identity,
    issuedPrefix,
    issuedSlot: slotA,
    workspace: `${root}/raf-develop`,
    allowedSubcommands: ["message", "ps"] as const,
    routing: "trusted-facade",
  });
  const state = {
    caller: identity as ChannelIdentity | null,
    grant: grant as AgentChannelGrant | null,
    registry: {
      revision: "registry-A",
      activePublicationId: A.publicationId,
      publications: [A],
    } as ChannelPublicationRegistry,
    leaseGeneration: null as PublishedChannelGeneration | null,
    pinError: null as Error | null,
    executeError: null as Error | null,
    output: {
      stdout: Buffer.from('{"accepted":true}\n'),
      stderr: Buffer.from(""),
      exitCode: 0,
    } as ChannelCommandOutput,
    executionGate: null as ReturnType<typeof deferred<ChannelCommandOutput>> | null,
  };
  const executions: PinnedChannelExecution[] = [];
  const pins: { generation: PublishedChannelGeneration; revision: string }[] = [];
  const verifiedPids: number[] = [];
  const loadedIdentities: ChannelIdentity[] = [];
  const events: string[] = [];
  const entered = deferred<void>();
  const ports: AgentChannelPorts = {
    async verifyCaller(pid) {
      verifiedPids.push(pid);
      return state.caller;
    },
    async loadGrant(caller) {
      loadedIdentities.push(caller);
      return state.grant;
    },
    async readPublicationRegistry() { return state.registry; },
    async pinGeneration(value, revision) {
      pins.push({ generation: value, revision });
      if (state.pinError) throw state.pinError;
      events.push(`pin:${value.publicationId}`);
      return {
        generation: state.leaseGeneration ?? value,
        async release() { events.push(`release:${value.publicationId}`); },
      };
    },
    async executePinned(input) {
      executions.push(input);
      events.push(`execute:${input.generation.publicationId}`);
      entered.resolve();
      if (state.executeError) throw state.executeError;
      return state.executionGate ? state.executionGate.promise : state.output;
    },
  };
  function publish(active: PublishedChannelGeneration): void {
    state.registry = {
      revision: `registry-${active.publicationId}`,
      activePublicationId: active.publicationId,
      publications: [...state.registry.publications.filter(g => g.slot !== active.slot), active],
    };
  }
  function request(suffix = "agent ps"): AgentChannelRequest {
    return {
      command: `${issuedPrefix} ${suffix}`,
      callerPid: 12001,
      cwd: `${root}/raf-develop`,
      env: {},
    };
  }
  return { state, ports, executions, pins, events, entered, verifiedPids, loadedIdentities, publish, request };
}

test("unchanged absolute prefix A runs message and ps through A, A→B and reused B→A", async () => {
  const f = fixture();
  const brief = Object.freeze({ raf_command: issuedPrefix, identity });
  for (const active of [A, B, nextA]) {
    f.publish(active);
    for (const suffix of ["agent message --to peer --text 'switch delivered'", "agent ps"]) {
      const result = await routeAgentChannelCommand(f.request(suffix), f.ports);
      assert.deepEqual(result, f.state.output);
      const execution = f.executions.at(-1)!;
      assert.deepEqual(execution.generation, active);
      assert.equal(execution.executable, active.executable);
      assert.equal(execution.argv[0], active.entrypoint);
      assert.deepEqual(execution.argv.slice(1), suffix === "agent ps"
        ? ["agent", "ps"] : ["agent", "message", "--to", "peer", "--text", "switch delivered"]);
      assert.deepEqual(execution.sender, identity);
      assert.equal(execution.shell, false);
      assert.equal(brief.raf_command, issuedPrefix);
    }
  }
  assert.deepEqual(f.verifiedPids, Array(6).fill(12001));
  assert.deepEqual(f.loadedIdentities, Array(6).fill(identity));
  assert.equal(f.pins.length, 6);
  assert.equal(f.events.filter(e => e.startsWith("release:")).length, 6);
});

test("an in-flight operation pins the entire old snapshot while the next call uses B", async () => {
  const f = fixture();
  f.state.executionGate = deferred<ChannelCommandOutput>();
  const operation = routeAgentChannelCommand(f.request(), f.ports);
  const firstEvent = await Promise.race([
    f.entered.promise.then(() => "entered"),
    operation.then(() => "completed", () => "rejected"),
  ]);
  assert.equal(firstEvent, "entered");
  f.publish(B);
  assert.deepEqual(f.executions[0].generation, A);
  assert.deepEqual(f.events, [`pin:${A.publicationId}`, `execute:${A.publicationId}`]);
  f.state.executionGate!.resolve(f.state.output);
  await operation;
  assert.equal(f.events.at(-1), `release:${A.publicationId}`);
  f.state.executionGate = null;
  await routeAgentChannelCommand(f.request(), f.ports);
  assert.deepEqual(f.executions[1].generation, B);
  assert.deepEqual(f.pins.at(-1), { generation: B, revision: `registry-${B.publicationId}` });
});

for (const field of ["publicationId", "commit", "sourceFingerprint", "buildFingerprint", "catalogFingerprint", "root", "entrypoint", "executable"] as const) {
  test(`lease mismatch in ${field} refuses execution and releases the lease`, async () => {
    const f = fixture();
    f.state.leaseGeneration = { ...A, [field]: "mutated-snapshot" };
    await assert.rejects(routeAgentChannelCommand(f.request(), f.ports), { code: "CHANNEL_SNAPSHOT_MISMATCH" });
    assert.equal(f.executions.length, 0);
    assert.equal(f.events.at(-1), `release:${A.publicationId}`);
  });
}

test("a stale registry fails closed without retrying against a candidate", async () => {
  const f = fixture();
  f.state.pinError = Object.assign(new Error("registry changed"), { code: "CHANNEL_PUBLICATION_STALE" });
  await assert.rejects(routeAgentChannelCommand(f.request(), f.ports), { code: "CHANNEL_PUBLICATION_STALE" });
  assert.equal(f.executions.length, 0);
  assert.equal(f.pins.length, 1);
});

test("unpublished active snapshot is refused before executing any slot", async () => {
  const f = fixture();
  f.state.registry = { ...f.state.registry, activePublicationId: "unpublished-B" };
  await assert.rejects(routeAgentChannelCommand(f.request(), f.ports), { code: "CHANNEL_PUBLICATION_UNVERIFIED" });
  assert.equal(f.pins.length, 0);
  assert.equal(f.executions.length, 0);
});

test("request cwd and env cannot replace trusted origin, sender or executable", async () => {
  const f = fixture();
  f.publish(B);
  const request = {
    ...f.request(),
    cwd: `${root}/forged-raf-main`,
    env: {
      HOME: "/attacker", PATH: "/attacker/bin", NODE_OPTIONS: "--import=/attacker/hook.mjs",
      RAF_MAIN: `${root}/unpublished`, RAF_AGENT_ID: "main", RAF_RUN_ID: "forged",
    },
  };
  await routeAgentChannelCommand(request, f.ports);
  const execution = f.executions[0];
  assert.deepEqual(execution.generation, B);
  assert.deepEqual(execution.sender, identity);
  assert.equal(execution.executable, "/trusted/bin/node");
  assert.equal(execution.cwd, f.request().cwd);
  assert.equal("env" in execution, false);
});

for (const [label, caller] of [
  ["unregistered caller", null],
  ["different agent", { ...identity, agentId: "other-agent" }],
  ["reused run", { ...identity, runId: "new-run" }],
  ["different runner", { ...identity, runnerSessionId: "other-runner" }],
] as const) {
  test(`${label} cannot inherit the original channel`, async () => {
    const f = fixture();
    f.state.caller = caller;
    await assert.rejects(routeAgentChannelCommand(f.request(), f.ports), { code: "CALLER_UNVERIFIED" });
    assert.equal(f.executions.length, 0);
    assert.equal(f.pins.length, 0);
  });
}

test("a missing trusted grant does not fall back to request env or prefix", async () => {
  const f = fixture();
  f.state.grant = null;
  await assert.rejects(routeAgentChannelCommand(f.request(), f.ports), { code: "CHANNEL_GRANT_MISSING" });
  assert.equal(f.executions.length, 0);
});

test("redirecting a ps-only grant never adds message authority", async () => {
  const f = fixture();
  f.publish(B);
  f.state.grant = { ...f.state.grant!, allowedSubcommands: ["ps"] };
  await assert.rejects(routeAgentChannelCommand(f.request("agent message --to peer --text denied"), f.ports), { code: "CHANNEL_COMMAND_DENIED" });
  assert.equal(f.executions.length, 0);
  assert.deepEqual(await routeAgentChannelCommand(f.request(), f.ports), f.state.output);
});

test("large literal stdout and stderr with nonzero status are preserved byte for byte", async () => {
  const f = fixture();
  f.publish(B);
  f.state.output = {
    stdout: Buffer.from("'\"\n$(touch /forbidden) `false` ; & | ".repeat(20000)),
    stderr: Buffer.concat([Buffer.from([0, 255, 13, 10]), Buffer.from("failure\n".repeat(20000))]),
    exitCode: 23,
  };
  const output = await routeAgentChannelCommand(f.request(), f.ports);
  assert.deepEqual(output, f.state.output);
  assert.equal(f.executions.length, 1);
  assert.equal(JSON.stringify(f.executions[0]).includes("touch /forbidden"), false);
  assert.equal(f.events.at(-1), `release:${B.publicationId}`);
});

test("execution failure releases the pinned snapshot without replay", async () => {
  const f = fixture();
  f.state.executeError = Object.assign(new Error("spawn refused"), { code: "EACCES" });
  await assert.rejects(routeAgentChannelCommand(f.request(), f.ports), { code: "EACCES" });
  assert.equal(f.executions.length, 1);
  assert.equal(f.events.at(-1), `release:${A.publicationId}`);
});

test("concurrent commands preserve separate outputs and release each generation lease", async () => {
  const f = fixture();
  const pending = [deferred<ChannelCommandOutput>(), deferred<ChannelCommandOutput>()];
  const inputs: PinnedChannelExecution[] = [];
  f.ports.executePinned = async input => {
    const index = inputs.push(input) - 1;
    if (index === 1) f.entered.resolve();
    return pending[index].promise;
  };
  const first = routeAgentChannelCommand(f.request("agent message --to peer --text first"), f.ports);
  const second = routeAgentChannelCommand(f.request(), f.ports);
  const entered = await Promise.race([
    f.entered.promise.then(() => true),
    Promise.all([first, second]).then(() => false, () => false),
  ]);
  assert.equal(entered, true);
  const outputs: ChannelCommandOutput[] = [
    { stdout: Buffer.from("first"), stderr: Buffer.from("first-error"), exitCode: 7 },
    { stdout: Buffer.from("second"), stderr: Buffer.from(""), exitCode: 0 },
  ];
  pending[1].resolve(outputs[1]);
  assert.deepEqual(await second, outputs[1]);
  pending[0].resolve(outputs[0]);
  assert.deepEqual(await first, outputs[0]);
  assert.equal(f.events.filter(event => event.startsWith("release:")).length, 2);
});

const forbiddenCommands = [
  `${issuedPrefix} agent run --id intruder`,
  `${issuedPrefix} agent close --id peer`,
  `${issuedPrefix} test run --project raf --phase red`,
  `${issuedPrefix} agent ps --unexpected`,
  `${issuedPrefix} agent message --to peer --text hi --from main`,
  `node ${slotB}/bin/raf.ts agent ps`,
  `node ${root}/raf-main/bin/raf.ts agent ps`,
  `node ${root}/raf-develop/bin/raf.ts agent ps`,
  `node ${root}/raf-hotfix/bin/raf.ts agent ps`,
  `node ${root}/attacker/raf-main-a/bin/raf.ts agent ps`,
  `RAF_MAIN=${slotB} ${issuedPrefix} agent ps`,
  `env RAF_AGENT_ID=main ${issuedPrefix} agent ps`,
  `cd ${root} && ${issuedPrefix} agent ps`,
  `${issuedPrefix} agent ps; id`,
  `${issuedPrefix} agent ps && id`,
  `${issuedPrefix} agent ps | cat`,
  `${issuedPrefix} agent ps > /tmp/leak`,
  `${issuedPrefix} agent ps\nid`,
  `bash -c '${issuedPrefix} agent ps'`,
  `${issuedPrefix} agent message --to peer --text "$(id)"`,
  `${issuedPrefix} agent message --to peer --text "\`id\`"`,
  `${issuedPrefix} agent message --to peer --text hi --to main`,
];

for (const command of forbiddenCommands) {
  test(`channel rejects expanded authority: ${command}`, async () => {
    const f = fixture();
    await assert.rejects(routeAgentChannelCommand({ ...f.request(), command }, f.ports), { code: "CHANNEL_COMMAND_DENIED" });
    assert.equal(f.pins.length, 0);
    assert.equal(f.executions.length, 0);
  });
}

test("quoted shell punctuation in message text stays literal data", async () => {
  const f = fixture();
  const text = "$(id); `whoami` | & < >";
  await routeAgentChannelCommand(f.request(`agent message --to peer --text '${text}'`), f.ports);
  assert.deepEqual(f.executions[0].argv, [A.entrypoint, "agent", "message", "--to", "peer", "--text", text]);
  assert.equal(f.executions[0].shell, false);
});

test("a refused widening does not damage another agent's granted channel", async () => {
  const f = fixture();
  await assert.rejects(routeAgentChannelCommand(f.request("agent close --id peer"), f.ports), { code: "CHANNEL_COMMAND_DENIED" });
  const peer = { ...identity, agentId: "peer", runId: "peer-run", runnerSessionId: "peer-runner" };
  f.state.caller = peer;
  f.state.grant = { ...f.state.grant!, identity: peer };
  assert.deepEqual(await routeAgentChannelCommand(f.request(), f.ports), f.state.output);
  assert.deepEqual(f.executions[0].sender, peer);
});

const readerCases: { name: string; readers: ChannelSlotReader[]; blocking: string[] }[] = [
  { name: "legacy channel without safe routing", readers: [{ id: "legacy", slot: slotA, live: true, kind: "legacy-channel", safeRouting: false }], blocking: ["legacy"] },
  { name: "redirectable channel without proof", readers: [{ id: "unproven", slot: slotA, live: true, kind: "redirectable-channel", safeRouting: false }], blocking: ["unproven"] },
  { name: "active pinned operation", readers: [{ id: "operation", slot: slotA, live: true, kind: "operation", safeRouting: true }], blocking: ["operation"] },
  { name: "safely redirected reader", readers: [{ id: "safe", slot: slotA, live: true, kind: "redirectable-channel", safeRouting: true }], blocking: [] },
  { name: "normally completed legacy reader", readers: [{ id: "finished", slot: slotA, live: false, kind: "legacy-channel", safeRouting: false }], blocking: [] },
  { name: "reader in other slot", readers: [{ id: "other", slot: slotB, live: true, kind: "legacy-channel", safeRouting: false }], blocking: [] },
];

for (const scenario of readerCases) {
  test(`slot reuse: ${scenario.name}`, () => {
    const before = structuredClone(scenario.readers);
    const result = assessAgentChannelSlotReuse({ slot: slotA, readers: scenario.readers });
    assert.deepEqual(result, { reusable: scenario.blocking.length === 0, blockingReaderIds: scenario.blocking });
    assert.deepEqual(scenario.readers, before);
  });
}

const policyInput: AgentNativePolicyInput = {
  mainCopies: [slotA, slotB],
  logicalMain: `${root}/raf-main`,
  activationMetadata: [
    `${root}/.gitmodules`, `${root}/.git/index`, `${root}/.git/refs/heads/main`,
    `${root}/.git/modules/raf/index`, `${root}/.git/modules/raf/refs/heads/main`,
    `${root}/.git/modules/raf/worktrees/main-a`, `${root}/.git/modules/raf/worktrees/main-b`,
    `${root}/.git/modules/raf/activation`,
  ],
  writableRoots: [root, `${root}/raf-hotfix`],
  exactWritableFiles: [`${root}/questions/projects/raf/questions.md`],
  denyReadPaths: [
    "/fixture/home/.raf/state.sqlite", "/fixture/home/.raf/state.sqlite-wal",
    "/fixture/home/.raf/state.sqlite-shm", "/fixture/home/.raf/bugs.sqlite",
    "/fixture/home/.raf/secrets.json", "/fixture/home/.raf/tmp/other-run",
    "/run", "/tmp/tmux-1000", "/tmp/cc-socks",
  ],
  denyConnectPaths: [
    "/fixture/home/.raf/tmp/raf.sock", "/tmp/tmux-1000/default", "/run/user/1000/bus",
    "/fixture/ssh/agent.sock", `${root}/registered-main.sock`,
  ],
  issuedCommandPrefixes: [`${issuedPrefix} agent message`, `${issuedPrefix} agent ps`],
};

for (const target of [
  ...policyInput.mainCopies, policyInput.logicalMain, ...policyInput.activationMetadata,
]) {
  test(`native policy protects main code or activation path: ${target}`, async () => {
    const policy = await compileAgentChannelNativePolicy(policyInput, { async canonicalPath(path) {
      return path === policyInput.logicalMain ? slotA : path;
    } });
    assert.equal(policy.providerRequired, true);
    assert.ok(policy.readOnlyPaths.includes(target));
    assert.ok(policy.readOnlyPaths.includes(target === policyInput.logicalMain ? slotA : target));
    assert.deepEqual(policy.writableRoots, policyInput.writableRoots);
    assert.deepEqual(policy.exactWritableFiles, policyInput.exactWritableFiles);
  });
}

test("native policy retains every baseline read/connect deny and the exact original command grants", async () => {
  const before = structuredClone(policyInput);
  const policy = await compileAgentChannelNativePolicy(policyInput, { async canonicalPath(path) { return path; } });
  for (const path of policyInput.denyReadPaths) assert.ok(policy.denyReadPaths.includes(path), path);
  for (const path of policyInput.denyConnectPaths) assert.ok(policy.denyConnectPaths.includes(path), path);
  assert.deepEqual(policy.issuedCommandPrefixes, policyInput.issuedCommandPrefixes);
  assert.deepEqual(policyInput, before);
});

test("native policy protects canonical Git aliases as well as the spelling granted for develop", async () => {
  const metadataAlias = `${root}/.git/modules/raf/worktrees/main-a`;
  const canonical = "/fixture/git-common/worktrees/main-a";
  const policy = await compileAgentChannelNativePolicy(policyInput, { async canonicalPath(path) {
    return path === metadataAlias ? canonical : path;
  } });
  assert.ok(policy.readOnlyPaths.includes(metadataAlias));
  assert.ok(policy.readOnlyPaths.includes(canonical));
});
