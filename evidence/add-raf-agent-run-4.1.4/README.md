# add-raf-agent-run:4.1.4 — регресійний assertion red підтверджено

Автор: `raf-ara414-scaffold`, 2026-10-25. Production-код і `tasks.md` не змінено.

## Остаточний результат

Первинний assertion red автора: runId `a3a08f9e-aaf2-45f6-b488-7bdb00e46619`, `assertions-failed`, **7 цільових assertion failures / 11 passed**. CLI code 1, child exitCode 1, 21261 ms; timeout 1200000 ms, `timedOut: false`, `timeoutCount: 0`. Cleanup complete, remainingPids [], unexecuted [], unknown [], groupSnapshot loaded, nextAction implement. CallerPhase test-scaffold, фаза red, точний node-профіль і лише власний файл. Setup/import failures у цьому прогоні немає.

Повний TestRunResult: `red.stdout` (рядок stdout), `red-result.json` (ті самі всі поля у зручному JSON), `red-evidence.json` (команда/CLI code/оцінка). Повний спостережений stderr черги: `red.stderr`. `tool-output.txt` зберігає весь незмінений вивід інструмента. Інструмент повертає об'єднані потоки: перший завершений JSON — результат stdout, наступний JSON `launch-queue.waiting` — stderr за контрактом CLI; первісний об'єднаний вивід збережено для перевірки цього розділення, жоден фрагмент не відкинуто. `artifact-hashes.json` містить розміри й SHA-256 власних артефактів; це локальний інвентар артефактів, не manifest хостового каналу. Обрізання не було.

Усі сім ERR_ASSERTION — власні deepStrictEqual про multiline parsing/delegation, рядки тесту 21, 42, 51. LF/CR/CRLF і композиція single quotes не проходять; 11 інваріантів проходять. Отже, падіння стосуються цільової поведінки. Main має перевірити цей доказ перед передачею іншому implement-агенту; групу, відбір і QA HOME/агрегат зберегти.

HEAD, спостережений після прогону: `795d6662cb6bdfce9db376141afb95ff8e555929`. SHA-256 тесту `76d502a5735ce10076a33e9ff46e4729bf835e89a5881ec18d8af8445b19e6ea` збігається з початковим `workspace.json`: тест після першого коміту не змінювався. Інші задачі зміни відкриті, sync/archive не застосовуються; галочку 4.1.4 ставить raf після прийнятого звіту.

## Контракт і актуальність

Пункт 4.1.4 досі відкритий. `proposal.md` включає agent message; `design.md`, розділ доставки, крок 4, вимагає: «Лапки, переноси, `$()` і backticks лишаються буквальними даними, ніколи shell-командою». Delta `specs/projects/raf/agent-message/spec.md`, вимога «Команда повідомлення агенту», вимагає буквального тексту. Доручення називає дефект host live QA ara41q6 на 23968f5. На HEAD зі `workspace.json` у `parseSandboxCommand` досі є безумовна відмова LF/CR перед обробкою single quotes. Суперечності чи втрати актуальності не виявлено.

## Тести й інваріанти

`test/sandbox-command-multiline.test.ts`: 18 unit-випадків. Для LF, CR і CRLF окремо перевіряються точний argv парсера та одноразова передача незміненого тексту/перевіреного sender через `runSandboxTestCommand` до fake communication port. Payload має справжні переноси, кінцевий перенос, Unicode, `$()`, backticks, `;`, pipe й redirect усередині single quotes. Зовнішніх процесів чи повідомлень тести не запускають.

Додаткове позитивне очікування — поєднання multiline single quotes з escaped apostrophe й сусідніми literal-сегментами. Інваріанти: backslash-n лишається двома байтами, не перетворюється на LF; нецитовані LF/CR/CRLF, escaped LF/CR поза лапками, `;`/pipe після multiline literal, NUL усередині/поза лапками та незакриті лапки відхиляються. Нова публічна поверхня не потрібна, тому каркас NotImplemented не додається.

Первісний статичний прогноз (7 failures / 11 pass) підтверджений остаточним прогоном вище.

## Незмінна група та реєстрація

Група для red → implement → QA: `add-raf-agent-run/sandbox-multiline`.

```sh
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/a082d01d-15d1-4418-a307-f8f63cb140f5/raf-main/bin/raf.ts test run --project raf --phase red --group add-raf-agent-run/sandbox-multiline --files test/sandbox-command-multiline.test.ts
```

Main перевірив і вніс у `conf/test-runs.json` (поза файловими межами автора) **до red**, Orchestrator `e13c62d34a52e4a4dea70c4deabc1202c59d5b23`:

