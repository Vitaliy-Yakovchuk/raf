# fix-raf-handoff-relaunch-log 1.1

Повторний wrapper того самого `runId` (Z.478, handoff після зміни serviceEpoch) має стартувати, коли `worker.log` уже існує, і дописувати в нього.

## Red

- Команда: [red.command.txt](red.command.txt)
- Повний `TestRunResult`: [red.json](red.json)
- stderr: [red.stderr](red.stderr)
- Код CLI: [red.cli-exit](red.cli-exit) (`1`), окремо від child `exitCode` `1` у JSON
- HEAD workspace: `9e2395383534bb21304f1003961f8fc0531f7197`
- Незакомічено на момент прогону: `test/handoff-relaunch-log.test.ts`. `src/launch-wrapper.ts` ще відкривав `worker.log` через `wx+`
- runId: `4d0d0448-6d15-4dd0-955a-08398ed89dc5`
- Відбір: `test/handoff-relaunch-log.test.ts`, група `fix-raf-handoff-relaunch-log/relaunch-log`, phase `red`, profile `node`
- outcome: `assertions-failed`; timedOut `false`; cleanup `complete`, remainingPids порожні
- knownRed: `test/handoff-relaunch-log.test.ts::Z.478 second wrapper of the same runId appends to the existing worker.log`
- unexecuted: порожньо; unknown: порожньо; timeoutCount `0`
- groupState: `idle`; nextAction: `implement`
- Падіння: `EEXIST: file already exists, open '…/z478-run/worker.log'` після успішного першого wrapper

## Hotfix

- Команда: [hotfix.command.txt](hotfix.command.txt)
- Повний `TestRunResult`: [hotfix.json](hotfix.json)
- stderr: [hotfix.stderr](hotfix.stderr)
- Код CLI: [hotfix.cli-exit](hotfix.cli-exit) (`0`), окремо від child `exitCode` `0` у JSON
- HEAD workspace на момент прогону: `9e2395383534bb21304f1003961f8fc0531f7197`
- Незакомічено: тест і `src/launch-wrapper.ts` (`a+` замість `wx+`)
- runId: `02de516b-b261-4d98-bff2-9fea1eca09c2`
- Той самий відбір і група, phase `hotfix`
- outcome: `passed`; timedOut `false`; cleanup `complete`, remainingPids порожні
- knownRed: порожньо; unexecuted: порожньо; unknown: порожньо; timeoutCount `0`
- groupState: `complete`; nextAction: `complete`

Обидва прогони лишили попередження, що файл ще не в `unitFiles`. Це не setup і не відмова: файл запущено через явний `--files`.
