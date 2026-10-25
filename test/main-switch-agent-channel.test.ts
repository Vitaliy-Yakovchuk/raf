import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentChannelReadOnlyPaths, runPublishedAgentChannel } from "../src/main-switch-agent-launcher.ts";
import { codexBwrapWrapper, protectCodexReadOnlyPaths } from "../src/codex-sandbox.ts";
import { compileCatalog } from "../src/catalog.ts";
import { execute } from "../src/cli.ts";
import { resolveWorkspaceRoute } from "../src/workspace-routing.ts";
import { createWorkspacePorts } from "../src/os-runtime.ts";
import { prepareProductionQaFixture, copyProductionQaDependencies } from "./production-qa-fixture.ts";
import { negativePeerCommand, drainStandServiceReader, normalizeStandReflog, nativeActorPlan, releaseNativeStage, captureCompletedNativeActors, nativeCompletionReceipt } from "../scripts/qa-main-agent-channel-metadata.mjs";
import { createStandGeneration } from "../scripts/qa-main-agent-generation.mjs";
import { verifyHotfixRuntimeInventory } from "../src/hotfix-runtime-inventory.ts";
import * as generationHost from "../src/hotfix-host.ts";
import { alive, processStart } from "../src/hotfix-host.ts";
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

import { captureStateReadControls, assertNativeDenial, nativeProbeReceipt } from "../scripts/qa-main-agent-denial.mjs";

const root = "/fixture/orchestrator";

test("native final transcript waits for both final gates and native CLI completion", async () => {
  const released: string[] = [];
  const finished: string[] = [];
  const snapshots = await captureCompletedNativeActors({ actors: ["a", "b"],
    gate: (actor: string) => released.push(actor),
    wait: async (actor: string) => { assert.deepEqual(released, ["a", "b"]); finished.push(actor); },
    capture: () => { assert.deepEqual(finished.sort(), ["a", "b"], "Copying before helper 3 exits leaves its native result unexecuted"); return ["a-native", "b-native"]; },
  });
  assert.deepEqual(snapshots, ["a-native", "b-native"]);
});

test("native final receipt requires the exact run and an actual completed exec output", () => {
  const call = { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "native-finish" } };
  const result = (receipt: object) => ({ type: "response_item", timestamp: "2026-10-25T00:00:00Z", payload: { type: "custom_tool_call_output", call_id: "native-finish", output: [{ type: "input_text", text: JSON.stringify(receipt) }] } });
  const receipt = { sym64NativeCompleted: 3, runId: "native-a", finalCliExitCode: 0 };
  const transcript = (...events: object[]) => events.map(event => JSON.stringify(event)).join("\n") + "\n";
  assert.deepEqual(nativeCompletionReceipt(transcript(call, result(receipt)), "native-a").receipt, receipt);
  assert.equal(nativeCompletionReceipt(transcript(result(receipt)), "native-a"), false);
  assert.equal(nativeCompletionReceipt(transcript(call), "native-a"), false);
  assert.equal(nativeCompletionReceipt(transcript(call, result(receipt)), "native-b"), false);
  assert.equal(nativeCompletionReceipt(transcript(call, result({ ...receipt, finalCliExitCode: 1 })), "native-a"), false);
  assert.equal(nativeCompletionReceipt(transcript(call, result({ ...receipt, sym64NativeCompleted: 2 })), "native-a"), false);
  assert.equal(nativeCompletionReceipt(transcript(call, { ...result(receipt), type: "event_msg" }), "native-a"), false);
  assert.equal(nativeCompletionReceipt(transcript(call) + '{"partial":', "native-a"), false);
});

test("native actor assignment stays small enough for complete repeated ps output", () => {
  const actors = ["a", "b"].map(nativeActorPlan);
  const output = JSON.stringify(actors.map(plan => ({ assignment: plan.item, activity: { description: plan.item }, launchContext: { description: plan.item } })));
  assert.ok(Buffer.byteLength(output) < 8192, "PS repeats the assigned item; put the full workflow in a stable fixture file");
  for (const plan of actors) {
    for (const stage of [0, 1, 2, 3]) assert.ok(plan.instructions.includes("node qa/sym64-probe.mjs " + stage));
    assert.ok(plan.instructions.includes("agent ps"));
    assert.ok(plan.instructions.includes("agent close --id"));
  }
});