- `projects.raf.profiles.node.unitFiles`: додати `test/sandbox-command-multiline.test.ts`.
- `projects.raf.groups["add-raf-agent-run/sandbox-multiline"]`: `{"profileId":"node","files":["test/sandbox-command-multiline.test.ts"]}`.

Точні машинні записи й передумови профілю — `channel-attempt.json#/profileRegistration`. Локально наявні Node v26.12.1, TypeScript, runner і reporter. Потрібні чинний trusted caller/module origin, develop workspace, ізольовані QA HOME/state/tmp, стандартний unit timeout із `conf/flow.json`; між стадіями зберегти той самий HOME/агрегат. Автор конфігурацію не змінював; main зареєстрував файл явно.

## Перевірка синтаксису та історія усунених блокерів

`node --check test/sandbox-command-multiline.test.ts` — exit 0. Це лише перевірка синтаксису. `git diff --check` — exit 0. Assertion-прогону поза дозволеним каналом не виконувалося.

Спроба наведеної red-команди завершилася кодом інструмента 1 ще в `runPublishedAgentChannel` → `verifyCaller`: `STATE_CONTEXT_REFUSED: Unregistered module origin: .../generations/a082d01d-15d1-4418-a307-f8f63cb140f5/raf-main/src/main-switch-agent-launcher.ts`. Повний незмінений вивід інструмента — `channel-attempt.json#/rawToolOutput`. Wrapper/runner не повернули TestRunResult, відокремлені stdout/stderr та власний CLI/child exit code невідомі; вони явно `null`, а не вигадані. Ця помилка каналу не підтверджує red, assertions чи setup/import результат самих тестів.

Адресу `main` підтверджено дозволеним `agent ps`. Перша спроба передати main конфігурацію повернула exit 1, `STATE_CONTEXT_REFUSED`, ENOENT `.../raf-hotfix/registry.json`, completed/pending порожні. Після отримання нового блокера окреме повідомлення з точною причиною також не доставлено: `HANDLER_FAILED`, `Recipient composer contains unrelated input`, exit 1, completed/pending порожні. Повна відповідь останньої доставки — `channel-attempt.json#/blockerMessage`. Сліпих повторів тесту, заміни CLI-покоління, зміни HOME, обходу sandbox або прямого читання SQLite не було.

На момент першої відмови потрібні були реєстрація файлу/групи й відновлення каналу main. Ці передумови згодом виконано; остаточний результат наведено на початку документа.

Уточнення main в цій сесії: «збій CLI стався через моє перемикання покоління raf (вікно без registry.json), канал уже відновлено — покоління 1c2ba8c0». Main доручив спочатку закомітити власні тест/докази, передати SHA через agent message, після чого він зареєструє unitFiles/групу й автор повторить red. Початкові відмови вище збережені як історія спроби, не як остаточний висновок.

Тест і початкові докази закомічено в `c8a723247f6106723fe36ace532c127c41b19f3f`; передача SHA main підтверджена receipt `2d3dd24d-1354-4d77-a12c-2f92ef910d19`. Main зареєстрував точний файл і preset у Orchestrator `e13c62d34a52e4a4dea70c4deabc1202c59d5b23`; автор окремо перевірив обидва записи перед повтором. Повтор зупинився на state origin покоління `1c2ba8c0` — повний вивід у `restored-channel-attempt.json`. Після завершення нового вікна ENOENT блокер доставлений main, receipt `82dd90cb-d038-490c-8f11-699d7fb8514c`.

Main підтвердив завершення перемикання (21:24–21:26) й повторно доручив ту саму red-команду. Наступна спроба повернула runId `d145def4-2ad4-413e-b913-48bb3f5a2ba1`, `outcome: refused`, `CALLER_UNAUTHORIZED`, причину `QA channel unavailable: unit context could not be verified`, `callerPhase: test-scaffold`, без runner/selection/profile/knownRed. Повний вивід у `unit-context-refusal.json`. Це не assertion red. Блокер доставлений main з receipt `55ce1c4c-d915-413c-ae25-7943b04cd845`; наступний прогін очікує відновлення unit-контексту, код тесту лишається незмінним.

Main оновив діагностику поколінням de319c1f і доручив одну спробу. Вона повернула `1ef89ecf-20c7-4f1b-94ed-b4ad9e2a1558`, refused: ізольована база QA має версію 16 й потребує явної міграції до 18 (`migration-refusal.json`). Повна причина доставлена main, receipt `9b468390-c3e8-49d5-b857-f4e1a7d82d62`. Main підтвердив штатну міграцію через scripts/migrate-state.ts із резервними копіями та доручив повтор. Автор не читав і не змінював SQLite, не скидав HOME/групу; наступний власний red успішно підтвердив саме assertions-failed, як наведено вище.
