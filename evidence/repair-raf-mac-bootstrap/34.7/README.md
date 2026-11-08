# repair-raf-mac-bootstrap:34.7

Аудит backup `7f51a91727ca85c8bbc859bf2a69713644231f85` проти hotfix `fe2b91e5a6464883fde338145bdbadb3436f9305`: усі доручені виправлення вже присутні. Production-код і тести не змінювалися. Повторного merge/cherry-pick немає: доручення прямо забороняє дублювати вже перенесені виправлення. Main прийняв цей маршрут, попросивши поіменний аудит. Його початкове повідомлення отримало receipt `44ac7870-f50c-4cf8-b3f6-ffea0ff12b29`, accepted=true.

## Кожен source-коміт

Повні OID, ancestor assertions, файли та SHA256 містить [audit.json](audit.json). Production-патч кожного джерела збережено окремим `*.production.patch`.

| Backup | Уже в hotfix | Місце та рішення |
| --- | --- | --- |
| 314cf45 | 00a9761 (34.5) | `src/brief-guide.ts:composeBriefGuide`, discoversRecipients/recipientGuidance: виконавці пишуть main напряму; main/coordinator зберігають discovery. Поточний файл ідентичний backup. |
| bb468b3 | 00a9761 (34.5) | `src/test-run-runtime.ts:createTestRunPorts`, selectedFiles/profiles: request files/only/group визначають профілі preflight для всіх проєктів. Поточний файл ідентичний backup. |
| 4f9b36c | 00a9761 (34.5) | Там само, prepareTemporary: realpathSync configured temporary root. |
| 50197d2 | 5612a4b (34.1) | `src/test-run-unit-state.ts:prepareUnitTestState`: realpathSync('/tmp') перед expectedHome. Файл ідентичний backup. |
| 23d84a6 | 5612a4b (34.1) | `src/test-run-runtime.ts:runConfiguredTestRun`, unitContext: канонічний /tmp перед unit HOME. |
| 1083b7d | 5612a4b (34.1), locale 00a9761 | `test-run-darwin-process.ts`, `test-run-processes.ts:reconcileTestRunProcess`, `test-run-resource-process.ts:observeReservedTestTree/testWrapperIdentity`, runtime processStart/processTree/settleKilledProcesses/spawn/reconcile. Усі файли крім darwin-process ідентичні backup. Єдина відмінність darwin-process: hotfix повторно використовує ідентичні darwinBoot/darwinStart із resource-wait-identity; backup дублює їх. LC_ALL=C/TZ=UTC присутні в обох ps викликах. |
| 5e5aecc | 32abcae | `src/test-run-diagnostics.ts:prepareRunTemporaryDirectory`: root-owned symlink повторно inspect за realpath з чинними ownership/socket/protected-context перевірками. Файл ідентичний backup (backup merge вже прибрав коментар). Наявний тест на root-owned alias із цього hotfix-коміту включений до GREEN. |
| f860421 | a09de8b (34.6) | `src/app-runtime.ts:launchAgent`: обидва features ?? [] у activity та brief. Решта відмінностей файлу — новіші launch-timeline/routing snapshot зміни hotfix; їх не відкочували. |
| 6f26ac7 | a09de8b (34.6) | `src/state-migration-darwin.ts:processes` приймає signed UID; `src/archive-events-runtime.ts:settleArchiveEvents` читає reminder pages чинним iterator. Обидва файли ідентичні backup. |
| 73acfff + 709d283 | не потрібні | Другий коміт повністю скасував перший. Перевірено порожній diff `73acfff^..709d283 -- src/task-context.ts`; поточний файл ідентичний backup. |

[remaining-production.diff](remaining-production.diff) фіксує тільки описані відмінності app-runtime й винесення Darwin-парсерів. Серед перелічених виправлень відсутніх немає. Не переносили сторонні evidence чи інші зміни backup. Наявні RED докази: `../34.5/red.TestRunResult.json`, `../34.6/red.TestRunResult.json`, `../../fix-raf-macos-tmp-symlink-root/red.TestRunResult.json`; новий RED без нового дефекту не створювали. Початковий production-аудит завершено до читання підготовлених тестів, їх твердження збережені.

## Перевірка

[Повний незмінений TestRunResult](green.TestRunResult.json), [команда](green.command.txt), [CLI code](green.cli-exit-code.txt), [спостережений stderr](green.stderr-observed.txt), [межі stderr](green.stderr-note.txt), [сирий результат інструмента](green.tool.json).

Стабільна група `repair-raf-mac-bootstrap/mac-test-run-fixes`, усі 18 налаштованих файлів: runId `39c1263b-132e-4120-9a11-ab45042b4fae`, passed, 395 passed IDs, CLI 0 / child exitCode 0, timedOut=false, cleanup.complete=true, remainingPids=[], knownRed/unexecuted/unknown=[], timeoutCount=0, groupState/nextAction=complete. Ізольований QA HOME збережено у command.environment повного JSON. Запит мав phase hotfix; результат зберігає phase=hotfix і callerPhase=implement (роль цього виконавця).

Tool обрізав комбінований output; JSON скопійовано з названого raf файла, без реконструкції та повторного прогону. Попередження конфігурацій інших проєктів збережені. Resource measurement partial/unknown чесно лишено в повному JSON; це не видається за native Mac чи безперервне resource profiling.

Ревізія перевірки — [head.txt](head.txt); до запуску власних code/test правок не було. [workspace-status.txt](workspace-status.txt) містить нові власні evidence та два чужі untracked документи fix-raf-hotfix-role-brief, яких не торкалися. `git diff --check` завершився 0, tracked diff порожній. Додатковий build для evidence-only коміту не потрібен. У реєстрі всі 18 файлів уже є: project raf, unitFiles additions=[], groups additions={}, in-place запис не потрібен; main немає чого комітити в conf/test-runs.json.

Darwin-native перевірки не повторювали на Linux; наявні джерела й обмеження описані в `../34.5/README.md`, розділ Darwin. Linux GREEN включає native Linux tree cleanup та mocked Darwin identity/locale controls. Нових функцій, лімітів або змін Linux-поведінки немає.

## Читабельність і завершення

База й перевірена production-ревізія однакові: fe2b91e5a6464883fde338145bdbadb3436f9305, власні production-функції не змінені. Область обов'язкової самоперевірки доданого/зміненого коду порожня. У межах предметного аудиту додатково простежено явні recipient branches, profile selection, canonical parent → inspect → private reservation → cleanup та Darwin platform branches. Спільні Darwin-парсери зберігають один контракт без дублювання; підстав переписувати ці компоненти немає. Збереження поведінки підтверджено повною групою.

Галочку 34.7 ставить raf. Пункти 4, 12, 31.3 лишаються відкритими, архівація не виконується. Push та активація належать main.
