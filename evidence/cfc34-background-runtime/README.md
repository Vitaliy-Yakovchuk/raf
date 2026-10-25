# QA complete-raf-flow-contracts:3.4 — 2026-10-25

I1–I7 пройдено на власному ізольованому живому стенді. Нижче наведено окремі результати; `incomplete` попередніх збірних запусків не перетворено на `passed`. Нового дефекту background-runtime не виявлено. Виправлено передумови й очищення самого QA-стенда у [scripts/qa-background-runtime.mjs](../../scripts/qa-background-runtime.mjs). Production-код ця QA не змінювала.

Предметне джерело: `openspec/changes/complete-raf-flow-contracts/background-runtime-design.md`, «Окреме живе приймання I1–I7 для 3.4», та повна delta background-runtime. Перед завершенням перевірено актуальність 3.4: суперечності з предметним контрактом немає. Інші відкриті пункти не виконувалися; tasks.md, sync/archive і push не змінювалися.

## Прийняті результати

| Сценарій | Доказ | Фактичний результат |
| --- | --- | --- |
| I1 | [local-5/summary.json](local-5/summary.json), [origin](local-5/I1-origin.json) | Fresh status; два одночасні окремі CLI start та повторний start дали одного власника/PID/epoch. Реальні entry/cwd/mainPath прив'язані до покоління; просування логічного main не змінило живого власника. |
| I2 | [local-5/I2-faults.json](local-5/I2-faults.json) | Відсутні main/entry, recovery fail, gated readiness, stale endpoint і неперевірний живий owner відхилені. Немає успішного enqueue, чужого kill/unlink; sentinel endpoint і власний fixture-worker, який у цьому сценарії грає роль неперевірного власника, збережені. |
| I3 | [local-5/I3-state.json](local-5/I3-state.json) | Stop та повторний stop завершили службу. Окремий status показав stopped; SQLite зі справжніми session/reminder/reservation записами й живий worker збережені. |
| I4 | [local-5/I4-diagnostics.json](local-5/I4-diagnostics.json) | Контрольований exit 17 зберіг причину; SIGKILL власної служби дав failed з null/false замість вигаданої причини. Stop не переписав crash. Пошкоджений diagnostic record дав ненульовий CLI code. |
| I5 | [local-I5/I5-grants.json](local-I5/I5-grants.json), [local-channel-final/I5-channel.json](local-channel-final/I5-channel.json) | Справжній grant, restart, збереження lastGrant; наступний grant через 15141.21041 мс після ready за interval 15000 мс. Pending клієнт під час stop отримав service_stopped/exit 1. Окремо pending Unix-клієнт після SIGKILL отримав connection lost/exit 1; lastGrant незмінний, epoch новий, старий клієнт не відродився. |
| I6 | [host-I6-lean/summary.json](host-I6-lean/summary.json), [delivery/SQL](host-I6-lean/I6-delivery.json), [HTTP requests](host-I6-lean/upstream-requests.jsonl) | Production bug-sync через справжній локальний HTTPS upstream і спільну доставку: new bug та person comment прийнято рівно по одному разу. Без main comment залишився noticed_at:null, після повернення main — доставлений. Чотири повторні batch не дали дубля. Без injected sharedDelivery. |
| I7 | [local-native/I7-messages.json](local-native/I7-messages.json) | За відсутньої/зупиненої служби системний producer отримав accepted receipt, живий CLI спожив literal marker. Звичайний перевірений cfc34-worker надіслав текст зі схожим підписом; канал додав його справжнього автора, не привласнив [raf]/[main]. Service не стартував. |

Для I1–I4 використовуються завершені окремі сценарії `local-5`, хоча весь цей запуск `incomplete` через неправильну reservation fixture у I5. I5 виправлено й перевірено окремо. I7 повторно підтверджено у `local-native` після peer-коміту `4d032d1dc44927c15b70ac908346a0ccf2dddd86`, який перевіряє native acceptance. Усі прийняті вище сценарії мають cleanup.complete:true, remaining:[], fixtureRemoved:true. Зведені точні SHA/argv/workspace та посилання — [verification.json](verification.json); raw JSON не переписувалися.

