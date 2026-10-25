# complete-raf-flow-contracts:9.7

Сценарій `scripts/qa-shared-libs-live.mjs` запускає main на хості з чистого клону raf-develop. Аргумент — повний SHA цього клону. Біля клону має бути копія актуального `conf/`, у клоні — залежності `node_modules/`. `CODEX_HOME` має вказувати на вже авторизований Codex; секрети не копіюються. Модель та effort обирає production routing без змін.

Команда: `node scripts/qa-shared-libs-live.mjs <reviewed-full-sha>`.

Скрипт створює власний `/srv/dev/cfc97-*`, окремі HOME/RAF_QA_HOME/tmp/tmux/SQLite та Git-репозиторії з main/develop worktree. CLI main attach/agent run/ps/service викликаються з **raf-develop** через власну зареєстровану main-панель. Ізоляція не змінює ledger unit-групи. Налаштування ресурсів, моделі, effort, timeout і guards не послаблюються; локальна довіра обмежена коренями стенду. У власному product fixture tasks.md лишається 1.3, щоб актори не архівували стенд.

1. `usesSharedLibs=true`: справжній etchly implement на develop виконує helper через свій native sandbox tool; той пише marker через symlink у shared-libs-develop та комітить тільки marker. Хост перевіряє реальні writeBoundaries, reported-commits repositories, точний Git-коміт, reportAcceptance і checkboxCommit raf.
2. `usesSharedLibs=false`: наступний запуск на тому самому HOME/state після зміни лише конфігурації etchly. Та сама бібліотека доступна для читання, але прямий шлях/symlink/git-dir/common-dir мають відхилити запис з EROFS/EACCES/EPERM. Shared-libs відсутня в writeBoundaries/repositories, її HEAD незмінний. Власний marker etchly комітиться і приймається.
3. Cleanup закриває тільки власні адреси, власну службу/сокети, перевіряє exit PID. Репозиторії та докази лишаються для огляду. Невідомі команди не повторюються; відсутні сценарії або cleanup error означають failed.

На stdout одразу друкується шлях стенду й доказів `ev/`. Кожна команда зберігає повні stdout/stderr, CLI exit, signal/error; probe окремо має exit дочірніх Git. `summary.json` містить checks/unexecuted/cleanup; `*-accepted.json` — прийнятий результат SQLite, `*-run/` — початковий бриф/контекст і звіт актора. Прогін не є unit і unit-виняток timeout до нього не застосовується.

Аудит: 9.5/9.6 закриті; чинні workspace-routing «Робоче дерево за проєктом і гілкою» (same-branch та usesSharedLibs=false), agent-adapters «Виконавець комітить свою роботу», quality-assurance «Ізольований живий QA develop» узгоджуються з 9.7. Продуктовий код не змінювався на стадії підготовки. Галочку 9.7 ставить raf лише за підсумковим валідним succeeded. Інші пункти відкриті, archive не застосовується.
