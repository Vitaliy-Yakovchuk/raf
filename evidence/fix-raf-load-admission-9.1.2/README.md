# fix-raf-load-admission:9.1.2

Виконавець raf-fla912-hotfix. Аудит 2026-10-24: доручення актуальне. `proc.txt` вихідного інциденту та власний assertion-red підтверджують зависання після зникнення tmux. Вимога recovery для справжнього обриву процесу (`complete-raf-flow-contracts/specs/projects/raf/agent-control/spec.md`, сценарій «Справжній обрив процесу») дозволяє фіналізацію мертвої сесії без `--force`. Суперечностей із чинним flow не виявлено. Інші пункти залишаються відкритими; архівація не застосовується.

## Виправлення

`944fa92a9f61bc55fee2e20d199d37f01458d29a` переносить тільки `session-closed` у глобальну hook-опцію tmux із фільтром `hook_session_name`. Цільові pane-died/pane-exited hooks лишаються на сесії: вони зберігають контекст природного завершення pane. Підписка передує перевірці стану; очищення прибирає лише власні індексовані hooks. Немає періодичного опитування або нових таймаутів.

`ps` показує pending worker як окремий рядок із `reconciliation.code=WORKER_RESULT_PENDING`, поточним станом і причиною, зберігаючи інші рядки та резерв worker. Інші помилки не поглинаються. `close` мертвої running/exited сесії з `--force` і без нього використовує recovery, зберігає прийнятий failed-звіт і не надсилає команди мертвому tmux.

`6ea5bf9f617f6bb247c022c12c51f9cc4958e42b` оновлює лише авторський production-стенд: raw TTY, native /status, pending paste і Working замість спрощеної фікстури, яка не проходила readiness.

## Власна unit-регресія

Стабільний відбір усіх прогонів: `--project raf --group fix-raf-load-admission/worker-idle --files test/agent-adapters.test.ts test/agent-control.test.ts test/launch-wrapper.test.ts`. Повний префікс і команда кожного запуску — у відповідному `*.capture.json`. HOME й агрегат незмінні; джерело таймауту — `conf/flow.json#/unitTests/timeoutMs`.

| Доказ | runId | Фаза | Outcome | CLI / child | Passed / knownRed | Група / наступна дія |
|---|---|---|---|---|---|---|
| red.json | 7ffa27f8-12bb-4606-8c28-61d844950737 | red | assertions-failed | 1 / 1 | 76 / 8 | idle / implement |
| hotfix-first.json | 429dac54-aa2d-4df2-8954-1dbdd0e537a5 | hotfix | assertions-failed | 1 / 1 | 80 / 4 | idle / fix-implementation |
| hotfix.json | 33aa893c-d96b-4245-90f3-cd3d602510c8 | hotfix | passed | 0 / 0 | 84 / 0 | complete / complete |
| hotfix-pane-scope.json | 9e8282d9-83b8-41f6-a836-c50af42dc799 | hotfix | passed | 0 / 0 | 84 / 0 | complete / complete |
| hotfix-final.json | abd78b5d-9cc1-4124-88b9-78dedd15b17c | hotfix | passed | 0 / 0 | 84 / 0 | complete / complete |

Усі п'ять результатів повні: `timedOut=false`, `cleanup.complete=true`, `remainingPids=[]`, `unexecuted=[]`, `unknown=[]`, `timeoutCount=0`. Зберігаються повні TestRunResult, окремі stderr і capture з CLI exit code; child exitCode походить із TestRunResult. Додатковий pane-scope результат транскрибований із повного CLI-виводу; остаточна перевірка спирається на безпосередньо збережений hotfix-final. Workspace SHA на момент прогонів — `346506087cc401f0992245af2f39b134a276649d`, незакомічені зміни — `*.workspace.patch` та red.workspace.json. Остаточна різниця після hotfix-final — лише видалення пояснювального коментаря для comment-policy перед успішною збіркою.

Red містить власні 8 assertion failures, а не setup/import failure: session removal waiter, два wrapper lifecycle сценарії зі звітом/без, ps pending worker, чотири dead-close комбінації. Перший hotfix лишив чотири shape failures (`forcedClose: undefined`); виправлено source, твердження не послаблено. Фінальний прогін містить успішні чинні Z.4.1 тести з цього ж призначеного файлу, а також попередні worker-idle bounded-command/environment тести.

## Реальний tmux

`tmux-red/summary.json`: baseline `3465060` зависає на kill-session і kill-pane до чинного transitionMs=10000. Natural pane-died отримує код27, але baseline також прокидається на чужу сесію (2 команди); тому весь baseline CLI1.

`tmux-green/summary.json` зберігає невдалий проміжний варіант із глобальними pane hooks: видалення сесії/pane виправлено, природне завершення зависає. `tmux-green-final/summary.json`: kill-session50мс, kill-pane52мс, natural pane-died75мс, усі три CLI0; 0 команд у простої та 0 команд через чужу сесію. Власні hooks прибрано, власні tmux servers і fixture видалено. Джерело timeout — `conf/raf.json#/runnerProtocols/codex/timeouts/transitionMs`.

