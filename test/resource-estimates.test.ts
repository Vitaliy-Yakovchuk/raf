import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveAgentResourceEstimate,
  resolveTestProfileResourceEstimate,
  type AgentResourceEstimateInput,
  type ResourceEstimateResolution,
  type ResourceTaskReference,
  type TestProfileResourceEstimateInput,
} from "../src/resource-estimates.ts";

const first: ResourceTaskReference = {
  project: "raf",
  change: "fix-raf-load-admission",
  item: "3.1",
};
const second: ResourceTaskReference = { ...first, item: "5.1" };
const firstPointer =
  "conf/flow.json#/resourceEstimates/projects/raf/agentTasks/fix-raf-load-admission/3.1";
const secondPointer =
  "conf/flow.json#/resourceEstimates/projects/raf/agentTasks/fix-raf-load-admission/5.1";
const profilePointer =
  "conf/test-runs.json#/projects/raf/profiles/node/resourceEstimate";

function flowWith(entries: readonly [ResourceTaskReference, unknown][]) {
  const projects: Record<string, { agentTasks: Record<string, Record<string, unknown>> }> = {};
  for (const [task, estimate] of entries) {
    const project = projects[task.project] ??= { agentTasks: {} };
    const change = project.agentTasks[task.change] ??= {};
    change[task.item] = estimate;
  }
  return {
    resources: {
      normal: { minRamBytes: 10000, minDiskBytes: 20000 },
      hotfix: { minRamBytes: 30000, minDiskBytes: 40000 },
    },
    resourceEstimates: { projects },
  };
}

function profileWith(estimate: unknown) {
  return { projects: { raf: { profiles: { node: { resourceEstimate: estimate } } } } };
}

function agent(input: AgentResourceEstimateInput): ResourceEstimateResolution {
  let result: ResourceEstimateResolution | undefined;
  assert.doesNotThrow(() => {
    result = resolveAgentResourceEstimate(input);
  }, "Agent estimates must resolve a KNOWN/UNKNOWN decision before reservation");
  assert.ok(result, "Agent estimates must return a decision");
  return result;
}

function profile(input: TestProfileResourceEstimateInput): ResourceEstimateResolution {
  let result: ResourceEstimateResolution | undefined;
  assert.doesNotThrow(() => {
    result = resolveTestProfileResourceEstimate(input);
  }, "Profile estimates must resolve a KNOWN/UNKNOWN decision before spawn");
  assert.ok(result, "Profile estimates must return a decision");
  return result;
}

function known(
  result: ResourceEstimateResolution,
  ramBytes: number,
  diskBytes: Record<string, number>,
  sources: string[],
) {
  assert.equal(result.status, "KNOWN");
  assert.deepEqual(result.reservation, { ramBytes, diskBytes });
  assert.deepEqual([...result.sources].sort(), [...sources].sort());
  assert.equal(result.reason, null);
  assert.equal(result.confPointer, null);
}

function unknown(result: ResourceEstimateResolution, pointer: string) {
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.reservation, null, "An incomplete estimate must not expose a partial reservation");
  assert.equal(result.confPointer, pointer);
  assert.equal(typeof result.reason, "string");
  assert.ok(result.reason?.trim(), "UNKNOWN must explain its cause");
  assert.ok(result.sources.includes(pointer), "The failing conf source must remain traceable");
}

test("estimates: tasks of the same phase retain their distinct configured costs", () => {
  const flow = flowWith([
    [first, { ramBytes: 11, diskBytesPerFileSystem: 21 }],
    [second, { ramBytes: 37, diskBytesPerFileSystem: 49 }],
  ]);
  known(agent({ flow, tasks: [first], fileSystemIds: ["work"] }), 11, { work: 21 }, [firstPointer]);
  known(agent({ flow, tasks: [second], fileSystemIds: ["work"] }), 37, { work: 49 }, [secondPointer]);
  flow.resources.normal.minRamBytes = 999999;
  flow.resources.normal.minDiskBytes = 888888;
  flow.resources.hotfix.minRamBytes = 777777;
  flow.resources.hotfix.minDiskBytes = 666666;
  known(agent({ flow, tasks: [first], fileSystemIds: ["work"] }), 11, { work: 21 }, [firstPointer]);
  known(agent({ flow, tasks: [second], fileSystemIds: ["work"] }), 37, { work: 49 }, [secondPointer]);
});

