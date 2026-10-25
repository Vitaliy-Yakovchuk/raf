# QA 2.4: поточні докази, 2026-10-25

Цей каталог ще не підтверджує весь пункт `complete-raf-flow-contracts:2.4`. Unit green не замінює I1–I4/L1–L4. Початкові результати збережено, setup/refused не зараховано як product red.

## Команди й незмінені результати

Повні команди, runId, CLI/child exit, cleanup/timeout, knownRed/unexecuted/unknown, groupState і nextAction: [runs.json](runs.json). Первинний tool envelope — `*.tool.json`; повний TestRunResult — `*.TestRunResult.json`; фактично повернений об’єднаний потік — `*.observed-merged-output`. Окремий первісний stderr недоступний: за повідомленням main raf не зберігає його поза envelope. `*.stderr-unavailable.txt` є поясненням межі доказу, а не вигаданим stderr.

| Прогін | Результат | Що підтверджено |
| --- | --- | --- |
| 08174764-3f10-4c03-ac97-c134eec28b4d | passed, 47, CLI/child 0/0 | Власне unit-підтвердження двох адресних файлів, cleanup complete, group complete; knownRed/unexecuted/unknown порожні. |
| a0b0d7e4-865c-4bab-9cf0-10ecd68402a6 | assertions-failed, CLI/child 1/1 | Setup: урізаний projects fixture не відповідав чинному каталогу. Не product red. |
| 4f2f630e-2a4d-44e3-b2ca-645841aafb72 | assertions-failed, CLI/child 1/1 | Setup: неповна fixture-конфігурація commandTiming. Не product red. |
| 6e9111c5-6e0c-4b83-b47e-c88fe73df533 | assertions-failed, CLI/child 1/1 | Setup: fixture не зберігала helperExecutables/health. Не product red. |
| e17afe73-8880-49f0-ad59-b6afb1e9fce3 | refused, CLI/child 1/null | Working raf preflight: INVENTORY_INCOMPLETE для test/z423-queued-stderr.test.ts, child не запущений. |

Усі п’ять мають `timedOut=false`, `cleanup.complete=true`, `remainingPids=[]`. Перші три integration-спроби залишили дев’ять setup-failed test IDs у knownRed; це стан агрегату, а не доказ перевірки предметних інваріантів. Той самий group/QA HOME збережено; лічильник не скидали. Integration deadline — `conf/flow.json#/integrationTests/timeoutMs` (1200000 ms), unit — окремий `unitTests/timeoutMs` (1200000 ms).

Перед unit: [before.json](before.json), workspace SHA ba87382aec6af6df415a971be48cd0f44602a396, hashes релевантного коду/тестів/conf. Integration виконували у спільному дереві; окремого атомарного Git/source snapshot для кожного child не знято. Межу атрибуції явно збережено в runs.json; повні результати містять фактичні conf fingerprints і process identity. Ця прогалина не видається за clean checkout.

## Стан сценаріїв

| Сценарій | Межа доказу / залишок |
| --- | --- |
| I1 | Новий тест використовує public compiled CLI, власний справжній main/tmux/SQLite та керований runner. Після setup-виправлень ще не виконаний. Адресні факти буквального повідомлення й перевірки composer можна повторно використати з `../cfc24-agent-adapters/stand-final/scenarios.json`, але вони не доводять весь public launch. |
| I2 | Тест містить unknown, limited, fast exit, delivery failure, pane loss при живому процесі та непідтверджений cleanup із збереженням резерву до exit. Предметний результат ще не отримано. |
| I3 | Тест містить atomic succeeded + exit 7, failed/partial/invalid/no-report + exit 0, реальну паралельну reconciliation і late report A після reused-address B. Предметний результат ще не отримано. |
| I4 | [I4-reuse.json](I4-reuse.json) адресно звіряє чинні реальні OS/process/socket факти Z.390 з кодом. Не новий integration pass і не закриття native/platform matrix. |
| L1 | Host-скрипт закомічений; main поставив на host-lock чистий клон `/srv/dev/cfc24h1/raf` на ffcfae61d0af25d230045d3a8703dcceff94c695, послідовно codex/grok/agy/claude. За останнім повідомленням ще не стартував. Результатів немає. |
| L2 | Позитивні native readiness/версія можуть спостерігатися під час L1, але intentional unknown/permission/auth і повна native UI матриця ще не виконані. |
| L3 | Native probe містить позитивні directory/file/Unix IPC/git і негативні canary/state/WAL/SHM/symlink. Справжнього результату немає; registered tmux, bus/ssh-agent, child і сусідні questions явно не закриті. |
| L4 | Наші дозволені прості test run/agent message підтверджують лише фактично виконані виклики. Повна native transport/concurrency/large-result/negative-shell і spec/design commit матриця не підтверджена. |

## Власні підготовлені файли

- `test/agent-adapters-integration.test.ts` — точний окремий integration preset, не unit inventory.
- `test/agent-adapters-public-fixture.ts` — справжній приватний main у tmux, public CLI child для кожного запиту; паралельні запити запускають окремі процеси.
- `test/agent-run-fixture.ts` — production QA зберігає повну чинну конфігурацію та inventory projects до buildCatalog.
- `scripts/qa-agent-adapters-live.ts` — host-only driver із новою evidence-директорією, точним reviewed SHA, приватним HOME/state/tmux і справжнім native executable; глобальні auth/config не змінює.
- `scripts/qa-agent-adapters-probe.mjs` — виконується самим native агентом у його sandbox; ENOENT не приймає за доказ заборони читання.

Host invocation (один runner, нова evidence-директорія; існуючі auth selectors задає власник):

```text
node scripts/qa-agent-adapters-live.ts ffcfae61d0af25d230045d3a8703dcceff94c695 codex /srv/dev/cfc24h1/codex/ev
```

Аналогічно grok/agy/claude; main володіє host-lock. Немає правди про їхній rc, stdout, stderr, identity чи cleanup до повернення доказів.

Main тимчасово зняв integration-реєстрацію (conf 351217774a) через робочу raf Z.423/Z.424. Нових integration-команд після повідомлення про паузу не запускали. Для продовження потрібні чинний artifact із виправленнями та явне повідомлення main про повернений preset/авторизацію; обхід inventory/sandbox не використовується.
