# complete-raf-flow-contracts:9.3 — workspace-routing

Незалежна реалізація завершена до першого читання підготовлених тестів. Джерела: delta workspace-routing, workspace-routing-design.md U1–U6, branch-directories та agent-adapters trust/commit. Аудит підтвердив актуальність дев'яти відмов U3/U5 прийнятого main red 9.2; суперечностей із чинним контрактом не виявлено. Другий resolver, activation gates та живі I1–I6 не реалізовувалися повторно.

`src/workspace-routing.ts` тепер вимагає обидва proof-порти realPath/gitRoot для кореневого Orchestrator і постійного raf-hotfix. Orchestrator використовує канонічний корінь; hotfix додатково відхиляє canonical alias зареєстрованого шляху. В обох випадках фактичний Git-корінь має збігатися з перевіреним cwd. Відсутні докази, чужий/non-Git root та помилки інспекції дають WORKSPACE_UNAVAILABLE до перевірки гілки/runner. Наявні BRANCH_MISMATCH, профільний вибір, вузькі права та same-branch shared-libs збережені.

Передумова — [прийнятий red 9.2](../cfc92-workspace-routing/README.md), runId fbd23c46-6b04-47b0-813a-550fc7d3aa52: 9 knownRed, 59 passed. Main підтвердив його в цій сесії. Inventory/preset уже застосував main; виконавець conf не змінював.

Команда власного підтвердження:

```sh
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/3557f6a4-89a2-41a3-b963-b4343aabc699/raf-main/bin/raf.ts test run --project raf --phase implement --group complete-raf-flow-contracts/raf-workspace-routing --files test/workspace-routing.test.ts test/workspace-routing-contracts.test.ts
```

Результат runId **486fd919-0d01-467d-987b-b99f11e5efb2**: **passed, 68/68, CLI/child 0/0**, 909 ms, timedOut=false, cleanup.complete=true. KnownRed/unexecuted/unknown/removed порожні, groupState=complete, timeoutCount=0, nextAction=complete. Усі дев'ять прийнятих red IDs тепер passed. Група, відбір та QA HOME/state збігаються з 9.2; ledger не скидався. Ресурсна повнота partial — вона не оголошується повною.

- [unit-result.json](unit-result.json) — повний незмінений JSON TestRunResult з фактичними argv/cwd/environment, policy й конфігураційними fingerprints.
- [unit-command-result.json](unit-command-result.json) — повний отриманий exec result із початковим output та окремим CLI exit_code; child exitCode міститься в TestRunResult.
- [stderr-status.json](stderr-status.json) — явна недоступність окремого stderr: exec_command повертає єдиний output, а capture після replay порожній. Єдиний output є повним JSON; нульовий stderr не вигадується.
- [pre-run.json](pre-run.json) — SHA перед прогоном, dirty workspace, власний diff, fingerprints конфігурації/тестів і checkpoint завершеної незалежної реалізації без читання тестів.
- [post-run.json](post-run.json) — SHA після прогону, власний diff/source hash, wrapper hash, незмінність тестів, перевірка red→green і збереження групи/HOME. HEAD рухався через паралельні коміти інших виконавців; власний код залишився незакоміченим до збереження цих доказів.

`node --check src/workspace-routing.ts`, `npm run build` та `npm run check:comments` завершилися з кодом 0. Тести не редагувалися; їх перший перегляд відбувся після завершеної реалізації та зеленого прогону. Наступна дія — окреме приймання 9.4; I1–I6 цим unit-результатом не закриті. Галочку 9.3 ставить raf. Архівація не виконується, бо інші пункти зміни відкриті. Push не виконувався.
