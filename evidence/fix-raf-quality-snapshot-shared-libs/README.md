# fix-raf-quality-snapshot-shared-libs:1.1

Аудит proposal.md/tasks.md і чинного коду підтвердив актуальність дефекту; суперечностей із дорученням немає. Виконано лише 1.1. Активація та архівація (1.2/1.3) залишаються відкритими.

`configuredSharedLibraries` бере гілку workspace, `usesSharedLibs`, корінь бібліотек та назву посилання з `conf/projects.json`. Дозволяється canonical realpath бібліотек саме цієї гілки. `snapshotWorkspace` матеріалізує залежності з node_modules і shared-libs у приватній копії, зберігає canonical realpath, SHA-256, роль і режим у manifest. Seal повторно звіряє realpath та байти; транспорт дозволяє зовнішній root лише для dependency. Інші виходи й цикли відхиляються. Звичайний tracked-каталог усередині workspace не обходиться вдруге.

## Перевірки

Повні незмінені TestRunResult, точні команди, ревізії, blobs власних незакомічених правок, відбір, CLI-код окремо від child exitCode та стани груп є в [summary.json](summary.json). Кожний результат скопійовано з файла, названого raf у stderr; execution.json зберігає вивід інструмента.

| Доказ | Outcome | Passed / knownRed | runId |
| --- | --- | --- | --- |
| red.TestRunResult.json | assertions-failed | 5 / 5 | dd95ffca-4e0d-45d5-bbf3-de4061cadef1 |
| green.TestRunResult.json | passed | 10 / 0 | cb94dbcd-3fe4-470c-b569-695a68a560b4 |
| transport.TestRunResult.json | passed | 77 / 0 | 0ea6639f-befa-4c2b-9c0f-fddc7c57aad5 |
| vitest.TestRunResult.json | passed | 14 / 0 | 096481fb-8b4e-40bc-be9f-214609d2a72d |
| local-red.TestRunResult.json | assertions-failed | 10 / 1 | 47f67776-66a1-42f8-8460-4a52918bb662 |
| final-green.TestRunResult.json | passed | 11 / 0 | 4b9fae39-d4b1-476f-8301-1ab86062a141 |

Початковий RED отримано до змін production-коду: саме відмова дозволеного node_modules-маршруту та tracked shared-libs. Перевірки циклів спочатку також падали, бо обхід передчасно відхиляв дозволений корінь. Додатковий local-red відтворив дублювання звичайного tracked-каталогу перед виправленням, знайденим самоперевіркою. Останній GREEN підтвердив усі 11 сценаріїв. Existing transport/Vitest перевірено їхніми власними налаштованими групами; подальша зміна стосувалася лише відбору symbolic shared-libs для додаткового обходу і покрита останнім GREEN.

Усі прогони: timedOut=false, cleanup.complete=true, remainingPids=[], unexecuted=[], unknown=[], timeoutCount=0. Одна стабільна власна група й незмінний QA HOME. Фінальний groupState=complete, nextAction=complete, knownRed=[]. Вивід local-red обрізаний інструментом; це явно позначено у summary/execution, повний TestRunResult збережений. Решта stderr збережена повністю. Наявні попередження конфігурації інших проєктів та operational observer збережені; вони не є setup failure цих тестів. RAM/disk attribution має заявлену самим raf часткову повноту, що не видається за повну телеметрію.

## Самоперевірка читабельності

База фактичних прогонів: b79d58d0903da999362fc8a0955db871b520bffe (переданий assignment base: 4a5724a632dd6c57c73609c2cd4bbd56378a4047). Перевірюваний стан — власні правки в implementation.patch та фінальні blobs у summary.json; це вміст коміту, що містить цей доказ.

- `src/test-run-quality-runtime.ts:52 configuredSharedLibraries`: одна дія — перетворити налаштовані project/branch routes на canonical root і link. Ранні повернення для проєкту без shared-libs чи відсутнього branch mapping; немає виведення гілки з basename або приймання довільного сусіда.
- `src/test-run-quality-runtime.ts:65 snapshotWorkspace`, локальний `walk`: явні roots, перевірка дозволеного realpath перед читанням, ancestors для циклів, окремі гілки directory/file. Запис inputs видимий у тілі обходу. Додатковий обхід стосується symbolic link, тому tracked local inputs не дублюються.
- `src/test-run-quality-runtime.ts:103 createQualityRuntime`: переглянуто весь компонент; новий шлях даних явний у snapshot callback — конфігурація, snapshot, Map canonical paths, dependency digest. readCurrent перевіряє збережений шлях, не шукає кожний файл лінійно в масиві. Manifest зберігає realpath поруч із хешем. Наявні порти копіювання, cleanup, coverage і finish збережені.
- `src/test-run-quality.ts:251 prepareQualityExecution`: іменована ознака sharedDependency дозволяє простежити єдиний доданий виняток; перевірки safe path, унікальності, байтів, production source, baseline та private copy залишаються на основному шляху.
- `test/quality-shared-libs-runtime.test.ts:16 fixture` і сценарії: локальні Git/QA/config fixtures, іменовані options, явна підготовка/cleanup. Перевіряються власні байти копій, canonical manifest, зміна digest, неправильна гілка, сусід зі спільним prefix, nested escape, usesSharedLibs=false та два види циклів. Чужі тести не змінювалися.

За цими ознаками потік входів, альтернативні гілки та записи стану простежуються без пояснювальних коментарів або нових UI-елементів. `git diff --check` успішний. Поведінкові докази наведені вище; читабельність не видається за окремі числові quality-gates чи live-пілот etchly.

## Передача метаданих

Коміт власного tasks.md в Orchestrator отримав CLI 128: `fatal: Unable to create '/srv/dev/work/orchestrator/.git/index.lock': Read-only file system` (orchestrator-commit.execution.json). Main отримав адресне повідомлення, receipt aef74a2d-5ed7-4fb1-b0e9-691e48998df2, та закомітив метадані від імені frqs-1-1: 537d74a9740bbc76f3e7e95d034b9b7860e73e1d. Точний патч — orchestrator-tasks.patch. Реєстр груп збережений main у 6d87173859a5711275578df8a75263617ad79a04. Галочки виконавець не змінював. Наступна дія main — приймання й активація за 1.2.
