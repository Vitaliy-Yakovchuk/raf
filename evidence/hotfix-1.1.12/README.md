# 1.1.12 — worker launch snapshots

Доручення актуальне: живий теплий raf-overhead після 98928360 — 3345 мс; proposal/tasks і live-after-1.1.11 узгоджені. Власний production commit: `28256dabaf6220ad2c91aa4e4c424bb35e5a576e`, база `98928360b16e8eecf8fe2f63fa3057b0933221e8`. Початкова реалізація завершена до читання підготовлених тестів. Потім власний regression RED виконано з відновленим старим складанням inspection args; інші незакомічені правки на RED — приватні часові мітки. [workspace.json](workspace.json) містить SHA-256 фінального коду/фікстур до коміту.

## Поведінка

`runProductionWorker` використовує наявний `withProcessObservations` окремо для handoff, кожної ownership перевірки і started reconciliation. Один pass має один OS process snapshot і один pane snapshot замість повторних targeted ps та обходу предків через окремий ps на кожен PID. У known-identity ownership прямий observeKnownProcesses замінений observeIdentity, який бере цей самий snapshot. Boot, PID/start time/command, pane ID, ancestry, lease/fence та durable state guards залишені. Snapshot до доставки не переноситься на перевірку після доставки; delivery waits і poll loops не обгорнуті спільним pass.

`prepareCodexRafCommandAccess` переносить --no-daemon із runner invocation до app-server inspection. Він зберігає конфігурацію і зупиняє відбір на --; hook hash, timeoutSec та synchronous delivery перевіряються як раніше. Це усуває розбіжність режиму процесу; окремого доведеного виграшу wall time саме від прапорця немає. Нових лімітів, таймаутів, polling чи користувацьких елементів не додано.

Додані приватні worker-runner-probe, worker-store-ready, worker-reservation, worker-sandbox і lifecycle-publish timestamps. Shared fixture лише додає наявні додаткові інтервали до diagnostics; попередні assertions/затримки/бюджет не послаблено.

## Фікстура і межі

Використано попередню live-volume fixture: 107 active changes, tasks.md разом 2 077 992 байти, selected tasks.md 223 419 байтів; telemetry.noticeSeen=true; 406 historical + п'ять реально запущених active sessions, 486 notices, 416 reminders, 335 intents. Поле size у shared diagnostic описує початковий seed; planningVolume.state містить фінальні більші counts. Runtime conf має попередні безпечні fixture overrides. Це не побайтова копія живого HOME чи конфігурації; живий запуск цей доказ не замінює.

Production main CLI, справжні worker/tmux/sandbox, реальний Codex app-server для hook inspection; native status/прийняття brief синтетичні з незмінними затримками. Вимір шостого запуску після п'яти occupancy agents — теплий. Raf-overhead = wall − readiness − delivery. Живий повтор і активація — main.

| Етап, мс | RED без batching | Фінальний GREEN |
| --- | ---: | ---: |
| Raf-overhead | 2507.746 | **2612.747 < 3000** |
| assignment | 484 | 469 |
| admission | 151 | 181 |
| admission → worker | 245 | 233 |
| worker → command-access | 231 | 186 |
| reservation handoff | 129 | 54 |
| command-access | 264 | 279 |
| lifecycle | 188 | 223 |
| settle | 110 | 101 |

Різні прогони мають різне навантаження: загальний wall time не доводить прискорення порівняно з RED. Структурно усунено повторні process queries; handoff став 54 мс проти 129, але живий виграш потребує повтору main. Зростання lifecycle видно чесно, не приховане відніманням runner time.

## Прогони

Усі команди: `node /srv/dev/work/orchestrator/raf-main/bin/raf.ts test run --project raf`, незмінна `--group fix-raf-cli-live-latency/live-latency`. QA HOME визначав raf, не змінювався. Повні *.TestRunResult.json — незмінені копії файлів, названих raf. CLI codes окремі від child exitCode.

