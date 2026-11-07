# repair-raf-mac-bootstrap:34.6

Виконано тільки 34.6 у `raf-hotfix`, база `4a5724a632dd6c57c73609c2cd4bbd56378a4047`.
Тести додано й первинний RED виконано до зміни production-коду. Завершений GREEN перевіряв робочі правки поверх цієї бази; точні SHA256 і Git blobs — [source-manifest.json](source-manifest.json), diff — [green.workspace.diff](green.workspace.diff). Після RED у тесті app-runtime додано тільки TypeScript type assertions/import; твердження поведінки не змінено.

## Перегляд і актуальність

Перевірено proposal Why/What Changes/Impact, tasks:34.6 та наявний код. Завдання актуальне: всі три дефекти відтворено, суперечностей чинним контрактам не виявлено. Повні переглянуті коміти збережено: [f8604216](mac-f8604216.patch), [6f26ac74](mac-6f26ac74.patch). Спочатку об’єкти були відсутні, а SSH ls-remote відмовив через права системного ssh config; main отримав їх у shared store. Зміни Git transport або SSH configuration не виконувалися.

- `f8604216d6b9deab30ab692410c678b9a8d7595d`: два nullish defaults у `src/app-runtime.ts`, щоб відсутній необов’язковий `--features` давав порожні features в activity та brief. CLI-регресія перевіряє успішний запуск, обидва порожні списки й один start; наявні тести з явними features лишилися GREEN.
- `6f26ac74cb42c4bb1280c9751d4b466b7d1e71ce`: `src/state-migration-darwin.ts` приймає знаковий UID із Darwin ps, зберігаючи перевірку safe integer, відбір власника й descriptor inspection. Окремі тести перевіряють quiescent та incompatible при наявності foreign UID -2. Наявні тести unknown/malformed/changing identity також GREEN.
- Другий фікс цього коміту належить `src/archive-events-runtime.ts`, а не reminder-cli: archive observer використовує чинний `iterateDatabaseTable` (keyset pages по 50), потім відбирає pending/active та archive bindings. Перенесено Mac-регресію: потрібний binding після 121 closed і 64 інших live reminders; одна archive event і всі 186 записів збережені. Повний `archive-without-reminder` перевіряє решту поведінки observer.

Усі три production-файли байтово збігаються з відповідними файлами переглянутих Mac-комітів (asserted blob equality у manifest). Schema version, migration procedure, Linux process inspector, ліміти й timeout не змінено. Darwin inspector викликається чинним Darwin branch у `src/state-migration.ts:33`. Спільні виправлення зберігають потрібну Linux-поведінку; переповнення archive read та відсутність features тепер обробляються коректно.

Mac-коміт містить авторський опис Darwin перевірок і live migration 18→20 у `evidence/mac-state-migration-20261107/README.md` (включено в patch). Це джерело автора, а не незалежно повторений тут native прогін: цей виконавець працював на Linux з ін’єктованими Darwin snapshots; production migration або активація main не виконувалися.

## RED → GREEN

Стабільна група обох прогонів: `repair-raf-mac-bootstrap/mac-test-run-fixes`, збережена з 34.5; QA HOME однаковий в обох повних JSON. Новий HOME для скидання агрегату не створювався.

| Прогін | runId | Результат | CLI / child | Група / nextAction |
| --- | --- | --- | --- | --- |
| [RED](red.TestRunResult.json), [команда](red.command.txt) | `8aeedc21-5950-42b3-b6f1-e530baa236c5` | assertions-failed; 63 passed, 4 knownRed | 1 / 1 | idle / implement |
| [GREEN](green.TestRunResult.json), [команда](green.command.txt) | `37f882aa-6423-439e-9536-4ed5ee6d59ff` | passed; 391 passed, 18 повних файлів | 0 / 0 | complete / complete |

RED відтворив `params.features is not iterable`, два помилкові unknown замість quiescent/incompatible та `DB_ROWS_READ_LIMIT_EXCEEDED: 65 > 50` у тілі тесту. Setup/import failures немає. У RED та GREEN: cleanup.complete=true, remainingPids=[], timedOut=false, timeoutCount=0, unexecuted=[], unknown=[]. У GREEN також knownRed=[]. Повний незмінений TestRunResult скопійовано з названих raf файлів, а не відновлено з урізаного stdout. CLI codes збережені окремо від child exitCode.

