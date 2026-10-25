# complete-raf-flow-contracts:10.5 — поточний запуск

Адресат `raf-cfc105-qa`, 2026-10-25, raf-develop. Галочка 10.5 залишається за raf. Ця тека належить цьому запуску; історичні докази в `evidence/cfc105-model-routing` не замінюють живий стенд.

## Автоматична інтеграція

Точна команда кожного прогону:

```
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/efd45e4d-b49f-42fe-9c21-dc5495f71b98/raf-main/bin/raf.ts test run --project raf --phase integration --group complete-raf-flow-contracts/model-routing-integration
```

Preset: `node-integration`, `test/model-routing-integration.test.ts`, callerPhase `qa`. HOME і група незмінні між усіма прогонами. Немає unit-прогону, скидання лічильника або обходу каналу test run.

| Доказ | runId | CLI / child | Outcome / залишок |
| --- | --- | --- | --- |
| `integration.TestRunResult.json` | `90e0c7f6-0485-4ba1-a669-c41ba209ae03` | 1 / null | refused INVENTORY_INCOMPLETE; group unavailable; next fix-setup |
| `integration-first.TestRunResult.json` | `bc1eac67-6d9f-409b-a551-a5a19386d392` | 1 / 1 | setup-failed, assertions + setup; 2 knownRed, I3 unknown; incomplete |
| `integration-fix-attempt.TestRunResult.json` | `9570bfa1-49e6-4d5a-b7fc-723e9bbd28c4` | 1 / 1 | assertions-failed; 2 passed, I4 knownRed; incomplete |
| `integration-green.TestRunResult.json` | `b137dffb-9a8b-423c-aa01-b56d54550edd` | 0 / 0 | passed; 3 passed, knownRed/unexecuted/unknown порожні; complete |

У всіх чотирьох timedOut=false, cleanup.complete=true, remainingPids=[]; timeoutCount=0 для завантажених груп. Зелений результат — наступна дія complete. Повні незмінені однорядкові TestRunResult збережені окремо від CLI-коду. `*.transport.json` зберігають повний отриманий output і код CLI; `*.stderr-extracted.txt` — позарезультатні протокольні рядки. Інструмент exec об'єднує stdout/stderr, тому нативне розділення stderr невідоме: це явно записано, його не подано як порожній потік. Зовнішній host-скрипт розділяє потоки нативно.

`environment.json`, `workspace-after-green.json` та `fixture-fix.diff` фіксують версії, конфігурацію, SHA/незакомічені файли й межі прив'язки до SHA. HEAD для green за локальним reflog: `6ad616d09af67dfcba7c34420f609a7f9c9213ea`; тест виконувався з власною незакоміченою правкою. TestRunResult не заморожує Git SHA самостійно. Ресурсна телеметрія часткова, її не подано як повний вимір піків.

## Знайдені й виправлені дефекти фікстури

Первісні failed/unknown результати збережені. Версійний stub Claude друкував неприпустимий формат `claude VERSION`; тепер використано справжній формат `VERSION (Claude Code)`. SQLite-тест викликав неіснуючі `StateStore.finalizeSession/listPending`; тепер використовує справжній `createSessionState` поверх двох незалежних SQLite-з'єднань, з тими самими перевірками rollback та idempotence. Перший fix залишив один `listPending` на неправильному об'єкті; цей assertion-red збережений перед остаточним виправленням.

На tmux 3.6 kill-server може залишити власний socket inode. `tmux-cleanup-red.json` містить окремий реальний контроль: сервер уже відсутній, сокет залишився. Cleanup тепер підтверджує відсутність сервера, звіряє dev/ino власного сокета, видаляє лише цей inode та перевіряє його відсутність. Green підтвердив усі три інтеграційні тести. Setup failure не зараховано як unit-red; автоматичні assertion-red і ручний socket-red названо окремо.

Межа автоматичного доказу: I1/I2 використовує справжні subprocess/CLI/SQLite/tmux, але версійні stubs і зареєстрований контрольний процес замість native агентів. I3 перевіряє handoff-порти з реальним процесом; I4 — rollback/idempotence на SQLite, без реальної одночасної роботи двох координаторів. Це не повне покриття I1–I5 і не L1–L4.

## Живий стенд через main

Закомічений драйвер: `scripts/qa-model-routing-live.mjs`; main-actor і sandbox helper — сусідні `qa-model-routing-main.mjs`, `qa-model-routing-actor.mjs`. Main запускає на хості `node scripts/qa-model-routing-live.mjs <повний reviewed SHA>` з наявними абсолютними CODEX_HOME та GIT_CONFIG_GLOBAL. Драйвер клонує саме SHA, копіює конфігурацію з фіксацією digest, збирає isolated raf/main-layout, використовує власний HOME/SQLite/tmux і нативні встановлені CLI. Auth не копіюється; явні існуючі selectors успадковуються. Моделі/effort обирає чинна policy, для адресного запуску змінюється лише операційне enable/disable у власному SQLite. Claude enable викликається рівно один раз.

По кожному runner: версія, один збір квот і один запуск, справжня відмова або durable native identity/brief/model/effort; для живого агента — вимкнення, звірка process identity і launchContext, відмова наступному запуску, потім release helper та report/commit acceptance. Потоки, CLI-коди, сигнали, помилки й час команд зберігаються окремо в host `ev/`. Cleanup обмежено власним стендом. Відмови не повторюються. Відсутня авторизація/квота або непідтверджений native protocol залишають сценарій відкритим.

L4 не підмінюється послідовним запуском інших runner. Потрібен реальний ліміт/відмова й підтверджений вихід попередника; квоти штучно не вичерпуються. I5 та повні конкурентні сценарії не доводяться цим драйвером. Наразі host-результат очікується; без нього весь 10.5 не може бути succeeded.

Перевірки драйвера: три `node --check` та `git diff --check` — 0. Початковий загальний `npm run check:comments` — 1 через чужі незакомічені коментарі `test/agent-run-fixture.ts:269–270`. Після їх видалення відповідальним агентом повторна перевірка — 0 (`checks-final.json`). Чужий файл нами не змінювався й не комітиться.
