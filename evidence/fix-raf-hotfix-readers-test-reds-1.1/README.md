# fix-raf-hotfix-readers-test-reds:1.1 — два knownRed у `test/hotfix-activation-readers.test.ts`

Група `fix-raf-hotfix-readers-test-reds/hotfix-activation`, профіль `node`, файл `test/hotfix-activation-readers.test.ts`. Базовий коміт дерева raf-hotfix: `0df8c68f49a5ea63e8244dcb04999a6b24f76d8c`.

## (1) «[hotfix-concurrency] conflicting main refresh cannot activate an old seal or erase either side»

«Missing expected rejection» на `assert.rejects(activateHotfix(f.host, verified), /stale|base|conflict|chang/)`: Git-залежну перевірку stale base прибрано комітом c0c6c1d за рішенням власника audit-process-rules:1.14; у `hotfix-activation-snapshot.test.ts` таку саму перевірку вже прибрано в 607ab0c. Узгодження: цей `assert.rejects` видалено; решта сценарію (конфліктне оновлення hotfix лишає MERGE_HEAD і обидві сторони, повторна активація відхиляється зміненим fingerprint, main і hotfix незмінні) збережена.

## (2) «[hotfix-production-readers] service/worker/session identity and signed message delivery survive successful publication»

Повідомлення `LAUNCH_FAILED: Native runner identity changed during initial brief delivery` ховало причину. Діагностичний прогін (`diagnostic-only.*`, лише цей тест, `verifyOwner` з причиною) показав: `exited: PID absent before targeted observation` — процес runner-а зник після вставки брифу, екран лишився на `/status`.

Причина — у фікстурі, не в raf: фейковий runner `test/hotfix-fixture.ts` виконував `process.exit(0)` на `buffer.includes('/exit')` для будь-якого введення, зокрема вставленого брифу. Бриф phase=implement з 2026-10-28 22:08 (orchestrator 8c7504cb4e, `conf/briefs/tasks/implement.md`: «…команда/stdout/stderr/exit/JUnit у доказах») містить підрядок `/exit`, тому фейковий codex завершувався під час вставки; raf коректно фіксував втрату runner-а. Останній green цього тесту (b2f7907, 2026-10-28 16:27) передує цій зміні брифу. Справжній codex виконує `/exit` лише як надіслану команду composer-а, не як підрядок вставленого тексту; версія codex (0.163.0 у метаданих) — це версія протоколу з conf, яку друкує фейковий runner, і до причини не стосується.

Виправлення:

- `test/hotfix-fixture.ts`: вставлений (bracketed paste) текст ніколи не трактується як команда; `/exit` і `/status` спрацьовують лише коли надісланий Enter рядок composer-а дорівнює команді.
- `src/production-runtime.ts`: відмова `verifyOwner` називає стан і причину втрати ідентичності (`exited: …`, `mismatch: …`), як сусідня відмова перед durable start gate.

## Прогони

- `red.*` — runId `bb161a7b-7b16-4127-a172-233e7bd8aa03`, `--phase red --files test/hotfix-activation-readers.test.ts`, незмінене дерево HEAD 0df8c68: `assertions-failed`, 14 passed, knownRed = обидва тести вище, cleanup complete.
- `diagnostic-only.*` — runId `522d9520-3e0b-4e08-a236-a5a18f529134`, `--phase hotfix --only` тест (2) з розширеним повідомленням `verifyOwner` і вже узгодженим тестом (1): knownRed лишаються; у діагностиці причина `exited: PID absent before targeted observation`.
- `green-no-files-refused.*` — runId `62beb6e2-0fb9-4283-9591-890f8980bc61`, `--phase hotfix` без `--files`: `refused` EMPTY_SELECTION, бо група ще не була в `conf/test-runs.json`; після цього групу зареєстровано (`conf/test-runs.json#/projects/raf/groups/fix-raf-hotfix-readers-test-reds~1hotfix-activation`).
- `green.*` — runId `8be46268-334f-47ef-8d64-a16464e041fa`, `--phase hotfix --files test/hotfix-activation-readers.test.ts`, робоче дерево з виправленнями: `passed`, 16 passed, knownRed/unexecuted/unknown порожні, groupState `complete`, cleanup complete.
- `green-committed.*` — runId `9f7b4acb-63f5-4e43-98d8-e46254345b85`, `--phase hotfix --only` обох колишніх knownRed на закоміченому коді 821d86c975b62b40cd194cf881bb7138e29e58a9 (чисте дерево): `passed`, обидва тести passed, knownRed/unexecuted/unknown порожні, groupState `complete`, cleanup complete.

Реєстрацію групи в `conf/test-runs.json` (репозиторій orchestrator) з пісочниці виконавця закомітити неможливо (EROFS на `.git/index.lock`); зміну передано main повідомленням agent message (receipt `1420cf58-6302-4f84-b6cf-9a96fc3e4959`).

Кожний `*.TestRunResult.json` — повний незмінений JSON команди, `*.stderr.txt` — stderr CLI, `*.cli.json` — команда, код виходу CLI, runId і стан дерева.
