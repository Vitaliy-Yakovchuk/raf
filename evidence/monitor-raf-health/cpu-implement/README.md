# monitor-raf-health 2.3 — реалізація власного CPU

Доручення: лише CPU за profile-raf-performance; тести не змінено. Передумови: monitor-raf-health 1.2/2.2 та прийняті profile §2–§3, підтверджені tasks.md. Main додав погоджені ключі conf і каталог комітом Orchestrator e920d9dd17; ці файли поза файловими межами виконавця.

Реалізація: `fc2f9d2d47fa564742a44e7e2cf6e503c47a0911` у `/srv/dev/work/orchestrator/raf-develop`. Новий профайлер, admission, EMA й тести не змінювалися. Наявний профіль отримав внутрішні порти відомих меж/відкритих інтервалів і лічильників завершених samples; публічний формат profile збережено. Вікно використовує прирости CPU і міжпроцесний monotonic hrtime; сума wall паралельних процесів не є знаменником.

Оперативний стан у тій самій SQLite: сумісне додавання таблиці `raf_health_cpu` під чинним guard і транзакцією, без підвищення user_version 18 чи зміни старих таблиць (попереднє покоління продовжує читати свою схему). Один непрозорий domain UUID, accumulation UUID, baseline, остання оцінка, bounded metadata за ключами профілю, активні інтервали. Подія й межа в одній транзакції; факт — у чинному pending_intents/event-registry, не в окремому журналі. Невідомі записи попередніх поколінь/незавершені інтервали залишають оцінку partial/unavailable; успішним нульовим CPU це не оголошується. Втрата metadata не скасовує запис основного профілю. Падіння процесу може залишити незавершений інтервал і відповідну неповноту; автоматичного вгадування його CPU немає.

Команда всіх трьох unit-прогонів (без зміни group/HOME/ledger):

```sh
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/23e78b0d-9095-48b2-929b-0e5e8d307756/raf-main/bin/raf.ts test run --project raf --phase implement --group monitor-raf-health/cpu --files test/health-cpu.test.ts
```

| Доказ | runId | Outcome / CLI / child | Відомі червоні / невиконані / unknown | Стан / наступна дія |
| --- | --- | --- | --- | --- |
| initial.TestRunResult.json | 81b9c57a-b89e-4ae4-8ba2-8d24fa5136fc | assertions-failed / 1 / 1 | 2 / 0 / 0 | idle / fix-implementation |
| green.TestRunResult.json | 3ba75149-8fc5-4d34-9853-daed1867e34f | passed / 0 / 0 | 0 / 0 / 0 | complete / complete |
| final.TestRunResult.json | 167926e3-86fb-48ad-a6b9-9ab1b299a782 | passed / 0 / 0 | 0 / 0 / 0 | complete / complete |

Кожний прогін: 66 тестів загалом, timedOut=false, timeoutCount=0, cleanup.complete=true, remainingPids=[]. Початковий прогін мав 64 passed і два коректні падіння: порожній профіль помилково вважався нульовим CPU; lifetime partial через стару відсутність CPU помилково знецінював новий повністю виміряний приріст. Виправлено код без зміни assertions. Переданий red 18e77cd3-f433-4a7a-8dde-651ad7f725d5 з tasks.md не скидався; наступні прогони використовували той самий агрегат.

`*.TestRunResult.json` — повний JSON CLI без зміни полів; `*.cli-exit.txt` відокремлює код CLI від exitCode child. Transport exec об'єднує потоки; весь повернений unit-вивід є одним валідним JSON без сторонніх байтів, stderr порожній (`*.stderr.txt`). Для green/final додатково збережено незмінений об'єкт tool-result із output. Фінальні SHA/status/patch — `final.before.*`; source/test patch порожній, незакоміченою залишалася лише власна evidence-тека. Початковий прогін був на SHA з `first.workspace-sha.txt` з первинними незакоміченими source-змінами. `after-first-fix.workspace.patch` знято вже після виправлення двох падінь, а `green.before.*` — перед першим green; їх не слід вважати точним snapshot початкового red. Його дві відмінності описано вище.

Фінальні `npm run build` і `npm run check:comments`: 0; розділені stdout/stderr й коди у `final.build.*`, `final.check-comments.*`. `git diff --check`: 0. Production-модулі імпортуються без помилок. Додатковий in-memory SQLite wiring probe із явно синтетичними CPU-лічильниками перевірив з'єднання портів, атомарність, deduplication, відкриті/закриті інтервали, metadata batch merge, unknown writes і збереження профілю при відсутній health-таблиці. Очікувана warning у цьому останньому сценарії збережена в `storage-probe.result.json`. Це не живе CPU QA пункту 2.4; воно залишається відкритим.

Інші unit-групи не запускалися: пункт 2.3 не має regressionGroups. Чужі правки/коміти й галочки tasks.md не включено; їхнім власником є raf. Інші пункти зміни відкриті, archive не виконується. Наступна дія — незалежний QA 2.4.
