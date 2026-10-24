# QA 4.4 — незавершено

Перевірено тільки `switch-raf-main-by-symlink:4.4`. Пункт tasks.md лишається відкритим. Інші відкриті задачі зміни не виконувалися; sync/archive не застосовуються.

## Підтверджене виправлення

Після реальної початкової конвертації `raf-main -> raf-main-a` CLI `main attach` відмовляв із `STATE_CONTEXT_REFUSED: Unregistered module origin`. Доказ: `stand-1/result.json`.

`src/state-migration-guard.ts` тепер допускає активний фізичний main лише за двома канонічними mainCopies, фактичним symlink, HEAD/main, фізичним gitlink і відповідним шляхом `.gitmodules`. Регресія також перевіряє відмову для підміненого неактивного слота і сторонньої теки. Звичайні branchPaths і hotfix-origin зберігають свої перевірки.

Поведінковий red `origin-red.json`: runId `dfe19a8b-acd2-4f33-8510-6eda4394e496`, assertions-failed, CLI/child 1/1, 62 passed, один knownRed `registered active main symlink admits its physical module in QA and production without admitting an unregistered target`, unexecuted/unknown порожні, timeout false, cleanup complete. Після виправлення `origin-qa.json`: runId `37af61df-762c-4302-ba75-c207cd411c19`, passed 63/63, CLI/child 0/0, knownRed/unexecuted/unknown порожні, timeout false, cleanup complete, група complete, nextAction complete. Стабільна група — `switch-raf-main-by-symlink/release`, HOME не змінювався.

Перед цим baseline `release-qa.json`: 62/62 passed, runId `a2c3ed68-2391-438e-a34d-41f1c381781c`. Спроба red до ініціалізації Git у тестовій фікстурі дала setup-помилку, не зарахована як поведінковий red; її сирий результат не збережено. Наступна відмова через зміну конфігурації під час очікування збережена повністю у `origin-config-refusal.*` і також не зарахована як red.

## Реальний стенд і другий дефект

`scripts/qa-main-symlink-release.ts` використовує справжні тимчасові Git-репозиторії/worktrees, індекси, filesystem symlink+rename та реальні verify/activate/recover спільного hotfix engine. Storage adapter виконує Git/filesystem операції. Compatibility і handover повертають готовність як передумову цього пункту; живий handover/нативний агент належать іншим пунктам. Паралельні читачі закріплюють physical realpath, запускають справжній CLI help і перевіряють два module markers по обидва боки publication. Це не native-channel QA 6.4 і не заміна Z.334.

`stand-2` — конфігураційний drift сусідньої зміни costProfile; `stand-3` — помилка назви методу адаптера стенда; `stand-4/5` — каталог був зібраний під зовнішню, а не ізольовану конфігурацію. Причини враховано перед наступними запусками; жоден не зараховано як pass. З `stand-2` окремо збережено stdout/stderr/код процесу. Gate JSON для останніх запусків скопійовані до all-gates до видалення фікстури.

`stand-6/result.json` підтверджує build-refusal і smoke-refusal з кодом gate 37, причиною та незмінними active fingerprint/SHA/readlink/main ref/index tree/foreign staged fingerprint/.gitmodules. Усі повні before/after метадані збережено у сценаріях. Публікація cycle-1-B зупинилася до rename через реальний дефект: після writeIntent engine повторює assertSnapshot; storage.inspect бачить activationComplete=false через цей самий intent, а assertFree помилково відмовляє MAIN_SLOT_BUSY.

Для другого дефекту додано регресію `publication admits its own durable intent during the common engine second snapshot check` у `test/main-symlink-release.test.ts`. Вона ще НЕ виконана. Код `main-symlink-release.ts` НЕ виправлявся до обов'язкового поведінкового unit-red. Звичайний mock 4.3 не повторював publication.assertSnapshot після intent і тому не виявив дефект.

Обидва цикли A→B→A, rollback, SIGKILL/restart і stale publisher залишаються невиконаними. Заплановані сценарії присутні у драйвері, але це не доказ їх проходження. У stand-6 діти отримали SIGKILL, фікстура видалена; result зафіксував children=3 до отримання close, тому cleanup дітей цього запуску не засвідчений. Драйвер доповнено очікуванням close перед наступною перевіркою, але нового запуску після цього немає.

## Зовнішній блокер запуску

Додатковий qa зі списком main-symlink-release + state-migration-guard отримав `setup-failed RESOURCE_WAIT_FAILED: Service stopped`, runId `538d253a-9540-4c5b-aeae-bb440d62a4a4`, child exitCode null, cleanup incomplete, група reconcile/nextAction reconcile, обидва файли unexecuted. Повний результат: `guard-service-refusal.*`. Це не pass і не red.

Наступна команда red нового дефекту повернула лише `RAF command transport failed: ENOENT ... codex-raf-results-VCarPZ; raf was not retried`, CLI 1, без TestRunResult: `intent-red-transport.*`. Доставка повідомлення main також не отримала підтвердження через цю помилку. Окрема read-only `agent ps` підтвердила недоступність транспорту: `transport-probe.tool.json`. Невідомий red не повторювався. Власнику поставлено питання про відновлення довіреного транспорту; обходу sandbox не було. Після відновлення main має встановити фактичний стан невідомого запуску й групи до продовження red/fix/qa у чинному агрегаті.

## Дозволена чужа регресія

Source item `switch-raf-main-by-symlink:4.4` явно декларує `complete-raf-flow-contracts/z392`. Команда qa без --files використала довірений preset. `z392-qa.json`: runId `81edfded-a65a-4cab-9f74-cdf39379b5e5`, CLI 1, child null, outcome/groupState unverified-remainder, успадкований timeoutCount=2, nextAction review-remainder, knownRed/unexecuted/unknown порожні, cleanup complete. Новий child не запускався; повтору й скидання HOME/лічильника не було. Це не pass. Z.334 чи інші чужі checkbox не змінювалися.

## Формат доказів

Для отриманих TestRunResult збережено повний незмінений JSON, command, CLI code окремо від child exitCode, а також повний transport output і tool wrapper. exec_command об'єднує stdout/stderr: незалежного stderr для цих дозволених простих raf-команд інтерфейс не надав; *.stderr.txt прямо зазначає це обмеження. Відсутній результат не реконструювався. Build і stand subprocess мають окремі stdout/stderr/код. `build.cli-code.txt` — 0; build пройшов після першого виправлення.

`workspace-at-transport-failure.json` містить повний HEAD, незакомічений стан, власний diff і SHA256 джерел/драйвера. Робоче дерево спільне: точний повний dirty snapshot ранніх queued unit-запусків не був зафіксований; цей пізніший snapshot не видається за їхній стан. Запуски стенда з успішним startup мають власні source HEAD/dirty та ізольовані Git SHA/fingerprints у result.json. Чужі правки до коміту не додаються.

Наступна необхідна дія — відновлення main довіреного raf transport та reconcile групи; після встановлення результату невідомого red потрібні поведінковий red другого дефекту, виправлення власного intent, qa в тій самій групі й решта сценаріїв стенда. Пункт 4.4 наразі failed, а не succeeded.
