# S.1: передача test-scaffold

Підготовлено лише тести дорученої стадії. Production-код і галочки tasks.md не змінювались. Завершення implement та зелене приймання S.1 не заявляються.

## Контракт і аудит

- `openspec/changes/complete-raf-flow-contracts/tasks.md`, S.1; delta `specs/projects/raf/background-runtime/spec.md`: «Межі служби raf», «Механізми поза службою», «Продовження після перезапуску служби», зі сценаріями.
- `design.md`, «Служба лише для жуків і черги»: нагадування, події, звірка сесій, звіти й квоти належать командам/воркерам. Службі залишаються resource wait та bug-sync.
- Аудит підтвердив актуальність: `service-host.ts` досі запускає reminder/event/session цикл, а production factory публікує його залежності.
- `event-catalog.ts` уже експортує повну сигнатуру `validateEventId(catalog: EventCatalog, kind: string, id: string): boolean`, реалізовану до цього доручення (коміт `8cc44f65c0fb5787bd5daf8acef95817ae943871`). Нової публічної поверхні для вилучення службових операцій немає; штучні методи чи заміна наявного валідатора на NotImplemented не потрібні. Нових production-методів не додано.

## Тести й інваріанти

`test/service-resource-only.test.ts` перевіряє видалення заборонених залежностей (тип host і runtime production factory), роботу host із самими ресурсними залежностями та відмову для семи reminder-операцій і event.emit. Інваріант знімків охоплює сесії, резерви, pending intents, нагадування й pending events через recover/refresh/керований wake/shutdown. Фікстури містять running/exited сесії, overdue/future/closed нагадування і прив'язаний pending event. Позитивні перевірки зберігають resource wait без session reservation та незалежну валідацію event ID.

`test/service-host.test.ts`: протилежні чинному контракту очікування замінено на незмінність стану й відсутність observation/delivery/event dispatch; ресурсні перевірки й cancellation збережено. Передано явний epoch дозволеним production producers.

`test/production-service-ports.test.ts`: прибрано тести видалених session/reminder transport wrappers; фабрика повинна не мати цих методів. Ресурсні тести зв'язують store через нормальне компонування host, без eventPorts. Транзакційні перевірки event registry збережено через прямий SQLite repository та event-catalog, незалежно від служби. Спостереження процесів, сесії, доставка й нагадування мають власні наявні тести; S.1 не повертає їх у service.

## Незмінна група й профіль

Група всіх наступних етапів: `complete-raf-flow-contracts/s1-service-resource-only`.

```sh
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/31c49695-8224-4d89-bb1f-ac811a920aba/raf-main/bin/raf.ts test run --project raf --phase red --group complete-raf-flow-contracts/s1-service-resource-only --files test/service-resource-only.test.ts test/service-host.test.ts test/production-service-ports.test.ts
```

Implement/qa використовують відповідну фазу й ту саму групу, без reset агрегату або нового QA HOME. Точні записи й передумови — `profile-handoff.json`. Конфіг змінено in-place за дорученням main; коміт conf належить main. Новий файл сам не реєструється.

Перший виклик `0785d1b9-830c-4765-864a-bd09751bffcc` чекав у ресурсній черзі й був відхилений до runner через конкурентну зміну `unitFiles/248`. CLI 1, timeout=false, cleanup.complete=true, assertions не виконувались. Це не red; повний TestRunResult і stderr збережено окремо. Повтор використовує ту саму групу та всі три файли.

Другий виклик `fb67190d-3652-4b77-811f-fd34f2c54ca1` відхилено до spawn: `RESOURCE_WAIT_FAILED`, `Service stopped`, CLI 1, cleanup.complete=true, timeoutCount=0, assertions не виконувались. Main підтвердив причину: перемикання raf на новий реліз під час черги; після readiness дозволено повторити ту саму групу. Це також не red.

