# guard-owner-attributed-decisions 3.1 / 3.2

## Результат і межі

Завершений звичайний слід одразу створює чинну context-review.due. Порога чи таймера немає. Повторне закриття не міняє пакет; новий слід створює наступний пакет. Фаза context-review не аналізує сама себе.

Сесія прибирається після завершення її поточних ефектів: немає pending intent, admission reservation, недоставленого result notice чи claim його доставки; modelHandoff зберігає свій поточний стан. result.forcedClose зберігається разом з потрібною операцією до завершення доставки. Адресний runId відділяє повторне використання addressId. Дозволені нагадування, їхні поточні delivery keys, closedRemindersMs і агрегат forced-close не змінено.

Один виклик cleanup сесій прибирає один кореневий запис. Відбір використовує чинний індекс sessions_retention; під writer повторно перевіряється поточний стан. Cleanup аналізу відбирає закритий пакет за індексом closed_at/id, повторно перевіряє успішне закриття та mainDelivered, прибирає лише цей пакет і повертає керування. Незавершений сусід залишається. Нові індекси не створюють журналу чи нового статусу.

Приватний повний кадр не має expiry й автоматичного sweep. Прийнятий main мінімальний контракт — зберігати кадр до завершення розбору, cleanupFailedDeliveryEvidence(runId, reference, ports). Невірна пара відхиляється, повторний cleanup безпечний; чужий run не видаляється. Нового автоматичного протоколу завершення розбору немає; адресний cleanup викликає відповідальний за розбір.

## Test-first і перевірки

Повні незмінені TestRunResult: red.json (14 knownRed), red-portions.json (новий тест повернення між пакетами); подальші hotfix-*.json. Команди, runId, відбори, SHA, child exitCode окремо від CLI exitCode, cleanup, timeout, knownRed/unexecuted/unknown і стан групи — runs.json. Tool повертав злиті stdout/stderr з обрізанням: це явно зазначено в *-cli.json. Для hotfix-2 злитий вивід не збережено; повний JSON збережено. Обрізаний вивід не використано замість TestRunResult.

Фінальний hotfix-final.json: runId 860713a6-6f54-4fcf-9478-fe7998f3c226, passed, CLI 0, child 0, 435 passed IDs у 12 файлах, knownRed/unexecuted/unknown порожні, cleanup complete, remainingPids [], timedOut false, timeoutCount 0, groupState/nextAction complete. Стабільні group guard-owner-attributed-decisions/context-state та ізольований QA HOME збережені в усіх прогонах. Додатковий адресний hotfix-metrics.json підтверджує видалення завершеної сесії та збереження дозволеного агрегату після reopen.

Початкова широка вибірка (hotfix-1.json) включала два змішані файли. agent-close-report-gate відокремлено через живий tmux stand: respawn pane still active належить frcll-1-1-17 (перенос Mac 88f4b42), за прямим повідомленням main. Сценарії tmux не переписувались. forced-close-metrics має два незалежні baseline-збої: mainRoute fixture без branchPaths.develop та command stats readAt; їх не виправляли в цій роботі. Власний змінений cleanup-тест цього файла окремо passed через --only відомого первинного red ID. Повний JSON початкових відмов збережений, removals outside-configured-selection видимі в hotfix-2.json; ці початкові відмови не видаються за passed.

Залежні scripts/usage-process-qa.mjs та scripts/qa-forced-close-live.mjs переведено з вікової межі на явне завершення доставки; node --check обох — 0. Живі інтеграційні сценарії не запускались повторно через описаний 1.1.17. test/startup-context-trace.test.ts та journal пройшли без потреби змінювати їхні предметні сценарії.

## Самоперевірка читабельності

Застосовано core/process/modularity-and-reuse: кожний змінений компонент має одну предметну дію. policyNumber і автоматичний expiry sweep видалені; код не маскує старе обмеження новим числом. Іменований pruneClosedStartupContextReview відділяє перевірку та видалення одного пакета від вибору наступного. hasUnfinishedSessionEffects прямо називає причину збереження сесії, SQL перевіряє існування адресних залежностей без десеріалізації колекції. Спільна транзакція захищає перевірку й видалення; peer/reopen і зміна стану між read/write перевірені тестами. Немає нових журналів, статусів, таймерів, видимих користувачу підписів чи елементів. git diff --check — 0. Окремі crapper/dryer/mutator не призначені цією зміною.

## Активація та відтворення

activation-conf.patch — точний патч conf/flow.json + conf/README.md для main. Поки старий raf активний, conf лишається сумісним; main застосовує патч атомарно з активацією hotfix, за власною поправкою. Видаляються лише runsPerReview, finishedSessionsMs, failedDeliveryEvidenceMs; closedRemindersMs лишається 172800000. Цей агент не активує main і не пушить.

workspace.json містить HEAD і SHA256 власних фінальних файлів, tested-workspace.patch — точний незакомічений код фінального прогону. Історичні проміжні dirty diff не збережені, їх не видаємо за чисті коміти. Чужі правки спільного дерева не включено до власних комітів. Інші пункти зміни відкриті, тому archive не виконується; галочки 3.1/3.2 ставить raf.
