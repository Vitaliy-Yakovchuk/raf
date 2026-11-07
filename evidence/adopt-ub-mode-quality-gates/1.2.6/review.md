# Hotfix 1.2.6: кандидат quality transport

Виконано тільки `adopt-ub-mode-quality-gates:1.2.6`. Аудит proposal (Why/What Changes/Non-goals), tasks і design-raf-quality-transport не виявив суперечності: quality runtime відсутній у hotfix, окреме доручення дозволяє його перенесення. Пілот Etchly, установка provider, QA 1.3 та активація не належать цьому пункту. Інші задачі відкриті; tasks.md не редаговано, archive не застосовується.

База hotfix до власних змін — `00a9761ae398515b789567aa572f9173455a03ce`, що включає main `3db25a4a104692c7cfbc3cc9aeb1ce4ab28b20e4` та завершене 34.5. За узгодженням main/rrmb файл src/test-run-runtime.ts змінено лише після коміту 34.5; його realpath/TMPDIR/locale поведінка збережена. Чужі зміни production-runtime, resource-usage-runtime, close-archived-change-bugs та індекс не комітилися.

## Межі перенесення

Взято точні source hunks `a2cdbb20a018a2e4c4d7473ae16ddd9747e171c2` та `99bb1b9f00400e0bb54b4e0a09a23e99c43f1190`, залежний test/contract scaffold `583d05c8ad7427bcab30b82c0f2d2b93db95c5a8`, Vitest test scaffold `0573efa841efed707b97730eb3b5ced00a250b4e` у фінальному вигляді 99bb1b9. Решту develop не переносили. Звичайний patch check не збігся контекстом src/test-runs.ts/src/test-run-runtime.ts; застосовано чисте тристороннє злиття конкретних файлів без зміни спільного індексу. Докази: source-node.patch, source-vitest.patch, source-scaffold.patch, transfer-code.patch.

Тести збережено без послаблення: overlay test бере вже виправлене в a2cdbb2 порівняння snapshot (Buffer/Uint8Array), Vitest test — версію 99bb1b9 без scaffold-коментарів. Жодних нових вимог, timeout/resource лімітів, UI або профілів не додано. conf/test-runs.json не змінено: обидві unit-групи, integration preset та inventory вже зареєстровані.

## Test-first і докази

Повні незмінені `TestRunResult` скопійовано з названих raf artifact-файлів. `*.command.txt`, `*.cli-exit-code`, `*.head.txt`, `*.tool-output.json`, `*.stderr-observed.txt` зберігають команди, CLI code та доступний merged вивід; stderr-observed містить лише видимі stderr-рядки з явним маркером неповноти. Інструмент обрізав merged stdout/stderr; це явно позначено, повні JSON не обрізані. Child exitCode наведено незалежно в кожному JSON і runs-summary.json. `mac-regression` artifact знайдено за точним runId у tmp, бо маркер шляху потрапив у вилучену частину merged output; результат не перезапускався.

| Доказ | runId | Результат | passed / knownRed |
| --- | --- | --- | --- |
| transport-red.json | e93ec9ad-8842-4482-a99a-4c4f9d039636 | assertions-failed | 1 / 76 |
| vitest-red.json | 13b459f8-1f60-4f29-9aa6-3b236904345d | assertions-failed | 0 / 14 |
| transport-green.json | aa40a839-8db6-408a-9031-fe84f5c06042 | passed | 77 / 0 |
| vitest-green.json | 59493aa2-0cf5-44ef-acbf-80801265a423 | passed | 14 / 0 |
| integration-green.json | f0786186-fbf0-4a49-a1f6-b660ddcf6bf3 | passed | 7 / 0 |
| selection-regression.json | 67ff2783-c05b-4c4a-abb1-6fed1093cb2b | passed | 91 / 0 |
| mac-regression.json | 489e1b48-049f-48d6-bf2e-06473ef9d19f | passed | 321 / 0 |
| transport-final.json | 6e1b9246-c181-491c-84c2-ddeb58939fe3 | passed | 77 / 0 |
| vitest-final.json | 67f49797-67fe-4fa7-b8d7-908aed1542ca | passed | 14 / 0 |
| integration-final.json | 046de080-280a-450a-b3de-6ed7533e6362 | passed | 7 / 0 |

RED transport виконувався на перенесеному scaffold до реалізації: відсутній parser flag/NotImplemented і перевірки відсутнього результату дають цільове assertions-failed, не setup/import failure. Scaffold і тести закомічено `3229e9dcc69edb2c031afd5c0bb02eb93b5b3dc7`. Vitest RED виконувався після Node runtime, перед 99bb1b9: pinned Vitest adapter відхилявся, що викликало 14 assert.doesNotReject падінь. Код 99bb1b9 ще не був застосований.

