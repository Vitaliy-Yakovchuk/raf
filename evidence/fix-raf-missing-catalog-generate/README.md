# fix-raf-missing-catalog-generate:1.1

Аудит 2026-10-27: задача актуальна; на початковому коді публічний CLI та bootstrap відмовляють за відсутнього `dist/catalog.json`. Межі proposal дотримано; skip_specs=true, нових вимог, таймаутів або лімітів немає.

Спільний читач `readCatalogArtifact` за ENOENT використовує той самий `CatalogGenerator.build` і `productionBindings`, що scripts/build.ts. Наявний каталог читається без звернення до conf; невалідний JSON не замінюється. Ідентичність bootstrap-теки фіксується після синхронної генерації, перед асинхронним dispatch: створення dist не помилково визначається як стороння заміна теки.

## Прогони

Стабільна група всіх прогонів: `fix-raf-missing-catalog-generate/unit`. QA HOME/state не змінювалися; індивідуальні TMPDIR створював runner. Повні незмінені JSON TestRunResult: `*-result.json`; окремі stderr: `*-stderr.txt`; точні команди й окремі CLI/child exitCode: `*-invocation.json`.

| Доказ | runId | Відбір | Результат |
| --- | --- | --- | --- |
| red-result.json | a28928fe-cdef-4abc-a74e-ec3937114422 | missing-catalog-generate | assertions-failed, CLI/child 1/1, 3 knownRed, nextAction=implement |
| hotfix-initial-result.json | c86474c9-f10a-4cc8-9419-73f61a7b7693 | missing-catalog-generate + bootstrap + catalog-generator | 47 passed, 4 knownRed старої bootstrap-фікстури, CLI/child 1/1 |
| hotfix-result.json | 13d9fdc0-362a-4655-977b-bc78c1f6b296 | той самий список трьох файлів | 51 passed, CLI/child 0/0, groupState=complete, nextAction=complete |

Для всіх: timedOut=false, timeoutCount=0, cleanup.complete=true, remainingPids=[], unexecuted=[], unknown=[]. Фінальні knownRed=[]. Повідомлення transport про робочий стан стосуються довіреного broker; command.environment у результатах підтверджує ізольований QA HOME/state тестового дерева.

Первинний red — три цільові assertion-падіння, без setup/import failure. Відтворення через справжній bin відбувається в локальній ізольованій QA-копії з власними conf/Git/state, без провайдерів чи виробничої SQLite. Порівнюються код CLI, stdout/stderr та точні байти артефакту з результатом scripts/build.ts. Додатково перевірено прямий bootstrap і збереження наявного/пошкодженого артефакту.

Перший hotfix уже виправив всі нові регресії. Розширення відбору виявило помилку старого тесту: `test/bootstrap.test.ts` на базовому bd94f0c5ddda9f30446ac82006de20dbabdec532 задає `reportStatuses: []`, хоча чинний `compileCatalog` відхиляє порожні value sources (src/catalog.ts:51,83). Виправлено лише фікстуру одним валідним статусом, без зміни тверджень чи продуктового контракту. Повтор з тим самим списком підтвердив 51/51.

## Відтворюваність

`red-workspace.json`, `hotfix-workspace.json`, `final-workspace.json` містять SHA та повний статус спільного дерева перед відповідними прогонами. Власні зміни коду — відповідні `*-workspace.patch`; незмінна нова регресія — `red-test.ts.txt`. Чужі правки показані як контекст спільного дерева, не включені до власного коміту. `integrity.json` фіксує SHA-256 власних фінальних файлів; `integrity.sha256` дозволяє перевірити їх після коміту.
