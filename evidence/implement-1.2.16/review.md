# 1.2.16 — quality у вкладених Vitest projects

Дефект підтверджено та виправлено. Код і власна регресія: `2938ec90a78c532e9112c659b966f6e9576c3560`, база `3356e72258fd8d5f3ed5415566f5ae9121c95ee0`. Пункт актуальний: передача 1.2.11.3 має GREEN без loadedSources та coverage.functions; production на базі передавав quality plugins лише кореневому createVitest. Guards Etchly, профілі продукту, зіставлення шляхів та ліміти не змінені.

## Причини та виправлення

Vitest 4.1.12 `resolveProjects` → `initializeProject` створює окремі Vite servers із plugins конфігурації project. `extends: true` повторно читає configFile, але не успадковує root createVitest overrides. Власна фікстура з реально встановленими pinned Vitest/coverage-v8 (з etchly-develop/node_modules; без інсталяцій) відтворює root control і inline nested project. RED: тести продукту й LCOV FNDA:1 для cachedLibrary/prepareLibrary/cachedListing є, але nested loadedSources порожні.

Додаткова причина у root control: post-transform повертав getCombinedSourcemap як карту власного append-only перетворення. Vite повторно компонував уже об'єднану карту; RED diagnostic зафіксував обидві функції library.ts у LCOV на рядку 1, хоча друга починається на рядку 2. Це незалежно перешкоджало однозначному mapping.

`src/test-run-quality-vitest.ts`:

- `createVitestQualityProjectsPlugin` додає свіжі source/transform plugins до inline project configs перед ініціалізацією їхніх servers; наявні plugins і решта конфігурації збережені. Інші форми project definitions не перебудовуються.
- Transform `createVitestQualityPlugin` повертає `map: null`: початкові рядки transformed code незмінні, додається лише suffix для runtime load observation; наявна sourcemap зберігається без повторної композиції. Хеш combined map і transformed code досі входять у доказ.
- `vitestQualityOptions` додає project injection plugin поряд із кореневими plugins. Невкладений шлях збережений.

LCOV `SF:src/...` успішно зіставляється через execution cwd `app/`; зміна resolver не потрібна. Фікстура перевіряє три mapped functions із hits=1, обидва реально завантажені файли й відмову mapping без load evidence. Це доказ призначених root/inline-project сценаріїв, не універсальна підтримка glob/file/async project definitions.

## RED → GREEN

Стабільна група `adopt-ub-mode-quality-gates/quality-vitest-projects`; файл `test/quality-vitest-projects.test.ts`. Команди, точний відбір, SHA/dirty стан, окремі CLI/child codes та всі стани — [test-summary.json](test-summary.json).

| Прогін | RunId | Результат |
|---|---|---|
| RED | 5b596c37-bfb9-480b-8fbd-7d0ee288b8e1 | assertions-failed, 2 knownRed, CLI/child 1 |
| RED diagnostic | 9832f7cb-584d-4936-9b72-652243ce45c6 | ті самі assertions; додано лише message з LCOV/load facts для встановлення другої причини |
| GREEN | f3ff9cfe-0daa-4cac-8ddb-122131623cbd | 2 passed, CLI/child 0 |
| Наявна quality-vitest-runtime | da5a8bdf-925e-49de-bc26-2b3811c82b41 | 14 passed, CLI/child 0 |

У всіх cleanup.complete=true, remainingPids=[], timedOut=false, timeoutCount=0, unknown/unexecuted=[]. RED: groupState idle, nextAction implement. GREEN: knownRed=[], groupState/nextAction complete. QA HOME визначений raf і однаковий між прогонами; не змінювався для скидання обліку. callerPhase=implement відповідає контексту доручення, phase=red/hotfix відповідає команді.