Tool output обрізано; [red stderr](red.stderr-observed.txt), [green stderr](green.stderr-observed.txt), пояснення меж збереження в `*.stderr-note.txt`, комбінований спостережений output у `*.tool.json`. Обрізання stdout не є доказом pass: pass встановлено за повним green.TestRunResult.json. У stderr є наявні попередження чужих конфігурацій і активного main archive observer; вони не замінені твердженням про чистий stderr. Прогони заради stderr не повторювалися.

[Build](build.json), [comment policy](comments.json) і [diff check](diff-check.json) завершилися 0. Build/comment scripts виконувалися з тим самим ізольованим QA HOME; під час unit-прогонів HOME/state/tmp надавав raf. Інших unit-прогонів не виконано.

## Самоперевірка читабельності

Область: зазначена база → manifest поточних робочих правок (власні коміти до перевірки не створювалися). Переглянуто цілі змінені production-компоненти за core/process/modularity-and-reuse; окремого автоматичного числового висновку про якість не заявляємо.

- `src/app-runtime.ts:createAppRuntime/launchAgent`, рядки 220–370: відповідальність запуску та послідовність validate → task → route → select → prepare/compose → reserve/start → verify/commit залишаються явними; nullish defaults локально визначають дані activity/brief. Потік помилок, compensation і resource cleanup збережено; залежності подані через наявні ports. Нова абстракція чи прихований стан не потрібні. Збереження поведінки підтверджено повним app-runtime.test.ts.
- `src/state-migration-darwin.ts:processes`, рядки 22–40: snapshot → parse pid/owner → safe integer/duplicate checks → account filter → identity validation → Map. Розширено лише формат foreign owner; негативний UID не проходить як поточний власник. Потік даних і fail-closed гілки читаються без нової вкладеності. Повні тести inspector перевіряють quiet, holder і unknown.
- `src/archive-events-runtime.ts:settleArchiveEvents`, рядки 45–105: читання reminder pages → відбір live archive bindings → archive snapshot → enqueue events → prune/close effects. Явний цикл із early continue заміняє запит/flatMap; iterator має одну наявну реалізацію в database-read-limit.ts. Немає дублювання pagination або нового side effect. Повні archive tests перевіряють binding за першою сторінкою, один event, retention та observer без reminder.
- Додані тести використовують наявні fixtures; новий archive test має власну тимчасову SQLite й try/finally cleanup. Назви описують сценарій та очікуваний результат; production-виклик виконується до перевірок.

Предметних невідповідностей читабельності в межах цих змін не виявлено. Приймальний перегляд коду й активація належать main; self-review не видається за незалежне приймання.

## Передача документів і межі завершення

Перший виклик commit port відмовив на каталозі замість explicit files; наступний — на чужому snapshot symlink `.qa-live-latency/.../fonts`. Код/індекс не комітилися. Main перемістив чужий fixture поза shared tree й підтвердив повтор коміту; чужі файли виконавець не видаляв.

Git root Orchestrator відмовив у власному docs commit: [точна команда й помилка](root-commit-error.json), CLI 128, `.git/index.lock: Read-only file system`. Main отримав [точний patch](orchestrator-tasks.patch) і шлях `openspec/changes/repair-raf-mac-bootstrap/tasks.md`; [доставка підтверджена](main-handoff.tool.json), receipt `ff0bd891-af44-4cbc-bca5-817696c52ad2`. Main підтвердив docs commit `6cf8334711e0fc5abfd63429d36eeafadf2f5c21`; registry committed separately `3f59d3739dac92908fafc7c388deeab85befb0b7`. Це коміти main/автоматики, не власні commits цього виконавця.

Checkbox 34.6 виконавець не змінює. Інші відкриті пункти 4, 12, 31.3 не входять у доручення; зміна не архівується. Push, активація main та live migration до повноважень цього запуску не належать.
