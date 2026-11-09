# 1.1 — маршрут браузерного QA на Darwin

Виконано за уточненням main у сесії frmbq-1-1: «Якщо так і на darwin — браузерні тести Mac мають іти через raf test run (Chromium стартує на хості), і виправлення — не дозволи sandbox, а маршрут: QA-скіл/бриф і, якщо треба, профіль test-runs для browser preset». Це уточнення замінює первісну гіпотезу proposal про необхідність Seatbelt-грантів. Живого Seatbelt-логу Chromium немає; відмову конкретної Mach-операції не заявлено відтвореною.

## Доведений маршрут

1. `src/codex-raf-command-access.ts:163`: PreToolUse hook передає видану просту команду в `runPublishedAgentChannel` разом з `issuedCommands`. Hook працює в хостовому процесі; sandbox отримує команду читання вже готового результату.
2. `src/main-switch-agent-launcher.ts:62`: launcher перевіряє виданий префікс і живого зареєстрованого caller, бере lease опублікованого покоління. На рядку 81 він запускає `process.execPath` + pinned `bin/raf.ts` з початковими аргументами. Тут немає виклику `prepareCodexSandbox`, `sandbox-exec` або окремої гілки darwin.
3. `src/test-run-runtime.ts:391`: test entry повторно перевіряє assignment, обирає налаштовану групу й ізольований QA HOME. `src/test-run-runtime.ts:271` запускає executable/argv тестового профілю напряму, `shell:false`, без sandbox агента.
4. `conf/test-runs.json#/projects/etchly/groups/dedupe-product-code~1etchly-d4-browser-integration` вже містить профіль `vitest-d4-browser` та два browser-файли. Профіль має `testKind:integration` і прямий запуск node/vitest, тому новий browser preset не потрібен. Реєстр цієї unit-регресії вже закомітив main у `e20c954485344f457ab2ebd51e536e97382c1a19` (не власний коміт виконавця).

`src/flow-brief.ts:23` тепер дає QA явний маршрут Chromium/Playwright через виданий `raf_command test run --phase integration --group ...`, з вимогою зареєстрованого QA-запуску. Наявні launcher/caller guards і Seatbelt-політика не змінені.

## RED → GREEN

Стабільна група `fix-raf-mac-browser-qa-sandbox/darwin-browser`, профіль `node`, три файли: `test/flow-brief.test.ts`, `test/codex-raf-command-fd.test.ts`, `test/codex-darwin-sandbox.test.ts`. Команди, код CLI та dirty paths — `red.cli.json`, `green.cli.json`; повні незмінені результати — `red.TestRunResult.json`, `green.TestRunResult.json`.

- RED до зміни production: `21122fc7-a712-4b68-a4e0-fd06477ebbdb`, 15 passed, 2 assertion failures у нових QA-брифах raf/etchly. CLI/child 1; setup/import failures немає.
- GREEN: `d817f19d-fd2c-4157-9996-eedd47a700d0`, 18 passed, CLI/child 0. Обидві відомі червоні закриті; knownRed/unexecuted/unknown порожні. Cleanup complete, timeout false; група завершена. QA HOME однаковий в обох результатах; агрегат не скидався.
- `*.stderr.txt` зберігають stderr із tool output. RED-вивід JSON обрізано інструментом; повний TestRunResult скопійовано з оголошеного raf файла. GREEN stdout/stderr перемішані інструментом; stderr відновлений за цілими warning/result рядками. Повний JSON не обрізаний і не реконструйований.
- Попередження про сторонні невалідні Etchly/Stitchly groups збережено; вони не вплинули на цей відбір. ResourceUsage чесно має partial/unknown вимірювання; це не приховано як повна телеметрія.
- `git diff --check` для власних змін — exit 0.

`test/codex-raf-command-fd.test.ts:54` запускає справжній production hook із fixture entrypoint і Darwin directory-path поведінкою. Host fixture записує receipt у каталог, зазначений як hidden для агента, до sandbox replay; replay повертає stdout і код без повторного виконання. Це перевірка маршруту/порядку й аргументів, а не Chromium або живого enforcement Seatbelt. Відсутність реального sandbox enforcement у цій фікстурі явно обмежує доказ. Незмінений `test/codex-darwin-sandbox.test.ts` окремо перевіряє конфігурацію exact filesystem permissions, read-only production, hidden secrets і plugins для writable/read-only workspace.

## Самоперевірка читабельності

База raf-hotfix `3d4b430572150a3d77aa5798e3b51b13960880c5`; перевірена ревізія — власний коміт із цим доказом (SHA в report.commits), на момент GREEN — власні робочі правки трьох файлів із `green.cli.json`.

Область: уся `prepareFlowBrief` (`src/flow-brief.ts:10`), QA-регресія (`test/flow-brief.test.ts:49`), host/replay-регресія (`test/codex-raf-command-fd.test.ts:54`). `browserGuidance` явно обирається тільки для QA і потрапляє у вже наявний механізм deduplication; інші стадії отримують порожнє доповнення. Немає нового стану, вкладених умов чи прихованих побічних ефектів. Тест послідовно готує hook, виконує команду, перевіряє receipt, читає replay й перевіряє єдиний виклик із точними аргументами. Імена відображають роль даних. GREEN перевіряє також незмінність main/test-scaffold/implement брифів і файлових меж. Нових quality-утиліт чи числових обмежень не додано.

## Передача main і Mac

Точні Mac-команди, стан реєстру, помилка root commit і receipt доставки — `handoff.json`. Початкові узгодження main підтверджені receipts `085e742b-0803-4780-aa31-9fdc1745e56e`, `69564a05-f1b3-4c1c-9403-9a26f5860d08`, `96ddb83f-ee31-4486-9bdf-2b0f5efae84a`, `24e0e88f-4f57-485a-91ce-bc16b32bcc89`.

Фінальне повідомлення з GREEN, root patch і командами Mac не доставлене: CLI 1 `MESSAGE_NOT_ACCEPTED`, composer містив unrelated input. Completed порожній, pending message-acceptance, retrySafe null; автоматичного повтору не робив. JSON-звіт є передачею результату, але не підтвердженням доставки повідомлення. Main має прочитати `handoff.json` і передати команди Mac.

Власні доповнення `tasks.md` без галочок уже записані; root commit відмовив через read-only `.git/index.lock` (CLI 128), точний патч — `tasks.patch`, коміт належить main. Архівацію не виконував: 9.1 не доручено й залишається відкритим. Push/активація належать main. Живий Chromium/Playwright запуск і наявні browser assertion failures не позначені PASS цим Linux-доказом.
