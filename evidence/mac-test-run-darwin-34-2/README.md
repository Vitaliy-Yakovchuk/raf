# repair-raf-mac-bootstrap:34.1 — Darwin test run на новій базі

База: `50197d23bacb6e1560c5a4296c983ddee3712178`; переданий RED-коміт: `64d530e3edda85896c277cf157a7e99e9215472d`. Робоче дерево: `raf-hotfix`, гілка `hotfix`. Перенесено призначення origin/mac `810dc384f607935e394877b7f2bf015a26a8c34f`, `d75ad98c3428c2141dbd5791e2c4d96afb2ed981`, `2768f21eeb878d402ba15e378ebf0a5c02b8ea7b`, `dbaf36e8902f6fc2e1bcea3861e0d69f1493b966` вручну, без заміни нової реалізації resource-wait-identity та Linux-гілок.

Darwin використовує ps/sysctl для ідентичності, спостереження, reconciliation і cleanup дерева. Start нормалізовано в UTC, boot — за sec/usec, старі raw boot записи читаються зі збереженням fencing. Нативні subprocess ps явно отримують LC_ALL=C: en_NZ на Mac повертає день перед місяцем. У test-run-home-canonical додано runId призначення виклику; у unit-state-upgrade канонізовано temporary root для збігу URL import hook після проходження symlink /var.

## Докази test-first

- `../mac-test-run-darwin-34-1/red.*`: переданий початковий RED без Darwin-фіксу; runtime ENOENT /proc і assertion treeControlSupported=false. Помилки оракула через sandbox не зараховано за RED.
- `native-darwin-process.*`: main запустив `node --test test/test-run-darwin-process.test.ts` поза sandbox: 0/5, Invalid Darwin process start identity. Це RED на реальному Mac перед locale-фіксом.
- `native-ps-locale.txt`: реальні ps stdout для LANG=en_NZ.UTF-8 і LC_ALL=C.
- `locale-red.*`: перша fixture-спроба була зеленою через успадковане LC_ALL=C у runner; це НЕ RED.
- `locale-confirmed-red.*`: виконавець задав en_NZ у fixture LANG/LC_ALL, запустив `node --test test/test-run-darwin-locale.test.ts` до locale-фіксу; exit 1, Invalid Darwin process start identity. Повний незакомічений diff, SHA, QA HOME, command та тест у command.json.
- `locale-green.*`: після LC_ALL=C, 1/1 pass, exit 0.
- `native-green-darwin-process.*`: main поза sandbox після фіксу, 5/5 pass, exit 0: wrapper, reservation, timezone, unknown-on-scan-failure, detached-child identity/reconcile/PID reuse/cleanup.
- `native-green-darwin-locale.*`: main поза sandbox, 1/1 pass, exit 0.
- `build.*`: npm run build, exit 0; `process-linux-port.*`: 7/7 pass; `cli.*`: 94/94 pass. Ці прогони виконавця мають окремий приватний QA HOME, точні команди і незакомічений diff у command.json.

`native-build.*`, `native-home-canonical.*`, `native-unit-state-upgrade.*` — попередні нативні перевірки main до адресного виправлення тестових fixtures. HOME fixture 3/5 через відсутній assignment.runId; schema upgrade fixture 0/1 через alias URL, який обходив import hook. Їх не подано як pass.

`test-run-socket-path` у попередній сесії відмовляє до сценарію, бо має assert process.platform=linux і /proc oracle. Він не адаптувався й не приховувався за skip; нативна Linux-перевірка лишається за main. 7/7 process-port і 94/94 CLI тести перевіряють спільну логіку, не замінюючи реальний Linux OS-прогін.

Для прямих node --test немає зовнішнього TestRunResult/runId або стану unit-групи; збережено повні stdout/stderr і CLI exit окремо. Вкладені TestRunResult у попередніх failed fixtures збережено без змін у stdout. Команду raf test run не запускали за прямою забороною доручення. Повторний нативний прогін fixtures, коміт коду й push main будуть дописані після підтвердження.
