# review-agent-startup-context — Z.2.1

Дата: 2026-10-26. Стадія: test-scaffold. Реалізацію Z.2.2 не виконано.

## Контракт і межа доказу

Очікування взято з `openspec/changes/review-agent-startup-context/design.md`, секція «Підключення до lifecycle», Z.2, та вимоги «Прив'язка агента аналізу до пакета» у delta `specs/projects/raf/startup-context-trace/spec.md` (OpenSpec root — `/srv/dev/work/orchestrator`). Аудит актуальності: Z.2.1 відкрита, контракт передачі файлом чинний, production start ще не передає файл і його шлях. Суперечностей для дорученого обсягу не виявлено.

Дві нові перевірки в `test/startup-context-runtime.test.ts` викликають справжні `createProductionServices`, `prepareReport`, `reserveStartupContextReview` і `adapter.start`. Fixture має власні SQLite, каталог запусків і три відкриті пакети; durable reserved session і task lease підготовлено без resource-admission сценарію. Модульний hook замінює лише `launchPersistentWrapper` на спостерігача передавання worker-у; hook знімається після імпорту. Зовнішній runner і tmux не запускаються. Це unit-доказ межі production start, а не повний користувацький запуск агента чи перевірка пісочниці CLI.

Перевіряються:

- фактично переданий worker-у бриф: абсолютний `contextReviewInputPath`, наявні `contextReviewId` і `runIds`, відповідність durable `brief.txt`;
- `context-review-input.json` поруч із `brief.txt`, доступний уже при вході у wrapper launch;
- агентський читач отримує дані лише з указаного файла, без доступу до SQLite;
- вибір саме дорученого середнього пакета серед трьох і відсутність чужих runId у payload;
- точний JSON `{contextReviewId, runIds, traces}`, порядок runId `*-z`, `*-a`, два послідовні reviewer runs з різними пакетами;
- декодовані збережені поля `StartupContextTrace`, включно з різними runner/phase, `null` і причинами, `context: null`, порожніми `reads`, `brief.parts`, переліком skills;
- незмінність збережених слідів та відсутність закриття інших пакетів.

Доданий lifecycle-інваріант у `test/startup-context-lifecycle.test.ts` підтверджує збереження payload, пояснених null і порядку під час прив'язки. Наявні перевірки закриття, повторного finalize, retry і retention виконано в тій самій групі.

Нова публічна production-поверхня не потрібна: тести використовують наявний API start і чинний `StartupContextTrace`. Тому нових production-класів/методів каркаса немає; логіку фічі не додано.

## Відбір і конфігурація

Незмінна група: `review-agent-startup-context/assigned-review-package`.

```sh
raf_command test run --project raf --phase red --group review-agent-startup-context/assigned-review-package --files test/startup-context-lifecycle.test.ts test/startup-context-runtime.test.ts
```

Наступна стадія використовує ту саму групу і список файлів із `--phase implement`. Повний використаний CLI-префікс збережено в JSON-доказах.

Доповнення `conf/test-runs.json`: **жодних**. Обидва файли вже входять у `projects.raf.profiles.node.unitFiles`; наявний запис `projects.raf.groups["review-agent-startup-context/assigned-review-package"]`:

```json
{"profileId":"node","files":["test/startup-context-lifecycle.test.ts","test/startup-context-runtime.test.ts"]}
```

Передумови профілю `node`: `cwd: "."`, executable `node`, argv `["./scripts/test-run-node.ts"]`, `exactIds: "node-test-name"`, `resultAdapter: "node-test-events"`; `environment: {"isolatedHome":true,"stateOrigin":true}`; checks — `node_modules/typescript/package.json`, `src/test-run-reporter.ts`, `scripts/test-run-node.ts`. Resource estimate — RAM 2147483648 bytes, disk 10737418240 bytes на filesystem. Main повідомленням підтвердив чинність записів і isolatedHome/stateOrigin перед red. Профіль повторно звірено після фінального прогону; точні записи містить `handoff.json`.

## Результати

1. `01-refused.json`: run `81c9ce90-3de6-4f0b-9eb3-0302a559ee71`, CLI 1, `CONFIGURATION_INVALID` через зміну unitFiles під час черги. Жодного тесту не виконано; це не red.
2. `02-refused.json`: run `7844f9b9-8422-4380-9e2a-1dfb920797a8`, CLI 1, та сама причина. Main ідентифікував проблему як Z.457 та доручив повторювати ту саму групу. Це не red.
3. `03-initial-behavior-red-with-fixture-failure.json`: run `c9f3df90-7b51-43b9-8a1e-1e868f6f2642`, CLI 1, 16 passed. Два нові assertion failure підтвердили відсутні шлях і файл. Наявний recovery-тест додатково впав через відсутній fixture `dist/catalog.json`; це падіння не вважається доказом фічі.
4. `04-red.TestRunResult.json`: run `e9d3c901-824d-4f6f-83a7-14609bdb7476`, CLI 1, `assertions-failed`, **17 passed, 2 knownRed**, без setup/import/test-failure, unexecuted/unknown/removed порожні. Cleanup complete, remainingPids порожні, timeoutCount 0. Залишилися лише два нові твердження про цільову поведінку:
   - `The brief actually passed to the worker must name contextReviewInputPath`;
   - `Production start must export stored traces before launching`.

Recovery fixture виправлено локально в її наявному тесті: створюється власний compiled catalog із fixture constants замість залежності від наявності робочого `dist`; recovery тепер passed. Очікування поведінки не послаблено.

Повні JSON-результати збережено для всіх спроб. Фінальні stderr і CLI code — `04-red.stderr`, `04-red.cli-code`; `04-red.tool-result.json` містить також команду. STATE_CONTEXT_WARNING та queue event залишено в stderr. `node --check` обох файлів і `git diff --check` пройшли. Green не заявляється — це передача до implement.

`tasks.md` не змінено: галочку Z.2.1 ставить raf після прийняття succeeded. Z.2.2 та інші пункти лишаються відкритими, sync/archive не виконуються.
