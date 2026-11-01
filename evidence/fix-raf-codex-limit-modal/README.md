# fix-raf-codex-limit-modal:1.1

База всіх прогонів: `499e2f0727baa5d3e57f38d05ab7f8680ef31311`, власні незакомічені зміни в patch/new-test файлах. Усі команди, повний незмінений JSON TestRunResult, stderr і CLI exit code збережено окремо; child exitCode міститься лише в TestRunResult. tool.json зберігає повну відповідь exec. Потоки exec об’єднані інструментом: JSON-рядок відокремлено без переформатування, решта — stderr. Обрізання немає.

| Прогін | runId | Результат | CLI / child | passed / knownRed |
|---|---|---|---|---|
| red | fa4d7256-ecd8-475c-9ae8-4d5845e6f225 | assertions-failed | 1 / 1 | 15 / 3 |
| hotfix-1 | a2e93d38-3d80-4c83-a257-5ed84bc40f62 | assertions-failed | 1 / 1 | 16 / 2 |
| red-2 | de6f3fa3-e251-47e1-b38c-3a9713a3c1fc | assertions-failed | 1 / 1 | 16 / 2 |
| hotfix-2 | 0fdd5d59-b6fa-4861-94d9-d7c205ae4632 | passed | 0 / 0 | 18 / 0 |
| regression-z449 | 070115c1-56ca-4d94-9c60-f54f1a03d7cd | passed | 0 / 0 | 9 / 0 |

Первинний red підтвердив відсутню відповідь спостереження. Перший hotfix виявив помилку фікстури готовності в новому delivery-тесті: `? for shortcuts` не є чинним ready-маркером codex. Додано чинний `Ask Codex to do anything`, твердження не змінено. Для чесного red доставки тимчасово повернуто лише src/message-delivery.ts з бази: red-2 підтвердив обидва цільові assertion failures. Після відновлення кандидата hotfix-2 пройшов.

Група `fix-raf-codex-limit-modal/unit` і QA HOME збережені між усіма фазами. У всіх прогонах timedOut=false, cleanup.complete=true, remainingPids=[], unexecuted=[], unknown=[], removed=[], timeoutCount=0. Фінальний groupState=complete, nextAction=complete. Регресію Z449 запущено її налаштованою групою без додавання до tasks. Попередження stderr стосуються пропущених записів etchly, не вибраного raf-профілю.

`node scripts/build.ts` у тому самому ізольованому QA HOME: CLI 0. `git diff --check`: успішно. conf/test-runs.json є ignored локальною конфігурацією; адресний запис скопійовано у configuration.json. Нових конфігурацій codex, моделей, effort, видимих UI-підписів чи таймаутів не додано. Спостереження та доставка узгоджені через наявний message-lock.

Аудит: proposal/tasks актуальні; код бази не обробляв codex modal. Пункти 1.1.1 і 1.2 залишаються поза дорученням. Галочку 1.1 ставить raf після успішного звіту; push і штатну активацію виконує main за своїми повноваженнями.

Main підтвердив штатну активацію `41347feae19288cae5281d1632eeba7309e845b7` у `raf-main-b`: усі 10 гейтів passed; служба ready (pid 91356), smoke `raf help` та `agent ps` — CLI 0. Дослівне повідомлення збережено в activation-receipt.json. Це receipt main; сирі результати його гейтів не належать до власних прогонів вище. Відомий тест cli-main-delivery-nonblocking із жорсткими датами виключений main; його виправлення залишається окремим пунктом 1.1.1. Активація завершена, 1.1 готовий до succeeded. Інші пункти відкриті, архівація не виконується.
