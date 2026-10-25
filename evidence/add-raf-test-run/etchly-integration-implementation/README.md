# add-raf-test-run:6.2.6.2

Реалізація: `9acb35ab1d1992ba1d99ea2fe86e00e21b70f7b2`. Незалежний виконавець після підтвердженого scaffold red `7a83dbc0-fd5c-4142-801d-9a67afd426f0`; підготовлені тести прочитані лише після початкової реалізації, не змінювалися. Галочки tasks.md не змінювалися. Інші пункти відкриті, архівація не виконувалася.

Додано D1 Vitest integration profile, точні presets, статичний type-aware inventory, production validators/planner/runtime/events, окрему integration timeoutPolicy для test/hook/deadline/transport, guards локальних залежностей/build, приватні HOME/TMP/cache та cleanup. Числа unitTests/integrationTests і conf не редагувалися.

Повні незмінені TestRunResult, команду, runId, відбір, SHA/dirty context фінальних прогонів, CLI/child codes, cleanup/timeout/knownRed/unexecuted/unknown, стан групи та наступну дію містить [runs.json](runs.json). `.stdout` та `.result.json` кожного прогону однакові байт у байт; SHA256 у `.capture.json`. Інструмент повертає об'єднаний output: поза повним JSON stderr не спостерігався, окремі порожні `.stderr` фіксують саме це спостереження. Незалежного захоплення OS stderr цим каналом немає; це обмеження не приховано. Оригінальні child diagnostics збережено в JSON. Результати не обрізані.

Фінальні прогони на закоміченому власному коді, незмінній групі та тому самому QA HOME:

| Група | RunId | Результат | CLI / child | Стан / наступна дія |
| --- | --- | --- | --- | --- |
| add-raf-test-run/etchly-integration | 13bea059-ac71-416a-b2f6-c272fae9a2f7 | 91 passed | 0 / 0 | complete / complete |
| add-raf-test-run/etchly-profiles | c73dc72d-00c5-4f28-92ff-60af4a21d461 | 87 passed | 0 / 0 | complete / complete |
| add-raf-test-run/integration-profiles | 61664645-ea7e-42b4-ab5a-4b87ee6d5abf | 102 passed, 2 knownRed | 1 / 1 | idle / fix-implementation |

В усіх трьох cleanup complete, remainingPids порожній, timeoutCount 0, timedOut false, unexecuted/unknown порожні. Регресія integration-profiles залишається червоною. [integration-runtime-scaffold-defect.json](integration-runtime-scaffold-defect.json) містить початковий runId `94694035-a8ea-4203-8832-eec071541946`, доказ незміненого baseline guard і причину: два тести повторюють runTestRun без acknowledgement delivery.pending, тому отримують попередній результат. Main повідомив, що виділить виправлення scaffold окремому агенту; prepared tests і delivery contract збережено.

`build-final.*`, `types-module-final.*`, `openspec-final.*`: exit 0. Ширша strict typecheck всіх десяти змінених файлів має exit 2: 30 наявних діагностик. [types-final-comparison.json](types-final-comparison.json) порівнює один snapshot, включно з чужими паралельними правками, з baseline, де тільки власні десять файлів замінені parent-версіями: ті самі 30 діагностик, внесених немає. Сирі baseline/current stdout/stderr і коди збережено. Раніші перевірки теж збережені й не замінені фінальними.

Передача незалежному QA 6.2.6.3:

- Перевірений registration patch: `evidence/add-raf-test-run/etchly-integration-scaffold/etchly-registration.patch.json`, SHA256 `b449411caf27b16e83540d1994445ce9923003be016143052f203241523da343`. Main застосовує його в conf; поточний стан і hash conf у [qa-handoff.json](qa-handoff.json).
- [registration-final.stdout](registration-final.stdout) доводить статичну валідацію 621 D1-файлу без unit overlap і production command planning чотирьох точних presets на Etchly `a6b072652ccb6c1e478b2046b2523314c4209908` (чисте дерево). Це перевірка inventory/planner; синтетичні environment inputs не є живим preflight.
- Invoked unit generation: `3557f6a4-89a2-41a3-b963-b4343aabc699`. Нове покоління для D1 ще не визначено. Main має перенести сумісні src, bridge scripts і conf після switch-raf-main-by-symlink 6.6, записати точний generation ID/commit/config fingerprints та забезпечити довірене доручення etchly для власної активної integration-групи.
- Preload `scripts/shared-library-runtime.mjs`, cwd `worker`, project `worker-d1-integration`, точні файли перед options. Локальні Etchly/Vitest/Cloudflare dependencies, executable workerd/esbuild, фізичний shared-libs alias та resource-protocol мають відповідати preflight; потрібний `app/dist/local/index.html` для local environment без dev1-маркера. Автоматичного install/build немає.
- QA HOME та власний run TMP мають бути canonical, uid-owned, private 0700; кінцевий TMPDIR не довший за 50 байтів. Потрібний локальний loopback listen. TMP, Wrangler logs, Node/npm/Vitest caches приватні. Спільні operational/worker endpoints і успадковані credentials не допускаються.
- Повний відбір QA: `--project etchly --phase qa --group add-raf-test-run/etchly-worker-d1-smoke`; точні файли smoke та три інші presets наведені в registration evidence. Виклик здійснює незалежний QA через наданий йому перевірений raf prefix і канал, після реєстрації/rollout. Живі D1/process сценарії не запускалися в implement і не видаються за пройдені.
