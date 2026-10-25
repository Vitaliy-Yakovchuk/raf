# complete-raf-flow-contracts:9.2 — тести workspace-routing

Автор: raf-cfc92-scaffold, стадія test-scaffold. Реалізація маршрутизації не змінена; галочки tasks.md належать raf.

## Контракт і аудит

Очікування визначають delta workspace-routing, workspace-routing-design.md U1–U6 та прямі branch-directories/agent-adapters вимоги. Чинний бриф і add-raf-test-run feature-test-authoring «Агент тестів і каркаса» скасовують старі blind-обмеження tasks/design: код і тести прочитані для сумісних fixture, не як джерело очікувань. Аудит підтвердив актуальність непокритих перевірок без створення другого resolver. Виняток symlink main та activation snapshot належать наявним залежностям і не переписуються.

- U1: наявні 14 тестів `test/workspace-routing.test.ts`, файл незмінений.
- U2: профільний вибір develop/release для spec/design, невплив порядку branchPaths/default path, відсутній/null/порожній/невалідний профіль і development, точна діагностика незареєстрованої гілки.
- U3: Orchestrator main/path="." без branchPaths, canonical root/Git root, wrong/detached/non-Git/non-root, помилки читання й відсутні proof-порти; виняток не поширюється на інший project/path=".".
- U4: чисті task-context/runtime порти; branch/cwd передаються у worker launch, brief і adapter; workspaceWritable=false, лише документи й Git Orchestrator, без продуктового code/Git. Відмова маршруту перед report/reservation/runner. Це unit-композиція, а не перевірка справжніх trust/sandbox.
- U5: спільний постійний hotfix cwd для двох runId, missing mapping/непридатне дерево/symlink/wrong branch/detached/canonical alias/foreign Git root/non-Git/відсутні докази та помилки інспекції; конфігурація й спостереження не змінюються.
- U6: не дублюється. Точні еквівалентні сценарії вже є в `test/state-migration-lazy-bootstrap.test.ts`: :409 lazy help/parser, :438 malformed conf, :532 parse→lease→imports→handler→release, :546 import/handler failures з release failure та primary cause, :561 reader refusal, :585 pinned catalog/modules. Їх тут не запускали; наявність тестів не оголошується новим live-прийманням.

Нової команди немає. Нові signatures — лише optional dependency interfaces та другий аргумент deriveTaskContext; вони передають виклик існуючим helper за замовчуванням. Нових production методів із тілами немає, тому вставляти NotImplemented в наявний resolver/helper було б штучним red. Main явно дозволив мінімальні декларації й default forwarding для U4. Жодна routing-перевірка чи feature-логіка не реалізована.

## Реєстрація та стабільна група

Передано main точний `workspace-routing-registration.json`: `conf/test-runs.json#/projects/raf/profiles/node/unitFiles` доповнити `test/workspace-routing-contracts.test.ts`; `#/projects/raf/groups/complete-raf-flow-contracts~1raf-workspace-routing` = `{"profileId":"node","files":["test/workspace-routing.test.ts","test/workspace-routing-contracts.test.ts"]}`. Main повідомив застосування комітом Orchestrator `23b9d245e6`; conf автор не змінював.

Передумови: перевірені project=raf/workspace=raf-develop/branch=develop, довірений red канал, isolated QA HOME/state; main перевіряє ledger/selection overlap. Timeout та max/optimize policy лише з `conf/flow.json#/unitTests`. Та сама group/QA ledger переходить 9.3/9.4; новий SHA/фаза/HOME не скидає бюджет. I1–I6 та integration preset не виконуються цим дорученням.

Команда автора:

```sh
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/3557f6a4-89a2-41a3-b963-b4343aabc699/raf-main/bin/raf.ts test run --project raf --phase red --group complete-raf-flow-contracts/raf-workspace-routing --files test/workspace-routing.test.ts test/workspace-routing-contracts.test.ts
```

Результат: `assertions-failed`, CLI/child exit 1, 59 passed (14 U1 + 45 нових), 9 knownRed, unexecuted/unknown/removed порожні. RunId `fbd23c46-6b04-47b0-813a-550fc7d3aa52`, 945 ms, timeout відсутній, cleanup complete. Setup/import помилок немає. U3 — 2 падіння за відсутніх realPath/gitRoot proof-портів; U5 — 7 падінь canonical alias/foreign Git root/non-Git/відсутніх proof-портів/помилок інспекції. У кожному випадку resolver повернув ok замість WORKSPACE_UNAVAILABLE. Решта U2/U4/U5 уже green; це не підстава міняти очікування або штучно ламати наявну поведінку.

Повний незмінений TestRunResult: [red-result.json](red-result.json). Повний результат exec з початковим JSON-виводом і зовнішнім exit_code: [red-command-result.json](red-command-result.json). Передумови, workspace SHA, конфігураційні fingerprints і policy зафіксовані в [pre-run.json](pre-run.json). Ресурсні вимірювання в TestRunResult мають completeness=partial; вони не оголошуються повними.

Main незалежно прийняв початковий red повідомленням: «Red 9.2 прийнято: runId fbd23c46, 9 knownRed (U3 — 2, U5 — 7, поведінкові: ok замість WORKSPACE_UNAVAILABLE), setup/import чисті, cleanup complete. Заверши докази й звіт; 9.3 отримає ту саму групу.»

Передача 9.3: виправити цільову відмову U3/U5; залишити стабільну групу, точні два files та QA HOME/ledger із TestRunResult. U4 використовує лише погоджені optional ports; реальна Git/sandbox/trust межа належить I2/I3. Syntax `node --check` для нового тесту, task-context та app-runtime — 0; `npm run check:comments` — 0. Нових production методів із NotImplemented немає: наявні методи не замінені, додано лише декларації й forwarding залежностей. Галочки 9.2 ставить raf; архівація не виконується, бо інші пункти зміни відкриті.
