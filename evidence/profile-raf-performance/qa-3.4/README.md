QA 3.4 — виконано

Unit: 93 passed, CLI/child 0, timeout=false, cleanup complete, knownRed/unexecuted/unknown порожні. Останній runId f791bba5-755c-44a2-9983-19fea09bb799; група profile-raf-performance/timing-coverage complete, nextAction complete. Повний незмінений JSON, stderr, окремі коди й SHA/workspace/команда — у final-unit/. Початковий run 2c3e0757 також збережено без змін у цій теці. Повтор був потрібний через наступні паралельні зміни production-фіналізації QA 2.4; HOME/група незмінні.

Main виконав host-скрипт на чистому клоні 6bea4aa36c63db847c1af2802a5a09b9de900c8e проти baseline 0605c8563376b1255e302f8a6ccf9060259131df. Host CLI=0, summary passed, обидві серії passed. Linux 7.0.0-30-generic, Node v26.12.1, git version 2.53.0, tmux 3.6, codex-cli 0.163.0, 1.14.3. Власні /srv/dev/p34-ErfN4p/{before,after}, HOME/TMPDIR/state/tmux, реальна SQLite й служба. Без auth-копій; єдиний auth-селектор CODEX_HOME=/home/dev/.codex. Main перед переданням перевірив секрети: значень 0, лише літерал CLAUDE_CODE у коді.

Команда host:

    CODEX_HOME=/home/dev/.codex node scripts/qa-runtime-timing-host.mjs 6bea4aa36c63db847c1af2802a5a09b9de900c8e /srv/dev/work/orchestrator/conf 0605c8563376b1255e302f8a6ccf9060259131df

16 живих порівнянь EMA (success/error). Сирі stdout/stderr, команда, CLI-код і SQLite до/після — host/{before,after}/ev/<scenario>.json та .stdout/.stderr; повний TestRunResult без переформатування — test-pass.stdout і test-fail.stdout. Окреме поле cliExitCode не підміняється TestRunResult.exitCode. Реальні фінальні SQLite з audit INSERT/UPDATE — host/{before,after}/home/.raf/state.sqlite; integrity_check=ok обох. Конфігураційні fingerprints і fixture commits — host/summary.json. Хеші копій, перевірка оригінального main-manifest і джерело CLI=0 — host/integrity.json.

| Сценарій | CLI | EMA до → після | wall до → після, ms |
| --- | --- | --- | --- |
| service start success | 0 | 0 → 1 | 2823.2 → 3277.8 |
| service status success | 0 | 0 → 1 | 1049.4 → 1248.1 |
| bug list success | 0 | 0 → 1 | 971.9 → 1348.4 |
| bug show error | 1 | 0 → 1 | 986.2 → 1138.0 |
| test run success | 0 | 0 → 1 | 2988.3 → 3601.0 |
| test run error | 1 | 0 → 1 | 3152.8 → 3932.1 |
| resource wait success | 0 | 0 → 0 | 1309.7 → 1595.0 |
| runner list success | 0 | 0 → 0 | 103.8 → 87.5 |
| runner list error | 1 | 0 → 0 | 108.9 → 93.5 |
| agent run success | 0 | 1 → 1 | 14286.4 → 15090.7 |
| agent run error | 1 | 1 → 1 | 5897.9 → 5766.2 |
| service stop success | 0 | 0 → 1 | 1331.5 → 1340.9 |
| service start error | 1 | 0 → 1 | 1295.8 → 1407.4 |
| service status error | 1 | 0 → 1 | 1188.5 → 1269.1 |
| service stop error | 1 | 0 → 1 | 1531.5 → 1313.3 |
| resource wait error | 1 | 0 → 0 | 1430.5 → 1162.0 |

Висновки: усі прямі service/test/bug гілки перейшли з 0 на 1 EMA-внесок за завершення. Agent run зберіг 1 внесок на успіх і duplicate error. Після спостереження реального native actor хост чекав 5 секунд і перевірив running та незмінну EMA; це видно також у тотожних agent-run.after та agent-duplicate.before. Маркер створив actor, а force-close штатно прибрав його run directory. Help/parser залишили SQLite невідкритою до main attach, а help/parser/resource wait у відкритому стенді не змінили жодного EMA-рядка. Bug list/show читали лише нову локальну базу; production-жуків не змінювали.

Test payload pass: CLI/child 0, outcome passed, knownRed=0, group complete/complete. Test payload fail: CLI/child 1, outcome assertions-failed, knownRed=1, group idle/implement — це навмисна помилка власної одноразової фікстури. В обох серіях timeout=false, cleanup complete, unexecuted/unknown порожні. Для основної unit-групи продуктового red немає.

Cleanup обох стендів підтверджено: service stopped, main tmux kill CLI0, worker tmux kill CLI1 (сервер уже завершено), /proc не містить живих процесів із cwd усередині стенду, remainingProcesses=[], complete=true. Всі перевірювані runtime-помилки дали звичайний CLI1 без signal/timeout.

Перша спроба e806178 завершилась setup-помилкою власного скрипта: ANY_RUN є статусом admission, а --level приймає normal/hotfix. Код 1 і complete cleanup збережено в host/attempt-1/. Фікстуру виправлено на normal у 6bea4aa; це не продуктовий red. Нових продуктових дефектів у 3.4 не знайдено. Syntax, check:comments і diff-check скрипта пройшли.

Межі висновку: по одному wall-заміру на живий випадок; це доказ семантики обліку, не доказ прискорення. Незавершені фіналізації профілю у QA 2.4, про які повідомив main, не закриваються цим пунктом. Усі доручені живі сценарії 3.4 виконані; інших відкритих живих сценаріїв цього пункту немає. Інші задачі зміни залишаються відкритими, тому sync/archive не виконуються. Галочку 3.4 ставить raf.