## Відтворення й походження

Локальний cwd: `/srv/dev/work/orchestrator/raf-develop`. Команди завершених адресних перевірок:

```text
/opt/dev/node/bin/node /srv/dev/work/orchestrator/raf-develop/scripts/qa-background-runtime.mjs evidence/cfc34-background-runtime/local-5 --no-tcp
/opt/dev/node/bin/node /srv/dev/work/orchestrator/raf-develop/scripts/qa-background-runtime.mjs evidence/cfc34-background-runtime/local-I5 --no-tcp --scenarios=I5
/opt/dev/node/bin/node /srv/dev/work/orchestrator/raf-develop/scripts/qa-background-runtime.mjs evidence/cfc34-background-runtime/local-native --no-tcp --scenarios=I7,I5-channel
/opt/dev/node/bin/node /srv/dev/work/orchestrator/raf-develop/scripts/qa-background-runtime.mjs evidence/cfc34-background-runtime/local-channel-final --no-tcp --scenarios=I5-channel
```

Main виконав I6 на чистому клоні `6955590627bd81584c690f8411edb1a326305151`, cwd `/srv/dev/c34h/raf-develop`, без змінних робочої сесії, LC_ALL=C, окремі HOME/TMPDIR на `/srv/dev`:

```text
/opt/dev/node/bin/node /srv/dev/c34h/raf-develop/scripts/qa-background-runtime.mjs evidence/cfc34-background-runtime/host-I6-lean --only-I6
```

[host.stdout](host-I6-lean/host.stdout), [host.stderr](host-I6-lean/host.stderr) (порожній), [host.exitCode](host-I6-lean/host.exitCode) (0) збережено окремо. Main підтвердив build 0, status=passed, I6 passed, cleanup complete=true/remaining=[]/fixtureRemoved=true і secscan 0. Повний скопійований каталог збережено без змін. Для фінальної локальної перевірки [driver-tool-result.json](local-channel-final/driver-tool-result.json) зберігає зовнішній exit_code 0. Для ранніх локальних драйверів окремого raw outer-exit файла немає: висновок ґрунтується на повному scenario JSON та збережених результатах дочірніх CLI; їхні коди не видаються за код драйвера.

Версії у всіх прийнятих запусках: Node v26.12.1, SQLite 3.54.0, Git 2.53.0, tmux 3.6, Linux 7.0.0-30-generic. CLI — зібраний каталог exact SHA кожного `summary.json`, не версія глобального raf. Там само записані незакомічені файли робочого дерева, fingerprints вихідного conf і fixture conf та fixture Git commit. У ранніх локальних snapshot були чужі незакомічені правки; у runtime копіювався лише committed source SHA, вони не тестувалися й не комітилися нами. Незакомічений власний harness описано відповідними власними комітами. У фінальних local-channel-final/host-I6-lean джерело чисте, крім каталогу доказів.

Кожен запис `commands[]` має точний argv/cwd, окремі stdout/stderr, CLI exitCode, signal/error й duration у відповідному `<label>.json`, `<label>.stdout`, `<label>.stderr`. Це exit конкретного CLI-процесу, відокремлений від JSON exitCode операції й зовнішнього драйвера. Очікувані негативні сценарії мають ненульові коди. SQL до/після, origin, pending sockets, diagnostics, receiver markers та service.log збережені поруч. Автоматична перевірка цілісності цих посилань наведена у verification.json.

Стенд створює власні HOME/state.sqlite/bugs.sqlite, мінімальний Git root, generation, Unix endpoint, tmux-сокети й CLI-процеси; перед відкриттям передає QA HOME кожному нащадку. Вихідні конфіги копіюються й адресно налаштовуються тільки всередині fixture; власні синтетичні TLS/secret upstream не є production-обліковими даними. Служба працює з реальним production host/ports/SQLite; entry додає лише origin-лог і явні recovery/crash fault режими. Фінальна lean-копія виключає evidence/docs та використовує os.tmpdir()/TMPDIR, щоб не копіювати накопичені докази в обмежений /tmp.

