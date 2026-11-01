# fix-raf-close-latency-many-workers:1.1

## Аудит і межі

Доручення актуальне: до реалізації два власні assertion failures відтворили надмірні writer-транзакції та повне читання payload історичних сесій у writer-транзакції. Proposal і task 1.1 узгоджуються з чинним projects/raf/command-timing (CPU/wall aggregation, durable completed observations), core/process/unit-test-runs і projects/raf/test-runs. Нових вимог, production timeout, polling, лімітів чи налаштувань немає. skip_specs: true.

## Причина й виправлення

- Кожний вкладений перехід worker cost profiler та кожна child sample окремо брали writer lock (`costProfile.sample`). Внески одного зовнішнього `measure` тепер накопичуються за наявними ключами та атомарно зливаються однією транзакцією при завершенні спостереження. Завершений цикл видимий до повернення `measure`, без очікування worker finish. Збережено self/child, samples, UTC boundaries, CPU availability і health coverage. Command/service поведінка збережена.
- `putSession` при створенні result notice робив `tx.listSessions()` та JSON.parse усіх історичних payload, тримаючи writer lock. Recipient тепер визначається адресним SQL lookup через наявний partial index `sessions_active_address` (предикат `state != 'finished'` присутній явно). Збережено running-recipient semantics та atomic notice insertion.
- `reminderTransaction` конкурує за той самий writer lock; у фікстурі його власна одна транзакція коротка. Його timeout/flow не змінено.

## Фікстура й виміри

Реальна окрема SQLite на диску, WAL/FULL, 40 worker identities зі станом alive, main та 400 finished sessions із payload 16 KB. OS identity/transport — ізольовані doubles, без запуску 40 зовнішніх агентів. Виконано реальні control.ps/control.close та reminder handler; profiler працює через реальний StateStore. Locks вимірюються як кількість `BEGIN IMMEDIATE` та сумарний monotonic час від успішного BEGIN до COMMIT. Це час утримання, без часу очікування чужого lock. Паралельний OS lock-contention/production benchmark не виконувався.

Одиничні діагностичні виміри red → остаточний hotfix (мс; повні числа у [measurements.json](measurements.json)):

| Операція | Wall до → після | CPU до → після | Writer locks до → після | Утримання lock до → після | Повні session payload reads до → після |
|---|---:|---:|---:|---:|---:|
| 40 worker observation wakeups | 70.294 → 29.121 | 76.437 → 29.726 | 440 → 40 | 56.495 → 18.252 | 0 → 0 |
| agent ps | 79.300 → 80.678 | 107.901 → 98.574 | 48 → 48 | 22.324 → 18.457 | 4 → 4 |
| agent close | 99.698 → 139.226 | 111.892 → 161.344 | 12 → 12 | 24.965 → 25.251 | 7 → 7 |
| reminder add | 1.203 → 1.530 | 1.186 → 1.422 | 1 → 1 | 0.619 → 0.755 | 0 → 0 |
| 40 result acceptances | 302.584 → 7.809 | 317.011 → 7.934 | 40 → 40 | 301.708 → 7.211 | 40 → 0 |

Структурне скорочення writer-lock acquisitions на observation cycle — 11 разів; усунуто 40 повних payload читань у writer-транзакціях прийняття результатів. Таблиця не доводить прискорення close/ps/reminder: тут немає конкурентних writer-процесів, серії CLI-вимірів або заміру production 20–200 секунд. Не заявляємо такого прискорення на підставі цих одиничних чисел. Наявні повні читання при ps/close лишаються в їхньому reconciliation flow; предмет виправлення — background writer churn і довгі writer sections.

## Test-first і результати

Усі тести запускалися лише дозволеним `raf test run`. Власна стабільна група `fix-raf-close-latency-many-workers/unit`, незмінний ізольований QA HOME із TestRunResult; агрегат не скидався. Інші changes не додавалися до tasks.