test("estimates: all unique task costs sum once under permutation and duplication", () => {
  const flow = flowWith([
    [first, { ramBytes: 11, diskBytesPerFileSystem: 21 }],
    [second, { ramBytes: 37, diskBytesPerFileSystem: 49 }],
  ]);
  for (const tasks of [[first, second], [second, first], [first, first, second], [second, first, second]]) {
    known(agent({ flow, tasks, fileSystemIds: ["work", "tmp", "work"] }),
      48, { work: 70, tmp: 70 }, [firstPointer, secondPointer]);
  }
});

test("estimates: uniqueness includes project and change, not only the item number", () => {
  const otherProject = { ...first, project: "other" };
  const otherChange = { ...first, change: "another-change" };
  const flow = flowWith([
    [first, { ramBytes: 2, diskBytesPerFileSystem: 3 }],
    [otherProject, { ramBytes: 5, diskBytesPerFileSystem: 7 }],
    [otherChange, { ramBytes: 11, diskBytesPerFileSystem: 13 }],
  ]);
  known(agent({ flow, tasks: [first, otherProject, otherChange, first], fileSystemIds: ["disk"] }),
    18, { disk: 23 }, [firstPointer,
      "conf/flow.json#/resourceEstimates/projects/other/agentTasks/fix-raf-load-admission/3.1",
      "conf/flow.json#/resourceEstimates/projects/raf/agentTasks/another-change/3.1"]);
});

test("estimates: dotted item keys are literal, and source pointers escape slash and tilde", () => {
  const task = { project: "pro/ject", change: "change~name", item: "2.1" };
  known(agent({ flow: flowWith([[task, { ramBytes: 5, diskBytesPerFileSystem: 7 }]]),
    tasks: [task], fileSystemIds: ["disk"] }), 5, { disk: 7 },
    ["conf/flow.json#/resourceEstimates/projects/pro~1ject/agentTasks/change~0name/2.1"]);
});

test("estimates: dotted item keys never fall back to nested numeric keys", () => {
  const flow = flowWith([[first, undefined]]);
  const entries = flow.resourceEstimates.projects.raf.agentTasks[first.change];
  delete entries[first.item];
  entries["3"] = { "1": { ramBytes: 2, diskBytesPerFileSystem: 3 } };
  unknown(agent({ flow, tasks: [first], fileSystemIds: ["disk"] }), firstPointer);
});

for (const [label, flow] of [
  ["missing flow", undefined],
  ["null flow", null],
  ["missing estimates", { resources: { normal: { minRamBytes: 99, minDiskBytes: 99 } } }],
  ["missing project", { resourceEstimates: { projects: {} } }],
  ["missing change", { resourceEstimates: { projects: { raf: { agentTasks: {} } } } }],
] as const) {
  test(`estimates: ${label} returns the requested task pointer without threshold fallback`, () => {
    unknown(agent({ flow, tasks: [first], fileSystemIds: ["disk"] }), firstPointer);
  });
}

test("estimates: a missing task invalidates the entire otherwise known assignment", () => {
  const flow = flowWith([[first, { ramBytes: 11, diskBytesPerFileSystem: 21 }]]);
  for (const tasks of [[first, second], [second, first]]) {
    unknown(agent({ flow, tasks, fileSystemIds: ["work", "tmp"] }), secondPointer);
  }
});

const invalidValues: [string, unknown][] = [
  ["missing", undefined], ["null", null], ["negative", -1], ["fraction", 1.5],
  ["unsafe integer", Number.MAX_SAFE_INTEGER + 1], ["NaN", NaN],
  ["infinity", Infinity], ["negative infinity", -Infinity], ["numeric string", "12"],
  ["boolean", true], ["object", {}], ["array", []],
];

for (const field of ["ramBytes", "diskBytesPerFileSystem"] as const) {
  for (const [label, value] of invalidValues) {
    test(`estimates: agent ${field} rejects ${label} with an exact field pointer`, () => {
      const estimate: Record<string, unknown> = { ramBytes: 11, diskBytesPerFileSystem: 21 };
      if (value === undefined) delete estimate[field];
      else estimate[field] = value;
      const flow = flowWith([
        [first, { ramBytes: 2, diskBytesPerFileSystem: 3 }], [second, estimate],
      ]);
      unknown(agent({ flow, tasks: [first, second], fileSystemIds: ["disk"] }), `${secondPointer}/${field}`);
    });

    test(`estimates: profile ${field} rejects ${label} with an exact field pointer`, () => {
      const estimate: Record<string, unknown> = { ramBytes: 11, diskBytesPerFileSystem: 21 };
      if (value === undefined) delete estimate[field];
      else estimate[field] = value;
      unknown(profile({ testRuns: profileWith(estimate), project: "raf", profileId: "node",
        fileSystemIds: ["disk"] }), `${profilePointer}/${field}`);
    });
  }
}

