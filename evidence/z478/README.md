# Z.478 handoff epoch

Група `complete-raf-flow-contracts/z478-handoff-epoch`. QA HOME прогонів не скидався.

- `red.result.json` — phase red, runId `d48eef83-7dbf-4b4d-b541-a2fe3e7f902b`, CLI exit 1, child exitCode 1, outcome `assertions-failed`, cleanup complete, timedOut false. knownRed: зміна serviceEpoch під час handoff; заміна мертвого wrapper. SIGTERM уже відпускав резервацію після повернення start. nextAction implement.
- `hotfix.result.json` — phase hotfix, runId `64c882c6-18b8-4937-8249-9ef8199ac5c7`, CLI exit 0, child exitCode 0, outcome `passed`, knownRed порожній, groupState complete, nextAction complete.
- `regression.result.json` — той самий group, phase hotfix, runId `4919f111-3100-4188-acbb-e774e331bc02`, CLI exit 0, outcome `passed`, 175 тестів, knownRed/unexecuted/unknown порожні. Файли: z478, task-reservations, agent-run-queue, agent-queue-start-result, launch-wrapper.

Команда red і hotfix: `node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/c16b357a-2033-4363-881b-046d0eb2a8be/raf-main/bin/raf.ts test run --project raf --phase <red|hotfix> --group complete-raf-flow-contracts/z478-handoff-epoch --files test/z478-handoff-epoch.test.ts`.

Stderr і код CLI лежать поруч із кожним result. `*.result.json` — незмінений JSON TestRunResult.
