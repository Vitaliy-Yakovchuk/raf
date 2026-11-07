# Hotfix 1.1.2 / 1.1.3

## Результат і причина

1.1.2: відтворено втрату integration-класифікації через помилкове подвійне членство трьох `worker/src/domain/concepts/import-plan-{lease,red,taxonomy}.test.ts` у `vitest-worker.unitFiles` та `vitest-worker-integration.integrationFiles`. `validateProfileInventories` пропускає весь дубльований профіль і його preset; явний `concept-answer-analysis.test.ts` після цього обирає unit fallback за cwd. Це пояснює `vitest-worker`, `unit` і GROUP_PROFILE_MISMATCH із раніше виконаним integration-агрегатом. В історичному TestRunResult оригінальна відмова виникає до child. Нові тести без child etchly перевіряють фактичний план для обох фаз, точний файл, profileId/testKind і джерело integration-політики.

Копія RED — адресна проєкція попереднього реєстру `3c5d1358c9~1:conf/test-runs.json` (повний SHA у workspace.json). Залишено два профілі, потрібне подвійне членство, обраний файл і його preset. Незмінена копія RED збережена як registry-red.json. GREEN-фікстура містить виправлене членство й один реальний unit-файл для непорожнього контрольного unit-профілю; окремо ті самі assertions читають поточний живий conf. Живий конфіг для RED не відкочувався. Main виправив реєстр у `3c5d1358c9`; власних змін класифікатора або кешу не потрібно. Diff `3b61e5b^..3b61e5b` для src/test-runs.ts, src/test-run-runtime.ts і src/test-run-integration-profiles.ts порожній; відтворення доводить достатність дефекту конфігурації, а не причинність активації кешу. Живі etchly integration-сценарії тут не запускались.

1.1.3: `catalogWithBriefPhases` у src/catalog-brief-phases.ts формує значення phase лише для agent run із заявлених фаз, що мають файл `.md` у conf/briefs/tasks. CatalogGenerator.build і buildCatalog застосовують одну реалізацію до публікації артефакту. Parser і help використовують той самий масив; red без брифа повертає INVALID_VALUE на етапі arguments, з expected, без виклику handler. Додавання red.md дозволяє red після rebuild, видалення знову відхиляє; директорія integration.md і red.txt не є брифами. Загальний agentPhases та test run --phase red не змінені. Нових таймаутів чи службових повідомлень немає. Активацію виконує main після звіту.

## Test-first і результати

Стабільна група: `fix-raf-cli-live-latency/profile-and-phase`. Команди, CLI codes і stderr — у відповідних *.command.txt, *.cli-code.txt та *.stderr.txt. CLI code збережено окремо від exitCode дочірнього runner у повних незмінених *.TestRunResult.json. Stderr виділено з об’єднаного виводу інструмента; повідомлення скопійовані дослівно. Для розширеного прогону інструмент обрізав stdout JSON, але файл TestRunResult скопійовано повністю, stderr містив усі чотири warning і адресу артефакту. Обрізаний stdout не використовувався як доказ pass.

| Прогін | runId | CLI / child | Результат | cleanup / timeout | knownRed / unexecuted / unknown | group / nextAction |
|---|---|---|---|---|---|---|
| RED | aea08896-9f5d-4523-8160-ed507bdaaef7 | 1 / 1 | assertions-failed: 4 цільові падіння, 2 current-conf passed | complete / false | 4 / 0 / 0 | idle / implement |
| GREEN, нова регресія | 6a49ebf8-76b8-4f72-a312-51d986105e4a | 0 / 0 | passed, 6 | complete / false | 0 / 0 / 0 | complete / complete |
| GREEN, розширена група | e6af9a32-3a9d-48e4-b81f-8d7b9dbf16a8 | 0 / 0 | passed, 75 | complete / false | 0 / 0 / 0 | complete / complete |

В усіх прогонах timeoutCount=0, QA HOME той самий (workspace.json), без скидання агрегату. Початковий RED — assertions, не setup/import failure. Розширена група містить новий файл та bootstrap/catalog-generator/cli-catalog. Базовий SHA, стан незакомічених правок і SHA-256 власних файлів зафіксовані у workspace.json. Повний власний commit OID подається у JSON-звіті; за цією ревізією відтворюються GREEN-входи.

## Читабельність і аудит

База — `07ef547a4ac16caf8cb610a3c573500508cf6d07`, перевірена ревізія — власні правки у workspace.json та коміт звіту. Область: вся catalogWithBriefPhases, CatalogGenerator.build і buildCatalog, нові регресійні тести. Потік явний: прочитати task-файли, зібрати їхні ID, відфільтрувати фазові значення лише agent run, передати той самий результат parser/help, серіалізувати атомарно за наявним контрактом. ENOENT каталогу дає порожній список фаз; інші файлові помилки не приховуються. Вхідний каталог не змінюється. Читач бачить гілки й повернення в одному короткому компоненті; спільна логіка має одного власника, без дублювання у двох builders. Unit-перевірки підтверджують поведінку обох builders; git diff --check пройшов. Аудит предметних tasks/proposal і чинного контракту не виявив суперечностей: 1.1.2 та 1.1.3 залишаються дорученими, виправлення main враховано, інші пункти не виконувались.

## Передача Orchestrator

Власний коміт tasks.md спочатку відхилено read-only кореневим Git: orchestrator-commit-error.txt (exit128). Точний patch — orchestrator-tasks.patch; реєстрація — registry-handoff.json. Main підтверджено отримав повідомлення (main-delivery.json, receipt 073eef41-8c14-4335-9cc2-03fdc4b79b1e), закомітив і запушив реєстр та tasks.md у `fe142620455ebbf6e37ca5ced8d168b35ec349ce`. Блокер доставки/коміту документів усунутий; цей чужий коміт не входить до commits виконавця. Галочки не змінювались. Інші пункти зміни відкриті, archive не виконується.