for (const [label, estimate] of [["missing", undefined], ["null", null], ["scalar", 9],
  ["string", "estimate"], ["array", []]] as const) {
  test(`estimates: ${label} task estimate is UNKNOWN at its entry pointer`, () => {
    unknown(agent({ flow: flowWith([[first, estimate]]), tasks: [first], fileSystemIds: ["disk"] }),
      firstPointer);
  });
  test(`estimates: ${label} profile estimate is UNKNOWN at its entry pointer`, () => {
    unknown(profile({ testRuns: profileWith(estimate), project: "raf", profileId: "node",
      fileSystemIds: ["disk"] }), profilePointer);
  });
}

test("estimates: explicit zeros are known agent and profile costs on every touched volume", () => {
  const estimate = { ramBytes: 0, diskBytesPerFileSystem: 0 };
  known(agent({ flow: flowWith([[first, estimate]]), tasks: [first], fileSystemIds: ["work", "tmp"] }),
    0, { work: 0, tmp: 0 }, [firstPointer]);
  known(profile({ testRuns: profileWith(estimate), project: "raf", profileId: "node",
    fileSystemIds: ["work", "tmp"] }), 0, { work: 0, tmp: 0 }, [profilePointer]);
});

for (const field of ["ramBytes", "diskBytesPerFileSystem"] as const) {
  test(`estimates: ${field} sum overflow invalidates the entire assignment`, () => {
    const a = { ramBytes: 0, diskBytesPerFileSystem: 0, [field]: Number.MAX_SAFE_INTEGER };
    const b = { ramBytes: 0, diskBytesPerFileSystem: 0, [field]: 1 };
    unknown(agent({ flow: flowWith([[first, a], [second, b]]), tasks: [first, second],
      fileSystemIds: ["work", "tmp"] }), `${secondPointer}/${field}`);
  });
}

test("estimates: exact safe-integer limit is valid and duplicate tasks cannot cause overflow", () => {
  const estimate = { ramBytes: Number.MAX_SAFE_INTEGER, diskBytesPerFileSystem: Number.MAX_SAFE_INTEGER };
  const zero = { ramBytes: 0, diskBytesPerFileSystem: 0 };
  known(agent({ flow: flowWith([[first, estimate], [second, zero]]), tasks: [first, second, first],
    fileSystemIds: ["work", "work", "tmp"] }), Number.MAX_SAFE_INTEGER,
    { work: Number.MAX_SAFE_INTEGER, tmp: Number.MAX_SAFE_INTEGER }, [firstPointer, secondPointer]);
  known(profile({ testRuns: profileWith(estimate), project: "raf", profileId: "node",
    fileSystemIds: ["work", "tmp"] }), Number.MAX_SAFE_INTEGER,
    { work: Number.MAX_SAFE_INTEGER, tmp: Number.MAX_SAFE_INTEGER }, [profilePointer]);
});

test("estimates: the sum of two positive estimates may equal the safe-integer limit", () => {
  const a = { ramBytes: Number.MAX_SAFE_INTEGER - 1, diskBytesPerFileSystem: Number.MAX_SAFE_INTEGER - 1 };
  const b = { ramBytes: 1, diskBytesPerFileSystem: 1 };
  known(agent({ flow: flowWith([[first, a], [second, b]]), tasks: [first, second],
    fileSystemIds: ["disk"] }), Number.MAX_SAFE_INTEGER, { disk: Number.MAX_SAFE_INTEGER },
    [firstPointer, secondPointer]);
});

test("estimates: profile lookup uses the selected profile and its complete configured upper bound", () => {
  const testRuns = { projects: { raf: { profiles: {
    node: { resourceEstimate: { ramBytes: 11, diskBytesPerFileSystem: 21 } },
    other: { resourceEstimate: { ramBytes: 37, diskBytesPerFileSystem: 49 } },
    unrelatedInvalid: { resourceEstimate: null },
  } } } };
  known(profile({ testRuns, project: "raf", profileId: "node", fileSystemIds: ["disk"] }),
    11, { disk: 21 }, [profilePointer]);
  known(profile({ testRuns, project: "raf", profileId: "other", fileSystemIds: ["disk"] }),
    37, { disk: 49 }, ["conf/test-runs.json#/projects/raf/profiles/other/resourceEstimate"]);
});

