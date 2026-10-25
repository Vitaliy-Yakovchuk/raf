# add-raf-test-run:6.6

## Рішення й аудит актуальності

Дефект чинний на raf-hotfix `0e1ffba331055a3baa484f35fe08107c35e09819`: `observeEtchlyInventory` порівнює SHA-256 усіх байтів кореневого `package.json`, хоча wrapper запускає фіксовані Node/Vitest executable/argv без npm. Із джерел доручення перевірено proposal.md (Why, What Changes, Non-goals), пункт 6.6 tasks.md, etchly-profile.md (команда й статичний інвентар), повну вимогу delta «Unit-профілі монорепозиторію etchly» зі сценаріями, core/process/test-first, core/process/unit-test-runs та вимогу аудиту projects/orchestrator/autonomous-development. Суперечностей доручення з цими вимогами не виявлено.

Обрана дозволена пунктом 6.6 альтернатива: звузити перевірку кореневого `package.json` до всіх JSON-полів, крім верхнього `scripts`. Wrapper не виконує npm scripts чи lifecycle scripts, install або discovery. Додавання, редагування чи видалення scripts не змінює його фіксованого запуску; зміни назв/вмісту тестів усе одно перевіряє статичний інвентар. Інші поля не оголошуються безпечними: workspaces, type, dependencies/devDependencies, overrides, imports/exports, engines, packageManager і навіть нові невідомі поля лишаються захищеними.

Хеш кореневого `package.json` у `src/test-run-etchly-audit.json#/sourceHashes/package.json` означає SHA-256 UTF-8 компактного JSON після видалення тільки верхнього `scripts` і рекурсивного сортування ключів об'єктів. Порядок і значення масивів зберігаються. Невалідний JSON або кореневе значення, що не є об'єктом, відхиляється як INVENTORY_INCOMPLETE з назвою файла. Решта sourceHashes, включно з app/package.json, worker/package.json, конфігами, preload і класифікатором, лишаються SHA-256 початкових байтів.

## Прийняття перевірених змін

Для scripts-only правки кореневого маніфесту оновлювати audit/conf не потрібно. Це не створює групу, не додає unitFiles і не змінює executable/argv чи права виконавця.

Зміна захищених полів або будь-якого іншого закріпленого джерела й далі дає INVENTORY_INCOMPLETE до класифікації/spawn. Тоді потрібна наявна процедура повторного статичного аудиту etchly-profile.md: перевірити diff джерела та вплив на класифікацію/запуск, передати точні inventory/groups та хеші main або стадії з правами на conf, погоджено оновити `src/test-run-etchly-audit.json` разом із потрібними conf-правками й перевірити регресії. Кореневий маніфест перераховується за описаним вище алгоритмом; інші файли — побайтово. Автоматичного прийняття поточного checkout чи перемикання гілки немає.

Фікстура `test/fixtures/etchly-audited-package.json` скопійована до реалізації з перевіреного маніфесту etchly-develop: початковий побайтовий SHA-256 `c688abefa18e4fe237818db9401affc13117926276a8c3654ed90751c5375b10` збігався з попереднім pin. Тести ізольовано перевіряють guard маніфесту: після прийняття він доходить до відсутнього наступного prerequisite `vitest.config.ts`; очікувана помилка перехоплюється всередині тесту. Це не позитивний прогін повного etchly-інвентаря й не setup/import failure suite.

## Канал прогонів

Перший власний `raf test run --phase red --group add-raf-test-run/etchly-profiles --files test/test-run-etchly-profiles.test.ts` відмовив через сторонній відсутній integration-файл `test/model-routing-integration.test.ts` у raf-hotfix. RunId `feacbbdb-e20c-4e9e-a85d-325d248c7422`, outcome refused, CLI 1, child exitCode null, без таймауту, cleanup complete, knownRed/unexecuted/unknown порожні, groupSnapshot unavailable, nextAction fix-setup. Це не red. Повний незмінений JSON і transport envelope збережено в initial-refusal.*; інструмент надає combined output, окремого raw stderr цього виклику не надав.

Main отримав точну відмову й 2026-10-25 явно доручив не обходити її: до виправлення 6.5 main виконує red/green на чистих клонах власних комітів із `node --test test/test-run-etchly-profiles.test.ts`, ізольованими HOME/TMPDIR й окремими stdout/stderr/кодами. Red-коміт: `b9ec64b58fd28c35990b636b16eebb3de87badf7`. Перевірка падіння має передувати реалізації. Цей погоджений хостовий виняток не видається за виконаний sandbox TestRunResult і не скидає агрегат групи.

Інші пункти зміни відкриті; tasks.md виконавець не змінює, sync/archive не виконує.

## Результати

Main підтвердив red на `b9ec64b58fd28c35990b636b16eebb3de87badf7`: 107 тестів, 102 pass, 5 assertion-fail; exit 1, stderr 0 байт, setup/import падінь немає. Після реалізації на `792915977696ecd1b036f609cba7c60f7467b20b` — 107/107 pass, exit 0 (`green-7929159.*`). Адресна статична TS-перевірка потім виявила власний TS2698: виклик arrow-функції fail без явного return не звужував unknown для spread. Це усунено комітом `8de8959108a4223aea9b2002bb72ae0dc7cdd83b` без зміни runtime-поведінки та тестів. Main повторив green на цьому фінальному code SHA: 107/107 pass, exit 0, stderr 0 байт (`green.*`, оригінали `/srv/dev/rtr66-green2.*`).

Падінь і невиконаних тестів у фінальному Node-прогоні немає, timeout не спрацював, main підтвердив cleanup clone/HOME/TMPDIR. Звичайний wrapper лишається заблокований стороннім integration-інвентарем; хостовим прогонам не вигадано runId чи активний SQLite-агрегат. Вони не видаються за `--phase hotfix` TestRunResult. Повторний прогін wrapper-а без виправлення setup не виконувався. Main відповідає за виправлення каналу та перенесення hotfix у робочий raf.

Докази: [run-summary.json](run-summary.json), [red.metadata.json](red.metadata.json), [green.metadata.json](green.metadata.json), окремі повні stdout/stderr/exit кожного host-прогону та початкові SHA-256 від main. [integrity.json](integrity.json) перевіряє байти копій і незмінність JSON першої відмови. [source-audit.json](source-audit.json) фіксує перевірений baseline та 15 незмінених побайтових pin. Синтаксис обох TypeScript-файлів і whitespace diff перевірено з exit 0; [typecheck.json](typecheck.json) чесно фіксує, що повний typecheck недоступний без @types/node: після виправлення TS2698 лишилися лише відсутні Node declarations (TS2591/TS2503). Повного typecheck pass не заявлено.
