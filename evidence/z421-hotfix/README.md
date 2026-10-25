# Z.421 — loopback TCP у пісочниці codex

Пункт: complete-raf-flow-contracts:Z.421 (виконавець raf-z421-hotfix, запуск 9bc35478-94c9-4679-b447-154f2f39c78b, baseCommit 30eaf7f).

## Зміна

- `src/codex-sandbox.ts`: seccomp-фільтр дозволяє `socket()` для AF_UNIX, AF_INET, AF_INET6; інші сімейства (netlink, packet тощо), io_uring і x32 заборонені, як і раніше. `--unshare-net` у обгортці bwrap не змінено, тож TCP працює лише у власному мережевому просторі агента з `lo`.
- Preflight: хостовий TCP-слухач на 127.0.0.1 має бути недосяжний (ECONNREFUSED за живого слухача; підключення чи інша помилка — відмова), у `/proc/self/net/dev` лише `lo`, власний 127.0.0.1 listen/connect/обмін працює; перевірки прихованих шляхів і Unix IPC збережено.
- `policy.json`: `socketFamilies` = AF_UNIX, AF_INET, AF_INET6.

## Регресія

`test/codex-unix-sockets.test.ts`, тест «Z.421 real sandbox: own loopback TCP listen/connect works in the unshared network namespace; host TCP addresses and raf sockets stay unreachable»: справжня пісочниця Codex; власний 127.0.0.1 працює; інтерфейси — лише `lo`; хостові TCP-адреси (127.0.0.1, ::1 і не-loopback адреси хоста, досяжні з хоста) відхилено; керівні Unix-сокети фікстури (tmux, tmp raf, bus, ssh, cc-socks, сусідній запуск) відхилено. У Y.2 `denied()` для TCP-проби ECONNREFUSED тепер допустимий: живість хостового слухача підтверджує `hostControls` до й після.

## Прогони (група complete-raf-flow-contracts/z421, файл test/codex-unix-sockets.test.ts)

| Фаза | runId | SHA / стан дерева | outcome | CLI exit | child exit | knownRed / unexecuted / unknown | cleanup |
|---|---|---|---|---|---|---|---|
| red | 6cfaae5f-2599-4a9a-ae8e-c8454ce2bb2d | 14bd866 + незакомічений тест | refused (CALLER_UNAUTHORIZED: група не зареєстрована) | 1 | — | — | complete |
| red | 2985314c-5958-417e-bc3b-c1f289f22189 | 14bd866 + незакомічений тест | assertions-failed: падіння `os.networkInterfaces()` (netlink заборонено), а не на TCP; пробу замінено на /proc/self/net/dev | 1 | 1 | 1 / 0 / 0 | complete |
| red | 4d76eb3a-205c-47bd-a63f-5429f8dc2f15 | 14bd866 + тест (закомічено в ac83c61b) | assertions-failed: власний 127.0.0.1 EACCES; 11 passed | 1 | 1 | 1 / 0 / 0 | complete |
| hotfix | 6eab5a26-c027-458b-a194-6ddb329aed6d | ac83c61b + незакомічений фікс src/codex-sandbox.ts | passed 12/12 | 0 | 0 | 0 / 0 / 0 | complete, groupState complete |

Повні TestRunResult: `red.result.json` (4d76eb3a), `hotfix.result.json` (6eab5a26). Інструмент агента об'єднав stdout і stderr; крім TestRunResult, у потоці був лише рядок `launch-queue.waiting` (queueId 15392981-91bf-41d4-857c-5fc6d4899263) і, у 2985314c, попередження `State store healthSummary.transaction failed (SQLite 5): database is locked`.

У спільному дереві під час прогонів були чужі незакомічені зміни (src/hotfix-origin.ts, src/os-runtime.ts, src/production-*.ts, src/state-*.ts, src/test-run-runtime.ts, src/test-run-unit-state.ts тощо, ймовірно Z.420); їх не змінено й не закомічено.

## Не перевірено

Інші групи з `prepareCodexSandbox` (codex-registered-tmux, codex-state-access, codex-account-state, codex-file-write-boundaries тощо) не проганялися: для Z.421 немає декларації regressionGroups. Їх варто прогнати main перед випуском, бо новий preflight виконується в кожному запуску codex.
