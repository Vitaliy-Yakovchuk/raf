# fix-raf-handoff-relaunch-runner 1.1

Повторний wrapper того самого `runId` (Z.478, handoff після зміни serviceEpoch) має замінити залишок tmux-сесії з тим самим ім'ям і довести запуск до readiness. Нових таймаутів немає.

Причина: abort епохи вбиває процес worker, але detached-сесія tmux лишається. Повтор використовує те саме `tmuxSession`. `new-session` падає з `duplicate session` і для живої заглушки, і для рано завершеного pane з `remain-on-exit` (`pane_dead=1`). Другий wrapper до readiness не доходить. Виправлення в `startWithoutInput`: один `kill-session` лише коли помилка містить `duplicate session`, потім повторний старт pane.

`worker.log` прогону `dd2fede7-6822-44da-83b3-9589bcb86a41` не відновлено: каталог `/home/dev/.raf/tmp/dd2fede7-6822-44da-83b3-9589bcb86a41` видалено. Регресія відтворює названу причину (повтор імені сесії та ранній вихід spawn).

## Red

- Команда: [red.command.txt](red.command.txt)
- Повний `TestRunResult`: [red.json](red.json)
- stderr: [red.stderr](red.stderr)
- Код CLI: [red.cli-exit](red.cli-exit) (`1`), окремо від child `exitCode` `1` у JSON
- HEAD workspace: `0198541d12b12599181da7f97a6a4b31ec6bcb3f`
- Незакомічено на момент прогону: `test/handoff-relaunch-runner.test.ts`. `src/agent-adapters.ts` ще не замінював дублікат сесії
- runId: `6a754dc1-1566-4b6b-9411-222797557d4a`
- Відбір: `test/handoff-relaunch-runner.test.ts`, група `fix-raf-handoff-relaunch-runner/relaunch-runner`, phase `red`, profile `node`
- outcome: `assertions-failed`; timedOut `false`; cleanup `complete`, remainingPids порожні
- knownRed: `test/handoff-relaunch-runner.test.ts::Z.478 second wrapper of the same runId replaces a leftover tmux session and reaches readiness`
- unexecuted: порожньо; unknown: порожньо; timeoutCount `0`
- groupState: `idle`; nextAction: `implement`
- Падіння: `tmux new-session failed: duplicate session: z478-session` після успішного першого wrapper і abort

## Hotfix

- Команда: [hotfix.command.txt](hotfix.command.txt)
- Повний `TestRunResult`: [hotfix.json](hotfix.json)
- stderr: [hotfix.stderr](hotfix.stderr)
- Код CLI: [hotfix.cli-exit](hotfix.cli-exit) (`0`), окремо від child `exitCode` `0` у JSON
- HEAD workspace на момент прогону: `0198541d12b12599181da7f97a6a4b31ec6bcb3f`
- Незакомічено: тест і `src/agent-adapters.ts` (один `kill-session` на `duplicate session`, потім повторний старт)
- runId: `8005e484-0734-4bcb-89f8-a1cbf16c3c94`
- Той самий відбір і група, phase `hotfix`
- outcome: `passed`; timedOut `false`; cleanup `complete`, remainingPids порожні
- knownRed: порожньо; unexecuted: порожньо; unknown: порожньо; timeoutCount `0`
- groupState: `complete`; nextAction: `complete`
- admission: `HOTFIX_ONLY` (normal load перевищив 1.2); queue.waited `true`

Обидва прогони лишили попередження, що файл ще не в `unitFiles`. Це не setup і не відмова: файл запущено через явний `--files`.
