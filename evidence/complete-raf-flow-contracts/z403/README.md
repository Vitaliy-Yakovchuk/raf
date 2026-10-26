# Z.403

Дефект QA Z.390.8: після stop/finish у `/tmp/raf-ipc-<uid>` лишався compact alias hotfix commit port, коли `runDirectory` або `.ipc` уже видалено. Регресія в `test/hotfix-commit-port-cleanup-z403.test.ts`, група `complete-raf-flow-contracts/z390`. Файл уже був у інвентарі групи; `conf/test-runs.json` не змінювався. QA HOME і назва групи не скидалися.

Обидва прогони йшли з HEAD `80c7901aa584d1ef069e6f81eb2b1161e5e9b43e` і незакоміченими власними шляхами. Red — лише новий тест. Hotfix — той самий тест і виправлення `src/raf-temporary-socket.ts`.

Термінальний лог зливає stdout і stderr. `*.TestRunResult.json` — дослівно один рядок JSON із `testKind`. `*.stderr.txt` — рядки `STATE_CONTEXT_WARNING`. `*.after-result.txt` — подія `launch-queue.waiting` після результату. `*.cli-exit-code.txt` — код CLI, окремо від `exitCode` у JSON.

## Red

```
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/537e0584-c857-4b61-bd5b-cffd87f1d655/raf-main/bin/raf.ts test run --project raf --phase red --group complete-raf-flow-contracts/z390 --files test/hotfix-commit-port-cleanup-z403.test.ts
```

CLI 1, child `exitCode` 1, runId `6a022786-264f-47a9-a870-848f2f4187d8`, phase `red`, callerPhase `hotfix`. Відбір: `test/hotfix-commit-port-cleanup-z403.test.ts`. outcome `assertions-failed`. 3 passed, 4 knownRed, unexecuted `[]`, unknown `[]`. timedOut false, cleanup.complete true, remainingPids `[]`, groupState `idle`, timeoutCount 0, nextAction `implement`.

knownRed: `[Z403 port runDirectory]`, `[Z403 port .ipc]`, `[Z403 endpoint runDirectory]`, `[Z403 endpoint .ipc]`. Причина — `ENOENT` на `lstat` уже видаленого `.ipc` під час cleanup, власний alias лишається. Контроль без видалення каталогу і обидва ownership-сценарії пройшли. Це не setup/import failure.

## Hotfix

Та сама команда з `--phase hotfix`.

CLI 0, child `exitCode` 0, runId `203729a1-b9a6-48ea-90c8-9184795b92d9`, phase `hotfix`. outcome `passed`. 7 passed, knownRed `[]`, unexecuted `[]`, unknown `[]`. timedOut false, cleanup.complete true, remainingPids `[]`, groupState `complete`, timeoutCount 0, nextAction `complete`.
