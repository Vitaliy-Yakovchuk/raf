# Z.413 — порожні sandbox mountpoints у списку OpenSpec

Початковий аудит підтвердив дефект на базі `b0448de5d6c130a791fd631ed281d13763ee86a5`: `src/assignment.ts` відхиляв увесь список через `.git`, `.codex`, `.agents`, `.aws`. Z.413 залишається актуальним; proposal і вибраний пункт узгоджуються з вузьким виправленням. Main погодив перевірку фактичної порожньої теки й зареєстрував стабільну групу `complete-raf-flow-contracts/z413` (Orchestrator `4d79f269d3`).

Парсер пропускає лише ці чотири точні назви з обома цілими лічильниками `0/0`, якщо `lstat` підтверджує теку без symlink, а `readdir` — відсутність будь-якого вмісту. Перевіряється фактична адреса active або archive списку. Відсутній шлях, файл, symlink, непорожня тека або помилка читання не дають винятку. Справжні невалідні імена, неповні/некоректні лічильники й дублікати справжніх змін надалі відхиляються з попередньою точною причиною. Sandbox preparation, захист цих чотирьох назв і CLI не змінено.

## Test-first та результати

Тест закомічено **до виправлення**: `72f28fbb660cc4cdc117cec670278f788c0c95b7`, `test/assignment-sandbox-placeholders.test.ts`. Очікування після red не змінювалися. Власні команди, повний selection, SHA/незакомічені зміни, runId, CLI/child коди, cleanup/timeout, knownRed/unexecuted/unknown та стан групи/наступна дія — [runs.json](runs.json), [red workspace](red-workspace.json), [hotfix workspace](hotfix-workspace.json), [точний source diff](source.diff).

- [Red TestRunResult](red.TestRunResult.json), `54fd0ade-4382-4651-868f-b2f0a5b2692a`: `assertions-failed`, 4 цільові knownRed, 40 passed, CLI/child `1/1`, timeoutCount `0`, groupState `idle`, nextAction `implement`. Це assertion red на потрібній поведінці: вибір, підтвердження завершеного checkbox та точна діагностика відкритого checkbox/дублікатів блокувалися `malformed changes`. Setup/import failure відсутні.
- [Hotfix TestRunResult](hotfix.TestRunResult.json), `aa09a2ca-1ee9-4df5-a55f-15eca4d56c9c`: **71 passed**, CLI/child **0/0**, groupState/nextAction `complete`, timeoutCount `0`; knownRed/unexecuted/unknown/removed порожні. Одним списком `--files` передано новий файл та `test/assignment.test.ts` у тій самій групі.
- Обидва прогони: `timedOut=false`, `cleanup.complete=true`, `remainingPids=[]`, той самий ізольований QA HOME/state. Перейменування групи, зміни HOME чи скидання агрегату немає. Чужі групи не запускали.

`*.TestRunResult.json` зберігають повний незмінений JSON, побайтово звірений з `output` відповідного `*.tool.json`. Tool JSON окремо містить код CLI; child `exitCode` залишається у TestRunResult. **Обмеження каналу:** `exec_command` повертає combined output і не надає незалежного stderr; тому stderr чесно позначено недоступним (`null`) у tool metadata й окремих `*.stderr.json`, а не названо порожнім. Combined output збережений повністю, без truncation. Це та сама доступність доказу, що у попередньому Z.412; main повідомлено чинним каналом.

## Перевірки та завершення

[Build](build.result.json) і [check:comments](comments.result.json) — exit `0`; stdout/stderr кожної команди збережено окремо, використано той самий ізольований QA HOME. `git diff --check` — `0`. Зміни коду обмежені `src/assignment.ts`; build не підтверджує активації робочої raf-main.

[Аудит завершення](completion-audit.json): ще 133 інші відкриті пункти complete-raf-flow-contracts. Виконавець не редагував tasks.md й не архівував зміну. Raf ставить і комітить лише галочку Z.413 після валідного succeeded. Власний коміт тестів наведено вище; наступний власний коміт містить виправлення та ці докази, його повний SHA передається в атомарному JSON-звіті. Початковий сторонній untracked `node_modules` залишено без змін. Push/активацію виконує main.
