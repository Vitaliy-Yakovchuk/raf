# fix-raf-service-restart-owner-exit:1.1 — Перезапуск служби під час виходу попереднього власника

## Проблема та рішення

Під час послідовного перезапуску фонової служби (`service stop` → `service start`) попередній власник міг уже отримати запит або сигнал зупинки, закрити сокет під час виконання `shutdown()`, або записати `state: "stopped"` до фактичного виходу процесу ОС. Тоді наступний `service start` бачив живий процес попереднього власника без підтвердженої готовності й завершувався помилкою `Existing service owner is alive without verified readiness`, або `service stop` повертався до завершення процесу власника.

Виправлення:
- `src/background-runtime.ts`: у `runServiceHost` перед `server.close()` та виконанням `options.handlers.shutdown()` стан у `service.json` оновлюється на `stopping` (`failed` у разі аварійного завершення).
- `src/service-lifecycle.ts`: `ServiceLifecycleController.ensureReady()` та `ServiceLifecycleController.stop()` розпізнають попереднього власника, що вже отримав `stop` і перебуває у процесі виходу (`stopping`, `stopped` при живому процесі або поточний `stoppingOwner`), та очікують фактичного завершення процесу через `ports.awaitShutdown(owner, deadline)` у межах наявного readiness budget перед поверненням `stop` або запуском нового власника з новим `serviceEpoch`.

## Докази прогонів `raf test run`

### 1. `--phase red`
- Команда: `node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/1a96b18f-4382-4693-8e24-e366577ff9df/raf-main/bin/raf.ts test run --project raf --phase red --group fix-raf-service-restart-owner-exit/unit --files test/background-runtime-unit.test.ts test/background-runtime.test.ts`
- Workspace: `/srv/dev/work/orchestrator/raf-hotfix`, SHA `4338c42216ee61e9ce1e2aa8df7b2ca1e8b2eb32`, незакомічені зміни: `M test/background-runtime-unit.test.ts`, `M test/background-runtime.test.ts`
- `runId`: `53a7b57a-9a8e-4d53-b16e-6dd0273ae852`
- Відбір: `files: ["test/background-runtime-unit.test.ts", "test/background-runtime.test.ts"]`, `testIds: []`
- `outcome`: `"assertions-failed"`, CLI exit code: `1`, child `exitCode`: `1`
- `timedOut`: `false`, `cleanup`: `{"complete":true,"remainingPids":[]}`
- `knownRed`: 8 тестів (зокрема `U5: owner that already received stop and is still exiting does not fail next service start and stop returns only after owner exit` та `service start waits for an owner that already received stop and is still shutting down, then starts ready with a new serviceEpoch`), `unexecuted`: `[]`, `unknown`: `[]`
- `groupState`: `"idle"`, `nextAction`: `"implement"`
- Файли: `red-test-run-result.json`, `red-stderr.txt`, `red-meta.json`

### 2. `--phase hotfix`
- Команда: `node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/1a96b18f-4382-4693-8e24-e366577ff9df/raf-main/bin/raf.ts test run --project raf --phase hotfix --group fix-raf-service-restart-owner-exit/unit --files test/background-runtime-unit.test.ts test/background-runtime.test.ts`
- Workspace: `/srv/dev/work/orchestrator/raf-hotfix`, SHA `724e15cc1de07a61ec5f9752a39c1f15e728cd6a`, незакомічені зміни: `M src/background-runtime.ts`, `M src/service-lifecycle.ts`, `M test/background-runtime-unit.test.ts`, `M test/background-runtime.test.ts`, `?? evidence/fix-raf-service-restart-owner-exit/`
- `runId`: `892a58eb-c801-45ab-9b56-4bd039ec0ea0`
- Відбір: `files: ["test/background-runtime-unit.test.ts", "test/background-runtime.test.ts"]`, `testIds: []`
- `outcome`: `"passed"` (57 passed, 0 failed), CLI exit code: `0`, child `exitCode`: `0`
- `timedOut`: `false`, `cleanup`: `{"complete":true,"remainingPids":[]}`
- `knownRed`: `[]`, `unexecuted`: `[]`, `unknown`: `[]`
- `groupState`: `"complete"`, `nextAction`: `"complete"`
- Файли: `hotfix-test-run-result.json`, `hotfix-stderr.txt`, `hotfix-meta.json`
