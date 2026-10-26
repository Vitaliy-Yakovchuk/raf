# complete-raf-flow-contracts:Z.449

Виправлено доставку до main із зайнятим composer. Виклик очікує звільнення чернетки та delivery lease, повторно перевіряє identity й не надсилає та не замінює чужий текст. Очікування чернетки не витрачає бюджет перевірки прийняття. Receipt залишається підтвердженням native acceptance; саме очікування не є receipt або durable inbox.

Повне власне повідомлення, перенесене terminal wrapping або розбите на рядки, розпізнається перед єдиним Enter retry. Чужий текст, shell, permission prompt та втрата identity не дозволяють вставку/Enter. Звичайні адресати зберігають відмову на зайнятий composer.

Повна перевірка inventory immutable generation перенесена за межі глобального activation.lock: під lock спочатку створюється reader lease, який утримує покоління. Повна валідація залишається обов’язковою до повернення reader; помилка звільняє lease. Це прибирає серіалізацію повних сканувань усіх паралельних CLI-повідомлень.

Аудит: Z.449 відповідає чинному agent-message (native acceptance, збереження чернетки, identity, серіалізація) та workspace-routing (повна перевірка покоління з reader lease). Застарілих або суперечливих вимог не виявлено. Інші відкриті пункти зміни не виконувалися; tasks.md не змінювався.

## Прогони

Усі прогони виконані через дозволений raf test run зі стабільними групами й тим самим ізольованим QA HOME. Red — падіння assertions, не setup/import. Повні команди, runId, відбір, CLI/child exitCode та стан агрегату також у [summary.json](summary.json).

| Прогін | Outcome | Passed / knownRed | CLI / child | Доказ |
| --- | --- | --- | --- | --- |
| red | assertions-failed | 3 / 3 | 1 / 1 | [JSON](red.result.json), [команда](red.command.txt), [stderr](red.stderr), [CLI](red.cli-exit-code) |
| hotfix | passed | 6 / 0 | 0 / 0 | [JSON](hotfix.result.json), [команда](hotfix.command.txt), [stderr](hotfix.stderr), [CLI](hotfix.cli-exit-code) |
| queue-red | assertions-failed | 6 / 3 | 1 / 1 | [JSON](queue-red.result.json), [команда](queue-red.command.txt), [stderr](queue-red.stderr), [CLI](queue-red.cli-exit-code) |
| queue-hotfix | passed | 9 / 0 | 0 / 0 | [JSON](queue-hotfix.result.json), [команда](queue-hotfix.command.txt), [stderr](queue-hotfix.stderr), [CLI](queue-hotfix.cli-exit-code) |
| reader-red | assertions-failed | 9 / 2 | 1 / 1 | [JSON](reader-red.result.json), [команда](reader-red.command.txt), [stderr](reader-red.stderr), [CLI](reader-red.cli-exit-code) |
| reader-hotfix | passed | 11 / 0 | 0 / 0 | [JSON](reader-hotfix.result.json), [команда](reader-hotfix.command.txt), [stderr](reader-hotfix.stderr), [CLI](reader-hotfix.cli-exit-code) |
| adapters | passed | 46 / 0 | 0 / 0 | [JSON](adapters.result.json), [команда](adapters.command.txt), [stderr](adapters.stderr), [CLI](adapters.cli-exit-code) |
| final-adapters | passed | 46 / 0 | 0 / 0 | [JSON](final-adapters.result.json), [команда](final-adapters.command.txt), [stderr](final-adapters.stderr), [CLI](final-adapters.cli-exit-code) |

Кожний `*.result.json` — повний незмінений JSON TestRunResult, `*.stderr` — окремий повний stderr, `*.cli-exit-code` — код CLI окремо від child exitCode. `*.tool-result.json` зберігає первинну відповідь інструмента. Для кожного з восьми прогонів перевірена точна відповідність повного output конкатенації збережених stdout і stderr.

Усі cleanup.complete=true, timedOut=false, remainingPids=[], unknown=[], unexecuted=[], timeoutCount=0. Остання z449: 11 passed, knownRed=[], groupState=complete, nextAction=complete. Остання raf-agent-adapters: 46 passed, knownRed=[], groupState=complete, nextAction=complete. Група іншої регресії не додавалася до доручених tasks.

Фактичний SHA й незакомічений стан для фаз — у `*-workspace.json`; [final-workspace.json](final-workspace.json) містить фінальний передкомітний SHA, повний git status, власний diff та SHA256 чотирьох файлів реалізації/регресії. Спільний HEAD змінювався комітами інших виконавців; їхні зміни не належать цьому hotfix.

`npm run build`: код 0, [метадані](build.json), [stdout](build.stdout), [stderr](build.stderr). Виконано з окремим QA HOME, вказаним у метаданих. `git diff --check` успішний.

Перевірено код ізольованими unit-регресіями та build. Активація production і smoke на живому main належать main; виконавець не виконував push/activation.
