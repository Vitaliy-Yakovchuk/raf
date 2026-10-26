# Z.461

Реалізовано production MainSymlinkStorage та підключено до наявних activateHotfix/recoverHotfixActivation для raf-main → raf-main-a|b. Верифікований sealed snapshot копіюється лише в неактивний слот; active symlink змінюється одним portable rename. Спільний activation engine зберігає checkpoint/gates/smoke/recovery. Production store і source hotfix лишаються окремими.

Durable intent містить початковий стан і точного кандидата. Під activation lock узгоджуються main ref, HEAD та index копії, фізичний gitlink, staged symlink, staged і worktree .gitmodules, immutable runtime registry. Чужі staged/unstaged записи збережено. Окремий owner journal та inode-перевірка дозволяють прибрати після SIGKILL лише власний index.lock; чужий lock зберігається. Читачам із pending intent повертається тимчасова відмова, cleanup не прибирає recovery snapshots.

ensureProductionMainStore реєструє gitdir/commondir до fetch і копіювання HEAD/index/ORIG_HEAD; mirror clone і staging мають gc.auto=0 та maintenance.auto=false. Process identity має ps fallback для macOS без procfs.

Операторський виклик наявного activation API (без нового пункту CLI-каталогу):

```text
node scripts/activate-hotfix.ts <canonical-orchestrator-root> <same-isolated-QA-HOME-used-for-gates> <verified.json>
node scripts/activate-hotfix.ts <canonical-orchestrator-root> <same-isolated-QA-HOME-used-for-gates> --recover
```

Вхід — verified.json із чинного verifyHotfixCandidate; скрипт не створює й не підміняє gate evidence. Активацію production та окремий handover довгоживучих компонентів виконує main за своїми повноваженнями. У цій сесії production не перемикалося, агенти не зупинялися.

Повні незмінені TestRunResult збережено як *.result.json, stderr окремо як *.stderr.txt, CLI exit code окремо від child exitCode як *.cli.json. Точні команди, SHA/незакомічений стан, runId, відбір, outcome, cleanup/timeout, knownRed/unexecuted/unknown, стан агрегату й nextAction — у [runs.json](runs.json). Snapshot перед фінальною перевіркою — [final.source.json](final.source.json), [final.workspace.patch](final.workspace.patch); початковий red має власний snapshot. Історичні environmental та behavioral failures збережено без переписування.

- Red a221840a-e355-4c06-a683-99d642335298: 3 assertions-failed через відсутній provider, не setup/import failure.
- Red 26fde553-ca36-4508-931c-2c0a6ec87052: 3 assertions-failed (procfs, prune-incomplete, maintenance), попередні 3 вже passed. Той самий агрегат розширено другим файлом.
- Hotfix cce8f223-daa9-4351-8fb0-1ad95ab3e7d3 та фінальний 7d802a51-5b6f-44b9-9e4d-7dc858ccb2f5: 6/6 passed, CLI/child 0.
- Integration 862cf74a-c252-4525-97d9-2993d5140062: passed, CLI/child 0. Справжні Git-репозиторії, захищений store, повні gates двічі, A→B→A, interruption до rename, SIGKILL під index.lock, recovery/idempotency, immutable старий reader та чужі staged/unstaged bytes/lock.
- Налаштована регресія іншої зміни switch-raf-main-by-symlink/release, 51b4ce6a-d038-458d-af98-f71bfb5334e5: 64/64 passed; цю зміну не додано до assignments/tasks.
- У фінальних трьох результатах cleanup.complete=true, timedOut=false, knownRed/unexecuted/unknown порожні, groupState=complete, nextAction=complete. Ресурсна телеметрія має чесно збережену partial/unknown completeness; це не твердження про повний облік RAM/disk.
- [build.json](build.json): repository build passed. Exploratory tsc не був валідною перевіркою (немає @types/node), pass йому не приписується.

Перевірено на Linux; portable rename виконувався нативно, відсутність procfs перевірено fault injection. Нативного macOS-прогону в цій сесії немає. Mac operation.log із доручення недоступний тут; детермінований prune/copy/chmod сценарій відтворено локальним регресійним тестом.

Аудит proposal/tasks і чинних workspace-routing вимог підтвердив актуальність Z.461, суперечностей не виявлено. Нових вимог/CLI-команд/таймаутів не додано. Галочку Z.461 ставить raf після прийняття succeeded. Інші відкриті задачі complete-raf-flow-contracts лишаються; sync/archive не застосовуються.
