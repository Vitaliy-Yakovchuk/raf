# Передача 3.2: ізольовані тести background-runtime

Доручено лише complete-raf-flow-contracts:3.2. Контракт — delta background-runtime та U1–U8 background-runtime-design.md. Аудит 2026-10-25 не виявив суперечності з чинними вимогами. Дозвіл читати production/чужі тести визначений новішою вимогою feature-test-authoring у add-raf-test-run; старе обмеження дизайну не застосоване.

Тести й каркас: `46797a1e494684ca60d570adff63b801aea3a13c`. Новий файл `test/background-runtime-unit.test.ts` містить 47 ізольованих тестів. Новий `src/service-lifecycle.ts` оголошує повні порти та сигнатури, конструктори лише зберігають аргументи; усі вісім операційних методів кидають `NotImplemented`. Наявні реалізовані методи не замінено заглушками, фічу не реалізовано.

| Матриця | Покриття |
| --- | --- |
| U1 | Готовність лише за актуальними epoch, identity, PID, mainPath, exclusive owner, SQLite, lastGrant та каналом черги; старий handshake не дозволяє enqueue. |
| U2 | Перший/повторний/конкурентний start, один процес, спільний deadline з очікуванням lock і retry; вичерпаний бюджет та cancellation не дозволяють enqueue/spawn. Числа фікстури — синтетичний clock, production policy береться з options/conf. |
| U3 | Штатний порт main route/snapshot; entry/cwd/mainPath одного покоління; missing main/entry, invalid origin та route failure без develop fallback; path traversal/absolute entry відхилені; нова публікація не переписує старе ready. |
| U4 | Ready/stopped/failed, перший status, невідома причина, смерть старого ready, збережена штатна/аварійна причина між controller instances; record/identity read errors; новий lifecycle не успадковує стару причину. |
| U5 | Підтверджений shutdown, повторний stop, ack без exit, shutdown transport failure, невідомий власник/reused PID/foreign epoch, stop після crash; втрата resource channel не повторює enqueue. |
| U6 | Негативні порти забороняють session/reminder/event/quota/report/reservation/main operations; композиція працює лише з bug-sync/resource-wait. Повний демонтаж legacy S.1 не виконано. |
| U7 | Shared agent-message отримує буквальний текст, to main та system identity. Accepted receipt зберігається; rejected/missing transport/missing receipt не стають успіхом. Підпис формує спільний канал. |
| U8 | Командний/worker notify не потребує recover/start; transport failure не запускає службу/main. Bug-sync notifier передає bug key/comment ID без другого системного підпису, відхилення лишає retry виробнику. |

## Первинний red автора

```sh
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/3557f6a4-89a2-41a3-b963-b4343aabc699/raf-main/bin/raf.ts test run --project raf --phase red --group complete-raf-flow-contracts/raf-background-runtime --files test/background-runtime-unit.test.ts
```

Повний результат — [red.TestRunResult.json](red.TestRunResult.json), CLI/child та межа stderr — [red.capture.json](red.capture.json), wrapper/workspace SHA і config hashes — [preflight.json](preflight.json).

- Run ID: `ead5c24c-8b1e-4dbc-9433-08a74f20b1ed`.
- Caller phase: test-scaffold; phase: red; testKind: unit; profile: node.
- Outcome: assertions-failed; 47 knownRed, 0 passed, 0 unexecuted, 0 unknown. Кожна діагностика — test-failure `NotImplemented` конкретного нового методу. Це початковий red нової ізольованої поверхні, а не доказ, що кожна наявна production-операція має дефект.
- CLI exit 1, child exit 1, signal null; 670 ms, timedOut false, timeoutCount 0; timeout policy — conf/flow.json#/unitTests/timeoutMs, 1200000 ms.
- Cleanup complete, remainingPids порожній. HOME/state та private TMPDIR вибрані wrapper, не підмінені автором.
- Повні 47 diagnostics збережені без обрізання; окремий stderr інструмент не надав (exec_command повертає злитий потік), це явно в capture.
- Main підтвердив прийняття red повідомленням у цій сесії: «Red 3.2 прийнято: runId ead5c24c, 47 knownRed (усі NotImplemented нового lifecycle/composition), setup/import чисті, cleanup complete».

`node --check` обох власних файлів та `npm run check:comments` — exit 0. Прямого node test або integration-прогону не було.

## Реєстрація і продовження

Main повідомив застосування conf у `ffdf00f0b4` до авторського red. Перевірено точні записи:

```json
{
  "projects.raf.profiles.node.unitFiles.add": ["test/background-runtime-unit.test.ts"],
  "projects.raf.groups.complete-raf-flow-contracts/raf-background-runtime": {
    "profileId": "node",
    "files": ["test/background-runtime-unit.test.ts"]
  }
}
```

Це доповнення наявного node profile, не окремий профіль. Передумови: локальний node та scripts/test-run-node.ts, валідний inventory, довірений caller/wrapper, зареєстровані project/workspace/branch, активна зміна, ізольований QA HOME/state/private tmp. Deadline забезпечує wrapper за conf/flow.json; окремих timeout-полів у групі немає. Конфіг поза файловою межею автора; автор його не змінював.

3.3 отримує ту саму групу, HOME/ledger та selection з фазою implement. Порти нового controller призначені для виділення ізольованої логіки з `createBackgroundRuntime` з production-адаптерами до наявних record/identity/route/lock/spawn/channel механізмів; це не дозвіл залишити паралельний невикористаний lifecycle. ServiceProducerRuntime так само потребує підключення до production-композиції зі спільною доставкою, без дублювання agent-message чи bug-sync pending. Production adapter зберігає state guards, pinning/lease і обробку часткового виконання. Живе походження покоління, справжній owner shutdown, fencing і фактичне default wiring transport мають окремі I1–I7 у 3.4; unit-моки їх не підтверджують. Нових CLI/прапорців немає; повний S.1 і handover не входять у 3.2.

Tasks.md автор не змінював; checkbox ставить raf. Інші пункти зміни відкриті, sync/archive не виконується.