## Відхилені setup-спроби

`stand-red/` — sandbox EACCES на service IPC до запуску сценарію. `stand-host-setup/` — перша спрощена фікстура не проходила native readiness. Обидва CLI1 є setup failures, не assertion-red і не pass. Після них виправлено фікстуру та передано повторний процесний запуск main; sandbox не обходився.

## Інші перевірки

`build.stdout`, `build.stderr`, `build.cli-code`: `node scripts/build.ts`, ізольовані HOME=RAF_QA_HOME, CLI0 (включає перевірку comment-policy). `git diff --check` — CLI0. Task checkboxes виконавець не змінював. Код не активовано й не відправлено push.

## Production-стенд і жива доставка

`bc0fbbe0fbedee4cc4289519063884540978fa61` виправляє лише preflight авторської фікстури: `codex sandbox` делегується справжньому Codex із тими самими аргументами й кодом завершення. Native UI запускається лише на TTY. Реальний preflight не підмінено. `stand2-setup/{red,green}` зберігають попередній TypeError setRawMode під час preflight; це setup, не red/green продукту.

`parallel3.redacted.json`: три паралельні запуски справжнього Codex на `6ea5bf9` (product source тотожний `944fa92`) — 3/3 accepted, CLI0, fixture cleanups completed. Відредагований витяг містить ідентичності процесів і SHA-256 вихідних файлів; сирі кадри та розгорнуту native команду не включено. Джерело — main, `/srv/dev/f912-stand2/parallel3`. Доставка Z.4.1 не погіршилася.

`build-final.*`: повторна збірка після `bc0fbbe`, CLI0. Зміни після фінального unit-прогону — comment-policy та авторська фікстура, product behavior не змінено.

`stand3-clone-setup/` — запуск із clean clone без sibling conf завершився ENOENT до fixture. Main додав копію штатної conf і повторив запуск; цей запис є лише setup evidence.

`stand3-status-setup/` — sandbox preflight проходить; native readiness не завершився, бо synthetic UI не відображав набраний `/status`. `d1473ec087b362350553878f337f405006504cd8` додає echo composer перед Enter за зразком чинного production-codex-delivery-qa. Це fixture-only виправлення, product source той самий. Build/diff-check CLI0 (`build-status-fixture.*`).

`check-exit-ui.mjs` / `.result.json`: локальна перевірка точної згенерованої UI-фікстури у власному tmux server — /status echo, Enter, 20177 pending, 20178 після першого Enter, Working після другого; CLI0, cleanup власного server/fixture. Це fixture smoke, не заміна unit чи production worker stand.

`stand4/red`: валідний процесний assertion-red на `3465060`, readiness пройдено, runnerExited=true, workerExited=false після 10067/10040мс, CLI1. `stand4/green` на `d1473ec` CLI1: обидва worker завершилися за 2424/1220мс, result failed/finished, резерви порожні, hooks прибрані. Failed лише idle (4 команди, 1–2ticks), бо вимір почався ще до blocking wait-for під час startup ownership перевірок. Це не pass. `067daa42511199744cea2eb5ec869484f1ba3600` додає marker фактичного wait-for перед виміром idle, не змінює product і не послаблює поріг 0команд/≤1tick.

## Остаточна процесна перевірка

`stand5/`: main запустив зі clean clone `067daa42511199744cea2eb5ec869484f1ba3600`, копією штатної conf (`stand5-conf.json`), окремими HOME=RAF_QA_HOME у /tmp, LC_ALL=C і штатним resource admission. Команда — `node /srv/dev/f912-stand5/clone/scripts/qa-worker-exit.ts <revision> /srv/dev/f912-stand5/<phase>/evidence`; revision SHA записаний у кожному summary. Повні stdout/stderr/CLI code, summary і traces збережені. Run IDs: exit-report, exit-missing.

Red на `346506087cc401f0992245af2f39b134a276649d`: readiness пройдено; обидва runnerExited=true, workerExited=false за 10078/10048мс при transitionMs=10000, CLI1. Обидва мають 0 команд і 0 CPU ticks за 1с простою. Це валідний поведінковий red.

Green на `067daa42511199744cea2eb5ec869484f1ba3600` (product source `944fa92`): CLI0, passed=true обидва; workerExited=true/runnerExited=true, report 2840мс, missing 1216мс. У кожному finished/failed, порожні task/admission reservations, власні hooks прибрані; cleanup «owned fixture processes stopped and fixture removed». Обидва мають 0 команд/0 CPU ticks за 1с простою, як baseline 9.1.1. Тому виправлення вкладається у чинний timeout conf без polling і не погіршує CPU.

Доставка підтверджена окремим живим parallel3 (3/3 accepted), product source відтоді незмінний. Пункти 4.3 і 7.1 зміни ще відкриті: tasks.md не змінено, архівація не виконується.
