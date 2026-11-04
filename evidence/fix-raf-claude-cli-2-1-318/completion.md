# Виконання 1.1 — fix-raf-claude-cli-2-1-318

Власний коміт коду, тестів і первинних доказів: `4f4b6b74958de8705382af5765a1dac11043ef46`.
Main застосував patch конфігурації комітом `1fd13f54cc5e65359cea58c43809392f276f2aa4`; документ протоколу, план перевірок, patch і живі докази закомічені main у root: `0e4c7fc1c3c9c7196fe24f7bb7f17b23ed544ecf`. Це пов’язані коміти main, не власні коміти виконавця.

Документ: `/srv/dev/work/orchestrator/openspec/changes/fix-raf-claude-cli-2-1-318/runner-protocol-evidence.md`. Він містить процедуру, live-рядки, відмінність weekly-only Claude Ultra, історію RED/повторного прогону/GREEN і обмеження першого limits-доказу. Фінальне підтвердження нижче закриває згаданий у ньому запит на QA-прогін.

Фінальний `runner limits --runners claude` виконав main на кандидатові з HEAD, що містить власний коміт коду, 2026-11-04T10:21Z:

- `/srv/dev/work/orchestrator/openspec/changes/fix-raf-claude-cli-2-1-318/main-limits-qa-home-2026-11-04/README.txt` — команда, ізольований HOME/RAF_QA_HOME, CLI exit 0, cleanup HOME.
- Там само `stdout.json`: collected=true, issues=[], all_models weekly used=0.68/remaining=0.32, fable weekly used=0/remaining=1, resetAt=2026-11-05T15:00:00.000Z. `reason=disabled` відображає початковий перемикач Claude у чистому QA state, а не збій збору; перемикач не змінювався.
- `stderr.txt` порожній; STATE_CONTEXT_WARNING немає.

За повідомленням main, перша спроба у чистому QA HOME зупинилася на workspace_trust_required: quotaProbeWorkspace не знайшов raf branch dir і обрав HOME/.raf/tmp/quota/*. Main повторив лише після налаштування довіри в ізольованій копії .claude.json; фінальний README явно описує цю передумову. Це конфігурація стенда, production-алгоритм довіри цим hotfix не змінювався. Модельних запитів ці перевірки не робили.

Початковий limits-доказ `main-limits-2026-11-04/` також collected=true, але містить STATE_CONTEXT_WARNING через робочий state. Його не підмінено ізольованим доказом і не видалено.

Unit-група `fix-raf-claude-cli-2-1-318/claude-protocol`, стабільний QA HOME, той самий відбір двох файлів у всіх фазах:

| Фаза / доказ | runId | CLI / child | passed / knownRed | outcome / наступна дія |
| --- | --- | --- | --- | --- |
| red.TestRunResult.json | f488eddb-059f-418f-890e-11e578e1bb41 | 1 / 1 | 41 / 3 | assertions-failed / implement |
| hotfix-attempt-1.TestRunResult.json | 4c59b84c-ae3e-4259-8cd1-95df02e9ef70 | 1 / 1 | 43 / 1 | assertions-failed / fix-implementation |
| hotfix.TestRunResult.json | 49a109bf-9c58-4651-bc61-fe137ec793b0 | 0 / 0 | 44 / 0 | passed / complete |

Повні незмінені результати скопійовані з broker-файлів; CLI-коди та точні команди у *.cli.json, stderr окремо у *.stderr.txt. Tool output не обрізано. Кожний запуск: cleanup.complete=true, timedOut=false, timeoutCount=0, unexecuted=[], unknown=[]. Фінальний groupState=complete, knownRed=[]. Наявні sampled resourceUsage обмеження не приховані у TestRunResult.

Після GREEN код не змінювався; `git diff --check` пройшов. Власні tmux-процеси і HOME прибрано, cleanup.json зберігає перевірку завершення сервера. `node_modules` — попередній чужий untracked шлях, не доданий до комітів.

Пункт 1.1 виконано. Галочки tasks.md не змінював; пункт 9.1 лишається відкритим для main. Production не активував і зміну не архівував. JSON-звіт виконавця пишеться атомарно за переданим report_path.