for (const [label, testRuns] of [
  ["missing config", undefined], ["missing project", { projects: {} }],
  ["missing profile", { projects: { raf: { profiles: {} } } }],
  ["missing resourceEstimate", { projects: { raf: { profiles: { node: {} } } } }],
] as const) {
  test(`estimates: profile ${label} does not borrow another source`, () => {
    unknown(profile({ testRuns, project: "raf", profileId: "node", fileSystemIds: ["disk"] }), profilePointer);
  });
}

test("estimates: a missing profile estimate cannot borrow another profile or project", () => {
  const testRuns = { projects: {
    raf: { profiles: { node: {}, other: { resourceEstimate: { ramBytes: 2, diskBytesPerFileSystem: 3 } } } },
    other: { profiles: { node: { resourceEstimate: { ramBytes: 5, diskBytesPerFileSystem: 7 } } } },
  } };
  unknown(profile({ testRuns, project: "raf", profileId: "node", fileSystemIds: ["disk"] }), profilePointer);
});

test("estimates: profile conf pointers escape project and profile names", () => {
  known(profile({ testRuns: { projects: { "pro/ject": { profiles: { "node~qa": {
    resourceEstimate: { ramBytes: 2, diskBytesPerFileSystem: 3 },
  } } } } }, project: "pro/ject", profileId: "node~qa", fileSystemIds: ["disk"] }),
    2, { disk: 3 }, ["conf/test-runs.json#/projects/pro~1ject/profiles/node~0qa/resourceEstimate"]);
});

test("estimates: colocated work and temporary paths reserve their filesystem once, without adding HOME", () => {
  const estimate = { ramBytes: 5, diskBytesPerFileSystem: 7 };
  const fileSystemIds = ["shared", "shared", "shared"];
  known(agent({ flow: flowWith([[first, estimate]]), tasks: [first], fileSystemIds }),
    5, { shared: 7 }, [firstPointer]);
  known(profile({ testRuns: profileWith(estimate), project: "raf", profileId: "node", fileSystemIds }),
    5, { shared: 7 }, [profilePointer]);
});

test("estimates: distinct filesystems each receive the disk estimate without multiplying RAM", () => {
  const estimate = { ramBytes: 5, diskBytesPerFileSystem: 7 };
  const fileSystemIds = ["work", "tmp", "tmp"];
  known(agent({ flow: flowWith([[first, estimate]]), tasks: [first], fileSystemIds }),
    5, { work: 7, tmp: 7 }, [firstPointer]);
  known(profile({ testRuns: profileWith(estimate), project: "raf", profileId: "node", fileSystemIds }),
    5, { work: 7, tmp: 7 }, [profilePointer]);
});

test("estimates: changed assignments and changed conf are resolved afresh without mutating inputs", () => {
  const flow = flowWith([
    [first, { ramBytes: 2, diskBytesPerFileSystem: 3 }],
    [second, { ramBytes: 5, diskBytesPerFileSystem: 7 }],
  ]);
  const tasks = Object.freeze([first]);
  const fileSystemIds = Object.freeze(["work", "work"]);
  const before = structuredClone(flow);
  known(agent({ flow, tasks, fileSystemIds }), 2, { work: 3 }, [firstPointer]);
  known(agent({ flow, tasks: [first, second], fileSystemIds }), 7, { work: 10 }, [firstPointer, secondPointer]);
  assert.deepEqual(flow, before);
  assert.deepEqual(tasks, [first]);
  assert.deepEqual(fileSystemIds, ["work", "work"]);
  flow.resourceEstimates.projects.raf.agentTasks[first.change][first.item] = {
    ramBytes: 13, diskBytesPerFileSystem: 17,
  };
  known(agent({ flow, tasks, fileSystemIds }), 13, { work: 17 }, [firstPointer]);
  delete flow.resourceEstimates.projects.raf.agentTasks[first.change][first.item];
  unknown(agent({ flow, tasks, fileSystemIds }), firstPointer);
});

test("estimates: profile changes are read afresh and its config is not mutated", () => {
  const testRuns = profileWith({ ramBytes: 2, diskBytesPerFileSystem: 3 });
  const before = structuredClone(testRuns);
  known(profile({ testRuns, project: "raf", profileId: "node", fileSystemIds: ["work"] }),
    2, { work: 3 }, [profilePointer]);
  assert.deepEqual(testRuns, before);
  testRuns.projects.raf.profiles.node.resourceEstimate = { ramBytes: 13, diskBytesPerFileSystem: 17 };
  known(profile({ testRuns, project: "raf", profileId: "node", fileSystemIds: ["work"] }),
    13, { work: 17 }, [profilePointer]);
});
