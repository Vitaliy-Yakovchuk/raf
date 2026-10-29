# audit-process-rules:1.12

Підстава: openspec/changes/audit-process-rules/tasks.md 1.12, questions/projects/raf/questions.md Q98 і audit-2026-10-26-timeouts-guards.md §1, §3. Звірено чинне доручення й Git baseline 4e97643ea8754ca333c85885b83c4a2ec5177818; завдання актуальне. Q98 уже закрито рішенням власника, чисел startupMs не збільшували.

Виправлено залишкові відмови через час: service lifecycle/transport readiness, helper Unix peer verification, resource readiness, Codex hook inspection, SQLite operation retry та обмежені WAL retries у state/bug store, чергу composer lease, підтвердження прийняття повідомлення й початкового брифу, integration execution/recovery. Таймер peer helper лише попереджає: перевірка PID/UID, відмова за невідповідності й зупинка helper після закриття socket збережені. Справжні помилки, скасування, втрата власника та ізоляція не перетворені на успіх.

Native startupMs/status, persistent readiness handshake, цикл підтвердження звіту, state-store contention і resource offer delivery уже мали warning-only поведінку в baseline. Це перевірено наявними тестами розширеної групи, додаткових змін там не потрібно. Codex sandbox preflight зі старого аудиту в чинному коді відсутній. Unit execution/cleanup timeout лишається за правилом власника. DISPUTED рядки аудиту (quota unknown, API request/retry, secrets lock, grant throttling) не класифіковані аудитом як REMOVE; їхніх контрактів це виправлення не змінює.

Спільний src/hotfix-host.ts: timeout→warning у writer/index lock і вилучення unit timeout з нетестової command погоджено передати комітом raf-gitval-1-14. Його Git-валідаційні правки належать 1.14. Атрибуція/остаточний SHA в coordination.json. Інші чужі файли до власного коміту не включено.

## Докази

Кожен JSON містить повний TestRunResult, точну команду, baseline/опис незакомічених змін, stderr CLI й окремий cliExitCode; result.exitCode є кодом child. Значення diagnostic.truncated збережені як повернув runner; вони не означають обрізання TestRunResult. Група весь час audit-process-rules/timeout-warnings; QA HOME незмінний, агрегат не скидався.

- red.json: первинні assertion failures SQLite, service readiness, resource readiness.
- red-additional.json: assertion failures повільного hook, нетестової hotfix command та integration.
- red-delivery.json: WAL і composer regression; старий diagnostic assertion та початково помилковий slow fixture окремо відмічені, не використані як доказ red для initial brief.
- red-initial-brief.json: виправлений slow fixture дає справжній Native initial brief acceptance timed out.
- red-peer.json: helper справді вбитий таймером, Unix peer verification failed: helper interrupted.
- hotfix.json: перші 119 tests passed.
- hotfix-selection-refused.json: розширення групи відмовлено до spawn через відсутній inventory entry; конфіг виправлено. Це не pass і не red.
- hotfix-expanded.json: 207 tests passed.
- hotfix-peer-assertion.json: додана negative identity assertion мала неточний regexp; перевірку виправлено на фактичний diagnostic, product identity check лишився чинним.
- hotfix-final.json: runId e4885bf1-8bc3-447a-b9ae-4f6b6d93d62e, 208 tests passed, cliExitCode=0, child exitCode=0, timedOut=false, cleanup.complete=true, remainingPids=[], knownRed/unexecuted/unknown=[], groupState=complete, nextAction=complete.

Попередження CLI щодо груп etchly збережено дослівно, вони не стосуються відбору raf. Облік пікових ресурсів має власні completeness/unknown пояснення у TestRunResult і не подається як повна ресурсна перевірка. git diff --check пройдено. Main не активовано й push не виконувався. Інші пункти зміни відкриті, тому tasks.md та archive не змінено.
