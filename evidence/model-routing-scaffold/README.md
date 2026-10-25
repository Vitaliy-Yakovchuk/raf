# complete-raf-flow-contracts:10.3 — передача test-scaffold

Предметний контракт: `openspec/changes/complete-raf-flow-contracts/specs/projects/raf/model-routing/spec.md`, дизайн 10.2 `model-routing-design.md`, U1–U6. Очікування визначено цими сценаріями та прямими залежностями quota-collection / agent-adapters / session-recovery / agent-run / agent-report / state-store. Реалізації фічі немає.

Аудит актуальності: 10.3 відкритий, 10.4/10.5 залишаються відкритими; Q61 задає керування runner, Q65 скасовує resume. Чинна delta `add-raf-test-run/specs/core/process/feature-test-authoring/spec.md`, вимога «Агент тестів і каркаса», дозволяє читати production/test-support/чужі тести. Застарілий рядок blind mode у «Джерелах за етапом model-routing» не застосовувався, про суперечність повідомлено main. Друга реалізація готових selectModel/listModelAvailability, адаптерів або SQLite не додавалася.

## Відбір і передумови

Стабільна група наступних стадій: `complete-raf-flow-contracts/model-routing`.

```text
raf test run --project raf --phase red --group complete-raf-flow-contracts/model-routing --files test/model-routing.test.ts test/model-routing-handoff.test.ts
```

Той самий точний відбір використовують незалежні implement/qa зі своєю фазою. Автор тестів запускає саме red. Повний TestRunResult — `red.stdout.json`; точний результат інструмента — `red.tool-result.json`; CLI/child exit та висновок main — `result-summary.json`.

Точні доповнення `conf/test-runs.json` — `conf-test-runs.patch.json`. Профіль `projects.raf.profiles.node`: cwd `.`, executable `node`, argv `./scripts/test-run-node.ts`, exactIds `node-test-name`, resultAdapter `node-test-events`, environment isolatedHome/stateOrigin=true; чинні checks з patch, branch develop, довірений канал автора red, ізольований стабільний unit HOME/SQLite ledger. Числові межі лише з `conf/flow.json#/unitTests`. Новий файл автоматично не реєструється. Conf поза межами запису автора; після коміту джерел main отримав patch і застосував реєстрацію.

Окрема запропонована дизайном група `model-routing-signals` **не зареєстрована**: main виявив, що `test/quota-screens.test.ts` уже входить до `complete-raf-flow-contracts/z390-regress`; повторне членство одного файла в групах тієї самої зміни заборонене. Нових assertions у `test/runner-protocols.test.ts` / `test/quota-screens.test.ts` немає, готове покриття не дублюється. UnitFiles нового handoff та цільову групу main зареєстрував Orchestrator-комітом `537ae58a59ad461ad638918459e8a9e1bc623c29`; остаточний conf patch відображає фактично застосовані записи. Його статично перевірені сценарії: auth/permission/unknown screen, argv/effort, pool isolation, stale/reset/missing → unknown, quota → routing. Ця передача не заявляє нового прогону signals.

Обидва файли цільової unit-групи не читають файлів/конфігурації на диску, не відкривають SQLite, не створюють процесів/tmux і не звертаються до провайдера. Runtime/CLI у U3 отримують синтетичний compiled catalog та порти в пам'яті. Перевірка синтаксису через TypeScript AST не є прогоном тестів.

## Покриття та інваріанти

| Контракт | Перевірки |
| --- | --- |
| U1 | Зміна taskClassification і назв складності; відсутня класифікація без fallback; зміна complexityOrder/effort/preferences/transitions/role bindings; роль main не задає модель без binding |
| U2 | Відсів runner disabled/model disabled/CLI unavailable/exhausted; незалежні пули; unknown явно лишається придатним unknown; немає downgrade; waiting з причиною; добір не мутує каталог/знімок |
| U3 | Наявний createAppRuntime/execute через порти: enable/disable/list, точний --runner, invalid/missing/duplicate/unauthorized без запису; saved switch переживає новий runtime та зміну initialEnabled; ініціалізація лише відсутніх; model enabled=false зберігається; заборонені stop/interrupt/probe/нові sessions; поточний Map без історії |
| U4 | limited/failed/exited збережені як причина, unknown exit не дорівнює success; відомий pool/retryAt не губиться, невідомі не вгадуються; помилка scanner не доводить exit; stale runId/current owner mismatch не впливає на новий запуск; starting/ready з agy identity pending не створює наступника та не підміняє identity |
| U5 | Final report перед finalization, process alive/unknown/scan exception блокують; report pending/wrong run блокують; unfinished finalization/claims/transaction exception не запускають; конкурентні виклики через спільний атомарний порт agent-run дають один запуск; source/conflict/runner drift відхиляються; pre-session limit потребує retrySafe=true та pending=[] |
| U6 | Прийнятий succeeded + nonzero exit без повтору; failed/missing/rejected не ставлять галочок; тільки актуальні незавершені пункти та evidence; нові runId/native/report_path; немає resume/history; paused/stopped блокують; порожній актуальний набір завершує передачу без агента |

## Каркас і межі портів

- `classifyModelTask(catalog: ModelCatalog, task: string): string | null` — лише `throw new Error('NotImplemented')`; повертає налаштовану складність або null без прихованого fallback.
- `handoffModelRun(request: ModelHandoffRequest, ports: ModelHandoffPorts): Promise<ModelHandoffResult>` — лише `throw new Error('NotImplemented')`; повні типи request/result/ports у `src/model-routing-handoff.ts`.
- `currentSession` та `inspect` — чинна перевірка конкретної identity, не висновок зі зникнення pane. Signal прив'язаний до runId, addressId сам по собі недостатній.
- `checkFinalReport` — чинний agent-report, включно з перевіркою поточного runId та OpenSpec; pending не є failed/missing.
- `finalize` — делегування вже наявній атомарній session-recovery/state-store фіналізації й claims cleanup. Не створювати нових таблиць, другого supervisor або окремого обліку завершень.
- `readCurrentWork` — повторне читання/валідація OpenSpec і вузького доручення, без копії tasks у SQLite; повертає evidence для нового брифа.
- `readRouting` — актуальний каталог і кешований snapshot, без quota probe.
- `launchNew` — порт чинного agent-run, який атомарно перевіряє predecessor/claims, актуальний source, owner pause/stop та доступність під час reservation і створює нові identity/report_path/brief. Це не виклик adapter напряму. Порт зберігає відмову drift/conflict; його fake моделює арбітраж, а не доводить транзакцію SQLite.

Інтеграційні I1–I5 та живі L1–L5 лишаються наступним прийманням 10.5 після implement; ці unit-тести не підтверджують реальну SQLite persistence, доставку повного брифа, транзакцію фіналізації або запуск чотирьох CLI. Integration preset і файл у цій unit-передачі не створювалися та не реєструвалися.

## Статичні перевірки

`npm run build` — exit 0. `npm run check:comments` — exit 0. TypeScript AST parse diagnostics усіх чотирьох змінених TS-файлів — порожні. `git diff --check` — exit 0. Unit-red: `159a1647-f686-40e6-b258-be585f65d543`, assertions-failed, CLI/child 1/1, 26 passed, 37 knownRed, 0 unexecuted/unknown, 0 timeout, cleanup.complete=true. Усі 37 test-failure diagnostics — NotImplemented у тілах тестів класифікації або handoff, setup/import failure немає. Main прийняв цільовий red у цій сесії; дослівне повідомлення та доступні SHA/fingerprints збережено в `result-summary.json`. Передача не потребує повторного red чи скидання групи/HOME/бюджету.
