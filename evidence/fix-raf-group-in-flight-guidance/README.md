# fix-raf-group-in-flight-guidance 1.1 evidence

- Workspace HEAD before implementation: a13230f10429e8748c7fb86c22c78ef90f374d4f.
- Unit group: fix-raf-group-in-flight-guidance/group-in-flight-guidance; selected file: test/test-run-legacy-in-flight.test.ts.
- RED: runId 54ac1934-26e9-4df1-a772-535025e0c53a; assertions-failed; 3 knownRed message assertions, no unexecuted or unknown tests; timeout false, cleanup complete. Full JSON: red-test-run-result.json.
- First hotfix attempt: runId eebcb0eb-c7c0-418b-9002-b319b98c9500; assertions-failed because the fixture capped messages at 128 bytes, truncating remediation. Full JSON: initial-hotfix-test-run-result.json. The fixture cap was raised to 512 bytes; production configuration is 4096 bytes.
- GREEN: runId af678aa0-e51e-4076-afff-62b37e67f4d1; passed; 23 tests passed, no knownRed, unexecuted, or unknown; timeout false, cleanup complete; group complete, nextAction complete. Full JSON: hotfix-test-run-result.json.
- CLI exit codes and commands: red-cli-metadata.json and hotfix-cli-metadata.json. The exec harness combined stdout and stderr; it exposed the stderr result path and warnings in the tool output but did not offer a separately capturable raw stderr stream.
- The test checks the full refusal guidance, including runId, pid, deadline, waiting and retrying the same command, and automatic recovery on the next call when the process is gone.
