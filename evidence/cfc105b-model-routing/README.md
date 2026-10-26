# complete-raf-flow-contracts:10.5 — запуск raf-cfc105b-qa

Адресат `raf-cfc105b-qa`, run `1481e82f-87cc-4931-bfd4-d9ab421808a7`, 2026-10-26, raf-develop HEAD `112e1908df9592ba065901e4c15e3ae2a3a6799e` (на старті; незакомічений чужий `scripts/qa-agent-adapters-native-refusal.ts` не чіпався). Попередній запуск цього ж доручення `9f5ab8d1-7983-46ba-b5f6-85694fe52cba` не стартував: «Runner readiness timeout» (відкритий hotfix Z.432 робочої raf). Галочку 10.5 ставить raf. Попередні докази `evidence/cfc105-model-routing-current/` (integration red/green, host cfc105h1) не повторювалися, лише використані з посиланням.

## Автоматичні прогони цього запуску

Префікс `node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/90734334-b607-48d3-afc1-1ab42e1f8ad6/raf-main/bin/raf.ts`, далі:

| Доказ | Команда | runId | CLI / child | Outcome |
| --- | --- | --- | --- | --- |
| `integration-green.*` | `test run --project raf --phase integration --group complete-raf-flow-contracts/model-routing-integration` | `7ae5d97a-16ff-4de9-976d-f14fde1e6db2` | 0 / 0 | passed 3/3 (I1/I2, I3, I4); knownRed/unexecuted/unknown порожні; groupState complete, nextAction complete |
| `unit-qa.*` | `test run --project raf --phase qa --group complete-raf-flow-contracts/model-routing` | `18c6a9ef-c1e5-4523-b90e-e3b225995a0f` | 0 / 0 | passed 63/63 (U1–U6); knownRed/unexecuted/unknown порожні; complete |

Обидва: timedOut=false, cleanup.complete=true, remainingPids=[], timeoutCount=0, QA HOME `/tmp/raf-unit-1000/8b186c55…` той самий, що в попередніх прогонах групи. `*.TestRunResult.json` — перший рядок незміненого виводу; `*.stderr-extracted.txt` — решта (рядок `launch-queue.waiting`); `*.transport.json` — повний вивід із транскрипту сесії та SHA256. Інструмент Bash об'єднує stdout/stderr, нативне розділення потоків недоступне. Код CLI 0 для обох видно з `exitCode` інструмента (помилки не було). Unit-результат не замінює живих сценаріїв.

## Живий production-доказ (робоча raf, не стенд)

`agent-ps-0259.sessions.json` — санітизований витяг `agent ps` (CLI 0, 2026-10-26T02:59Z; повний вивід 3.9 MB, SHA256 `e95e7bf6a4756f317f0e8e285a128c123e5bce31bc15d536a260ed335d9fbbde`, не комітиться через розмір і чужі брифи). Збережено лише addressId/runId/state, selection, process identity, виконуваний файл, observation і launchedBy; argv/settings/токени не збережено.

- **L1 claude**: ця сесія — робоча raf `28ad8b81efa0453cb761e6fec81204725919c823` (покоління 90734334, предок develop HEAD) запустила `/home/dev/.local/bin/claude`, встановлена версія `2.1.310 (Claude Code)` (налаштована 2.1.308 — лише попередження за Z.335), у tmux session `a088cb58-…`, pane `%58`. Selection `claude` / `claude-opus` / `high`, причина «Selected claude-opus on claude for decision by configured policy and catalog order; quota unknown». Process PID 897435, startedAt 02:57:01Z; native ID `3f8ee426-80a9-4409-9594-4841050b8091`, призначений raf через `--session-id`, збігається з `CLAUDE_CODE_SESSION_ID` процесу. Бриф `brief.txt` 41865 B, SHA256 `a553529a81263ca950c97b6106fdf4f142c055449d637a3669a4d561b51ae178`; звіт — `report_path` цього запуску. Другий незалежний claude-запуск — `etchly-agl32-impl` (run 4390d639, native 87e74510-…). Прийняття цього звіту raf відбувається після його запису і тут не заявляється.
- **L1 codex**: 8 живих production-сесій codex `gpt-6.1-sol`/`high` з native UUID і tmux (той самий знімок) плюс прийнятий звіт host cfc105h1 (`../cfc105-model-routing-current/host-cfc105h1/assessment.json`).
- **Зміна моделі для того самого пункту**: 10.5 раніше виконував `raf-cfc105-qa` (run f782ada8, native `01a17533-…` — формат codex, звіт failed за записом main у tasks.md). Новий запуск того ж незавершеного пункту — інший CLI/модель (claude-opus), новий runId, native ID і report_path; бриф без resume містить лише 10.5 і посилання на попередню спробу. Причина переходу (complexity decision від main чи стан runner) і факт фіналізації f782ada8 зі знімка не встановлюються — запитано в main (receipt `13a00343-c1ac-4f4f-8da9-3ff63036ede6`).
- **Одна команда ввімкнення claude**: `conf/models.json` має claude `initialEnabled:false`, а production запускає claude-opus — отже стан змінено командою. Рівно одну команду в production не перевірено; в ізольованому стенді cfc105h1 рівно одна `runner enable --runner claude` → 0.

