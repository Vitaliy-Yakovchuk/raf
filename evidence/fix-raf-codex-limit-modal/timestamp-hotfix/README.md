# Hotfix 1.1.1: відносні часові значення фікстури

У `test/cli-main-delivery-nonblocking.test.ts` завершена сесія мала `finishedAt` понад добу тому й видалялася штатним `cleanupCompleted` (`src/session-state.ts`, `conf/flow.json#/retention/finishedSessionsMs`). Тому notice зникав до перевірки доставки. Тепер finishedAt, proof.at і перше нагадування використовують `now − 2 хв`, друге — `now − 1 хв`. Усі твердження збережено без змін; production-код не змінювався.

- Red: `4e629e39-125c-42c2-9e6f-69bbb601742c`, CLI 1 / child 1, assertions-failed: «Queued result notice must be delivered once main composer clears», 19 passed / 1 knownRed.
- Hotfix: `ccb4ffaa-56c1-4344-8afb-24e6073a120e`, CLI 0 / child 0, passed: 20/20; knownRed/unexecuted/unknown порожні, groupState=complete, nextAction=complete.
- Обидва прогони: та сама група `fix-raf-codex-limit-modal/unit`, ті самі три файли та QA HOME, timeoutCount=0, timedOut=false, cleanup.complete=true; групу й агрегат не скидали.

Повний незмінений TestRunResult — у `red.test-run-result.json` / `hotfix.test-run-result.json`; повний stderr, CLI-код і початковий transport збережено окремо. Попередження stderr стосуються сторонніх etchly конфігурацій і не обрізані. `evidence.json` містить точні команди, SHA та стан workspace; патчі фіксують незакомічені правки. Під час red джерельний тест відповідав HEAD; під час hotfix мав лише наведений патч.

Доручення охоплює лише 1.1.1. Галочку ставить raf за succeeded-звітом. Пункт 1.2 відкритий і не виконувався; archive не запускався.
