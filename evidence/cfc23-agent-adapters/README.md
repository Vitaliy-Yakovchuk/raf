# complete-raf-flow-contracts:2.3 — implement

Виправлено лише прогалину U5 у `src/launch-wrapper.ts`: помилка перевірки ownership, stop або очікування виходу під час cleanup більше не губиться. Первинна помилка залишається першою, супутня додається наявним `withAccompanyingFailure`. Той самий об'єднаний текст отримують lifecycle.failed та caller; якщо lifecycle.failed також відмовляє, його причина додається після попередніх. Recoverable, ownership guards і порядок фіналізації збережені: непідтверджений процес не звільняється й watcher не прибирається.

Аудит актуальності: пункт 2.3 відкритий, 2.2 підтверджений red. Джерела — proposal Why/What Changes, agent-adapters-design.md (порти й U1–U5), повна delta agent-adapters, застосовні стики agent-run/report та процес feature-implementation/unit-test-runs. Новий supervisor, store, recovery, Q.4.1/Y/Z pipeline не створювалися. U1–U4 already green за доказом 2.2, їх не переписано. Підготовлені тести відкрито лише після завершення незалежної початкової реалізації та запису `implementation.json`; жодного тесту не змінено.

## Unit-доказ

Точна команда власного прогону:

```text
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/3557f6a4-89a2-41a3-b963-b4343aabc699/raf-main/bin/raf.ts test run --project raf --phase implement --group complete-raf-flow-contracts/raf-agent-adapters --files test/agent-adapter-readiness.test.ts test/agent-adapters-contract.test.ts
```

Повний незмінений JSON з merged tool output: [implement.TestRunResult.json](implement.TestRunResult.json), 11355 bytes. Окремий код CLI та межа доступності stderr: [implement.capture.json](implement.capture.json). Інструмент `exec_command` надав лише один output і не експонував окремого stderr. Його відсутність не підмінено твердженням про порожній stderr. Output повністю є одним валідним TestRunResult JSON, без обрізання; CLI code отримано безпосередньо з tool result, child code — з JSON.

| Факт | Результат |
| --- | --- |
| runId | f5d40bed-2372-466c-9f5b-10729dd8dc36 |
| Test kind / phase | unit / implement |
| Початок / тривалість | 2026-10-25T13:15:11.775Z / 847 ms |
| Outcome / CLI / child | passed / 0 / 0 |
| Passed IDs | 40, включно з U5 |
| knownRed / unexecuted / unknown / removed | [] / [] / [] / [] |
| Cleanup | complete=true, remainingPids=[] |
| Timeout | timedOut=false, timeoutCount=0 |
| Group / nextAction | complete / complete |
| Deadline | conf/flow.json#/unitTests/timeoutMs = 1200000 ms |

Попередній red автора: `evidence/cfc22-agent-adapters/final.TestRunResult.json`, runId e505884c-c046-49b2-b5f9-ad1306167d0b, assertions-failed, один knownRed U5, groupState=idle, nextAction=implement, timeoutCount=0. Порівняння публічних результатів підтвердило незмінні group і QA HOME `/tmp/raf-unit-1000/8b186c55b4e5d09825e2b95aff4f750bb7bc2ab6fd6034951178a517b04b3391`; приватний ledger не читався й не змінювався. Reset, перейменування чи оптимізація відбору не виконувалися. Inventory/preset уже зареєстровані main; запис conf не доручено й доповнень не потрібно. Чужі regressionGroups у пункті не задекларовані — їх не запускали.

## Workspace та перевірки

Тестований HEAD — `f7474de010b623f41ee812746f758e8037c9e611` (reflog: 13:15:09Z, перед початком прогону). HEAD рухався через коміти інших виконавців між початковим snapshot `60e921e829d87f73e6cfd1fdd21928065947e2dc` і прогоном; [implementation.json](implementation.json) та [workspace-after.json](workspace-after.json) фіксують стан. Точна власна незакомічена правка під час прогону — [tested.patch](tested.patch). Чужі tracked правки: src/background-runtime.ts, src/production-runtime.ts, src/production-service-ports.ts, src/service-lifecycle.ts; не редагувалися й не включаються до власного коміту. До початкового snapshot також належала згодом закомічена іншою сесією правка evidence/cfc94-workspace-routing/README.md.

SHA-256 двох тестів до/після незмінні й збігаються з evidence 2.2: readiness `f492cd78a0d7dadb3330fba1e882c5c8a5b9bfa1392a906dc7b92e55b27d2052`, contract `8c8d4e8486c60f634e45066cdd6979d9c973502f76da9c3c4d8801859c9caf6b`. SHA-256 реалізованого wrapper `ad5386a8978edfafffa5f7df182219f90da3307625ff4e31f87def037a348bf9` також незмінний між snapshots.

`npm run build`, `npm run check:comments`, `node --check src/launch-wrapper.ts`, `git diff --check -- src/launch-wrapper.ts` завершилися з кодом 0. Команди/коди та справжні окремі stdout/stderr локальних перевірок збережено як build/comments/syntax/diff.{json,stdout,stderr}. Числової політики, conf, timeout, sandbox чи assertions не змінювали.

Пункт 2.3 готовий до підтвердження raf за JSON-звітом. Галочку виконавець не ставить. Інтеграційні I1–I4 і живі L1–L4 та пункт 2.4 залишаються відкритими; unit не підтверджує підтримку справжніх CLI. У зміні лишаються інші відкриті пункти, тому sync/archive не виконується.