Для всіх прогонів timeoutCount 0, timedOut false, cleanup.complete true, remainingPids [], unexecuted/unknown []. CLI/child 1 для RED і 0 для GREEN. RED groupState idle / nextAction implement; GREEN complete / complete. Групи та QA HOME незмінні між RED/GREEN, фазами й SHA. Unit-команди використовували red/hotfix; runtime — окрему integration фазу. Чужі регресії виконано їхніми власними налаштованими групами raf, без додавання їх до доручення.

Первинні GREEN та суміжні регресії перевіряли байти exact donor runtime: tested-files.json і tested-workspace.diff на HEAD scaffold-коміту. Після предметного спрощення читабельності фінальні 14+77 unit і 7 runtime виконано на закоміченому `576494595a66c3fa1b22a4f25575b7b14c2e5aa6`; final-tested-files.json, final-own-code.diff (порожній) та final-workspace-status.txt фіксують власні чисті файли й чужий dirty стан. Повторення було потрібне саме через це спрощення; суміжні регресії повторно не запускали, їхній звичайний шлях не змінювався.

build-final.command.json/stdout/stderr/cli-exit-code: штатний npm run build на тому самому ізольованому QA HOME — 0. import-smoke.*: import production-entry.ts та production-runtime.ts — 0. final-config-inputs.json зберігає SHA-256 конфігурацій і dist/catalog.json. Попередній build також 0. git diff --check — 0.

## Самоперевірка читабельності

Область: усі власні додані/змінені компоненти від бази 00a9761 до 5764945. Адреси та предметний висновок:

- src/test-run-quality.ts:215 parseQualityRequest та :250 prepareQualityExecution: недовірені дані проходять перевірку структури/byte spans, snapshot/baseline, selector і лише тоді створюється copy; ports явно позначають читання й видалення. :303 verifyQualityCoverage повертає provenance decision окремо від числових coverage фактів.
- src/test-run-quality.ts:322 classifyQualityRun: пріоритет timeout/interruption/refusal/setup/compile/assertions видно з явних гілок. Початкові вкладені ternary для outcome, reason, nextAction розгорнуто; :373 recordQualityObservation так само явно встановлює aggregate.state. Немає прихованих присвоєнь у виборі результату. recoverQualityCopies видаляє тільки власні terminated copies.
- src/test-run-quality-runtime.ts:20 selectTypeScriptQualitySites, :50 snapshotWorkspace, :82 createQualityRuntime: selector, snapshot та runtime ports мають окремі відповідальності; qualityContext явно передає provenance й owner. Роль input вибирається явними гілками, copy directory/file writes розгорнуто в послідовні дії. Замикання finish/cleanup належать одному prepared run; зовнішній протокол явно передає result/events і termination. Гілки Node/Vitest зберігають pinned profile.
- src/test-run-quality-vitest.ts:10 supportsVitestQuality, :18 verifiedVitestLoads, :30 parseLcov, :55 mapVitestFunctionCoverage, :79 createVitestQualityPlugin, :132 vitestQualityOptions: профіль, input/transformed/load evidence та mapping розділено; consumer не відновлює внутрішній стан іншого компонента. Loader src/test-run-quality-loader.ts прямо спостерігає resolve/load. Єдина реалізація кожного adapter, без паралельного compatibility шару.
- src/test-runs.ts/runTestRun, src/test-run-runtime.ts/createTestRunPorts, src/test-run-etchly.ts/runVitestBatch: quality увімкнено лише за qualityRequest/settings; існуючі lifecycle, timeout, profile та canonical accounting збережені. Protocol, formatter, recovery та profile validator переносять quality/compile факти через чинні контракти. Тести/fixture називають перевірювані входи й результат; assertions не змінено.

readability-refinement.patch показує всі відмінності нових quality компонентів від 99bb1b9: лише розгортання гілок/ефектів і назва qualityContext. До спрощення 77+14+7 GREEN, після — 77+14+7 GREEN. Це самоперевірка виконавця; предметне приймання main має оцінити ті самі адреси. Пілотні метрики CRAP/dryer/mutator і справжній Etchly/Vite provider цим не оголошено перевіреними.

## Передача main

Кандидат не активований. Main виконує обов'язкові справжні CLI agent ps/message і service start/readiness/stop, звірку clean candidate/config/artifact fingerprint та атомарну публікацію за workspace-routing. Мій allowlist дає тільки live agent ps/message/test run; smoke запусків/зупинок служби не виконував. Production import smoke є лише частиною gates. Чужі незакомічені файли у shared tree зафіксовані; їхнє подальше включення/зміна входів потребує чинних перевірок main. Сесіям/живому стану зміни не вносилися.

coordination.json містить receipts. Перший trusted commit відмовив directory path без коміту; повтор з явним переліком файлів успішний (commit-port-notes.json). Root-документи не змінено, тому blocker коміту Orchestrator не виникав. Галочку 1.2.6 ставить raf після succeeded JSON; інших items у звіті немає.