Незмінені повні `*.TestRunResult.json` скопійовані з названих raf файлів. Stderr дослівно перенесений з видимих stderr-рядків комбінованого tool output в окремі `*.stderr.txt`; CLI codes окремо в `*.cli-code.txt`. Tool обрізав stdout runtime-guards, але повний TestRunResult збережений; його stderr-рядки видимі повністю. Повтору заради stderr не було. Діагностичний повтор RED потрібен для встановлення невідомої причини mapping; setup/import failures не було.

Власна регресія написана до production-fix. Існуючі підготовлені тести прочитано лише після завершення початкової реалізації та першого GREEN; вони не змінювалися. Від red-diagnostic до GREEN власний тест незмінний. Наявна runtime-група перевіряє відмови неуспішного baseline, неповного протоколу, відсутніх load/hash/mapping і класифікацію overlays. Жоден guard не послаблено.

Збірка `HOME=/tmp/raf-unit-1000/1ee10007bf6d5e71b39d6a2873064a767eeb928e7910599b166a0d60270ff685 node scripts/build.ts`: exit 0. `git diff --check`: 0. `openspec validate adopt-ub-mode-quality-gates --strict` у корені Orchestrator: exit 0. Див. [validation.json](validation.json).

## Читабельність і межі

Переглянуто всю змінену `createVitestQualityPlugin`, її transform callback, нову `createVitestQualityProjectsPlugin` з config callback та `vitestQualityOptions`: база й перевірена ревізія наведені вище, точний diff у [production.patch](production.patch). Потік settings → plugins → project configs явний; root та project plugins мають окремі load state maps. Config callback має ранній вихід без projects, залишає сторонні форми визначень незмінними й додає лише instrumentation до копії inline config. Існуюча load/transform послідовність та перевірки private/canonical roots збережені. Map використовується для fingerprint, а не повторного transform mapping. Побічні ефекти читання settings та запису load observations лишилися на наявних межах. Нових UI-підписів, вимог чи ресурсних меж немає.

Читабельність не підміняє поведінкові перевірки: 16 GREEN вище. Окремі crapper/dryer/mutator цим інфраструктурним дорученням не запускалися; числового quality gate для власного коду та реального Etchly baseline/overlays тут не заявлено. Незавершений пілот 1.2.11.4 залишається окремою роботою.

## Передача main

[registry-handoff.json](registry-handoff.json) містить повну передачу реєстру: project raf; profiles.node.unitFiles += test/quality-vitest-projects.test.ts; groups[adopt-ub-mode-quality-gates/quality-vitest-projects] = {profileId:node, files:[test/quality-vitest-projects.test.ts]}. Записи внесено in-place, auto-коміт Orchestrator `149039d1084927029ca770d9bb6385afc0b85fac` уже їх містить; це не власний коміт виконавця.

Власна спроба коміту tasks.md завершилась CLI 128, `.git/index.lock: Read-only file system`, див. [orchestrator-commit-attempt.json](orchestrator-commit-attempt.json). Точний [patch](orchestrator-tasks.patch) збережено. Main у повідомленні цієї сесії підтвердив завершення: tasks.md закомічений ним як `25a31aaaf87d0c9f611fa6534716ec8a84ddcd48`. Цей коміт не записано як власний.

Початкове повідомлення про групу прийняте (receipt 76370818-b294-48eb-9328-6aa98deb9cbe). Наступні спроби повідомити GREEN/реєстр та документний блокер повернули CLI 1 MESSAGE_NOT_ACCEPTED: Recipient composer contains unrelated input, completed=[], pending=[message-acceptance], retrySafe=null; результати й remediation збережені у message-result.json і blocker-message-result.json. Receipt не підтверджує доставку. Пізніше main явно підтвердив у цій сесії, що отримав GREEN-повідомлення й закомітив tasks/реєстр; додаткових спроб доставки не робилося.

Кандидат не активовано. Наступні дії main: приймання/активація hotfix, потім реальний Etchly baseline 1.2.11.4 із перевіркою snapshot identity та overlays. Галочку ставить raf; інші пункти відкриті, archive/sync не виконуються. Чужі файли спільного дерева не комітились.
