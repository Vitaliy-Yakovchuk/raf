# Брифи запуску

raf складає інструкцію з `runners/<runner>.md`, `tasks/<стадія>.md` та конкретного доручення. До кожного брифа raf додає спільну інструкцію `completion.md`. Runner і складність беруться з `conf/models.json`, єдиний словник типів — `conf/raf-constants.json#/agentTypes`; правила затвердження — `openspec/specs/projects/orchestrator/agent-types/spec.md`. Каталоги шаблонів не є окремими реєстрами дозволених значень.

Доручення містить проєкт, адресний ID, межі запису, список змін із вибраними пунктами та їх актуальним текстом, точні релевантні джерела, абсолютний `report_path` і `report_schema`. Загальні інструкції: працювати лише над дорученими пунктами; відповідати власнику українською; давати правдиві результати й докази, залишаючи відмітки доручених через raf --tasks пунктів raf; записати JSON за схемою. Звіт містить `status` зі словника `conf/raf-constants.json#/reportStatuses`, `answer`, результати доручених пунктів із посиланнями на докази. Файл — `<назва-сесії>.json` у tmp-каталозі конкретного запуску; абсолютний шлях і обов’язкову схему задає raf. Звіт обов’язково містить commits: [{repository, sha}] з канонічними дозволеними коренями та повними власними Git OID в ancestry-порядку; checkboxCommits raf до нього не входять. За відсутності власних комітів commits: [] має пояснення в answer. Додаткові поля про сесію дозволені.

Тимчасовий звіт конкретного запуску не є дозволом на архів звітів. Контракт — `openspec/changes/add-raf-agent-run/specs/projects/raf/agent-report/spec.md`; складання та приймання вже реалізовані, а залишок наскрізного QA й узгодження відстежується в активних tasks.md. Актуальні commits, checkbox і порядок останнього пункту — також у complete-raf-flow-contracts/specs/projects/raf/agent-report/spec.md (Z.349, Z.370.1).

Q68: main не запускається через raf; launchableByRaf у каталозі відрізняє обліковувані типи від доступних для запуску. Інструкція tasks/main.md призначена наявному координатору, а не створенню raf-сесії.

Достатність кожного варіанта запуску — вимога «Самодостатній вузький бриф запуску» в `openspec/specs/projects/orchestrator/spec-context/spec.md`: необхідні зараз інструкції, коротка пам’ятка raf із чинного каталогу та точні адреси деталей із поясненням, коли їх читати. Покажчик не є списком обов’язкового читання. Розширення генератора та QA всіх варіантів відстежуються в `add-raf-agent-run/tasks.md`.

Unit-прогони в брифах задавай через `raf test run` за `core/process/unit-test-runs` і `projects/raf/test-runs`. Параметри й семантику бери з `conf/raf-constants.json#/commands` (запис із path `test`, `run`), фази — з `#/agentPhases`, дозволи фаз — із `conf/test-runs.json#/phases`, профілі й налаштовані групи — із `conf/test-runs.json#/projects`. Числові межі читаються лише з `conf/flow.json#/unitTests`; брифи та скіли їх не копіюють.

Форма передачі точного відбору:

```text
raf_command test run --project <project> --phase <phase> --group <change>/<unit-group> --files <file> <another-file>
```

`raf_command` — переданий виконавцю буквальний префікс CLI, не shell-змінна чи новий alias. Без `--files` потрібна налаштована група. Не підставляй теку, glob або повний набір. `--only` застосовуй лише до відомих knownRed IDs цієї групи за результатом wrapper-а; він не поєднується з `--files`.

| Роль | Дія з unit-групою |
| --- | --- |
| test-scaffold | Сам проганяє свої тести з --phase red; передає inventory, передумови й повний TestRunResult |
| main / явно делегований coordinator | Перевіряє й вносить/доручає unitFiles/groups та перевіряє, що red падає на цільовій поведінці; green залишає implement/qa/hotfix; setup/import failure не є red |
| implement | Після незалежної початкової реалізації отримує результат із `--phase implement` |
| qa | Перевіряє з `--phase qa`; для власного дефекту сам проганяє unit-red, потім qa |
| hotfix | Сам проганяє unit-red, потім підтверджує виправлення з `--phase hotfix` |

Назва стабільної групи `<change>/<unit-group>` і агрегат передаються між ролями та SHA без reset; оптимізація відбору не створює нової групи чи нового QA HOME. Червоний прогін виконує сам автор тестів; main прогонів за виконавців не виконує. Інтеграційні та стендові перевірки мають окремий маршрут, unit-wrapper їх не замінює.

У sandbox бриф узгоджує `raf_command`/`raf_subcommands` із фактично дозволеним каналом. `raf_command test run` викликається однією простою командою без env-префікса, cd, конвеєрів, підстановок чи shell-обгорток, із phase/project/workspace/change/group та відбором авторизованого доручення. Для raf-develop/hotfix потрібен перевірений ізольований QA HOME/state/tmp за projects/raf/test-runs.

Зберігай повний незмінений JSON `TestRunResult`, stderr і код CLI окремо від child exitCode; у звіті за наявною report_schema назви доказ, команду, SHA/dirty context, runId, відбір, outcome, cleanup/timeout, knownRed/unexecuted/unknown та стан групи/наступну дію. Лише passed має код CLI 0; неперевірений залишок, transport failure та урізаний/відсутній output не є green. Main використовує отриманий доказ без ручного дублювання штатного прогону.

Чужу unit-регресію implement/qa/hotfix запускає лише у власній фазі за кінцевою декларацією `; regressionGroups=["change/group"]` саме вибраного пункту tasks.md. Launcher перевіряє декларацію з OpenSpec snapshot і зберігає в `launchContext.testAssignment.regressionGroups` sourceChange/sourceItem та configured profileId/files; звичайна згадка, sources, повідомлення чи редагування брифу прав не додають. Чужу зміну не додавай до --tasks або assignment.changes лише заради регресії. Broker дозволяє точну групу, preset або непорожній піднабір його files; --only містить лише knownRed цільової групи й файли цього preset. Project/workspace/branch і фаза незмінні; drift profileId/files або закрита ціль потребують нового перевіреного запуску main. Resume зберігає початковий grant. Прогін використовує звичайний агрегат project/workspace/group і стабільний QA HOME цільової групи з її timeoutCount, in-flight/recovery та залишком; вихідне доручення не скидає цей стан. Дозвіл не розширює звітні items, файлові межі, initial-red або права test-scaffold/spec/design. У доказі назви sourceChange/sourceItem, target group і повний TestRunResult/stderr/CLI code. Стара сесія без grants лишається fail-closed: потрібен новий перевірений запуск.
