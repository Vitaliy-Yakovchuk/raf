# fix-raf-test-run-readonly-generation:1.1

Audit: the W_OK gate still exists in the assigned base and blocks generation client dispatch before the test-run handler. The assignment remains current. No requirements, limits or deadlines changed.

The public CLI no longer requires write access to activation control before dispatch. A generation CLI tolerates only EROFS/EACCES from its own reader registration. Writable clients still retain/release their lease; other reader failures still refuse. The trusted published-agent launcher holds its own generation lease until its child exits (`src/main-switch-agent-launcher.ts`, `runPublishedAgentChannel`). Service reader acquisition and worker retention are unchanged and keep their existing failure handling. Production state/runtime-origin checks still run in the production entry.

The unit fixture calls the real `runPublicCli` with a generation entry URL and injects filesystem/reader failures. It verifies test-run dispatch, the unchanged original execution result, writable retention and non-permission refusal. The old read-only-refusal assertion was replaced because it asserted the reported defect; genuine reader/state failures remain covered.

| Evidence | runId | Outcome | CLI / child exit | Passed / known red |
| --- | --- | --- | --- | --- |
| red | 12cab505-ab83-4dd2-ad86-e4752269d5b4 | assertions-failed | 1 / 1 | 2 / 2 |
| hotfix | b2ebdc0f-3963-4233-87e9-11e390b484fe | passed | 0 / 0 | 4 / 0 |
| regression | 2ed22e37-d495-4f59-86d1-abb82921c1cb | passed | 0 / 0 | 152 / 0 |
| owner | 6825f120-6a28-4011-90dd-5b5d029254f9 | passed | 0 / 0 | 10 / 0 |

For every run, `<name>.result.json` preserves the complete unchanged TestRunResult line. `<name>.stderr.txt` preserves the CLI stderr, `<name>.cli-exit-code.txt` the CLI code separately from TestRunResult.exitCode, and `<name>.tool-result.json` the complete tool response. The command and pre-run SHA/uncommitted workspace diff are recorded in `<name>.command.txt` and `<name>.workspace.txt`. The split result plus stderr was verified byte-for-byte against the tool output. The tool exposes a combined output stream; the single complete JSON line and remaining warning lines were separated without rewriting their contents.

All runs used the same isolated QA HOME selected by the trusted wrapper. No group timeout was recorded. Red had groupState=idle, nextAction=implement; hotfix completed the same group, knownRed=[], unexecuted=[], unknown=[], timeoutCount=0, groupState=complete, nextAction=complete. Both configured regression groups also completed with no red, unexecuted or unknown remainder. Every cleanup was complete and timedOut=false. Resource-usage completeness is partial as recorded by the wrapper; it is not represented as complete measurement.

Main registered the unit profile inventory and group in Orchestrator commit bcbd77a5b8fd080a8cb60e4c78d16a4e08512a16. This is a coordinator-owned configuration commit, not an executor commit. Existing regression groups were invoked by their configured presets without adding those changes to the assignment.

`openspec validate fix-raf-test-run-readonly-generation --strict` returned 0; see openspec-validation.txt. The change has skip_specs: true. Executor leaves task checkboxes to raf and archives only after the confirmed checkbox commit.
