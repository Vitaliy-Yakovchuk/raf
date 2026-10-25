# Z.422 — SQLite contention hotfix

Змінено лише `src/state-store.ts` і `test/state-store.test.ts`. `DatabaseSync` використовує `conf/raf.json#/state/contention/timeoutMs` замість жорстких 250 мс. Політика перевіряється без числового fallback. Це спільне нативне очікування для SQL цієї connection, включно з прямим `ResourceUsageRepository.merge`; повторення callback або зовнішніх ефектів не додається.

Конфігурацію зареєстрував main у Orchestrator-коміті `1c5960673b`: `busyTimeoutMs=250`, `timeoutMs=10000`, `retryDelayMs=100`, за картою `openspec/changes/complete-raf-flow-contracts/state-store-design.md:50-52`. Фактичний конфіг і його SHA-256 наведено в `hotfix.workspace.json`. Код читає конфігурацію відносно модуля, включно зі snapshot конфігурації замороженого покоління.

Нативне очікування може блокувати поточний JS-потік до налаштованого бюджету. Повний асинхронний contention-протокол 7.x (окремі короткі спроби, yield, спільний monotonic deadline вкладених операцій, BUSY_SNAPSHOT) цим hotfix не реалізований і не оголошений виконаним. Вузький варіант погодив main у цій сесії.

## Перевірка test-first

Стабільна група всіх прогонів — `complete-raf-flow-contracts/z422`, project `raf`, profile `node`, selection `test/state-store.test.ts`. Дозволена команда для кожного прогону записана в `*.workspace.json`; префікс і група не змінювалися, QA HOME не скидався.

| Прогін | runId | CLI / child | Результат |
| --- | --- | --- | --- |
| Некоректна початкова fixture, phase red | ef8e21ea-05af-4a7d-ac3f-f2aa655bbd5e | 1 / 1 | assertions-failed, НЕ продуктовий red: async helper повертав сам Promise завершення holder та дочікувався звільнення блокування. Повний JSON і stderr збережені як invalid-fixture.* із відповіді інструмента. |
| Цільовий red після виправлення helper | a0f748f6-ebb3-4b8b-a44f-50bd6188b301 | 1 / 1 | 3 нові тести падають через database is locked, 12 попередніх passed. |
| Hotfix | 7b811ac6-b8a6-4370-a53e-3a1eeeab578b | 0 / 0 | passed, 15/15. |

У всіх трьох результатах `timedOut=false`, cleanup complete, remainingPids/unexecuted/unknown порожні, timeoutCount=0. Після red — groupState idle, nextAction implement, три knownRed; після hotfix — groupState complete, nextAction complete, knownRed порожній. Ідентичний QA HOME видно у незмінених JSON.

Регресія використовує окремий справжній Node-процес: він підтверджує `BEGIN IMMEDIATE`, після запиту запускає таймер 700 мс і підтверджує утримання блокування. Батьківський процес тоді пробує запис. Перевірено звичайний запис, запис після повторного відкриття бази та `ResourceUsageTracker.finish`. Для cleanup навмисна початкова коротка відмова залишає finishedAt=null, після відновлення стандартного timeout повтор завершує запис; повторна фіналізація і перевідкриття зберігають один незмінний результат.

`red.workspace.patch` і `hotfix.workspace.patch` містять точні власні незакомічені зміни на HEAD `11d07f787de0ec08839a19e174774662a822a6da`. Початкова некоректна fixture відрізнялася лише `return closed` та отриманням його результату; реалізація продукту до цільового red не змінювалася. Чужі попередні зміни state-store уже закомічені їхнім власником у 11d07f7, до власного редагування цього файла.

Повні незмінені TestRunResult — `red.stdout.json`, `hotfix.stdout.json`; stderr черги — окремі `*.stderr`, CLI code — `*.cli-exit-code`, child exitCode — усередині TestRunResult. `*.tool-result.json` зберігають повну необрізану відповідь exec_command. Інструмент повернув першим рядком stdout JSON, далі stderr; конкатенація окремих файлів побайтово збігається з повним output інструмента, довжини й SHA-256 наведено в `*.manifest.json`. Зовнішнього manifest хостового каналу ця сесія не отримувала.

`npm run build` пройшов, включно з перевіркою заборони коментарів у власному коді; `git diff --check` — 0. Додаткових unit-груп не запускали.

## Межі завершення

Ізольована регресія підтверджує повтор незавершеного cleanup. Живий run `5f1c3dbb-5831-4579-bac7-8c6c48782df9` у production HOME не змінювався. Main підтвердив, що його власник повторить cleanup після випуску. Випуск у main, push і активацію виконує main; цей коміт їх не виконує. Чужої unit-групи в immutable assignment немає, тому її прогін цим виконавцем не здійснювався.

Пункт tasks.md не змінювався виконавцем: галочку приймає raf за succeeded. В інших пунктах зміни є відкриті задачі, тому sync/archive не застосовуються.
