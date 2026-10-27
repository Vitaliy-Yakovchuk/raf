# profile-raf-performance 5.8: повторна перевірка hotfix

Локальну частину доручення завершено відповідно до уточнення main у цій сесії. Перенесення вже міститься в ancestry поточного hotfix: регресії `a711b8863c9cffed5ded36f11e730c836fe6a979`, код `6bfd2f03a47e1579584ca74dcba7697d50a62304`. Повторне перенесення не потрібне. [provenance.json](provenance.json) зберігає точні source SHA для 2.3, 3.3, 4.4 і обох QA-виправлень, перевірку ancestry та дослівне уточнення main. Початковий test-first збережений у [попередніх доказах](../hotfix-5.8/README.md).

## Виправлення фікстур

Свіжий hotfix-прогін виявив 1 падіння profile і 28 падінь timing. Перед правками виконавець сам повторив їх у фазі red зі стабільними групами та незмінним QA HOME/ledger. Обидва результати — assertions-failed, CLI/child 1, без setup/import failure, timeout або неперевіреного залишку.

- Profile використовує віртуальний `/unit/orchestrator` без health-конфігурації. Чинний `src/event-catalog.ts` читає події зі скомпільованого каталогу, тому health увімкнено навіть для цього кореня. За `src/health-summary.ts` така фікстура повертає явну CONFIGURATION_INVALID для `conf/raf.json#/health/summaryIntervalMs`. Виправлено лише застаріле очікування null; перевірка всього health-об'єкта, profile та EMA збережена. Нова валідація продукту не додається.
- Timing-фікстура викидала вигаданий TIMING_UNIT_OPERATION_FAILED, якого немає в чинному каталозі. `src/cli.ts` нормалізує незареєстровані коди до HANDLER_FAILED. Фікстура тепер використовує зареєстрований HANDLER_FAILED, зберігаючи EUNIT як sourceCode і повний сценарій первинної помилки. Перевірки одноразового EMA, часових меж, помилок, help/parser та виключення payload CPU не змінено.

Це виправлення помилок тестів за core/process/test-first, а не зміна поведінки CLI чи health. Інший production-код і чужі файли не редагувалися.

## Перевірка

| Група | Власний red runId | Остаточний hotfix runId | Результат |
| --- | --- | --- | --- |
| profile | c3fb35eb-3266-41ec-89fa-7ee3418eb323 | 7580cbf7-37eb-497f-a109-d603afda94b6 | 31 passed |
| timing-coverage | c7915797-1a41-4823-99a0-9ea19bc73fe6 | 95cd38ef-3fe4-4924-9010-8317a3e145af | 93 passed |
| agent-ps | початковий red успадковано з a711b886 | 40f74304-178f-4b22-9799-46d1ae1c6ee5 | 23 passed |

Усі остаточні прогони: CLI/child 0, outcome passed, knownRed/unexecuted/unknown порожні, timedOut=false, cleanup.complete=true, timeoutCount=0, groupState/nextAction=complete. [runs.json](runs.json) містить точні команди, відбір і стан кожного прогону, включно з початковими hotfix-падіннями. Групи не перейменовувалися, QA HOME не змінювався, агрегат red не скидався. Agent-ps не змінювався після свого зеленого прогону.

`npm run build` і `npm run check:comments` — CLI 0, HOME/RAF_QA_HOME відповідають ізольованому QA HOME прогонів. Повні окремі stdout/stderr й метадані: [build.json](build.json), [comments.json](comments.json). `git diff --check` — 0.

Для unit кожний `*.TestRunResult.json` зберігає повний незмінений рядок JSON; `*.tool.json` — повний результат exec_command, `*.cli.json` — команду та окремі CLI/child exit. Інструмент повертає об'єднаний потік: `*.stderr-derived.txt` містить усі рядки, крім TestRunResult. Незалежна ідентичність stdout/stderr fd цим транспортом не надана; ця межа не приховується. JSON не урізано.

[before-fixture-fix.workspace.json](before-fixture-fix.workspace.json) фіксує HEAD/dirty/hash до власних правок, [verified.workspace.json](verified.workspace.json) — перевірений HEAD `e376ba4211c3138ce4ee27077f6e68ee7a5b3697` і власний patch/hash для зелених profile/timing та build/comments. На початку сесії існували чужі dirty-файли; повного patch того раннього стану немає, він не видається за чистий commit. HEAD початкових hotfix-прогонів за reflog — `9d461aa80e554885c548498e71e01a70aa430a2d`; чужі правки тоді ще комітилися іншими виконавцями. Власні зміни обмежені двома названими тестами і цією текою доказів.

## Передача main

За явним уточненням main його наступний мініреліз виконує активацію й живі agent ps / command stats із перевіркою профілю, EMA, результатів, SQLite і подій. Повідомлення про старт і прогрес доставлено main (receipt cf12c79b-d4e5-4b71-bedb-802d9f5e2725). Останнє повідомлення з підсумком не доставлене: composer адресата містив сторонній текст; невідому доставку не оголошено успішною.

Read-only спостереження Git: `raf-main-a` має `adf873fad75d98d40396cf20295397823bd268fb`, `raf-main` уже вказує на `raf-main-b` із `e376ba4211c3138ce4ee27077f6e68ee7a5b3697`. Це лише фізичний шлях і HEAD, а не доказ живого активного runtime або збереження SQLite/подій. Виконавець не виконував активацію й не стверджує завершення живих перевірок main. Звіт succeeded стосується уточненої локальної частини 5.8.

tasks.md не редагувався: доручені галочки ставить raf. У зміні залишаються відкриті 5.1, 5.11 та 5.11.1; їх не виконував, sync/archive не застосовується.
