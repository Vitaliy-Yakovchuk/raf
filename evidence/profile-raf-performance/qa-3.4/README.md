QA 3.4 — проміжні докази

Адресна unit-матриця: 93 passed, CLI/child 0, без timeout, knownRed, unexecuted або unknown. Група complete, nextAction complete. Команда, SHA та стан workspace: unit-provenance.json. Повний незмінений TestRunResult: timing-coverage.TestRunResult.json. Сирий результат транспорту: unit-tool-result.json. Окремі stderr і коди: timing-coverage.stderr.txt та timing-coverage.exit.json; останній пояснює обмеження об’єднаних потоків exec_command.

Живе приймання очікує host-запуск main; unit не є його заміною. scripts/qa-runtime-timing-host.mjs створює власний стенд через mkdtemp у /srv/dev, чисте оточення, HOME/TMPDIR/SQLite/tmux і before/after клони. Єдиний зовнішній auth-селектор — CODEX_HOME=/home/dev/.codex, без копій auth. Прямі bug list/show читають лише нову локальну базу; мережевий origin підмінено на ізольований loopback.

Запуск на чистому клоні закоміченого SHA з установленими залежностями:

    CODEX_HOME=/home/dev/.codex node scripts/qa-runtime-timing-host.mjs <FULL_REVIEWED_SHA> /srv/dev/work/orchestrator/conf 0605c8563376b1255e302f8a6ccf9060259131df

Скрипт друкує власний каталог /srv/dev/p34-*/summary.json. Сирі команди/коди/stdout/stderr, SQLite до/після та журнал внесків лежать у before/ev і after/ev. Намірені runtime-помилки мають звичайний ненульовий CLI, signal/timeout не приймаються за результат. Аудит INSERT/UPDATE рахує внески EMA; виключені операції порівнюють усю таблицю. Живий native Codex виконує лише очікування на власному маркері; launch EMA перевіряється до й після п’яти секунд життя агента. Завершення вимагає відсутності власних процесів стенду.

Перед переданням main виконано node --check, check:comments та git diff --check. Скрипт у sandbox не запускався: main підтвердив заборону локальних сокетів і запускає reviewed SHA поза sandbox.

До першого host-результату додаткова звірка каталогу виявила помилку setup-скрипта: ANY_RUN — статус admission, а CLI --level приймає normal/hotfix. Обидва сценарії виправлено на normal; це не продуктовий red і не підстава вважати живу перевірку пройденою.
