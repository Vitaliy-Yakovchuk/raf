# S.5 — квоти без фонового збору, test-scaffold

## Межі

Джерело очікувань: `openspec/changes/complete-raf-flow-contracts/tasks.md:S.5`,
quota-collection «Збір лише за явною командою» з обома сценаріями та
«Збереження та свіжість спостережень». Аудит підтвердив актуальність S.5:
`collectRunnerQuotas` і production `quotaStore` досі мають background mode,
валідація потребує intervalMs/failureBackoffMs. Нової публічної поверхні не потрібно:
змінюється наявний контракт, тому нові production-класи/методи й NotImplemented
каркас не вводяться. Логіка фічі не реалізована.

## Інваріанти й тести

- `test/quota-collection.test.ts`: синтаксичний інваріант відсутності background
  у сигнатурах collection/quotaStore; явний збір не планує наступний автоматичний
  збір і не блокує наступний явний запит інтервалом/backoff; missing/stale/failed
  читачі не відкривають probe, не беруть замки й не змінюють поточний замір.
- `test/quota-screens.test.ts`: усі чотири протоколи приймають collection тільки
  зі staleAfterMs; перевірка його коректності лишається. Наявний conf-тест більше
  не вимагає застарілих scheduling-полів. Спільний conf/raf.json не редагувався:
  видалення його полів дозволене лише після переходу raf-main на сумісний код.
- `test/quota-explicit-production-unit.test.ts`: справжні production services з
  in-memory StateStore double та підміною лише перевірки доступності CLI;
  три одночасні routingSnapshot плюс обробники runner list та agent run до
  модельного вибору; missing/fresh/stale/failed/reset зі старими полями та без них.
  Нуль зовнішніх процесів, quota leases, записів quota/error; повторне читання SQLite
  double і збереження unknown за відсутності актуального виміру.

Наявні позитивні тести явного збору, cleanup, конкуренції й збереження попереднього
знімка збережені; історичні тести фонових спроб замінені контрактом S.5.
`test/runner-limits-production.test.ts` має реальні tmux/CLI-процеси. Він не є
ізольованим unit і не включений у цю групу; його живе/integration приймання окреме.

## Стабільний відбір

```text
raf_command test run --project raf --phase red --group complete-raf-flow-contracts/quota-collection --files test/quota-collection.test.ts test/quota-screens.test.ts test/quota-explicit-production-unit.test.ts
```

Наступний implement зберігає group і files, змінює лише `--phase implement`.
Main підтвердив реєстрацію 2026-10-26 через agent message: «зареєстровано — unitFiles
node + група complete-raf-flow-contracts/quota-collection. Запускай red».
Точний patch — `conf-test-runs.patch.json`; наявні quota-collection/quota-screens
вже зареєстровані в node unitFiles. Передумови: Node >=25.4.0, встановлений TypeScript,
`src/test-run-reporter.ts`, `scripts/test-run-node.ts`, перевірений workspace,
ізольовані QA HOME/state/tmp профілю node (`isolatedHome=true`, `stateOrigin=true`).
Deadline й облік групи забезпечує raf за conf/flow.json#/unitTests/timeoutMs.

## Підготовка прогону

Перші два запуски ccc7036d-a837-4605-ab21-5d86a90d84a4 і
25881388-e364-481c-ba25-fadc6a9d9131 повернули setup-failed, CLI/child 1,
cleanup.complete=true, без жодних passed/knownRed. Це не red. Причина встановлена
викликом validateDiagnosticLimits на shared conf: CONFIGURATION_INVALID
`diagnostics/maxProtocolLineBytes`. Main переніс чинне виправлення hotfix
у develop commit b895e5f: прибрано цю вимогу за рішенням власника.
Профільні ліміти й production-код квот виконавець не змінював.

Третій запуск `381a0395-1ecc-4427-a328-1e2f0279073a` після очікування ресурсів
відмовив до spawn: CONFIGURATION_INVALID — конкурентна зміна
`conf/test-runs.json#/projects/raf/profiles/node/unitFiles/245`.
Повний результат: `red-attempt-3.capture.json`. Це також не red.

## Первинний red підтверджено

Run `dd9e6b77-ec09-4f1a-ae77-6e13a589f53a`: assertions-failed, CLI 1, child 1,
41 passed / 9 knownRed; failureKinds=[assertions], timedOut=false,
timeoutCount=0, cleanup.complete=true, unexecuted/unknown порожні, nextAction=implement.
Повний TestRunResult: `red.TestRunResult.json`; сирий результат інструмента зі
збереженим CLI code: `red-attempt-4.capture.json`; stderr (попередження контексту
та повідомлення черги): `red.stderr.txt`; SHA256 тестів і короткий результат:
`red.summary.json`.

Цільові причини падінь:

- Повторна явна спроба після помилки повертає backoff замість нового probe.
- Успішний явний збір створює nextAttemptAt замість відсутності планування.
- Сигнатура collectRunnerQuotas досі містить background mode.
- validateQuotaProtocol відхиляє коректний протокол лише зі staleAfterMs.
- П’ять production-сценаріїв без intervalMs/failureBackoffMs не читають збережені
  квоти через цю валідацію (0 читань замість 5); відповідні legacy-сценарії зелені.

Усі падіння походять із тіл тестів і цільового production validation; setup/import
failure відсутні. Main має незалежно перевірити ці причини перед implement.
Зелені перевірки no-probe вже захищають поточний шлях runner list/agent run;
червоний синтаксичний інваріант блокує збереження фонового entry point.

Це завершення лише test-scaffold S.5. Реалізація, фінальний зелений прогін тієї
самої групи й окрема перевірка runner-limits-production лишаються implement.
Галочки tasks.md не змінювалися, інших відкритих пунктів зміни багато;
sync/archive не застосовні. Конфігурація квот видаляється зі shared conf лише після
сумісної активації raf-main, що не належить цій стадії.