| Доказ | runId | Результат | CLI / child exit | Group / next action |
|---|---|---|---|---|
| [red](red-test-run-result.json) | ff0a2514-95f3-4c1b-b8d1-1ba7ae59c0be | assertions-failed: 1 pass, 2 knownRed (440 locks; 40 full reads) | 1 / 1 | idle / implement |
| [hotfix-1](hotfix-1-test-run-result.json) | 730effab-0c98-49ce-86ba-c60ab8ab93c4 | setup-failed: cleanup hook закривав store до worker.finish; 2 pass, 1 knownRed/unknown | 1 / 1 | idle / fix-setup |
| [hotfix-2](hotfix-2-test-run-result.json) | 1d3d8185-9ef4-44b1-ba2b-ea9be472bd4b | passed: 3 | 0 / 0 | complete / complete |
| [hotfix-3](hotfix-3-test-run-result.json) | 4b22eba1-6938-4c3b-9db0-2e4798452e08 | passed: 3, остаточний SQL із явним partial-index predicate | 0 / 0 | complete / complete |
| [profile](regression-profile-test-run-result.json) | 7d11feac-1953-4b23-86a9-861dadffb4f3 | passed: 31, profile-raf-performance/profile | 0 / 0 | complete / complete |
| [CPU](regression-cpu-test-run-result.json) | be92ce18-dfad-4807-ad56-7a1b5845c63e | passed: 67, monitor-raf-health/cpu | 0 / 0 | complete / complete |
| [agent ps](regression-agent-ps-test-run-result.json) | a01aac6f-b74c-40b8-aa31-a5eeca3680b3 | passed: 23, profile-raf-performance/agent-ps | 0 / 0 | complete / complete |
| [store](regression-store-test-run-result.json) | 977cd760-c230-4d85-b16b-22ecb01d3908 | assertions-failed: 18 pass, 2 knownRed Z.431 prefix1/prefix100 | 1 / 1 | idle / fix-implementation |

У всіх прогонах timedOut=false, cleanup.complete=true, remainingPids=[], timeoutCount=0, unexecuted=[]. У фінальній власній групі та трьох зелених регресійних групах knownRed/unknown порожні. Детальний стан кожного прогону, selection, наступна дія — [runs.json](runs.json). Перша cleanup-помилка не зарахована як red або pass; порядок завершення фікстури виправлено без зміни assertions.

Два Z.431 failures виникають у `test/state-store.test.ts:394`: прямий виклик незміненого `inspectStateSchema` з `src/state-schema.ts`, без `openStateStore`, cost profiler або result notices. Обидва файли незмінені від commit `775a7d6118196e593a7ce84d5956080c1e61cac8`. Код повертає порожню schema при спостереженні size=0 під час `writeFileSync` truncate/write. Це висновок з читання коду; окремий baseline-прогін не виконувався. Сторонню регресію не виправляли й не приховували повтором; main повідомлено receipt `37e2aa8f-84cd-4dd2-a70a-c058eb554198`.

## Відтворюваність доказів

Для кожного префікса з таблиці збережено повний незмінений JSON рядок TestRunResult у `*-test-run-result.json`, non-JSON повідомлення CLI у `*.stderr`, окремий код CLI у `*.cli-exit-code.txt`, точну команду у `*.command.txt`, повну відповідь exec transport у `*.transport.json`. Transport надає об'єднаний output; `.stderr` виділено з non-JSON рядків без зміни їхнього тексту, вихідний combined stream збережено в transport. Немає truncated результатів; resourceUsage completeness у runner часткова й не видається за повну resource telemetry. Wrapper друкує STATE_CONTEXT_WARNING про його working state; дочірні тести мають підтверджений ізольований HOME у TestRunResult.

SHA та status workspace до прогонів: [red-workspace.json](red-workspace.json), [hotfix-workspace.json](hotfix-workspace.json), [hotfix-2-workspace.json](hotfix-2-workspace.json), [hotfix-3-workspace.json](hotfix-3-workspace.json), [regressions-workspace.json](regressions-workspace.json). Точні власні незакомічені source/test patches — однойменні `.patch`. Спільний worktree містив чужі зміни, вони не включені до власних patches/commit. Реєстрацію групи виконав main, root commit `89cd4b57de97b3f7c34453be8c5098c4c4042df8`; conf не редагували.
