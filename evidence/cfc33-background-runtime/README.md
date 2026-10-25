# Реалізація complete-raf-flow-contracts:3.3

Аудит чинних proposal, пункту 3.3, delta background-runtime та U1–U8 дизайну не виявив суперечностей. Реалізовано лише 3.3; живі I1–I7 належать 3.4. Інші задачі відкриті, тому sync/archive не виконується. Tasks.md і підготовлені тести не змінено; галочку ставить raf.

## Результат і production wiring

- `ServiceLifecycleController` реалізує start/ensureReady/status/stop/request: один readiness deadline, exclusive startup, перевірені main generation/entry/cwd, поточні identity/epoch/PID і readiness усіх компонентів. Повторний start повертає фактичне живе покоління. Stop потребує підтвердженого завершення власника, діагностика штатного stop/збою зберігається, втрата request не спричиняє повторного enqueue.
- `createBackgroundRuntime` використовує цей controller через наявні record, OS identity/peer, lease, main route, spawn і socket механізми. Запити та stop fenced поточним epoch. Cleanup стосується лише дочірнього процесу власної startup-спроби; діагностика бере лише новий хвіст service.log. Обробники spawn/error встановлюються перед асинхронним закриттям log fd.
- `ServiceProducerRuntime` підключено до `createServicePorts`: recover запускає resource queue і bug-sync, shutdown зупиняє їх. Bug-sync передає буквальний body з повним bug key/comment ID без додаткового `[raf]`, rejected/exception лишає повідомлення pending.
- Default production wiring: service-entry → `production-service-ports.createServicePorts` → `ServiceProducerRuntime` → default `sharedDelivery` → `production-runtime.createProductionSystemDelivery` → наявний `AgentControlService.message` із внутрішнім system caller. Спільний канал сам формує системний підпис і підтверджує прийняття. Немає окремого formatter/delivery parser і запуску main заради повідомлення.
- Чинні state guards, pinning/generation lease та legacy-композицію збережено. Повний демонтаж S.1 і handover не входять у доручення. Ізольовані unit-тести не є доказом живого default transport, SQLite/OS shutdown або інтеграції I1–I7; це передача для 3.4.

## Незалежна початкова реалізація

[initial-implementation.json](initial-implementation.json) зафіксовано до читання підготовленого test-файла: initialImplementationComplete=true, preparedTestsRead=false, workspace HEAD і незакомічені шляхи, SHA256 реалізації та незмінного теста. Лише після цього прочитано тести для виправлення помилки діагностики deadline. SHA256 `test/background-runtime-unit.test.ts` залишився `e346d493f949880c17b1c2765684c3e44e14752f9a55090c8879af961ce6d5d8`.

Переданий початковий red: runId `ead5c24c-8b1e-4dbc-9433-08a74f20b1ed`, 47 knownRed, [повний результат автора](../cfc32-background-runtime/red.TestRunResult.json). Реєстрацію node.unitFiles/groups уже застосував main; conf не редагувався. Стабільну групу, її агрегат та QA HOME не змінено.

## Unit-прогони

Усі три implement-прогони мали ту саму точну команду:

```sh
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/3557f6a4-89a2-41a3-b963-b4343aabc699/raf-main/bin/raf.ts test run --project raf --phase implement --group complete-raf-flow-contracts/raf-background-runtime --files test/background-runtime-unit.test.ts
```

1. `ef03b245-a9cc-4b0c-a98f-11facab04938`: CLI exit 1. Інструмент обрізав повернений потік через замалий output budget. [Незмінений tool envelope](unit-initial.tool.json) збережено; це неповний доказ, точні child exit/counts/group state не встановлено і pass не заявляється. Видима assertion-діагностика вимагала явного слова deadline; виправлено текст без зміни тестів. Main повідомлено про обрізання; повтор був після виправлення з більшим output budget, не сліпим повтором невідомого результату.
2. `1ac553fe-3be2-41d2-9422-c13105a5c0cb`: [повний незмінений TestRunResult](unit-fixed.TestRunResult.json), [CLI/child capture](unit-fixed.capture.json). Passed 47, knownRed/unexecuted/unknown порожні; CLI 0, child 0, duration 669 ms, timedOut false, timeoutCount 0, cleanup complete, remainingPids порожній, groupState complete, nextAction complete.
3. Фінальний прогін після виправлення spawn race та додавання OS peer перевірки: `8e8f864c-a10a-4da1-bfdd-0e337e0fea70`, [повний незмінений TestRunResult](unit-final.TestRunResult.json), [CLI/child capture](unit-final.capture.json). Outcome passed, 47 passed, knownRed/unexecuted/unknown/removed порожні; CLI 0, child 0, signal null, duration 704 ms, timedOut false, timeoutCount 0, cleanup complete, remainingPids порожній, groupState complete, nextAction complete. Timeout policy: conf/flow.json#/unitTests/timeoutMs, 1200000 ms. Весь файл відбору виконаний, `--only` не застосовувався.

Фінальний workspace HEAD `60e921e829d87f73e6cfd1fdd21928065947e2dc` із чотирма власними незакоміченими production-файлами, wrapper HEAD, SHA256 файлів і конфігів зафіксовано у [final-preflight.json](final-preflight.json). Хеші реалізації та теста повторно звірено після прогону. HOME усіх прогонів: `/tmp/raf-unit-1000/8b186c55b4e5d09825e2b95aff4f750bb7bc2ab6fd6034951178a517b04b3391`, без підміни або скидання агрегату.

Межа stderr: exec_command надає злитий output і не повертає окремий CLI stderr. Для двох повних зелених прогонів потік є рівно одним валідним JSON без стороннього префікса/суфікса. Окремий stderr недоступний, це явно записано в capture; порожній stderr не вигадано. CLI exit збережено окремо від child exitCode.

`npm run build`, `npm run check:comments` та `git diff --check` реалізації завершилися з exit 0; [checks.json](checks.json) посилається на окремі повні stdout/stderr цих перевірок. Після додавання доказів staged source diff також чистий. Повний staged diff повертає 2 лише через порожній останній рядок незміненого `check-comments.stdout`; перевірка з `core.whitespace=-blank-at-eof` повертає 0. Сирий stdout збережено повністю. Чужі unit-групи та інтеграційні сценарії не запускалися.
