import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
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

const type = "test-scaffold";
const typePointer = "conf/flow.json#/resourceEstimates/agentTypes/test-scaffold";
const projectTypePointer = "conf/flow.json#/resourceEstimates/projects/raf/agentTypes/test-scaffold";
const baseEstimate = { ramBytes: 101, diskBytesPerFileSystem: 211 };

type ProjectEstimates = {
  agentTasks: Record<string, Record<string, unknown>>;
  agentTypes?: Record<string, unknown>;
};

function flowWith(entries: readonly [ResourceTaskReference, unknown][] = []) {
  const projects: Record<string, ProjectEstimates> = {};
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
    resourceEstimates: { agentTypes: { [type]: { ...baseEstimate } } as Record<string, unknown>, projects },
  };
}

function profileWith(estimate: unknown) {
  return { projects: { raf: { profiles: { node: { resourceEstimate: estimate } } } } };
}

function agent(input: Omit<AgentResourceEstimateInput, "type" | "project"> &
  Partial<Pick<AgentResourceEstimateInput, "type" | "project">>): ResourceEstimateResolution {
  let result: ResourceEstimateResolution | undefined;
  assert.doesNotThrow(() => {
    result = resolveAgentResourceEstimate({ type, project: "raf", ...input });
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

test("estimates v1.2: component maxima are invariant under task permutation and duplication", () => {
  const flow = flowWith([
    [first, { ramBytes: 11, diskBytesPerFileSystem: 49 }],
    [second, { ramBytes: 37, diskBytesPerFileSystem: 21 }],
  ]);
  for (const tasks of [[first, second], [second, first], [first, first, second], [second, first, second]]) {
    known(agent({ flow, tasks, fileSystemIds: ["work", "tmp", "work"] }),
      37, { work: 49, tmp: 49 }, [firstPointer, secondPointer]);
  }
});

test("estimates v1.2: task identity includes project and change with unique exact sources", () => {
  const otherProject = { ...first, project: "other" };
  const otherChange = { ...first, change: "another-change" };
  const flow = flowWith([
    [first, { ramBytes: 2, diskBytesPerFileSystem: 13 }],
    [otherProject, { ramBytes: 11, diskBytesPerFileSystem: 7 }],
    [otherChange, { ramBytes: 5, diskBytesPerFileSystem: 3 }],
  ]);
  known(agent({ flow, project: "canonical-launch-project", tasks: [first, otherProject, otherChange, first],
    fileSystemIds: ["disk"] }), 11, { disk: 13 }, [firstPointer,
      "conf/flow.json#/resourceEstimates/projects/other/agentTasks/fix-raf-load-admission/3.1",
      "conf/flow.json#/resourceEstimates/projects/raf/agentTasks/another-change/3.1"]);
});

test("estimates: dotted item keys are literal, and source pointers escape slash and tilde", () => {
  const task = { project: "pro/ject", change: "change~name", item: "2.1" };
  known(agent({ flow: flowWith([[task, { ramBytes: 5, diskBytesPerFileSystem: 7 }]]),
    tasks: [task], fileSystemIds: ["disk"] }), 5, { disk: 7 },
    ["conf/flow.json#/resourceEstimates/projects/pro~1ject/agentTasks/change~0name/2.1"]);
});

test("estimates v1.2: absent dotted item ignores nested numeric keys and uses the type", () => {
  const flow = flowWith();
  flow.resourceEstimates.projects.raf = { agentTasks: { [first.change]: {
    "3": { "1": { ramBytes: 2, diskBytesPerFileSystem: 3 } },
  } } };
  known(agent({ flow, tasks: [first], fileSystemIds: ["disk"] }), 101, { disk: 211 }, [typePointer]);
});

for (const [label, flow] of [
  ["no projects", { resourceEstimates: { agentTypes: { [type]: baseEstimate } } }],
  ["no project", flowWith()],
  ["no agentTasks", { resourceEstimates: { agentTypes: { [type]: baseEstimate }, projects: { raf: {} } } }],
  ["no change", { resourceEstimates: { agentTypes: { [type]: baseEstimate }, projects: { raf: { agentTasks: {} } } } }],
  ["no item", { resourceEstimates: { agentTypes: { [type]: baseEstimate }, projects: { raf: { agentTasks: { [first.change]: {} } } } } }],
] as const) {
  test(`estimates v1.2: optional ${label} uses one base estimate for any task count`, () => {
    for (const tasks of [[], [first], [first, second, first], Array.from({ length: 30 }, (_, i) => ({ ...first, item: `new.${i}` }))]) {
      known(agent({ flow, tasks, fileSystemIds: ["disk"] }), 101, { disk: 211 }, [typePointer]);
    }
  });
}

test("estimates v1.2: input type selects its own global source", () => {
  const flow = flowWith();
  flow.resourceEstimates.agentTypes.hotfix = { ramBytes: 5, diskBytesPerFileSystem: 7 };
  known(agent({ flow, type: "hotfix", tasks: [first], fileSystemIds: ["disk"] }),
    5, { disk: 7 }, ["conf/flow.json#/resourceEstimates/agentTypes/hotfix"]);
});

test("estimates v1.2: canonical launch project selects project type even without tasks", () => {
  const flow = flowWith();
  flow.resourceEstimates.projects.raf = { agentTasks: {}, agentTypes: { [type]: { ramBytes: 13, diskBytesPerFileSystem: 17 } } };
  flow.resourceEstimates.projects.other = { agentTasks: {}, agentTypes: { [type]: { ramBytes: 23, diskBytesPerFileSystem: 29 } } };
  known(agent({ flow, type, project: "raf", tasks: [], fileSystemIds: ["disk"] }),
    13, { disk: 17 }, [projectTypePointer]);
  known(agent({ flow, type, project: "other", tasks: [], fileSystemIds: ["disk"] }),
    23, { disk: 29 }, ["conf/flow.json#/resourceEstimates/projects/other/agentTypes/test-scaffold"]);
});

test("estimates v1.2: item then task project type then global type determine the maximum", () => {
  const other = { ...second, project: "other" };
  const flow = flowWith([[first, { ramBytes: 2, diskBytesPerFileSystem: 307 }]]);
  flow.resourceEstimates.projects.raf.agentTypes = { [type]: { ramBytes: 401, diskBytesPerFileSystem: 7 } };
  known(agent({ flow, tasks: [first], fileSystemIds: ["disk"] }), 2, { disk: 307 }, [firstPointer]);
  known(agent({ flow, tasks: [second], fileSystemIds: ["disk"] }), 401, { disk: 7 }, [projectTypePointer]);
  known(agent({ flow, tasks: [first, second, other], fileSystemIds: ["disk"] }),
    401, { disk: 307 }, [firstPointer, projectTypePointer, typePointer]);
});

test("estimates v1.2: project type pointers escape project and type tokens", () => {
  const flow = { resourceEstimates: { projects: { "pro/ject~": { agentTypes: {
    "type/~": { ramBytes: 2, diskBytesPerFileSystem: 3 },
  } } } } };
  known(agent({ flow, project: "pro/ject~", type: "type/~", tasks: [], fileSystemIds: ["disk"] }),
    2, { disk: 3 }, ["conf/flow.json#/resourceEstimates/projects/pro~1ject~0/agentTypes/type~1~0"]);
});

test("estimates v1.2: global type pointers escape type tokens", () => {
  known(agent({ flow: { resourceEstimates: { agentTypes: {
    "type/~": { ramBytes: 2, diskBytesPerFileSystem: 3 },
  } } }, type: "type/~", tasks: [], fileSystemIds: ["disk"] }),
    2, { disk: 3 }, ["conf/flow.json#/resourceEstimates/agentTypes/type~1~0"]);
});

for (const [label, flow] of [
  ["missing flow", undefined], ["missing estimates", { resources: { normal: { minRamBytes: 99, minDiskBytes: 99 } } }],
  ["missing agentTypes", { resourceEstimates: {} }],
  ["missing type", { resourceEstimates: { agentTypes: {} } }],
  ["another type or project", { resourceEstimates: { agentTypes: { hotfix: baseEstimate },
    projects: { other: { agentTypes: { [type]: baseEstimate } } } } }],
] as const) {
  test(`estimates v1.2: ${label} is UNKNOWN at the base type without borrowing thresholds`, () => {
    unknown(agent({ flow, tasks: [first], fileSystemIds: ["disk"] }), typePointer);
  });
}

const malformedContainers = [null, 1, "bad", []];
for (const [label, path] of [
  ["flow", []], ["estimates", ["resourceEstimates"]],
  ["global types", ["resourceEstimates", "agentTypes"]],
  ["projects", ["resourceEstimates", "projects"]],
  ["project", ["resourceEstimates", "projects", "raf"]],
  ["project types", ["resourceEstimates", "projects", "raf", "agentTypes"]],
  ["tasks", ["resourceEstimates", "projects", "raf", "agentTasks"]],
  ["change", ["resourceEstimates", "projects", "raf", "agentTasks", first.change]],
] as const) {
  for (const [index, invalid] of malformedContainers.entries()) {
    test(`estimates v1.2: malformed ${label} container ${index} is UNKNOWN at that container`, () => {
      let flow: any = flowWith();
      flow.resourceEstimates.projects.raf = { agentTasks: { [first.change]: {} } };
      if (!path.length) flow = invalid;
      else {
        let parent = flow;
        for (const key of path.slice(0, -1)) parent = parent[key];
        parent[path[path.length - 1]] = invalid;
      }
      unknown(agent({ flow, tasks: [first], fileSystemIds: ["disk"] }),
        "conf/flow.json" + (path.length ? "#/" + path.join("/") : ""));
    });
  }
}

const invalidValues: [string, unknown][] = [
  ["missing", undefined], ["null", null], ["negative", -1], ["fraction", 1.5],
  ["unsafe integer", Number.MAX_SAFE_INTEGER + 1], ["NaN", NaN],
  ["infinity", Infinity], ["negative infinity", -Infinity], ["numeric string", "12"],
  ["boolean", true], ["object", {}], ["array", []],
];

for (const field of ["ramBytes", "diskBytesPerFileSystem"] as const) {
  for (const [label, value] of invalidValues) {
    for (const source of ["global type", "project type", "item"] as const) {
      test(`estimates v1.2: ${source} ${field} rejects ${label} without fallback`, () => {
        const estimate: Record<string, unknown> = { ramBytes: 11, diskBytesPerFileSystem: 21 };
        if (value === undefined) delete estimate[field];
        else estimate[field] = value;
        const flow = flowWith();
        let pointer = typePointer;
        if (source === "global type") flow.resourceEstimates.agentTypes[type] = estimate;
        else {
          flow.resourceEstimates.projects.raf = {
            agentTasks: {}, agentTypes: { [type]: { ramBytes: 13, diskBytesPerFileSystem: 17 } },
          };
          pointer = projectTypePointer;
          if (source === "project type") flow.resourceEstimates.projects.raf.agentTypes![type] = estimate;
          else {
            flow.resourceEstimates.projects.raf.agentTasks[first.change] = { [first.item]: estimate };
            pointer = firstPointer;
          }
        }
        unknown(agent({ flow, tasks: [first], fileSystemIds: ["disk"] }), `${pointer}/${field}`);
      });
    }

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
  for (const source of ["global type", "project type", "item"] as const) {
    test(`estimates v1.2: ${label} selected ${source} entry is UNKNOWN without fallback`, () => {
      const flow = flowWith();
      let pointer = typePointer;
      if (source === "global type") flow.resourceEstimates.agentTypes[type] = estimate;
      else {
        flow.resourceEstimates.projects.raf = { agentTasks: {}, agentTypes: { [type]: baseEstimate } };
        pointer = projectTypePointer;
        if (source === "project type") flow.resourceEstimates.projects.raf.agentTypes![type] = estimate;
        else {
          flow.resourceEstimates.projects.raf.agentTasks[first.change] = { [first.item]: estimate };
          pointer = firstPointer;
        }
      }
      unknown(agent({ flow, tasks: [first], fileSystemIds: ["disk"] }), pointer);
    });
  }
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

test("estimates v1.2: all zero overrides replace a nonzero type without a hidden floor", () => {
  const zero = { ramBytes: 0, diskBytesPerFileSystem: 0 };
  known(agent({ flow: flowWith([[first, zero], [second, zero]]), tasks: [first, second, first],
    fileSystemIds: ["work", "tmp"] }), 0, { work: 0, tmp: 0 }, [firstPointer, secondPointer]);
});

test("estimates v1.2: a zero override and a task using the type share component maxima", () => {
  known(agent({ flow: flowWith([[first, { ramBytes: 0, diskBytesPerFileSystem: 0 }]]),
    tasks: [first, second], fileSystemIds: ["disk"] }), 101, { disk: 211 }, [firstPointer, typePointer]);
});

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

test("estimates v1.2: positive estimates at MAX_SAFE_INTEGER remain valid under maximum", () => {
  const a = { ramBytes: Number.MAX_SAFE_INTEGER, diskBytesPerFileSystem: 1 };
  const b = { ramBytes: 1, diskBytesPerFileSystem: Number.MAX_SAFE_INTEGER };
  known(agent({ flow: flowWith([[first, a], [second, b]]), tasks: [first, second, first],
    fileSystemIds: ["work", "tmp", "work"] }), Number.MAX_SAFE_INTEGER,
    { work: Number.MAX_SAFE_INTEGER, tmp: Number.MAX_SAFE_INTEGER }, [firstPointer, secondPointer]);
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

test("estimates v1.2: queued assignment and conf changes resolve afresh without mutating inputs", () => {
  const flow = flowWith([
    [first, { ramBytes: 2, diskBytesPerFileSystem: 3 }],
    [second, { ramBytes: 5, diskBytesPerFileSystem: 7 }],
  ]);
  const tasks = Object.freeze([first]);
  const fileSystemIds = Object.freeze(["work", "work"]);
  const before = structuredClone(flow);
  known(agent({ flow, tasks, fileSystemIds }), 2, { work: 3 }, [firstPointer]);
  known(agent({ flow, tasks: [first, second], fileSystemIds }), 5, { work: 7 }, [firstPointer, secondPointer]);
  assert.deepEqual(flow, before);
  assert.deepEqual(tasks, [first]);
  assert.deepEqual(fileSystemIds, ["work", "work"]);
  flow.resourceEstimates.projects.raf.agentTasks[first.change][first.item] = {
    ramBytes: 13, diskBytesPerFileSystem: 17,
  };
  known(agent({ flow, tasks, fileSystemIds }), 13, { work: 17 }, [firstPointer]);
  delete flow.resourceEstimates.projects.raf.agentTasks[first.change][first.item];
  known(agent({ flow, tasks, fileSystemIds }), 101, { work: 211 }, [typePointer]);
  flow.resourceEstimates.projects.raf.agentTypes = { [type]: { ramBytes: 19, diskBytesPerFileSystem: 23 } };
  known(agent({ flow, tasks, fileSystemIds }), 19, { work: 23 }, [projectTypePointer]);
  flow.resourceEstimates.projects.raf.agentTypes[type] = { ramBytes: 29, diskBytesPerFileSystem: 31 };
  known(agent({ flow, tasks, fileSystemIds }), 29, { work: 31 }, [projectTypePointer]);
  flow.resourceEstimates.agentTypes.hotfix = { ramBytes: 37, diskBytesPerFileSystem: 41 };
  known(agent({ flow, type: "hotfix", tasks, fileSystemIds }), 37, { work: 41 },
    ["conf/flow.json#/resourceEstimates/agentTypes/hotfix"]);
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

test("estimates v1.2: unselected invalid types and task entries cannot poison a valid selection", () => {
  const flow = flowWith([[second, null]]);
  flow.resourceEstimates.agentTypes.hotfix = null;
  flow.resourceEstimates.projects.raf.agentTypes = { hotfix: null };
  known(agent({ flow, tasks: [first], fileSystemIds: ["disk"] }), 101, { disk: 211 }, [typePointer]);
});

test("estimates v1.2: a complete item override does not consult invalid lower priority sources", () => {
  const flow = flowWith([[first, { ramBytes: 2, diskBytesPerFileSystem: 3 }]]);
  flow.resourceEstimates.agentTypes[type] = null;
  flow.resourceEstimates.projects.raf.agentTypes = { [type]: null };
  known(agent({ flow, tasks: [first], fileSystemIds: ["disk"] }), 2, { disk: 3 }, [firstPointer]);
});

test("estimates v1.2: an invalid selected item makes the entire otherwise known maximum UNKNOWN", () => {
  const flow = flowWith([[first, { ramBytes: 2, diskBytesPerFileSystem: 3 }], [second, null]]);
  for (const tasks of [[first, second], [second, first]]) {
    unknown(agent({ flow, tasks, fileSystemIds: ["work", "tmp"] }), secondPointer);
  }
});

for (const scenario of ["initial compatibility", "threshold independence"] as const) {
  test(`estimates v1.2: actual conf covers every launchable type with ${scenario}`, () => {
    const flow = JSON.parse(readFileSync(new URL("../../conf/flow.json", import.meta.url), "utf8"));
    const catalog = JSON.parse(readFileSync(new URL("../../conf/raf-constants.json", import.meta.url), "utf8"));
    const launchable = catalog.agentTypes.filter((entry: { launchableByRaf: boolean }) => entry.launchableByRaf);
    assert.ok(launchable.length > 0, "The migration must cover an actual nonempty launchable catalog");
    const before = structuredClone(flow);
    for (const { id } of launchable) {
      const tier = id === "hotfix" ? "hotfix" : "normal";
      const { minRamBytes, minDiskBytes } = before.resources[tier];
      const pointer = `conf/flow.json#/resourceEstimates/agentTypes/${id}`;
      assert.deepEqual(flow.resourceEstimates?.agentTypes?.[id], {
        ramBytes: minRamBytes, diskBytesPerFileSystem: minDiskBytes,
      }, `Initial migration requires explicit independent numbers for ${id}`);
      if (scenario === "threshold independence") {
        flow.resources[tier].minRamBytes = 0;
        flow.resources[tier].minDiskBytes = 0;
      }
      for (const tasks of [[], [first], [first, second, first]]) {
        known(agent({ flow, type: id, project: "raf", tasks, fileSystemIds: ["work", "work", "tmp"] }),
          minRamBytes, { work: minDiskBytes, tmp: minDiskBytes }, [pointer]);
      }
    }
    if (scenario === "initial compatibility") assert.deepEqual(flow, before);
  });
}

for (const source of ["global type", "project type"] as const) {
  for (const value of [0, Number.MAX_SAFE_INTEGER]) {
    test(`estimates v1.2: ${source} accepts explicit boundary ${value} for the whole launch`, () => {
      const estimate = { ramBytes: value, diskBytesPerFileSystem: value };
      const flow = flowWith();
      let pointer = typePointer;
      if (source === "global type") flow.resourceEstimates.agentTypes[type] = estimate;
      else {
        flow.resourceEstimates.projects.raf = { agentTasks: {}, agentTypes: { [type]: estimate } };
        flow.resourceEstimates.agentTypes[type] = null;
        pointer = projectTypePointer;
      }
      for (const tasks of [[], [first, second, first]]) {
        known(agent({ flow, tasks, fileSystemIds: ["work", "tmp", "work"] }),
          value, { work: value, tmp: value }, [pointer]);
      }
    });
  }
}
