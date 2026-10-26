# QA 2.4: поточні докази, 2026-10-25

Цей каталог ще не підтверджує весь пункт `complete-raf-flow-contracts:2.4`. Unit green не замінює I1–I4/L1–L4. Початкові результати збережено, setup/refused не зараховано як product red.

## Продовження 2026-10-26: Claude fixture red → fix → green

Власну помилку відсутнього Claude brief виправлено без повторного QA-проходу. Перед fix збережено [SHA, diff і початковий helper](brief-red-before.json); фактичний unit assertion-red `15eea3e5-dc95-497e-be15-4bbf17d04a63` перевірив відсутність вибраного runner brief (47 інших тестів пройшли). Helper тепер копіює справжній brief вибраного runner у приватний conf. Scoped QA green `eb2c45dc-b01e-43f1-89b8-72ba80dd599a` підтвердив цю регресію: CLI/child 0/0, group complete, knownRed/unexecuted/unknown порожні, cleanup complete, timeoutCount 0. Group і QA HOME незмінні. Повні команди, результати й межа stderr: [brief-regression-runs.json](brief-regression-runs.json), `brief-{red,green}.{TestRunResult.json,tool.json,stderr,observed-merged-output,cli.json}`. Відмову несумісного відбору `--files` + `--only` також збережено окремо, child не запускався; це не red або green.

Первісні host-сценарії нижче лишаються failed: unit підтверджує лише підготовку фікстури. Native L ще не виконані. `npm run build` після fix — CLI 0. Main підтвердив робочу raf ec8d770 (Z.420–Z.426) та develop merge 2b40b7b. Канал відновлено: unit результати отримані, agent message доставлено з receipt `cc2dded8-4242-48b3-a97a-94df09ff93ce`. Integration preset на момент перевірки conf 458080c5a8 відсутній; чекаємо явного повернення main, нових integration викликів під час паузи немає. Для власного tmux-routing дефекту запитано лише початковий ізольований host red; після результату той самий QA негайно виправляє й перевіряє цю регресію. Попередні записи нижче є незміненою історією обмежень, актуальний стан — тут і в completion.json.

## Продовження 2026-10-26: отримані host-результати та відмова каналу

[host-first-results/index.json](host-first-results/index.json) індексує 56 оригінальних файлів шести завершених host-прогонів: окремі `exit`, `stdout`, `stderr`, повні JSON, native version streams. Файли скопійовано побайтово з наданих main `/srv/dev/cfc24h1` і `/srv/dev/cfc24h2`; індекс містить SHA256 і точні host timestamps. Нативні перевірки не виконані (`checks=[]`); усі host driver rc=1, public launch CLI/child=1/1, cleanup complete. Це нові фактичні результати замість попереднього стану «у черзі» нижче.

| Стенд / runner | Версія | Первісний результат |
| --- | --- | --- |
| L1 ffcfae61 / codex | 0.163.0 | `RESOURCE_WAIT_FAILED`: недостатній залишок диска після reservation; запуск resource-wait service також відмовив через неповний runtime inventory. |
| L1 ffcfae61 / grok | 1.0.67 | `NO_SUITABLE_CAPACITY`: pre-brief native identity evidence unavailable, quota unknown. |
| L1 ffcfae61 / agy | 1.4.7 | `NO_SUITABLE_CAPACITY`: pre-brief native identity evidence unavailable, quota unknown. |
| L1 ffcfae61 / claude | 2.1.310 | `LAUNCH_FAILED`: у QA-фікстурі відсутній `conf/briefs/runners/claude.md`. |
| L3-full 3ee65c2 / codex | 0.163.0 | Та сама відмова resource-wait до native запуску. |
| L3-full 3ee65c2 / claude | 2.1.310 | Та сама відсутність runner brief до native запуску. |

Це збої передумов/setup, не product red і не native acceptance. Чинний conf не має `native` dialect для grok/agy; не вигадуємо identity або quota. Runtime-політику ресурсів і глобальні конфіги не послаблено. Неправильний Claude brief є власною помилкою host-фікстури, а не mainHotfix; для її test-first виправлення ще потрібен дозволений початковий assertion-red та scoped green.