Отримувач — власний живий stdin CLI у справжньому tmux, який показує налаштований Claude native-screen context/empty composer, споживає literal текст і змінює панель після прийняття. Main attach та ordinary sender перевіряються за реальними OS/tmux identities. Це контрольований screen fixture, не справжній AI runner і не доказ його startup/readiness або семантичної відповіді. Такі перевірки належать 2.4; тут перевірено production wiring background-runtime до спільного каналу. Receipt, SQL noticed_at та literal consumption перевірено разом; injected delivery callback не застосовувався.

## Попередні невдалі/неповні спроби

| Каталог | Результат і виправлення стенда |
| --- | --- |
| live-1 | Setup incomplete: HTTPS TCP listen заборонений sandbox; I6 не виконувався. Main виконав його на дозволеному ізольованому хості. |
| local-2 | Setup: звуження projects fixture зробило приклад catalog невалідним; збережено повний projects catalog. |
| local-3 | Setup: створення вже наявної develop branch; виправлено власне fixture worktree setup. |
| local-4 | Непідготовлений production-store split під час одночасного start дав guard refusal; це не red. Стенд тепер викликає справжній prepare до паралельних клієнтів. Повного результату драйвера/другого клієнта немає, pass не заявляється. |
| local-5 | Загалом incomplete: I5 має неповну resourceBundle/machineIdentity reservation. Виправлена fixture, адресний local-I5 passed. I1–I4/I7 мають власні завершені результати. |
| host-I6-native | Exit 1, stderr порожній, incomplete: upstream fixture використовувала author_kind human замість чинного person, тому очікуваний pending comment не створився. Виправлено fixture API; успіх — host-I6-lean. |
| local-native | I7 passed; I5-channel не створив pending, бо зміна логічного конфіга не змінила pinned generation. Виправлено передумову реальним grant/restart; фінальний local-channel-final passed. |
| local-channel | Setup disk I/O/EDQUOT; cleanup snapshot теж зірвався. Повного завершеного результату немає. Виправлено lean archive/TMPDIR і обробку помилки snapshot під час cleanup. |
| host I6 на f78e737 | EDQUOT до сценарію; повного каталогу/raw результату main не зберіг. Доступне лише [дослівне повідомлення main](host-I6-edquot-main-message.txt). Ця спроба не є pass або red. |
| local-channel-lean | Сам I5-channel passed; весь запуск incomplete: негайний cleanup scan побачив ще завершуваний tmux-child. Додано bounded очікування завершення власного дерева; фінальний local-channel-final має повне очищення. |

Два старі власні fixture-каталоги після незавершених спроб видалено окремо після підтвердження main про відсутні активні процеси та власної перевірки tmux-сокетів: [deferred-cleanup.json](deferred-cleanup.json). Невідомі/неповні результати вище не замінюються фінальним pass заднім числом.

## Канал виконання та наступна дія

Main явно доручив живий власний ізольований стенд: чинний working raf не підтримує цей integration profile, а launch assignment не дозволяє додати його після запуску. `raf test run` тут не виконувався, TestRunResult/runId не існує. Unit-регресія у 3.4 умовна; production-код не змінювався, нової product assertion-red немає. Групу `complete-raf-flow-contracts/raf-background-runtime`, її HOME/ledger/knownRed не скидали й не змінювали; її поточний стан не перевірявся і unit pass не заявляється. Живі deadline/очікування не трактувалися як unit-timeout виняток.

3.4 готовий до прийняття raf за цими доказами. Галочку ставить і комітить raf. Інші пункти зміни відкриті, тому архівація не застосовується. Перенесення runtime та реєстрація майбутнього integration preset — повноваження main; цей звіт не заявляє такий прогін.