test("native host releases both actors before awaiting either stage", async () => {
  const released: string[] = [];
  const controls: string[] = [];
  await releaseNativeStage({ actors: ["a", "b"],
    writeControls: (actor: string) => controls.push(actor),
    gate: (actor: string) => { assert.ok(controls.includes(actor)); released.push(actor); },
    wait: async () => { assert.deepEqual(released, ["a", "b"], "A stalled actor must not keep its live peer behind the host gate"); },
  });
});

test("native hidden state denial requires exact existing host controls and refuses missing fixtures", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "native-read-controls-"));
  try {
    const names = ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm", "secrets.json"];
    for (const name of names) await fs.writeFile(join(directory, name), "isolated host sentinel");
    const controls = captureStateReadControls(directory);
    const target = join(directory, "state.sqlite");
    const hiddenRead = { target, control: controls[0] };
    const masked = { cliExitCode: 1, signal: null, stderr: "Error: ENOENT: no such file or directory, open hidden alias" };
    assert.doesNotThrow(() => assertNativeDenial(masked, hiddenRead), "Native none policy masks an existing file as ENOENT");
    assert.throws(() => assertNativeDenial(masked), /permission denial/);
    assert.throws(() => assertNativeDenial(masked, { target: target + ".missing", control: controls[0] }));
    assert.throws(() => assertNativeDenial(masked, { target, control: { ...controls[0], regularFile: false } }));
    assert.throws(() => assertNativeDenial({ ...masked, cliExitCode: 0 }, hiddenRead));
    assert.throws(() => assertNativeDenial({ ...masked, signal: "SIGTERM" }, hiddenRead));
    assert.throws(() => assertNativeDenial({ ...masked, stderr: "fixture setup failed" }, hiddenRead));
    assert.doesNotThrow(() => assertNativeDenial({ ...masked, stderr: "EROFS: read-only file system" }));
    await fs.unlink(join(directory, "state.sqlite-wal"));
    assert.throws(() => captureStateReadControls(directory), /ENOENT/, "A missing WAL cannot become a passing denial");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("native probe stdout stays bounded while its receipt verifies the complete large report", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "native-report-receipt-"));
  try {
    const report = join(directory, "stage.json");
    const value = { stage: 1, runId: "native-receipt-fixture", status: "passed", results: [{ stderr: "large negative result".repeat(60000), cliExitCode: 1 }] };
    const bytes = JSON.stringify(value, null, 2) + "\n";
    await fs.writeFile(report, bytes);
    const receipt = nativeProbeReceipt(value, report);
    assert.ok(JSON.stringify(receipt).length < 1024, "Native tools must receive a small receipt instead of truncating the full probe report");
    assert.equal(receipt.report, report);
    assert.equal(receipt.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(receipt.results, 1);
    assert.equal(receipt.runId, value.runId);
    assert.equal(receipt.status, "passed");
    assert.deepEqual(JSON.parse(await fs.readFile(report, "utf8")), value, "The large raw report remains complete and unchanged");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("native host read transaction preserves SQLite sidecars after the writer exits", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "native-state-lifetime-"));
  let reader: DatabaseSync | undefined;
  let writer: DatabaseSync | undefined;
  try {
    writer = new DatabaseSync(join(directory, "state.sqlite"));
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('isolated');");
    await fs.writeFile(join(directory, "secrets.json"), "isolated sentinel");
    reader = new DatabaseSync(join(directory, "state.sqlite"), { readOnly: true });
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) FROM sqlite_schema").get();
    const before = captureStateReadControls(directory);
    writer.close(); writer = undefined;
    assert.deepEqual(captureStateReadControls(directory), before, "The same host files must exist while native read probes run");
  } finally { writer?.close(); reader?.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("native stand drains only its host service reader before migration and preserves actors", { timeout: 10000 }, async () => {
  const service = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  const actor = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  await Promise.all([once(service, "spawn"), once(actor, "spawn")]);
  const serviceStart = await processStart(service.pid!);
  const actorStart = await processStart(actor.pid!);
  try {
    const commands: string[][] = [];
    await drainStandServiceReader({ service: { pid: service.pid }, processStart, alive,
      request: async (_label: string, command: string[]) => {
        commands.push(command);
        service.kill("SIGTERM");
        return { cliExitCode: 0, stdout: JSON.stringify({ state: "stopped" }) };
      },
      wait: async (_label: string, ready: () => Promise<boolean>) => { while (!await ready()) await delay(10); },
    });
    assert.equal(await alive(service.pid!, serviceStart), false, "A successful fixture drain must wait for the actual service reader exit");
    assert.deepEqual(commands, [["service", "stop"]]);
    assert.equal(await alive(actor.pid!, actorStart), true, "Draining a host service must preserve the native actor identity");
    await assert.rejects(drainStandServiceReader({ service: { pid: actor.pid }, processStart, alive,
      request: async () => ({ cliExitCode: 1, stdout: "", stderr: "fixture stop refused" }),
      wait: async () => assert.fail("A failed stop cannot permit migration"),
    }), /fixture stop refused/);
    assert.equal(await alive(actor.pid!, actorStart), true);
  } finally {
    for (const child of [service, actor]) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
  }
});

test("native QA negative CLI probe exercises protected runtime rather than public catalog output", async () => {
  const configuration = async (name: string) => JSON.parse(await fs.readFile(new URL('../../conf/' + name, import.meta.url), 'utf8'));
  const constants = await configuration('raf-constants.json');
  const catalog = compileCatalog(constants, await configuration('models.json'), constants.commands.map((command: { path: string[] }) => command.path.join(' ')), await configuration('projects.json'));
  let runtimeCalls = 0;
  const result = await execute(negativePeerCommand('sym64-peer'), catalog, new Proxy(Object.create(null), {
    get: () => async () => { runtimeCalls++; throw new Error('Protected runtime denied'); },
  }));
  assert.equal(runtimeCalls, 1, 'A catalog-only command cannot prove denial of protected host operations');
  assert.notEqual(result.exitCode, 0);
});
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

async function publishedLauncherFixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "raf-launcher-"));
  const source = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
  const A = join(root, "raf-main-a");
  const B = join(root, "raf-main-b");
  const home = join(root, "qa-home");
  const work = join(root, "work");
  const environment = { ...process.env, HOME: home, RAF_QA_HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args: string[]) => execFileSync("git", ["-C", A, ...args], { env: environment, encoding: "utf8" }).trim();
  try {
    for (const directory of [join(root, "conf"), join(A, "bin"), home, work]) await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(join(A, "bin/raf.ts"), `import{readdirSync}from'node:fs';process.stdout.write(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),entrypoint:process.argv[1],pinned:readdirSync(process.env.CHANNEL_CONTROL+'/readers').length>0})+'\\n');process.stderr.write('literal $() stderr\\n');process.exitCode=17;`);
    git("init", "-b", "main");
    git("add", "bin");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "published fixture");
    execFileSync("git", ["-C", root, "init", "-b", "main"], { env: environment });
    execFileSync("git", ["-C", root, "-c", "protocol.file.allow=always", "submodule", "add", "--name", "raf-main", "./raf-main-a", "raf-main-a"], { env: environment });
    execFileSync("git", ["-C", root, "submodule", "absorbgitdirs"], { env: environment });
    git("worktree", "add", "-b", "develop", join(root, "raf-develop"), "HEAD");
    git("worktree", "add", "--detach", B, "HEAD");
    await fs.symlink(A, join(root, "raf-main"));
    await fs.writeFile(join(root, "conf/projects.json"), JSON.stringify({ version: 1, profiles: { fixture: { production: "main", environments: { runtime: "main" } } }, projects: { raf: { profile: "fixture", path: "raf-main", branchPaths: { main: "raf-main", develop: "raf-develop" }, mainCopies: ["raf-main-a", "raf-main-b"] } } }));
    await fs.writeFile(join(root, "conf/raf.json"), JSON.stringify({ version: 1, state: { fileName: "state.sqlite" }, runnerProtocols: [{ runner: "codex", timeouts: { transitionMs: 10000 } }] }));
    const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
    for (const directory of [A, join(root, "raf-develop")]) {
      await fs.cp(join(source, "src"), join(directory, "src"), { recursive: true });
      await fs.cp(join(source, "scripts"), join(directory, "scripts"), { recursive: true });
      await fs.writeFile(join(directory, "package.json"), '{"type":"module"}\n');
    }
    await fs.copyFile(join(source, "bin/service.ts"), join(A, "bin/service.ts"));
    git("add", "--", "src", "bin", "scripts", "package.json");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Complete published runtime fixture");
    execFileSync("git", ["-C", root, "add", "--", "raf-main-a", ".gitmodules"], { env: environment });
    const { ensureProductionMainStore } = await import("../src/main-production-store.ts");
    await ensureProductionMainStore({ root });
    copyProductionQaDependencies(A);
    copyProductionQaDependencies(join(root, "raf-develop"));
    return { root, A, B, home, work, source: join(root, "raf-develop"), git, common, environment };
  } catch (error) { await fs.rm(root, { recursive: true, force: true }); throw error; }
}

