Третій host attempt завершився фактичним ресурсним допуском, але відмовою worker до native readiness. Run `7ff3d76e-01d0-4eb0-a92b-432ef58dac12`, CLI `LAUNCH_FAILED`/exit 1; stderr містить «Invalid report confirmation budget at conf/raf.json#/runnerProtocols». Worker cleanup released, pending=[], загальний cleanup complete. Усі сім live checks невиконані; це не pass доставки або реального native запуску.

Аудит нових обставин: доручення 4.1 лишається актуальним за autonomous-development «Аудит та вилучення неактуальних змін». Неправильного зменшення ресурсів уже немає: admission ANY_RUN/allowed=true, requested 10737418240 disk bytes, remaining 150988427264. Новий збій стосується передачі protocol, а не місткості стенда.

Статичний пошук класу за feature-verification охопив усі чотири виклики приватного `sessionTools` у `src/production-runtime.ts` на 1973e882438755c4f322e5ac1690ba30b3e0228f:

- Рядок 598 очікує callback `settingsFor: (runner) => Promise<ProtocolSettings>`. Рядок 599 дістає `.timeouts` із результату callback; acceptPendingReport на 625 передає цей budget у report confirmation.
- createProductionSystemDelivery:983 передає повний settingsFor:982 — узгоджено.
- createProductionRuntime:1030 передає повний settingsFor:1028 — узгоджено.
- reconcileProductionReports:992 передає вже `protocolFor(...).timeouts` — не відповідає сигнатурі; наступне `.timeouts` дає undefined.
- runProductionWorker:1469 передає вже `settings.timeouts` — той самий дефект; наступне `.timeouts` дає undefined.

`agent-report.ts:237` чекає resolved protocol; `report-confirmation-retry.ts:97–102` законно відхиляє відсутні transitionMs/pollMs. У копії conf протоколи мають transitionMs=10000, pollMs=100; helper configureLiveCodexTrust змінює лише argv trust. SHA256 трьох релевантних production-файлів у worker generation тотожні raf-develop, тож це не drift генерації. Сам host stderr підтверджує прояв worker; reconcile шлях знайдений статично і поки не має власного нового red/green результату.

Залишок і наступна дія: підготувати assertion red для worker та reconcile callsites, виправити передачу повного protocol у двох місцях, повторно перевірити обидва шляхи та реальний host сценарій. Передано main адресним повідомленням із receipt 88696107-39a1-48b4-bcd0-41c2856080d4; код і підготовлені тести на момент цього запису не змінено. Потенційна hardcoded runner=claude для main лишається окремою непідтвердженою live гіпотезою; цей збій ще не дав дійти до неї.

Після незалежного scaffold 4.1.1 main підтвердив assertion red `db40563f-5e86-4d4a-befc-ac1d8e88fc4d`: 4 knownRed worker/reconcile × codex/claude. Реалізацію двох callsites завершено до читання нового тесту; змінено тільки повернення повного ProtocolSettings замість його timeouts. Підготовлені тести виконавець не змінював.

Власний implement прогін тієї самої `add-raf-agent-run/report-budget`: `b29f46c3-1079-4098-b5c0-9d9c3ee1665d`, 4 passed, 0 knownRed/unexecuted/unknown, CLI/child 0, timeout false, cleanup complete, group complete. Це підтверджує обидва знайдені шляхи для Codex і Claude. Повні результати й capture note — `unit-report-budget.*`.

Main розширив ту саму стабільну contracts-групу production-runtime.test.ts (Orchestrator 7327fe0370). Власний прогін `9f49ada3-cf37-4428-9fb2-e46a974af531`: 614 passed / 14 knownRed / 0 unexecuted/unknown, CLI/child 1, timeout false, cleanup complete, group idle/nextAction fix-implementation. Початкові 608 тестів зелені. Усі нові відмови в production-runtime.test.ts виникають при resolveTask до перевірки worker: shared `test/production-fixture.ts:19` передає старий stub catalog без `constants`, а task-context.ts:158–160 тепер бере reportStatuses із compiled catalog.constants. Raw fixture conf уже має валідні reportStatuses на рядку 137; послаблювати product validation не потрібно. Підготовлені тести не виправлялися; main отримав точний тріаж receipt c3beba87-7036-4ffb-a339-c992a2855b72. Розширена група лишається red, без скидання aggregate/HOME.

Пошук області спільної fixture: її імпортують production-runtime, production-launch-integration, production-codex-{qa-fixture,delivery-qa,writes-qa}, production-claude-delivery-qa, workspace-trust, reported-commits-acceptance, worker-idle-cost. Ці інші набори цим новим прогоном не запускалися, pass для них не заявляється. Виправлення shared fixture та повтор contracts потрібні; новий реальний host attempt для native-сценаріїв теж потрібний.
