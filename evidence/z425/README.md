# Z.425 — сумісність preflight Z.390 і loopback TCP Z.421

Доручення: `complete-raf-flow-contracts:Z.425`. Аудит proposal, вибраного tasks item, agent-adapters («Адреси тимчасових Unix-сокетів raf», «Примусова ізоляція codex перед дозволом IPC»), test-first та unit-test-runs підтвердив актуальність дефекту. Джерело test-runs знайдено в активній залежності `openspec/changes/add-raf-test-run/specs/projects/raf/test-runs/spec.md`; канонічного spec ще немає.

База всіх прогонів: `e860ffae5818e46b574b7a1f2c788a9639a43058`, гілка hotfix, робоче дерево `/srv/dev/work/orchestrator/raf-hotfix`. Сторонній untracked `node_modules` не змінювався. Стан тестового файла до виправлення збережено у `red-workspace.patch`, після — у `fixed-workspace.patch`. Усі власні зміни обмежено тестовим файлом і цими доказами.

Причина: shim Z.390 сам встановлював `deny-tcp.bpf` (EPERM для AF_INET/AF_INET6) і викликав абсолютний `/usr/bin/bwrap`, оминаючи підготовлений production backend. Це несумісно з чинним Z.421: власний TCP у unshared namespace має працювати. Відмова production preflight була правильною. Перед виправленням додано witness фактичного TCP-listen; усі 4 старі позитивні сценарії самостійно відтворили очікуване падіння. Виправлено помилку fixture за core/process/test-first, без зміни production-коду, очікуваних Unix-адрес, hidden-path перевірок або fail-closed. Shim тепер знаходить підготовлений `bwrap` через PATH і використовує його network namespace/seccomp; власний застарілий фільтр прибрано. Дескриптор порожнього файла для deny mounts відповідно перенесено з 4 на 3.

| Доказ | runId | Outcome | CLI / child | Відбір |
| --- | --- | --- | --- | --- |
| `refused-z425.*` | f58ad283-f314-4c44-8a43-ccfc835da492 | refused, CALLER_UNAUTHORIZED | 1 / null | z425 ще не налаштовано |
| `refused-group-rename.*` | 52b2ffd9-3fe6-483b-886e-9103ad832c89 | refused, GROUP_RENAME_REFUSED | 1 / null | новий z425 preset, 2 файли |
| `red.*` | 43a81609-d2f7-4315-9dea-6646df30bd8f | assertions-failed, 4 knownRed | 1 / 1 | z390, preflight-path файл |
| `green-z390.*` | 207ad7ed-669a-4058-a2f5-ee5e8569795d | passed, 77 tests | 0 / 0 | повний z390 preset, 4 файли |
| `green-z421.*` | 494996ad-1d78-4f67-9f66-1751ddc7c7f2 | passed, 12 tests | 0 / 0 | повний z421 preset, codex-unix-sockets |

Кожний `*.stdout.json` містить повний незмінений TestRunResult; `*.stderr` — окрему повну діагностику CLI, включно з чергою; `*.cli.json` — точну просту команду, CLI code окремо від child exitCode і стан workspace. Доказ отримано без редиректу чи shell-обгортки дозволеної raf-команди. Повний текст tool result збережено в пам'яті до копіювання; скорочення показу в чаті не обрізало артефакт. `manifest.json` фіксує довжини та SHA-256. Побічні flow-plan попередження у stderr збережено без редагування.

Обидві відмови сталися до child, не є red і не витратили timeout budget. Після GROUP_RENAME_REFUSED виконано remediation: використано чинні z390 і z421 з їхнім агрегатом та тим самим ізольованим QA HOME `/tmp/raf-unit-1000/1ee10007bf6d5e71b39d6a2873064a767eeb928e7910599b166a0d60270ff685`. Стан z425 був absent/idle. Main повідомлено про обидві відмови; другий receipt `d79c14a2-23be-4cf3-8ec4-79a32aba8f59`. Немає перейменування чинної групи, reset SQLite/HOME чи обходу sandbox. Новий preset z425 не використовувався для запуску child.

В усіх фактичних прогонах cleanup complete, remainingPids порожній, timedOut=false, timeoutCount=0. Red має 4 knownRed з `host TCP isolation unverified: EPERM`, unexecuted/unknown порожні, groupState=idle, nextAction=implement. Обидва green мають knownRed/unexecuted/unknown порожні, groupState=complete, nextAction=complete. Green Z.390 також зберігає негативні перевірки preflight відмови, backend selection, приватних socket/tmux адрес і cleanup; Z.421 перевіряє справжній Codex, власний IPv4 listen/connect і недоступність host TCP/raf sockets/hidden state.

`git diff --check` успішний. Build не потрібен для зміни лише test fixture: production source і каталог не змінено. Unit-результат не оголошує виконаними інші QA/live задачі. На завершення лишалися інші відкриті пункти зміни; tasks.md не змінювався, archive не виконувався. Наступна дія — прийняття JSON і checkbox Z.425 силами raf; випуск/активація належать main.
