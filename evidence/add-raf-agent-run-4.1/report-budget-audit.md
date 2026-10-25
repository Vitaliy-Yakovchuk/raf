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