- RED: `--phase red --files test/worker-launch-latency.test.ts`, run `90a4b71a-17ac-49ce-a4d5-c5ff87a23ce4`, assertion відсутнього --no-daemon, CLI/child=1, один budget test passed. [red.TestRunResult.json](red.TestRunResult.json). Stderr відновлений із повного stderr tool output; stdout інструмент обрізав.
- Green-1: `--phase hotfix --files test/worker-launch-latency.test.ts test/production-runtime.test.ts test/production-runner-readiness-qa.test.ts test/production-codex-delivery-qa.test.ts test/codex-raf-command-lifetime.test.ts test/task-reservations.test.ts`, run `21067fec-3e25-45b3-978d-ea4bef483394`. 115 passed, один assertion failed у власній новій фікстурі: вона додала другий --no-daemon до вже наявного і Codex відхилив дубль. Власний зайвий args override прибрано; assertion daemon mode та trusted hash збережений. Outcome assertions-failed, CLI/child=1; це не pass відбору. Решта 114 dependency перевірок passed. [green-1.TestRunResult.json](green-1.TestRunResult.json), [green-1.tool-output.txt](green-1.tool-output.txt); combined tool output обрізаний, повного stderr цього прогону інструмент не зберіг. Повтор заради stderr не виконувався.
- Фінальний GREEN: `--phase hotfix --files test/worker-launch-latency.test.ts`, run `8e2ffa0a-ea54-42f2-9905-f5abad0eb591`, **2 passed**, outcome passed, CLI/child=0. [green-final.TestRunResult.json](green-final.TestRunResult.json), [green-final.stderr](green-final.stderr). knownRed/unexecuted/unknown=[], groupState=complete, nextAction=complete, timeoutCount=0, timedOut=false, cleanup.complete=true, remainingPids=[]. Resource completeness partial/unknown не є доказом точного піку.

Перший виклик RED помилково був у shell-команді разом із записом tasks.md; sandbox відмовив CALLER_UNAUTHORIZED (CLI1, child=null, run b33e2e19-b33a-40a5-8ae4-9da27b7086a1, no registered live caller). Жоден тест не виконувався, це не RED. Наступний виклик був окремою дозволеною простою командою й дав зазначений вище справжній RED; обхід sandbox не застосовувався.

## Читабельність і передача

Самоперевірка від base до production commit: prepareCodexRafCommandAccess, runProductionWorker handoff/ownership/lifecycle, verifyLiveStateBudget diagnostics і нова regression fixture. Inspection args обробляються явними гілками з межею --. Handoff явно захоплює перевірений lease, отримує wrapper і повертає результат; зміна lease видима у присвоєнні. Known-identity ownership розгорнуто з одного довгого рядка на послідовні durable identity → observation → pane guard → result; cold discovery branch зберігає наявні candidate/ancestry guards. Кожен snapshot має межу одного виклику, не приховане довгоживуче кешування. Diagnostic helper має лише побічний ефект додавання stageMs; тест перевіряє реальний hook і прибирає власні файли через попередній fixture cleanup. Build та git diff --check пройшли; поведінкові докази вище.

[registry-handoff.json](registry-handoff.json): project raf, profiles.node.unitFiles та groups[fix-raf-cli-live-latency/live-latency].files += test/worker-launch-latency.test.ts; внесено in-place перед RED, коміт спільного реєстру — main. [tasks.patch](tasks.patch) — точний власний документний diff, вже внесений in-place, без зміни галочок. Власний root commit відмовив із Read-only file system для .git/index.lock, CLI128; [orchestrator-commit.json](orchestrator-commit.json). Це відмова доступу, lock не видалявся. Main має закомітити документ. Пункт 1.1 відкритий; архівація не застосовується.

Передача main з SHA/результатами/registry/tasks.patch відхилена: MESSAGE_NOT_ACCEPTED, CLI1, Recipient composer contains unrelated input; completed=[], pending=[message-acceptance], retrySafe=null. [message-failure.json](message-failure.json). Фактичне прийняття не підтверджено; без сліпого повтору. Атомарний JSON є передачею результату raf, але не підтверджує доставки повідомлення main.
