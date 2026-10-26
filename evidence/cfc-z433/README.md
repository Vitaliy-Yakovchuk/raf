# complete-raf-flow-contracts Z.433

Scope: `context-review.due` only. Workspace: `/srv/dev/work/orchestrator/raf-hotfix`, branch `hotfix`. Regression tests: `test/service-host.test.ts`. Stable group: `complete-raf-flow-contracts/z433`. No task checkboxes are edited by this executor.

## Audit

The assignment is current: `review-agent-startup-context/specs/projects/raf/startup-context-trace/spec.md`, “Подія аналізу стартового контексту”, requires main to receive one event for a completed batch; “Прив'язка агента аналізу до пакета” requires a stable package ID. Both production-runtime and service-host currently use a pending-only `mainDelivered` marker, swallow delivery errors, and have no durable claim before calling transport. The event repository consumes accepted pending intents; lifecycle finalization can put the same package back in pending. Package state must outlive that consumption.

Initial test-only commit: `f59fcc57932b6b7c4347c8da8d2ebf6175ac679e`.

## Initial channel refusal (not red)

Command:

```
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/90734334-b607-48d3-afc1-1ab42e1f8ad6/raf-main/bin/raf.ts test run --project raf --phase red --group complete-raf-flow-contracts/z433 --files test/service-host.test.ts
```

`refused.stdout.json`, `refused.stderr.txt`, and `refused.cli-exit-code.txt` preserve the complete result/diagnostic from run `f8b8dd7f-f288-49e0-bfd3-f234f5bc5192`: CLI 1, child exitCode null, `CALLER_UNAUTHORIZED`, group not configured. No child ran; this is not assertion-red. Main registered the group in Orchestrator commit `d26c65093cda9239cdccc7a1e1ac1b62cabeceaf` before the subsequent runs. The group name, QA HOME, and budget will not be changed to work around the refusal.

## Foreign regression follow-up reserved for main

File: `test/startup-context-runtime.test.ts`.

Test: `service recovery captures a persisted accepted report before removing its brief and retries main delivery`.

Current behavior expected by that test: first delivery returns false, the second throws `main temporarily unavailable`, and a third attempt succeeds; it asserts `attempts === 3` and no remaining `context-review.due` pending intent.

Required behavior under Z.433: an unconfirmed delivery has a durable, explicit `uncertain` state and blocks automatic resend, including after restart. After providing a registered running main in that fixture, the unconfirmed first receipt must keep attempts at 1; its pending fact must remain unconsumed and package delivery state must expose uncertainty and its reason. The current fixture has no registered main, so the new safe preflight does not call its transport at all; the follow-up must seed main and build its missing compiled catalog before verifying the semantic assertion. Accepted delivery remains suppressed after pending consumption and restart.

Main instructed this executor to leave that foreign test unchanged and unexecuted. It belongs to `review-agent-startup-context/assigned-review-package`; no `regressionGroups` grant exists in the immutable Z.433 item. Main will create a separate follow-up with `regressionGroups=["review-agent-startup-context/assigned-review-package"]` and a new launch. The source file was restored exactly after clarification; no foreign regression is claimed as passed here.

## Test preparation failure (not red)

Run `967f7fed-750c-4e6d-92a7-87d997ee9ab8`, same red command/group/selection: CLI 1, child 1; the wrapper reports assertions-failed, but all 15 tests were blocked by the fixture's missing `raf-develop/dist/catalog.json`. This is setup failure and is not counted as the required red. `red-setup.*` preserves the complete result, stderr, CLI code and transport response. Fixture-only commit `07e9e775b5af7a6d0bac9357d8c16ae8dd798ce3` builds the compiled catalog from current constants/models/projects. No production fix preceded the next red.

## Confirmed red

Run `dcaac765-4dad-495e-ada7-4a7c152e9e28`, exact red command above, SHA `07e9e775b5af7a6d0bac9357d8c16ae8dd798ce3`; no uncommitted production changes (only this evidence directory and the foreign node_modules link). CLI 1, child 1, assertions-failed; all five Z.433 tests fail on behavior assertions (duplicate accepted delivery, retry after unknown outcome, overlapping attempts, false receipt, and legacy reviewer binding). Nine existing tests pass. One existing default-production-ports test also fails because its fixture omitted the now-required serviceEpoch; the hotfix test fixture supplies an explicit epoch without changing that production contract.

Full immutable result: `red.stdout.json`; stderr: `red.stderr.txt`; CLI code: `red.cli-exit-code.txt`; original tool envelope: `red.transport.json`. Cleanup complete, no remaining PIDs; no timeout; knownRed six IDs, unexecuted/unknown empty, group idle, timeoutCount 0, nextAction implement. The setup run's fifteen knownRed IDs were retained in the same aggregate and reduced only by passing tests; HOME/group were never reset.

## Implementation

Both service-host and production-runtime call the same context-review-only delivery function. A transaction writes package mainDelivery=uncertain before transport; a concurrent host, another command and a restarted process observe that durable claim and cannot resend. Acceptance writes delivered and promotes the current pending fact for reminder dispatch. This state lives in startup_context_reviews.payload and survives consumption/recreation of pending. Existing pending mainDelivered, bound reviewer or closed review provide migration evidence of delivery. A missing channel or absent running recipient leaves the event unattempted. False receipt or a thrown transport error retains uncertain with attemptId, attemptedAt and reason, and emits a diagnostic; it requires explicit investigation rather than automatic retry. Other event paths and health-summary code are unchanged. No schema change.

The regression fixture now includes a registered main for the five context-review cases, and preserves that session for the mocked transport. The original default-port fixture gets its explicit epoch. These preparation changes do not alter the target assertions.

## Verification status

Hotfix run `27f7c3f9-b6f5-4df3-902d-1d220968f1f6` passed all 15 tests, including the five new regressions. Exact command:

```
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/90734334-b607-48d3-afc1-1ab42e1f8ad6/raf-main/bin/raf.ts test run --project raf --phase hotfix --group complete-raf-flow-contracts/z433 --files test/service-host.test.ts
```

CLI 0, child exitCode 0, outcome passed, diagnostics empty/nontruncated, cleanup complete with no remaining PIDs, timedOut false. knownRed/unexecuted/unknown/removed all empty; groupState complete, timeoutCount 0, nextAction complete. Complete unchanged TestRunResult: `hotfix.stdout.json`; full CLI stderr (including unrelated confirmation warnings): `hotfix.stderr.txt`; CLI code: `hotfix.cli-exit-code.txt`; original tool envelope: `hotfix.transport.json`. Stable group and exact same QA HOME as red: `/tmp/raf-unit-1000/1ee10007bf6d5e71b39d6a2873064a767eeb928e7910599b166a0d60270ff685`.

At launch, HEAD was `b919a68` (full OID in before-hotfix.json) plus the exact own uncommitted implementation/test changes recorded below. Those same code bytes were committed while waiting for the result as `9d1555d52c1274e7c3239a2edababd911ab0de3e`; no further code changes followed. No CONFIGURATION_INVALID/refusal/cancellation occurred, so no retry was needed after main's conf notice. Resource usage measurement is explicitly partial; it is not treated as complete telemetry or a performance result.
 `before-hotfix.json`, `hotfix.patch`, and `startup-context-delivery.ts.txt` capture the exact workspace/implementation used for that run. `npm run build` passed with isolated temporary QA HOME; complete output and code are in `build.*`. `git diff --check` passed.

115 tasks in the change remain open at this executor's completion audit. Z.433's checkbox is owned by raf. No archive or unrelated task work is performed.
