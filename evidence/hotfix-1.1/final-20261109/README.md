# Перевірка 1.1 — 2026-11-09

Результат доручення: **failed**, залишок **активація + живий повтор main**. Перевірено кандидат 2399db3a482669524f7fe50812beb607f4b8b8bb. Власних змін production-коду чи тестів у цій сесії немає: попередні продовження вже впроваджені, ця сесія перевіряє актуальний результат. Checkbox 1.1 не змінено, архівація не виконувалася.

## Аудит і тестовий доказ

proposal.md та tasks.md зберігають відкритий 1.1 і вимогу живого повтору після активації. Попередній потрібний RED уже зафіксовано в ../continuation-18/occupancy-red.TestRunResult.json: run 562d1c65-66ad-47bb-8c60-8d23cfa528b4, assertions-failed, ps 2078.26 мс на 20 агентах. Ця сесія не видає історичний RED за свій новий прогін і не змінює реалізацію без нового дефекту.

Власний повтор GREEN: budget.TestRunResult.json — повна незмінена копія файла raf; точна команда, SHA, workspace, відбір, CLI code окремо від child exitCode — budget.transport.json. Run 6a0fea64-1f4e-4507-b3b8-525c18453312, 11 passed, CLI/child 0, duration 252315 мс, outcome passed. Cleanup complete, timedOut=false, knownRed/unexecuted/unknown=[], groupState=complete, nextAction=complete. Історичний timeoutCount=1 збережено; QA HOME, групу й агрегат не скидали. Stderr початкового tool-output обрізано; окремий первинний stderr не збережено, що явно зазначено у budget.stderr.txt і transport. Повний TestRunResult не обрізаний.

На production-фікстурі з 20 активними агентами: ps 755.897 мс <1000; launch wall 9840.738 мс, зовнішній runner 7449 мс, RAF overhead 2391.738 мс <3000 за чинним контрактом тесту. Фікстура має 135 active changes, tasks.md разом 2253278 байт, selected tasks 235306 байт. Окремий reminder list 21.249 мс <500, writers=0; settlement 28.937 мс, writers=0; agent ps на 260 процесах має один ps і одне читання panes. Це фікстурний GREEN, не живий.

## Копія живого стану

Main передав .tmp/frcll/state-0225.sqlite. state-inventory.json містить лише агрегати та hash: 256 sessions, 17 running, 429 reminders, 323 notices, 315 intents. База й sidecars не копіювалися у evidence й не комітяться. Вимір scripts/profile-cli-latency.ts використовує ізольовані HOME/QA HOME/tmux, read-only backup SQLite та копію conf/OpenSpec; з OpenSpec скопійовано 8526 Markdown-документів без evidence через великий розмір дерева 4.9 ГБ.

copy-profile.json і copy-profile.transport.json: CLI0, cleanup без помилок; reminder list 851.978 мс, agent ps 477.175 мс, agent run 3849.976 мс. Це холодні окремі CLI на адаптованій копії: скрипт завершує вихідні sessions, очищає delivery/reservation rows та redirects recipients; runner синтетичний. Reminder і повний launch wall перевищують відповідні числа proposal; цей вимір не підтверджує живі бюджети й не має відтворення живих екранів 17 агентів. Повний копійний JSON зберігає етапи, а не приватні payload сесій.

## Межа завершення

Main повідомив: кандидат 2399db3 пройшов 10 воріт verify; активація відмовляє inactive main slot busy. Слот raf-main-b тримають 8 довгих воркерів; ETA немає, цикл повторює активацію кожні 20 хв. Main прямо доручив не чекати у сесії й завершити failed з залишком «активація + живий повтор main». Джерело й receipts доставки — coordination.json. Після активації main виміряє живі ps/reminder list/дозволений agent run і закриє 1.1 продовженням. Цей звіт не доводить активацію або живий GREEN.

## Читабельність і область

База та перевірена ревізія однакові: 2399db3a482669524f7fe50812beb607f4b8b8bb; власні правки — лише ця тека доказів. Production-функції, тести й параметри не змінювалися, тому нової області самоперевірки зміненого коду немає. Предметний доказ попереднього впровадження capturePaneScreens, scanner.inspectMany, AsyncLocalStorage scope, findRunningSession/listModelHandoffCandidates та settleResultNotices — ../continuation-18/README.md і candidate.patch. Цей повтор підтвердив no-op writer behavior, адресні читання, спільний snapshot і бюджети; не заявляє нового приймання сторонніх незмінених функцій. Видимий вивід, ліміти й таймаути не змінено.
