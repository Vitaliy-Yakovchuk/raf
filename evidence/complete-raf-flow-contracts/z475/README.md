# Z.475 — очікування блокування state.sqlite

Паралельний `BEGIN IMMEDIATE` довше за `conf/raf.json#/state/contention/timeoutMs` (10000 мс) змушував запис стану повернути `ERR_SQLITE_ERROR` / SQLite 5 `database is locked`. Читання у WAL лишалось успішним. `timeoutMs` у delta state-store є порогом попередження, не причиною відмови. Нового ключа в conf немає: нативний `busy_timeout` лишається `timeoutMs`, після нього запис попереджає один раз і повторює операцію, доки блокування не звільниться.

Група `complete-raf-flow-contracts/z475`, файл `test/state-store-lock-wait.test.ts`. Команда без обгортки — у `red.cli.json` і `hotfix.cli.json`.

| Фаза | runId | CLI | child exitCode | outcome | cleanup | timedOut | timeoutCount | knownRed | unexecuted | unknown | groupState | nextAction |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| red | `4639ca71-5ca7-456f-85bd-bddd61ec6060` | 1 | 1 | assertions-failed | complete, remainingPids=[] | false | 0 | 1 | [] | [] | idle | implement |
| hotfix | `236170ae-d6d2-4ded-96b7-e00a2388f05d` | 0 | 0 | passed | complete, remainingPids=[] | false | 0 | [] | [] | [] | complete | complete |

Повний збережений `TestRunResult` hotfix — `hotfix.result.json` (lastResult агрегату тієї групи в ізольованому QA HOME). Поля red stdout — `red.observed.json`. stderr CLI окремо від child exitCode — `red.stderr.txt`, `hotfix.stderr.txt`. Попередження inventory очікуване: файл передано явним `--files` і не входить до unitFiles.
