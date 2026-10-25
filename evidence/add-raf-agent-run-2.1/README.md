# Передача add-raf-agent-run:2.1

Підготовлено тести та каркас без реалізації фічі. Контракт перевірено за чинними delta run/message/ps, design.md (1.2), agent-types, resource-admission та дозволом читати production/test-support із pre-sync feature-test-authoring. Предмет доручення актуальний: наявні owner-компоненти покривають більшість сценаріїв, але повторне використання адреси під час message лишає дві відтворювані прогалини. Нове сховище, транспорт або supervisor не вводилися.

## Відбір та результат

Стабільна група для 2.2 / 3.1 / 4.1: `add-raf-agent-run/contracts`, project `raf`, profile `node`. Точні 15 файлів, доповнення `unitFiles: []`, профіль і передумови наведені в [profile-handoff.json](profile-handoff.json). Main зареєстрував групу конфігураційними комітами 806951af00 та 2f401baaad; автор не змінював conf. Усі файли вже зареєстровані як unitFiles. Потрібні ізольовані HOME/state, Node >=25.4, встановлений TypeScript, reporter та scripts/test-run-node.ts; тайм-аут береться з flow, не задається локально.

Виконано адресний `test run --project raf --phase red --group add-raf-agent-run/contracts`. Повний [TestRunResult](red-result.json): runId `7315b628-527b-44e7-a743-e16d4e6af92e`, callerPhase `test-scaffold`, outcome `assertions-failed`, exitCode **1**, 567 passed / 41 knownRed; unexecuted та unknown порожні, cleanup complete. Точна команда і класифікація в [red-summary.json](red-summary.json). Повний результат збережено read-only з lastResult тієї самої групи та runId в ізольованому агрегаті SQLite: великий вивід перевищує бюджет інструмента; у попередньому прогоні також спостерігалося перемішування JSON з подією launch-queue.waiting. Повторного запуску тестів поза raf не було.

Власний набір `ARA 2.1`: **21 passed, 2 assertion failures**. Цільовий red:

- `test/agent-control.test.ts::ARA 2.1 recipient replaced during inspection receives no stale message`: після завершення старої сесії й появи нового run за адресою B старий identity snapshot усе ще допускає transport.deliver. Очікується відмова без доставки.
- `test/agent-control.test.ts::ARA 2.1 recipient replaced before receipt cannot acknowledge the old run or redirect to successor`: після зміни поточного runId приймається receipt попереднього run. Очікується відмова, новий процес не отримує старого повідомлення.

Решта **39** падінь не є доказом власного red: 18 `test-failure` у старих Z12 fixture під час compileCatalog (INVALID_VALUE для прикладу каталогу з проєктом поза fixture), 16 assertions task-context, один timing diagnostic, один close/reused-PID та три admission-snapshot. Вони перелічені повністю в red-summary і red-result; твердження task-context можуть маскувати ранню помилку fixture. Main має розібрати їх перед green. Власних setup/import failure у фінальному прогоні немає. Race fixture повертає чинний на момент observation snapshot, потім окремим конкуруючим commit завершує стару сесію та створює наступника; додаткові assertions підтверджують finished старого run і рівно одного активного B, без воскресіння старого запису моком coordinator. У першому прогоні виправлено очікування store-error (reason структурованої помилки замість тотожності об'єкта) та застарілий example у recompilation fixture; ці падіння не зараховані як red.

## Покриття вимог та інваріанти

| Контракт | Файли стабільної групи та перевірки |
| --- | --- |
| Готовий state-store, помилка до старту | app-runtime: по одній спробі відкриття точного statePath для run/message/ps, збережена причина, нуль services/reserve/start/commit і fallback; збій atomic reserve не запускає tmux; existing launch-state/session-state rollback |
| Типи Q34, обов'язкові аргументи, ID | cli-catalog: динамічно всі agentTypes з conf, mandatory/unknown і main refusal; app-runtime: кожний launchable тип без підміни моделі/effort; hotfix-xxxx відмінний від runId і tmux; session-state: приєднаний main, unique live address і reuse після finish |
| Ресурси та атомарність | resource-admission: точна inclusive межа conf, RAM/disk на байт нижче, load вище; перестановка/поділ резервів не змінюють рішення, збільшення вартості не покращує рівень; existing UNKNOWN/critical, resource-estimates, home-disk-admission, launch-state last-resource race та task-reservations з двома SQLite connections |
| Живий список | agent-control/session-recovery: процес перевіряється scanner, unknown не означає смерть, PID reuse не авторизує message; main захищений; session-state snapshots/side effects atomic |
| Повідомлення й безпека | agent-control: [ID]/[main]/[raf], неперевірений caller і присвоєння raf відхиляються до transport, системна доставка raf→main проходить той самий receipt, internal tmux/native IDs не заміняють адресу, literal shell text/control stripping, busy/no acceptance, structured failure без повторної відправки, два нові recipient-run race |
| tmux/runner та receipt | agent-adapters-contract: mocks launch wrapper/selected model/cwd/brief, одноразова initial delivery, identity fencing, readiness/unknown, composer/shell/permission refusal, bounded Enter retry та native acceptance без semantic answer; реальні API/моделі не викликаються |
| Вузький контекст/помилки | app-runtime/task-context/task-context-z12: вибрані пункти різних змін, точні paths/outcome/sources, cleanup і передача первинної помилки; поточні fixture failures явно наведені вище |

Existing owner-тести використано без дублювання реалізації. Транспорт уже має власну серіалізацію за pane/socket у production-runtime; сервісу не нав'язано другий mutex. Тест `concurrent messages retain intact payloads` та adapter concurrency перевіряють незалежні межі. Перевірка реального tmux/runner з main-session-accounting не змішувалася з unit; жива перевірка лишається 4.1.

## Каркас і перевірки

`src/agent-control.ts`: новий приватний метод з повною сигнатурою `private async confirmMessageRecipient(target: SessionRecord): Promise<void>` містить лише `throw new Error('NotImplemented')`. Він ще не під'єднаний до поведінки. Наявні public run/message/ps ports та state-store перевикористано. Реалізатор має вирішити recipient fencing за контрактом; тести стверджують зовнішню поведінку, а не виклик цього приватного методу.

Перевірки: node --check змінених тестів, git diff --check і npm run check:comments пройшли. Production diff додає тільки NotImplemented метод. Галочки tasks.md автор не змінював; інші пункти відкриті, sync/archive не застосовуються.
