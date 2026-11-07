# fix-raf-lazy-bootstrap-catalog:1.3

Виправлено помилку в `test/missing-catalog-generate.test.ts`: за відсутнього каталогу legacy-очікування вимагали неявної генерації. Чинний контракт і виконаний пункт 1.1 вимагають явної відмови без читання вихідного conf для перебудови. Production-код не змінено.

Аудит: proposal/tasks цієї зміни; projects/raf/state-store, вимога «Захист робочої бази від іншої гілки raf» з усіма сценаріями; projects/raf/cli-catalog, сценарій «Зміна джерела після збірки»; core/process/test-first, включно з дозволом виправлення помилки в самому тесті; core/process/unit-test-runs. Доручення актуальне й відповідає цим джерелам.

Тепер public CLI для help/agent ps без dist повертає `CATALOG_UNAVAILABLE`, код 1 і порожній stdout, не створює каталог чи dist. Прямий bootstrap із відсутнім або пошкодженим каталогом також відмовляє, не викликає handler та не перебудовує артефакт. Збережено позитивні перевірки зібраного каталогу й авторитетності артефакту після вилучення conf, перевірку незмінності пошкодженого JSON; до останньої додано порожній stdout.

`runs.json` містить точні команди, SHA, patch/status незакоміченого workspace, runId, selection, child/CLI exit codes, timeout/cleanup та стан агрегату. `red.result.json` і `green.result.json` — повні незмінені файли TestRunResult із tmp-каталогу запуску; побайтову рівність оригіналам перевірено, SHA-256 збережено в manifest. `*.cli-output.json` зберігає відповідь інструмента; `*.stderr.txt` — доступний повний блок stderr із його об'єднаного виводу. Порядок потоків відповідає інструменту. GREEN stdout в інструменті урізано, повний TestRunResult збережено; stderr не урізано. Повтор заради виводу не виконувався.

- RED `35a4ac80-70f8-4020-9765-673559e8b324`: legacy-файл до виправлення, 1 pass / 3 assertion failures; setup/import failures відсутні. CLI 1, child 1; без таймауту, cleanup complete; knownRed 3, unexecuted/unknown порожні, groupState idle, timeoutCount 0, nextAction implement.
- GREEN `2a953fe0-a617-4e25-b836-48d5b3e15830`: виправлений legacy-файл і незмінений `test/state-migration-lazy-bootstrap.test.ts`, 243 pass / 0 fail (4 + 239). CLI 0, child 0; без таймауту, cleanup complete; knownRed/unexecuted/unknown порожні, groupState complete, timeoutCount 0, nextAction complete. `removed` чесно містить три старі хибні назви, замінені перевірками явної відмови; файл і всі чотири тестові сценарії збережено, покриття corrupt bootstrap розширено.

Стабільна група `fix-raf-lazy-bootstrap-catalog/lazy-bootstrap` і QA HOME однакові між фазами та пунктом 1.1; агрегат не скидався. До node.unitFiles та preset цієї групи in-place додано лише legacy-файл. Автокоміт реєстру orchestrator: `c34e7c2d06a16d26c2fce28989b6c075cf2a63ea`; це не власний коміт виконавця.

Для checks інших уже зареєстрованих raf-профілів перед RED скопійовано повні наявні ізольовані snapshots `.qa-hotfix-candidate` і `.qa-main-baseline` із raf-develop. Вони не виконувалися цим відбором; власні копії прибрано після GREEN. Спільний workspace та QA HOME збережено. Наявний до роботи untracked `node_modules` не змінено. `git diff --check` — 0.

Галочку 1.3 ставить raf за succeeded-звітом. Пункт 9.1 лишається відкритим і поза цим дорученням, тому archive, push і активація не виконувалися.