Окремо source review встановив власний дефект нового L3 probe: PATH `tmux` потрапляє в fixture shim, що відкидає `-S`/`-L` і підставляє socket контрольного private main. Сам probe ще не виконувався, тож source review не видається за підтверджений red. Підготовлено `scripts/qa-agent-adapters-tmux-regression.ts <reviewed-full-sha> <new-absolute-evidence-dir>`: host-only перевірка endpoint routing з окремим власним контрольним сервером, повними потоками та cleanup. Вона має зберегти identity контрольного сервера й перевірити реальний executable та окремий socket позитивної проби. Це регресія драйвера, не приймання native sandbox. Після початкового падіння той самий QA має відразу виправити явний executable і перевірити лише цю регресію; фактичних red/green поки немає, probe не змінено.

Доставка попередження main не відбулася: [channel-refusal.json](channel-refusal.json), [повний tool envelope](channel-refusal.tool.json), [незмінений merged output](channel-refusal.observed-merged-output). Дозволений `agent message` повернув CLI 1, `STATE_CONTEXT_REFUSED`, відсутній `raf-hotfix/registry.json`; receipt немає. Новий префікс каналу запитано в чаті. Нічого не підставляли замість заданої CLI, state не створювали, QA HOME/групу не скидали. Паузу integration збережено до явного повернення preset main. Закриття агентів Z.425/Z.426 не є підтвердженням випуску чи авторизації.

`node --check scripts/qa-agent-adapters-tmux-regression.ts` і `npm run build` — CLI 0. Це перевірка підготовленого коду, не виконана регресія і не заміна I/L. Старі записи нижче збережено як історію доказів; актуальний стан host описано в цьому розділі.

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

## Перевірка збірки

`npm run build` після усунення чужих коментарів завершився CLI 0; повний tool envelope збережено у [build-green.json](build-green.json). Початковий build-check.json містить окрему чужу source-comment відмову й повідомлення main. Збірка підтверджує компіляцію; предметні integration/native сценарії цим не закриваються.

## Адресні факти живого Codex із наявного host-стенда

[native-codex-reuse.json](native-codex-reuse.json) посилається на реальний перевірений стенд 4e1d2345b9d4134df73e03fb9fb2f88c6b311db1: два native ID, 6 accepted message receipts незалежно зіставлені з user-role отриманням, 6 повних ps stdout по 77341/77342 символи звірені з CLI audit; 8 завершених native helpers мають індекси виконаних IPC/Git/state/registered-tmux перевірок і raw exit/stderr. Джерела вже містять host review та контроль існування/живості endpoint; сам ENOENT не доводить заборону доступу до наявного ресурсу.

Збережено source hashes і [повний релевантний drift](native-codex-source-drift.patch). Після стенда змінилися network filter/preflight Codex та message/lifecycle код. Тому зараховуються лише виконані історичні факти; весь поточний L1/L3/L4, інші runners, bus/ssh-agent, questions та spec/design commit лишаються непідтвердженими. Чужу unit-регресію не запускали.

## Передумови продовження

[pending-prerequisites.json](pending-prerequisites.json) зберігає точну чинну Git-цитату Z.425, останній refused runId, чергу host на reviewed SHA та ще неперевірені native критерії. Закриття агентів Z.423/Z.424 не означає випуску у робочу raf: main повідомив про чотири нові preflight-падіння кандидата e860ffa, які блокують повернення preset. Це запис зовнішніх передумов, а не фінальний звіт або відкладення за рішенням власника.

## Додатковий host-стенд L3-full (ще не виконаний)

Додатковий режим `scripts/qa-agent-adapters-live.ts <reviewed-full-sha> codex <new-evidence-dir> L3-full` (так само claude) перевіряє ще непокриті захисні сценарії. `scripts/qa-agent-adapters-controls.ts` перед native запуском тримає справжній власний SQLite/WAL/SHM, створює лише приватні nonsecret secrets/questions canaries та Unix listeners bus/ssh-agent/host і бере socket зареєстрованого private main. Host перевіряє наявність/identity та з’єднання до і після native проб; operational services чи credentials не читаються.

`scripts/qa-agent-adapters-extra-probe.mjs` виконується самим native агентом: власні file/Unix IPC/Git commit/tmux, а для кожного захищеного контрольного ресурсу — direct/symlink/справжній child. Masked ENOENT має сенс лише разом із незалежним host before/after контролем існування та живості; без успішного host verify режим не проходить. Первісний probe зі строгим EACCES/EPERM не змінений. Новий режим не зараховує заново L1: native lifecycle є передумовою нових L3 проб.

Це підготовка сценаріїв, не green і не повтор виконаних перевірок. Перевірка синтаксису трьох файлів та `npm run build` завершилися 0. Фактичних native результатів нового режиму немає; попередній queued host на ffcfae61 лишається без змін. L2 та L4 цим режимом не закриваються.
