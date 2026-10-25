# add-raf-agent-run:4.1.4 — тест підготовлено, red не підтверджено

Автор: `raf-ara414-scaffold`, 2026-10-25. Production-код і `tasks.md` не змінено.

## Контракт і актуальність

Пункт 4.1.4 досі відкритий. `proposal.md` включає agent message; `design.md`, розділ доставки, крок 4, вимагає: «Лапки, переноси, `$()` і backticks лишаються буквальними даними, ніколи shell-командою». Delta `specs/projects/raf/agent-message/spec.md`, вимога «Команда повідомлення агенту», вимагає буквального тексту. Доручення називає дефект host live QA ara41q6 на 23968f5. На HEAD зі `workspace.json` у `parseSandboxCommand` досі є безумовна відмова LF/CR перед обробкою single quotes. Суперечності чи втрати актуальності не виявлено.

## Тести й інваріанти

`test/sandbox-command-multiline.test.ts`: 18 unit-випадків. Для LF, CR і CRLF окремо перевіряються точний argv парсера та одноразова передача незміненого тексту/перевіреного sender через `runSandboxTestCommand` до fake communication port. Payload має справжні переноси, кінцевий перенос, Unicode, `$()`, backticks, `;`, pipe й redirect усередині single quotes. Зовнішніх процесів чи повідомлень тести не запускають.

Додаткове позитивне очікування — поєднання multiline single quotes з escaped apostrophe й сусідніми literal-сегментами. Інваріанти: backslash-n лишається двома байтами, не перетворюється на LF; нецитовані LF/CR/CRLF, escaped LF/CR поза лапками, `;`/pipe після multiline literal, NUL усередині/поза лапками та незакриті лапки відхиляються. Нова публічна поверхня не потрібна, тому каркас NotImplemented не додається.

Статичний прогноз — сім assertion failures на позитивній multiline-поведінці та одинадцять pass. Це **не результат прогону**: потрібен первинний red автора після відновлення каналу.

## Незмінна група та реєстрація

Група для red → implement → QA: `add-raf-agent-run/sandbox-multiline`.

```sh
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/a082d01d-15d1-4418-a307-f8f63cb140f5/raf-main/bin/raf.ts test run --project raf --phase red --group add-raf-agent-run/sandbox-multiline --files test/sandbox-command-multiline.test.ts
```

Main має перевірити та внести в `conf/test-runs.json` (поза файловими межами автора) **до red**:

- `projects.raf.profiles.node.unitFiles`: додати `test/sandbox-command-multiline.test.ts`.
- `projects.raf.groups["add-raf-agent-run/sandbox-multiline"]`: `{"profileId":"node","files":["test/sandbox-command-multiline.test.ts"]}`.

Точні машинні записи й передумови профілю — `channel-attempt.json#/profileRegistration`. Локально наявні Node v26.12.1, TypeScript, runner і reporter. Потрібні чинний trusted caller/module origin, develop workspace, ізольовані QA HOME/state/tmp, стандартний unit timeout із `conf/flow.json`; між стадіями зберегти той самий HOME/агрегат. Конфігурацію не змінено й новий файл не вважається автоматично зареєстрованим.

## Фактична перевірка і блокер

`node --check test/sandbox-command-multiline.test.ts` — exit 0. Це лише перевірка синтаксису. `git diff --check` — exit 0. Assertion-прогону поза дозволеним каналом не виконувалося.

Спроба наведеної red-команди завершилася кодом інструмента 1 ще в `runPublishedAgentChannel` → `verifyCaller`: `STATE_CONTEXT_REFUSED: Unregistered module origin: .../generations/a082d01d-15d1-4418-a307-f8f63cb140f5/raf-main/src/main-switch-agent-launcher.ts`. Повний незмінений вивід інструмента — `channel-attempt.json#/rawToolOutput`. Wrapper/runner не повернули TestRunResult, відокремлені stdout/stderr та власний CLI/child exit code невідомі; вони явно `null`, а не вигадані. Ця помилка каналу не підтверджує red, assertions чи setup/import результат самих тестів.

Адресу `main` підтверджено дозволеним `agent ps`. Перша спроба передати main конфігурацію повернула exit 1, `STATE_CONTEXT_REFUSED`, ENOENT `.../raf-hotfix/registry.json`, completed/pending порожні. Після отримання нового блокера окреме повідомлення з точною причиною також не доставлено: `HANDLER_FAILED`, `Recipient composer contains unrelated input`, exit 1, completed/pending порожні. Повна відповідь останньої доставки — `channel-attempt.json#/blockerMessage`. Сліпих повторів тесту, заміни CLI-покоління, зміни HOME, обходу sandbox або прямого читання SQLite не було.

Наступна дія main: зареєструвати файл/групу й відновити довірений канал для автора; автор сам повторює первинний red та зберігає повний TestRunResult, stderr і код CLI. Main перевіряє саме цільові assertion failures перед передачею іншому реалізатору. Пункт 4.1.4 не готовий до галочки; інші пункти відкриті, sync/archive не застосовуються.

Уточнення main в цій сесії: «збій CLI стався через моє перемикання покоління raf (вікно без registry.json), канал уже відновлено — покоління 1c2ba8c0». Main доручив спочатку закомітити власні тест/докази, передати SHA через agent message, після чого він зареєструє unitFiles/групу й автор повторить red. Початкові відмови вище збережені як історія спроби, не як остаточний висновок.
