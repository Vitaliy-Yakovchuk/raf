# QA 7.2: штатне завершення inline handover service

Host18 зберіг failed: generic cleanup пропускав inline `node --input-type=module -e` handover owner; verifier правильно виявив PID 2047034. Оригінали: ../qa-7.2-live/host18/. Live-етапи Host17 не повторюються.

Власна регресія створює два справжні ізольовані Unix-socket service hosts. Red: новий helper лише повертав status, тому невідповідний PID не відхилявся — `Missing expected rejection`. 85963a9d-311b-4d95-8a58-eca7857295cc: 31 passed, 1 knownRed, assertions-failed; CLI/child 1/1. Це assertion, не setup/import failure. Фікс звіряє PID/mainPath/serviceEpoch до штатного socket stop, потім перевіряє stopped, normal reason та mainPath. Невідповідні PID/path/epoch відхиляються; peer лишається ready; власний процес завершується exit 0 без сигналу. Child fixture додає resourceWait для повної readiness та діагностику передчасного виходу.

Qa f764612d-0a58-4854-863a-9883a016dd59: 32/32, CLI/child 0/0. Обидва прогони: cleanup.complete=true, remainingPids=[], timedOut=false, unexecuted/unknown=[]; red groupState idle/nextAction implement, qa complete/complete. Тривале duration red включає очікування resource admission і не означає child timeout. Той самий агрегат/HOME з metadata.json не змінювався.

Точні команди (однакові group/files, фази red та qa):

```
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/c5d1e9bf-30a3-43b8-ae1e-0aec877403cf/raf-main/bin/raf.ts test run --project raf --phase red --group switch-raf-main-by-symlink/production-start-layout --files test/production-start-layout.test.ts
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/c5d1e9bf-30a3-43b8-ae1e-0aec877403cf/raf-main/bin/raf.ts test run --project raf --phase qa --group switch-raf-main-by-symlink/production-start-layout --files test/production-start-layout.test.ts
```

red/qa.result.json містять повний незмінений JSON stdout; stderr.txt — весь збережений stderr CLI з flow/queue diagnostics, без підгонки; cli-code.txt відокремлений від child exitCode. tool.json зберігає повну відповідь інструмента. metadata.json містить SHA256 канонічного JSON результату та stderr для звірки брокером. Підтвердження broker ще очікується. qa.workspace.json зберігає фактичний HEAD/branch/status/diff перед qa. red.head-reflog.txt встановлює HEAD 1589f549 на початок red через Git reflog; окремого before-run workspace dump не було: red виконував незакомічений новий test/helper-stub, наведений у діагностиці й описі вище. Це обмеження provenance не приховане.

npm run build та node --check обох mjs → 0, повний доказ поруч. Автоматичний unit доказ обмежений ізольованими service hosts; він не доводить завершення host PID 2047034. Наступна host-команда виконає лише normal socket stop exact retained owner, збере status/stop/status та stopped record, а потім перевірить відсутність процесів стенда. Вісім live-етапів, native report/message і switch не виконуються повторно. Host green ще не отримано.
