# Докази для `fix-raf-cli-blocks-on-main-delivery:1.1`

## Корінь проблеми й виправлення

1. У `src/production-runtime.ts` у `transport.deliver` виклик `deliverCheckedMessage` передавав `waitForComposer: identity.runner === 'main'` безумовно. Через це фонові системні доставки (`[raf] ...` від `rafSystemCaller` під час `settleCommandState` / `deliverResults` на вході й виході будь-якої CLI-команди: події `resultNotices`, нагадування, стартові та health-повідомлення) синхронно крутилися в нескінченному циклі `transitionMs`, поки поле вводу панелі `main` містило непідтверджений драфт або повідомлення.
   - Виправлено на `waitForComposer: identity.runner === 'main' && !message.startsWith('[raf] ')`: системні фонові доставки (`[raf] ...`) при непорожньому полі `main` повертають `Composer input is not empty` без блокування CLI-команди, залишаючи події й нагадування в черзі (`state.sqlite`), звідки вони доставляються, щойно поле вводу `main` звільниться.
2. У `src/message-delivery.ts` `deliverInComposer` під час очікування звільнення композитора (`waitForComposer: true`) тримав захоплений `message-locks` lease протягом `await ports.delay(ports.settings.timeouts.transitionMs)`, блокуючи інші виклики доставки до `main`.
   - Виправлено: перед `delay(transitionMs)` lease звільняється, а після `delay` і `verify()` захоплюється повторно перед новим `capture()`.

## 1. Червоний прогін (`--phase red`)

- Команда: `node /srv/dev/work/orchestrator/raf-main-a/bin/raf.ts test run --project raf --phase red --group fix-raf-cli-blocks-on-main-delivery/unit --files test/cli-main-delivery-nonblocking.test.ts` ([red.command.txt](red.command.txt))
- CLI exit code: `0` ([red.cli-exit-code.txt](red.cli-exit-code.txt)), child exitCode: `1`
- Стан workspace: HEAD `803c41c68072290b4e0cada5735edec527c4cca6`, незакомічені зміни: `test/cli-main-delivery-nonblocking.test.ts` та `conf/test-runs.json` ([red-workspace.json](red-workspace.json))
- `runId`: `58045973-0b9c-48de-a269-922c3240e8d5`
- Відбір (`selection`): `files: ["test/cli-main-delivery-nonblocking.test.ts"]`, `testIds: []`
- `outcome`: `assertions-failed`
- `timedOut`: `false`, `cleanup`: `{"complete":true,"remainingPids":[]}`
- `knownRed`: обидва тести в `test/cli-main-delivery-nonblocking.test.ts`; `unexecuted: []`, `unknown: []`
- Стан групи / наступна дія: `groupState: "red"`, `nextAction: "implement"`
- Повний `TestRunResult`: [red.result.json](red.result.json), stderr: [red.stderr.txt](red.stderr.txt)

## 2. Зелений прогін (`--phase hotfix`)

- Команда: `node /srv/dev/work/orchestrator/raf-main-a/bin/raf.ts test run --project raf --phase hotfix --group fix-raf-cli-blocks-on-main-delivery/unit` ([hotfix.command.txt](hotfix.command.txt))
- CLI exit code: `0` ([hotfix.cli-exit-code.txt](hotfix.cli-exit-code.txt)), child exitCode: `0`
- Стан workspace: HEAD `803c41c68072290b4e0cada5735edec527c4cca6`, незакомічені зміни: `src/production-runtime.ts`, `src/message-delivery.ts`, `test/cli-main-delivery-nonblocking.test.ts`, `conf/test-runs.json` ([hotfix-workspace.json](hotfix-workspace.json))
- `runId`: `28deb40f-2a9c-4fb7-b9bf-7fc34ea909bd`
- Відбір (`selection`): `files: ["test/cli-main-delivery-nonblocking.test.ts"]`, `testIds: []`
- `outcome`: `passed`
- `timedOut`: `false`, `cleanup`: `{"complete":true,"remainingPids":[]}`
- `passed`: 2 тести в `test/cli-main-delivery-nonblocking.test.ts`; `knownRed: []`, `unexecuted: []`, `unknown: []`
- Стан групи / наступна дія: `groupState: "complete"`, `nextAction: "complete"`
- Повний `TestRunResult`: [hotfix.result.json](hotfix.result.json), stderr: [hotfix.stderr.txt](hotfix.stderr.txt)

## 3. Суміжна регресія (`complete-raf-flow-contracts/z449`)

- Команда: `node /srv/dev/work/orchestrator/raf-main-a/bin/raf.ts test run --project raf --phase hotfix --group complete-raf-flow-contracts/z449` ([z449.command.txt](z449.command.txt))
- CLI exit code: `0` ([z449.cli-exit-code.txt](z449.cli-exit-code.txt)), child exitCode: `0`
- Стан workspace: HEAD `803c41c68072290b4e0cada5735edec527c4cca6` ([z449-workspace.json](z449-workspace.json))
- `runId`: `89ed919d-bbb5-437c-b38b-3aefdc12d310`
- Відбір (`selection`): `files: ["test/message-delivery-draft-z449.test.ts"]`, `testIds: []`
- `outcome`: `passed` (9/9 тестів зелені)
- `timedOut`: `false`, `cleanup`: `{"complete":true,"remainingPids":[]}`
- `knownRed: []`, `unexecuted: []`, `unknown: []`
- Стан групи / наступна дія: `groupState: "complete"`, `nextAction: "complete"`
- Повний `TestRunResult`: [z449.result.json](z449.result.json), stderr: [z449.stderr.txt](z449.stderr.txt)