## L2 claude: живе вимкнення в робочій raf (виконав main)

На запит (receipt `13a00343-c1ac-4f4f-8da9-3ff63036ede6`) main у робочій raf (покоління 90734334) виконав: `runner disable --runner claude` rc=0 о 03:03:07Z → `{"runner":"claude","enabled":false}`; `runner list` rc=0 — обидва claude-рядки `enabled:false, available:false`, reasons «Runner disabled or absent from catalog», «Quota unknown»; `runner enable --runner claude` rc=0 о 03:03:13Z; повторний list — `available:true`, reasons лише «Quota unknown». В обох list присутнє попередження «версія 2.1.310 не збігається з перевіреною 2.1.308, протокол не перевірено» (Z.335). Незмінені копії — `main-L2/` (SHA256 збігаються з `/srv/dev/cfc105L2/`; secscan main 0, власний grep token/secret 0). Rc зафіксовано зі слів main, файли містять лише stdout.

Після цього `agent ps` (CLI 0, 03:03:55Z; повний вивід SHA256 `69d72fcdd7bfe57e35417d8a04c2f1f141cc0eaf4b02dcdc85db445654c36983`, витяг `agent-ps-after-L2.sessions.json`): моя сесія `alive`, `process` (PID 897435, startedAt, runnerSessionId, tmuxSession) і `observation.identity` незмінні, selection/activity/launchedBy незмінні; у launchContext додано лише `flowTestRuns` — записи двох моїх test run. Усі 11 сесій першого знімка живі з тим самим process. Нового claude-запуску з відмовою main не робив: за вимкненого claude маршрутизація могла б запустити агента на іншому runner. Тож «наступний старт заборонений» для claude підтверджено лише станом list (available:false з причиною), фактичну відмову `NO_ENABLED_MODELS` доведено для codex на стенді cfc105h1.

Одна команда ввімкнення: за main остання `runner enable` у command_timings — 2026-10-22T20:09:37Z, без назви runner і без rc. Рівно одну команду в production не доведено; на стенді cfc105h1 — рівно одна, rc 0. Повторне ввімкнення 03:03:13Z однією командою повернуло обидві каталожні claude-моделі.

## Broker-записи test run

`broker-flowTestRuns.json` — записи raf для двох прогонів у моєму launchContext. `resultDigest` збігається з SHA256 `*.TestRunResult.json` (2f97e543…, da82ce7f…), `stderrDigest` — з SHA256 `*.stderr-extracted.txt` (b2c7f066…, b1d1c1e6…), cliCode 0 обидва.

## L4: перехід codex → claude для 10.5

За main: попередник `raf-cfc105-qa` run f782ada8 — process.runner codex, native `01a17533…`, запуск `--complexity decision`, selection у launchContext null; state finished, finishedAt 2026-10-26T00:30:22.571Z, abortReason «tmux kill-session failed: can't find session …», без successor — фіналізований. Потім спроба 9f5ab8d1 (readiness timeout, без брифа) і цей запуск 1481e82f: claude-opus за актуальною політикою для decision, новий runId/native ID/report_path, лише незавершений 10.5, без resume. Це живий перехід між CLI після фіналізації. Межа: перехід не спричинений підтвердженим лімітом моделі; автоматичну передачу після справжнього ліміту (L3→L4) не спостерігали.

## Що лишається відкритим

- grok 1.0.67 та agy (встановлено 1.4.7, налаштовано 1.4.5): у `conf/raf.json` немає `native.identity`, запуск відмовляє «Pre-brief native identity evidence is unavailable» до брифа (host cfc105h1; Q.4.1.3 відкритий). Живого L1 для них немає.
- Фактична відмова нового claude-запуску при вимкненому claude та точне число production enable-команд.
- L4, спричинений справжнім лімітом; повна матриця I5; конкурентні production-координатори.
- Претензія host-стенда cfc105h1 щодо claude `unknown_screen`: стенд ізолює HOME без селектора auth/onboarding для claude (лише CODEX_HOME). За Z.427 у такому середовищі claude 2.1.310 показує onboarding «Let's get started»; екран cfc105h1 не збережено, тож причину не встановлено. Production-доказ вище замінює цей шлях для L1 claude; стенд не змінювався.
- Z.427 (попередження замість відмови версії в quota probe) є лише в гілці hotfix (`3f1b4a7`), у develop `src/quota-collection.ts:180` досі строгий gate — зворотне злиття hotfix→develop за main.
