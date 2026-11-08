# Діагностика fix-raf-agent-caller-readonly-state:1.1

Результат: **failed / заблоковано до RED**. Production-код не змінено. Підготовлені регресії ще не виконані; вони не є доказом виправлення.

## Причина за кодом і спостереженнями

Базовий workspace: `cfd87ba152800abeedd20790bbaa265ebfe58242`, незакомічені на момент RED зміни лише двох тестів, перелічених у `red-request.json`.

Коміт `e90c0d695bc7b54f0d8844b737bbfa101cbd17e4` виніс контекст stable PreToolUse hook у `RAF_CODEX_RESULTS` та `RAF_CODEX_PUBLICATION` (`regression-origin.diff`). `prepareCodexRafCommandAccess` повертає їх у `environment`, а hook читає `JSON.parse(process.env.RAF_CODEX_RESULTS)` (src/codex-raf-command-access.ts:386–410). Production worker бере лише `codexAccess.invocation` (src/production-runtime.ts:1754–1756); його protocol повертає цю invocation (1804). Tmux adapter також не передає `command.environment` у нову сесію (src/agent-adapters.ts:182–225). Отже, підготовлений контекст губиться у двох місцях. Потрібне наступне виправлення має передати його через обидві межі; caller-verification змінювати не потрібно.

Поточний sandbox не має обох RAF_CODEX змінних (`current-environment.json`). Його `test run` відмовляє з «no registered live caller», а `agent message` звертається до readonly SQLite. Це узгоджується з незапущеним хостовим каналом: команда потрапляє у sandbox, де чинна перевірка не знаходить зареєстрованого caller. Сам stderr падіння hook для історичних запусків не збережений; висновок про місце втрати environment встановлений читанням коду, а не прямим спостереженням винятку JSON.parse.

`timelines.json` містить отримані read-only з state.sqlite identity/часи: обидва невдалі erb-8-3 (5048b808) і erb-4-3 (7baceab4) — Codex; успішні erb-7-4 та erb-8-3b — Grok. Тимчасові каталоги завершених запусків уже видалені, тому повні історичні launch timelines недоступні. Перевірка збережених hook-конфігурацій через native hooks/list в ізольованому HOME дала збіг installed/current hash для обох Codex; доказу stale trust cache немає. Поточний `current-launch-timeline.jsonl` показує завершену публікацію до власної відмови, тому власна відмова не пояснюється раннім викликом до publication.

## Підготовлена регресія

- `test/production-worker-pane.test.ts`: повний fixture worker launch отримує підготовлене environment і перевіряє точну доставку обох JSON значень у tmux pane.
- `test/codex-caller-channel-environment.test.ts`: adapter fixture перевіряє обидва способи запуску (коротка команда й source-file), точні значення з апострофом, session-local передачу як даних без global set-environment.
- До тієї самої групи додані наявні caller/trust перевірки `test/sandbox-test-caller-z400.test.ts` і `test/command-access-trust-cache.test.ts`.

Реєстр: `registry.json`, стабільна група `fix-raf-agent-caller-readonly-state/caller-channel`, профіль `node`. Зміни conf/test-runs.json внесені in-place, їх має закомітити main. Документ відбору та фактичної відмови: `tasks.patch`; галочки не змінені.

## Первинний запит RED

Точна команда, SHA й відбір — `red-request.json`. CLI exit 1, child exitCode null, runId `9931eecf-5c10-4953-9e42-99e9de47d6f5`, outcome refused, CALLER_UNAUTHORIZED. Child не стартував; cleanup.complete true, remainingPids [], timedOut false. knownRed/passed/unexecuted/unknown — порожні, бо відбір не був розгорнутий, а не через успішне виконання. groupSnapshot unavailable, groupState null, timeoutCount null, nextAction fix-setup.

`red.cli.json` — повний незрізаний exec результат, який містить об'єднані stdout/stderr. `red.TestRunResult.json` — повний незмінений JSON рядок з нього; `red.stderr.txt` — решта merged потоку, не окремо захоплений fd stderr. CLI не оголосив `RAF test run result: …`; канонічного tmp артефакту для копіювання не отримано. Це обмеження доказу вказане явно, тому відмова не видається за RED або pass.

Без підтвердженого початкового assertion failure test-first забороняє залежне production-виправлення. Запит не повторювався сліпо; GREEN не запускався. Наступна дія: відновити хостовий канал/доручити той самий відбір виконавцю зі справним каналом; повторити точний RED зі сталою групою та тим самим QA HOME/агрегатом, потім виправити propagation environment і підтвердити hotfix.

## Передача та коміти документів

`message-refusal.json`, `blocker-message.cli.json`: повідомлення main не доставлені, CLI 1, CALLER_UNVERIFIED, SQLite 8 readonly. `root-document-commit.json`: commit власного tasks.md неможливий через Read-only file system для Orchestrator .git/index.lock, exit 128. Це відмова доступу, lock не видалявся. `tasks.patch` містить точний патч; `root-patch-handoff.json` фіксує недоставлену спробу повідомити main шлях патча, ціль і помилку (CLI 1, CALLER_UNVERIFIED, remediation зі штатної відповіді). Атомарний звіт лишається способом передачі результату, без твердження про доставку повідомлення.

## Самоперевірка читабельності й обмеження приймання

Новий код лише у тестах: короткий adapter fixture відокремлено від наявного production worker fixture; два варіанти запускаються однаковим циклом без дублювання. Імена commandEnvironment/largeInvocation пояснюють дані й відмінність сценаріїв. Перевірки йдуть за спостережуваним шляхом prepare → worker → tmux; немає нового production API, timeout чи послаблення caller. Читання кожного тесту не вимагає виводити внутрішню identity з неспоріднених функцій. Предметне приймання незавершене: жоден новий assertion не виконано.

`node --check` обох змінених тестів і `git diff --check` завершилися кодом 0. Це лише синтаксична/форматна перевірка, не unit pass. Завдання 1.1 не виконано; 9.1 не доручено, архівація не проводилася.