test("native stand registers a complete runtime inventory before publishing each generation", async () => {
  const f = await publishedLauncherFixture();
  try {
    const commit = f.git("rev-parse", "HEAD");
    const generation = await createStandGeneration(f.A, commit, generationHost);
    verifyHotfixRuntimeInventory(f.A, commit, generation.runtimeInventory, join(f.A, "src/production-entry.ts"));
    await fs.appendFile(join(f.A, "src/production-entry.ts"), "\nexport const tamperedFixture = true;\n");
    assert.throws(() => verifyHotfixRuntimeInventory(f.A, commit, generation.runtimeInventory), /runtime inputs changed/);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("public CLI pins the active physical main slot before loading its runtime", async () => {
  const f = await publishedLauncherFixture();
  try {
    await fs.cp(join(f.source, "src"), join(f.A, "src"), { recursive: true });
    await fs.cp(join(f.source, "package.json"), join(f.A, "package.json"));
    await fs.mkdir(join(f.A, "dist"));
    const configuration = async (name: string) => JSON.parse(await fs.readFile(new URL('../../conf/' + name, import.meta.url), 'utf8'));
    const constants = await configuration('raf-constants.json');
    const catalog = compileCatalog(constants, await configuration('models.json'), constants.commands.map((command: { path: string[] }) => command.path.join(' ')), await configuration('projects.json'));
    await fs.writeFile(join(f.A, "dist/catalog.json"), JSON.stringify(catalog));
    await fs.writeFile(join(f.A, "src/production-entry.ts"), `import{existsSync,readdirSync}from'node:fs';export async function runProductionCli(){return{exitCode:17,stderr:'',stdout:JSON.stringify({origin:import.meta.url,pinned:existsSync(process.env.CHANNEL_CONTROL+'/readers')&&readdirSync(process.env.CHANNEL_CONTROL+'/readers').length>0})}}`);
    f.git("add", "--", "src", "package.json", "dist/catalog.json");
    f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "physical main CLI fixture");
    execFileSync("git", ["-C", f.root, "add", "--", "raf-main-a", ".gitmodules"], { env: f.environment });
    const script = `const{runPublicCli}=await import(${JSON.stringify(new URL("file://" + join(f.A, "src/cli.ts")).href)});const result=await runPublicCli(${JSON.stringify(new URL("file://" + join(f.A, "bin/raf.ts")).href)},['agent','ps']);console.log(JSON.stringify(result));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: f.work, env: { ...f.environment, RAF_ORCHESTRATOR_ROOT: f.root, CHANNEL_CONTROL: join(f.common, "raf-hotfix") }, encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    const cli = JSON.parse(result.stdout);
    assert.equal(cli.exitCode, 17, cli.stderr);
    const runtime = JSON.parse(cli.stdout);
    assert.ok(runtime.origin.startsWith(new URL("file://" + join(f.common, "raf-hotfix/generations/")).href), runtime.origin);
    assert.equal(runtime.pinned, true);
    assert.deepEqual(await fs.readdir(join(f.common, "raf-hotfix/readers")), []);
    await fs.cp(join(f.source, "src"), join(f.B, "src"), { recursive: true });
    await fs.cp(join(f.source, "package.json"), join(f.B, "package.json"));
    await fs.cp(join(f.A, "dist"), join(f.B, "dist"), { recursive: true });
    const inactiveScript = script.replaceAll(f.A, f.B);
    const inactive = spawnSync(process.execPath, ["--input-type=module", "-e", inactiveScript], { cwd: f.work, env: { ...f.environment, RAF_ORCHESTRATOR_ROOT: f.root }, encoding: "utf8", timeout: 30000 });
    assert.equal(inactive.status, 0, inactive.stderr);
    const refused = JSON.parse(inactive.stdout);
    assert.equal(refused.exitCode, 1);
    assert.match(refused.stderr, /Inactive main slot/);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("QA source registration preserves pre-existing fixture contents", async t => {
  const temporary = await fs.mkdtemp(join(tmpdir(), "raf-source-registration-"));
  try {
    const codeRoot = join(temporary, "raf-develop");
    await fs.mkdir(join(codeRoot, "bin"), { recursive: true });
    await fs.mkdir(join(temporary, "conf"));
    await fs.mkdir(join(temporary, "home"));
    await fs.writeFile(join(codeRoot, "bin/fixture-marker"), "retain fixture contents\n");
    await fs.writeFile(join(temporary, "conf/projects.json"), JSON.stringify({ projects: { raf: { path: "raf-main", branchPaths: { main: "raf-main", develop: "raf-develop" } } } }));
    await fs.copyFile(new URL("../../conf/raf.json", import.meta.url), join(temporary, "conf/raf.json"));
    let failure: unknown;
    try { await prepareProductionQaFixture(t, { root: temporary, home: join(temporary, "home") }); }
    catch (error) { failure = String(error); }
    assert.equal(failure, undefined, "Registering an existing fixture directory must preserve its files");
    assert.equal(await fs.readFile(join(codeRoot, "bin/fixture-marker"), "utf8"), "retain fixture contents\n");
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test("logical main routing accepts only a canonical registered physical main worktree", async () => {
  const f = await publishedLauncherFixture();
  try {
    const configuration = JSON.parse(await fs.readFile(join(f.root, "conf/projects.json"), "utf8"));
    const route = () => resolveWorkspaceRoute({ root: f.root, project: "raf", branch: "main" }, configuration, createWorkspacePorts());
    assert.deepEqual(await route(), { ok: true, project: "raf", branch: "main", cwd: join(f.root, "raf-main") });
    await fs.unlink(join(f.root, "raf-main"));
    await fs.symlink(f.source, join(f.root, "raf-main"));
    assert.equal((await route()).ok, false, "An unregistered source target cannot replace main");
    await fs.unlink(join(f.root, "raf-main"));
    await fs.symlink(f.B, join(f.root, "raf-main"));
    assert.equal((await route()).ok, false, "An inactive detached slot cannot become the main route");
    await fs.unlink(join(f.root, "raf-main"));
    await fs.symlink(f.A, join(f.root, "raf-main"));
    delete configuration.projects.raf.mainCopies;
    assert.equal((await route()).ok, false, "An undeclared symlink cannot become a directory route");
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("production scope protects both actual Git directories and main locks while preserving assigned Git writes", async () => {
  const f = await publishedLauncherFixture();
  try {
    const paths = await agentChannelReadOnlyPaths(f.root, f.home);
    assert.ok(paths.includes(f.A));
    assert.ok(paths.includes(f.B));
    assert.ok(paths.includes(join(f.root, "raf-main")));
    assert.ok(paths.includes(join(f.root, ".gitmodules")));
    assert.ok(paths.includes(join(f.common, "raf-hotfix")));
    const control = join(f.common, "raf-hotfix"), production = join(control, "main.git");
    for (const name of ["HEAD", "index", "index.lock", "HEAD.lock", "config", "refs/heads/main", "refs/heads/main.lock", "packed-refs"]) {
      assert.equal(paths.includes(join(f.common, name)), false, 'Source metadata must remain writable: ' + name);
      assert.equal(paths.includes(join(production, name)), false, 'Directory policy must not create child mountpoints: ' + name);
    }
    assert.equal(paths.some(path => path.startsWith(control + '/')), false, 'The existing control directory recursively protects every production path');
    const bGit = execFileSync("git", ["-C", f.B, "rev-parse", "--absolute-git-dir"], { env: f.environment, encoding: "utf8" }).trim();
    assert.ok(bGit.startsWith(production + "/"));
    assert.equal(paths.includes(bGit), false);
    assert.equal(paths.includes(f.common), false);
    assert.equal(paths.includes(join(f.common, "refs/heads/develop")), false);
    assert.equal(paths.includes(join(f.root, ".git/index")), false);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("production launcher rejects unissued origins and shell expansion before opening state", async () => {
  const entrypoint = fileURLToPath(new URL("../bin/raf.ts", import.meta.url));
  const issued = `node ${entrypoint} agent ps`;
  for (const command of [`${issued}; id`, `env HOME=/tmp ${issued}`, `node /candidate/bin/raf.ts agent ps`, `node ${entrypoint} agent close --id peer`]) {
    await assert.rejects(runPublishedAgentChannel({ orchestratorRoot: "/nonexistent", homeDirectory: "/nonexistent-home", cwd: "/nonexistent-work", runId: "fixture-run", agentId: "fixture-agent", issuedCommands: [issued], command }), { code: "CHANNEL_COMMAND_DENIED" });
  }
});

test("production launcher verifies registered caller and pins published code through exact output and exit", async () => {
  const f = await publishedLauncherFixture();
  try {
    const launcher = new URL("file://" + join(f.source, "src/main-switch-agent-launcher.ts")).href;
    const origin = join(f.source, "src/main-switch-agent-launcher.ts");
    const state = new URL("file://" + join(f.source, "src/state-store.ts")).href;
    const guard = new URL("file://" + join(f.source, "src/state-migration-guard.ts")).href;
    const runtime = new URL("file://" + join(f.source, "src/os-runtime.ts")).href;
    const issued = `node ${join(f.source, "bin/raf.ts")} agent ps`;
    const input = { orchestratorRoot: f.root, homeDirectory: f.home, cwd: f.work, runId: "fixture-run", agentId: "fixture-agent", issuedCommands: [issued], command: issued };
    const script = `
const {runPublishedAgentChannel}=await import(${JSON.stringify(launcher)});
const {openStateStore}=await import(${JSON.stringify(state)});
const {productionStateContext}=await import(${JSON.stringify(guard)});
const {executeCommand,readMachineBootIdentity}=await import(${JSON.stringify(runtime)});
const input=${JSON.stringify(input)};
const context=productionStateContext(input.orchestratorRoot,${JSON.stringify(origin)},input.homeDirectory,'hook');
const store=openStateStore(context.statePath,{context});
const scan=await executeCommand({executable:'ps',args:['-ww','-axo','pid=,lstart=,command=']});
const row=scan.stdout.split('\\n').map(line=>/^\\s*(\\d+)\\s+(\\w{3}\\s+\\w{3}\\s+\\d+\\s+\\d{2}:\\d{2}:\\d{2}\\s+\\d{4})\\s+(.+)$/.exec(line)).find(row=>row&&Number(row[1])===process.pid);
const boot=await readMachineBootIdentity();
store.sessionRepository.transaction(tx=>tx.putSession({runId:input.runId,addressId:input.agentId,revision:1,state:'running',activity:{cwd:input.cwd,type:'implement',project:'raf',features:[],phase:'implement'},launchContext:{assignment:{changes:[]},selection:{runner:'codex',model:'fixture',effort:'fixture',reason:'fixture'},briefPath:'fixture',reportPath:'fixture'},process:{pid:process.pid,startedAt:new Date(row[2]).toISOString(),runner:'codex',runnerSessionId:'fixture-native',tmuxSession:'fixture',evidence:{command:row[3],...boot}}}));
store.close();
await (async()=>{try{await runPublishedAgentChannel({...input,agentId:'forged'});throw new Error('forged caller was accepted')}catch(error){if(error.code!=='CHANNEL_COMMAND_DENIED')throw error}})();
process.exitCode=await runPublishedAgentChannel(input);
`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: f.work, env: { ...f.environment, CHANNEL_CONTROL: join(f.common, "raf-hotfix") }, encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 17, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "literal $() stderr\n");
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.argv, ["agent", "ps"]);
    assert.equal(output.cwd, f.work);
    assert.ok(output.entrypoint.startsWith(join(f.common, "raf-hotfix/generations/")));
    assert.notEqual(dirname(output.entrypoint), join(f.A, "bin"));
    assert.equal(output.pinned, true);
    assert.deepEqual(await fs.readdir(join(f.common, "raf-hotfix/readers")), []);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("logical main parent becomes read-only while existing Orchestrator Git and assigned directories remain writable", async () => {
  const f = await publishedLauncherFixture();
  try {
    for (const name of [".git/objects", ".git/refs/heads", "openspec", "conf", "raf-develop", "raf-hotfix"]) await fs.mkdir(join(f.root, name), { recursive: true });
    const index = join(f.root, ".git/index");
    const readme = join(f.root, "README.md");
    const secret = join(f.root, "secret.json");
    await fs.writeFile(index, "own index");
    await fs.writeFile(readme, "own docs");
    await fs.writeFile(secret, "hidden");
    await fs.writeFile(join(f.root, ".gitmodules"), "protected");
    const original = { ":root": "read", [f.root]: "write", [join(f.root, ".git")]: "write", [secret]: "none" };
    const result = await protectCodexReadOnlyPaths(original, [f.A, f.B, join(f.root, "raf-main"), join(f.root, ".gitmodules")], [index, join(f.root, ".gitmodules")]);
    assert.deepEqual(result.symlinkParents, [f.root]);
    assert.equal(result.filesystem[f.root], "read");
    for (const name of [".git", "openspec", "conf", "raf-develop", "raf-hotfix"]) assert.equal(result.filesystem[join(f.root, name)], "write", name);
    assert.ok(result.writableFiles.includes(index));
    assert.ok(result.writableFiles.includes(readme));
    assert.equal(result.writableFiles.includes(secret), false);
    assert.equal(result.writableFiles.includes(join(f.root, ".gitmodules")), false);
    assert.equal(result.filesystem[f.A], "read");
    assert.equal(result.filesystem[f.B], "read");
    assert.equal(result.filesystem[join(f.root, "raf-main")], undefined);
    assert.equal(result.filesystem[secret], "none");
    assert.equal(original[f.root], "write");
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});


test("native bwrap wrapper preserves inherited mask-data FD 9 while adding its network filter", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "raf-channel-fds-"));
  let mask: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const backend = join(root, "backend");
    const wrapper = join(root, "bwrap");
    const filter = join(root, "network.bpf");
    const data = join(root, "mask-data");
    await fs.writeFile(filter, "network-filter");
    await fs.writeFile(data, "backend-mask");
    await fs.writeFile(backend, `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);const fd=Number(args[args.indexOf('--add-seccomp-fd')+1]);
process.stdout.write(JSON.stringify({mask:fs.readFileSync(9,'utf8'),filter:fs.readFileSync(fd,'utf8'),fd,args}));
`, { mode: 0o700 });
    await fs.writeFile(wrapper, codexBwrapWrapper(backend, filter, join(root, "tmux"), []), { mode: 0o700 });
    mask = await fs.open(data, "r");
    const result = spawnSync(wrapper, ["--file", "9", "/hidden/peer.sock", "--", "/payload"], { stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", mask.fd] });
    assert.equal(result.status, 0, result.stderr?.toString());
    const output = JSON.parse(result.stdout.toString());
    assert.equal(output.mask, "backend-mask");
    assert.equal(output.filter, "network-filter");
    assert.notEqual(output.fd, 9);
    assert.deepEqual(output.args.slice(-6), ["--perms", "0700", "--tmpfs", join(root, "tmux"), "--", "/payload"]);
  } finally { await mask?.close(); await fs.rm(root, { recursive: true, force: true }); }
});


test("legacy stand reflog survives source maintenance without a false metadata conflict", async () => {
  const f = await publishedLauncherFixture();
  try {
    const runGit = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { env: f.environment, encoding: "utf8" }).trim();
    const directory = runGit(f.B, "rev-parse", "--absolute-git-dir");
    const reflog = join(directory, "logs/HEAD");
    const beforeHead = runGit(f.B, "rev-parse", "HEAD");
    const original = await fs.readFile(reflog, "utf8");
    assert.ok(original.endsWith(" +0000\n") || /[+-]\d{4}\n$/.test(original), "Git-created empty reflog messages must exercise the normalization case");
    normalizeStandReflog(f.B, runGit);
    const prepared = await fs.readFile(reflog, "utf8");
    runGit(f.B, "reflog", "expire", "--expire=never", "--expire-unreachable=never", "--all");
    assert.equal(await fs.readFile(reflog, "utf8"), prepared, "Source maintenance must not change the prepared legacy snapshot");
    assert.equal(runGit(f.B, "rev-parse", "HEAD"), beforeHead);
    assert.equal(prepared.replace(/\t(?=\n)/g, ""), original.replace(/\t(?=\n)/g, ""), "Normalization must retain every reflog entry and commit");
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