Третій виклик `2a30618e-2b8b-484f-82b8-6538f56f2ee6`: runner виконав 39 тестів (6 passed, 33 failures), CLI 1, cleanup.complete=true, timeoutCount=0. Хоча адаптер позначив результат `assertions-failed`, runtime-тести мали setup ENOENT для `dist/catalog.json`; цей виклик не є підтвердженням чистого red. У трьох власних fixtures виправлено підготовку: перед імпортом production-entry вони копіюють compiled catalog обраного workspace до ізольованого develop. Production-код і загальний fixture helper не змінювались. Повний результат і stderr: `red-fixture-result.json`, `red-fixture-stderr.txt`.

Четвертий виклик `1dbe1543-22c9-4627-90bb-848ba31fe686`: 10 passed, 29 failures, CLI 1, cleanup.complete=true, timeoutCount=0. API/інваріанти/відхилення старих операцій уже впали за цільовою поведінкою; вісім production-тестів мали setup `CONFIGURATION_INVALID state/contention` через урізаний fixture raf.json. Цей виклик також не прийнято за чистий red. Production-fixture тепер копіює повні settings обраного workspace, зберігаючи локальні state.fileName/каденс/параметри resource wait. Нових вимог чи defaults у production не додано. Повний результат і stderr: `red-contention-result.json`, `red-contention-stderr.txt`.

Main має перевірити діагностику цільових assertions перед передачею implement. Зелені адресні перевірки service-host/production-service-ports/service-entry/background-runtime належать наступному етапу після реалізації; цей scaffold не заявляє їх проходження чи живого QA. Реальні service-entry/background-runtime сценарії не підміняються unit-фікстурою. Інші пункти зміни відкриті, архівація не виконується.

## Підтверджений первинний red

П'ятий виклик `9278cbcf-9706-41bf-bd28-27d4f01e83dc` виконав усі 39 тестів: 17 passed, 22 knownRed, unknown=[], unexecuted=[], removed=[]. CLI 1, child exitCode=1, outcome=assertions-failed, failureKinds=[assertions], cleanup.complete=true, timedOut=false, timeoutCount=0, nextAction=implement. Тривалість 127176 ms. Повний TestRunResult — `red-result.json`, stderr CLI — `red-stderr.txt`, коди викликів — `runs.json`.

Усі падіння стосуються S.1: заборонені dependency slots лишилися, recover змінює reminders/events/sessions, старі reminder/event операції приймаються, служба викликає observation/delivery. Один diagnostic `test-failure` з текстом `Service host dependencies are incomplete` є цільовим: ресурсний host навмисно передано без вилучених reminder/session залежностей; чинний host їх усе ще вимагає. Це не import/setup failure. Решта 21 diagnostic — assertion. Проходять ресурсні перевірки, cancellation/shutdown, event-repository transaction та прямий validateEventId.

Main має перевірити ці diagnostics перед implement. Виконавець продовжує ту саму групу, з тим самим стабільним QA HOME; конфіг профілю не потребує додаткових змін. Етап test-scaffold завершено, реалізація й зелене приймання S.1 залишаються наступному виконавцеві.

## Залежності для наступного виконавця

Main повідомлено, що `test/production-service-ports-qa.test.ts:99–351` використовує старі `eventPorts/observeProcesses/deliverReminder`, а `test/startup-context-runtime.test.ts:208–212` містить `deliverStartupContextEvent` та старі seams. Звірка цих fixtures із чинними власниками механізмів потрібна під час implement; вони не є причиною залишати заборонені службові API. Ці чужі файли не змінювались. Main підтвердив прийняття залежності й додавання її до передачі.

Main також повідомив про майбутнє злиття hotfix Z.455, що змінює `test/service-host.test.ts`. Порядок узгоджено: спочатку власний коміт цього scaffold, потім main зливає hotfix у develop і розв'язує можливий конфлікт, зберігаючи очікування S.1 та регресію hotfix.
