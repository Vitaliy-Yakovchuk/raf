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

L4 не підмінюється послідовним запуском інших runner. Потрібен реальний ліміт/відмова й підтверджений вихід попередника; квоти штучно не вичерпуються. I5 та повні конкурентні сценарії не доводяться цим драйвером. Host-прогін 7639 завершився rc=1; весь 10.5 залишається failed, а невиконані сценарії — відкритими.

Перевірки драйвера: три `node --check` та `git diff --check` — 0. Початковий загальний `npm run check:comments` — 1 через чужі незакомічені коментарі `test/agent-run-fixture.ts:269–270`. Після їх видалення відповідальним агентом повторна перевірка — 0 (`checks-final.json`). Чужий файл нами не змінювався й не комітиться.

Історичні broker facts: за адресною відповіддю main Z.423 не переписує факти попередніх прогонів. Прямий lookup фактів red `9570bfa1`/green `b137dffb` через дозволений канал недоступний; їхній stderrDigest не зафіксовано як перевірений. Protocol-extracted stderr з `launch-queue.waiting` збережений, порожній потік/digest не підставлено. Пізніше main підтвердив старий broker digest e3b0 і прямо доручив створити нову пару; результат цього окремого доручення наведено нижче.


## Результат host cfc105h1, 2026-10-26

Команда `node scripts/qa-model-routing-live.mjs 7639f992200f7c7099c4456edbbea9201397ade5` з `/srv/dev/cfc105h1/raf`; 00:00:37–00:03:38 UTC. Build — 0, host — 1, stderr порожній. Повні потоки, окремий rc, raw команди та native артефакти збережено в `host-cfc105h1/`; SHA256 незмінених копій — `host-artifact-manifest.json`. Згенеровані sandbox executables/BPF виключені; brief/report/worker/runtime/identity збережені. Це ручний host-доказ, а не TestRunResult.

Codex 0.163.0: runId `219ed2be-7461-4eb9-9dbb-d90358a65573`, native ID `01a17584-0096-70f0-a3ca-ed6fdf263a43`, policy обрала `gpt-6-luna` / `medium`. Реальний native агент виконав helper і контрольний коміт `2d68d57dc8adca8a8ce40e90cd2fb12492ac2a5d` у власному стенді; report acceptance — succeeded. Disable зберіг процес PID/startTicks/bootId, launchContext/activity та SHA256 брифа; наступний запуск відхилено саме `NO_ENABLED_MODELS`, нової сесії немає. Артефакт `assessment.json` адресує докази. Один завершений fixture checkbox стенда не є виконанням production задачі 10.5.

Grok 1.0.67 та agy 1.4.5: збір квот — unknown_screen, запуск — NO_SUITABLE_CAPACITY через відсутній pre-brief native identity protocol; жодного native брифа/звіту. Claude 2.1.310: рівно одна enable-команда — 0; limits відмовив через pinned 2.1.308, а agent run дійшов до native readiness і завершився unknown_screen. Ці дві відмови розділено; сама версія запуск не блокувала. Readiness-екран не збережено перед cleanup, тому auth або конкретну несумісність не встановлено; код адаптера навмання не змінювався. Codex quota містить справжній замір weekly/shared remaining 0.73; іншого запасу/вичерпання не припускаємо.

Cleanup повний: власні tmux/service завершені; post-cleanup SQLite має 0 task/resource reservations і pending intents, власні агенти finished. Рядки фінальної resource telemetry збережені, не трактуються як активні claims. Повна матриця I5, виробничі concurrent reconcilers і L4 не виконані. Для L4 потрібні підтверджена фіналізація попередника, придатна альтернатива та нові identity/report_path для тих самих незавершених пунктів. Послідовні host-запуски цього не доводять. Продовження належить тому самому відкритому 10.5, без нового repeat-qa/defect-fix пункту; tasks.md не редаговано.


## Уточнення Z.335: версія не є передумовою

CLI 2.1.308 не потрібен: встановлена 2.1.310 має давати лише warning. Host driver не відкидає версію й виконав agent run після quota refusal. Відмова `Unsupported claude version` походить із самої raf, `src/quota-collection.ts:180–181`, а не fixture. У робочій raf-main-b, branch main, HEAD ec8d770 цей самий strict gate підтверджено читанням Git; runner-availability окремо правильно повертає available:true з warning. Точна команда, raw rc/error, Git-цитата Z.335 та межа runtime доказу — `claude-version-refusal-clarification.json`. За прямою вказівкою main передано для working-raf hotfix (receipt 95efc655). Команда limits runId не повертає; наступний native runId f6b722d9 стосується іншої відмови readiness unknown_screen. Її не приписано номеру версії. Нового прогона не було; попередні факти не переписано.


## Нова пара red/green за прямим дорученням main

Main підтвердив report-rejected старих 9570bfa1/b137dffb: broker зберіг stderrDigest e3b0, а артефакти містять launch-queue.waiting. Історичні факти не переписано. Main спочатку назвав робочу ec8d770, потім явно дозволив лише переданий CLI generation efd45e4d (HEAD 28ad8b81), без гарантії Z.423 на боці CLI. Новий prefix не використовувався. Доручення й SHA/незакомічені файли — `broker-refresh-20261026/provenance.json`.

Для нового red відтворено точний уже виправлений I4 fixture defect: один виклик states[0].listPending повернуто до first.listPending. Після red виправлення одразу відновлено байт у байт; assertions/відбір/таймаути не змінені. Це оновлення доказу того самого дефекту, не новий дефект і не повтор native QA.

| Фаза | runId | CLI / child | Outcome / група |
| --- | --- | --- | --- |
| red | 7edb57b3-e987-44ab-844a-4047f9643e95 | 1 / 1 | assertions-failed, I4 knownRed, setup failure немає; incomplete / complete-integration |
| green | 52dd7ee2-9a7f-4961-b314-95609fc379f6 | 0 / 0 | passed 3/3, knownRed/unexecuted/unknown порожні; complete / complete |

Та сама команда integration preset, група та QA HOME. В обох timedOut=false, cleanup.complete=true, remainingPids=[], timeoutCount=0. Повні незмінені TestRunResult/merged transport, окремі CLI/child коди і позарезультатні stderr-рядки — `broker-refresh-20261026/`. Red stderr 1503 bytes SHA256 5b7c59bef064a1a95ef23c899aaf367f915bcd19b8078e1aea2e35278896137d; green 1524 bytes SHA256 86cff9cfbbdd3a441af15f882cbe3489d1cdb06e76287ccd040b53d9ea766dec. Обидва знову містять launch-queue.waiting. Нативне розділення потоків exec не надає; повний рядок не видалено й порожній digest не підставлено. Main одержав нові runId/hash для звірки broker (receipt 4ed344d3). До відповіді відповідність новим broker facts невідома; ще одного повтору чи обходу каналу немає. Native L1/L2/L4 та загальний failed 10.5 цією парою не змінюються.
