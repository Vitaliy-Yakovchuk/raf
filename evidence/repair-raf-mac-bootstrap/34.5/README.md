# repair-raf-mac-bootstrap:34.5

База `3db25a4a104692c7cfbc3cc9aeb1ce4ab28b20e4`, джерело Mac `origin/mac-test-run-fixes` = `fced331e585b4f2e4eca861d6adb77f0f6554b2e`. Аудит підтвердив актуальність пункту: потрібні виправлення, нових можливостей чи вимог немає. Цей результат готує hotfix для main; push та активацію виконує main.

## Перегляд комітів

Повні source/test diff комітів збережені в [source-commit-review.patch](source-commit-review.patch). Рішення щодо кожного:

| Коміт джерела | Предмет перегляду і рішення |
| --- | --- |
| `fbef2a156b487ac95b05b8a2106ca408520bafb4` | Регресія alias системного `/tmp`, приватності owner і канонічних HOME/state/tmp. Уже є в базі; збережено і виконано весь файл. |
| `23d84a67a90923c8f0b9c64d0979910eb2b0e59a` | `realpathSync('/tmp')` перед побудовою unit HOME. Уже є; перевірки приватності самого owner не послаблено. |
| `50197d23bacb6e1560c5a4296c983ddee3712178` | Той самий канонічний батько під час підготовки unit state. Уже є; hash HOME і бюджет групи збережено. |
| `64d530e3edda85896c277cf157a7e99e9215472d` | Нативні process identity/tree/reconciliation регресії. Уже є; Linux виконує три спільні нативні сценарії, два Darwin-сценарії мають окремий Mac-доказ. |
| `1083b7d2517dbb2bbe818243d4bf9c1e6573c621` | Darwin ps/sysctl, UTC/C locale, legacy boot fencing, fixtures. Нативний порт уже є, додано відсутнє `LC_ALL=C` в обидва виклики ps і незмінений locale regression з гілки. Парсери `darwinBoot`/`darwinStart` семантично тотожні спільним `resource-wait-identity.ts`; дублікати не перенесено. Канонізацію кореня unit-state-upgrade fixture перенесено. |
| `bb468b311511ec2efffacf793cdc13f662f4754c` | Preflight обирає профілі requested files/group/only для всіх проєктів. Уже є; нові контролі raf перевіряють усі три форми із відсутніми runner/dependencies стороннього профілю. |
| `4f9b36cb88616a7827a6cdf99ae84d32980a8392` | Канонізація configured temporary root. **Загублена при merge fced331**, хоча була перед ним. Відновлено після власного RED для symlink root. Канонічний Linux root і відмова unsafe target підтверджені окремими контролями. |
| `314cf450d0da0930fff482a369da140ffb0fef9b` | Executor recipient guidance адресує main без пошуку через agent ps; main/coordinator залишають пошук адресата. Перенесено зі змістовними локальними назвами замість умовного виразу всередині довгого рядка. Дозволений каталог команд не змінено. |
| `fced331e585b4f2e4eca861d6adb77f0f6554b2e` | Merge з main. Main-правки вже є в базі, повторного merge немає. Збережено спільні identity parsers; окремо відновлено втрачений temporary-root fix попереднього коміту. |
| `bca054b1e5d0179b39f7696f5c1ee686c9cc734c` | Darwin Seatbelt: native permissions, точні file grants, lexical/canonical hidden paths, без bwrap на Darwin. Уже в ancestry бази й Mac tip. Код не змінено; два simulated Darwin тести та Linux sandbox controls повністю GREEN. |

## Test-first і повна Linux-група

Стабільна група: `repair-raf-mac-bootstrap/mac-test-run-fixes`. Її 14 повних файлів і доповнення unitFiles записані в [test-registry-entry.json](test-registry-entry.json). Групу, QA HOME та SQLite aggregate не перейменовували й не скидали.

RED-команда:

```text
node /srv/dev/work/orchestrator/raf-main/bin/raf.ts test run --project raf --phase red --group repair-raf-mac-bootstrap/mac-test-run-fixes --files test/test-run-darwin-locale.test.ts test/test-run-mac-fixes.test.ts test/brief-composition-c2.test.ts
```

GREEN-команда (обидва hotfix-прогони):

```text
node /srv/dev/work/orchestrator/raf-main/bin/raf.ts test run --project raf --phase hotfix --group repair-raf-mac-bootstrap/mac-test-run-fixes
```

| Доказ | Run ID | Результат | CLI / child |
| --- | --- | --- | --- |
| [red.json](red.json) | `aedee47f-99c6-432c-8f1e-37817b2d44bf` | assertions-failed: locale, tmp alias, чотири executor stages; також 5 старих fixture assertions | 1 / 1 |
| [hotfix-1.json](hotfix-1.json) | `b2b3016b-83da-451d-8e14-cb7df854b65c` | setup-failed + assertions: цільові регресії виправлені; catalogue fixture assertion і два Darwin-only skip як unexecuted | 1 / 1 |
| [green.json](green.json) | `76f7a44f-659f-47bf-a7ca-8a217b2b3967` | **passed, 321 перевірка, 14 повних файлів**, group complete, nextAction complete | 0 / 0 |

У всіх трьох timedOut=false, timeoutCount=0, cleanup complete, remainingPids=[] і unknown=[]. Остаточні knownRed=[] та unexecuted=[]. Повні списки попередніх knownRed/unexecuted збережені в оригінальних JSON; їх не приховано під успішним результатом.

RED зафіксований комітом `21a234f8bfa5f5f69d4b14efc43a8ddab0238f1b` до зміни production-коду. RED виконувався на базі + нові незакомічені тести. Обидва hotfix-прогони: HEAD цього RED-коміту + робочі виправлення. Точні argv, SHA, вибірка, CLI code і примітки знімків — `red.command.json`, `hotfix-1.command.json`, `green.command.json`; diff/status — сусідні файли. Green diff включає сторонні production/resource/archive правки спільного дерева лише як контекст; вони не входять до власних комітів. [source-hashes.json](source-hashes.json) ідентифікує остаточний власний source/test вміст.

Кожен TestRunResult скопійовано **повністю й без перетворення** з test-run UUID файла run tmp. CLI codes збережені окремо від child exitCode. Tool обрізав combined stdout/stderr, тому `*.stderr-observed.txt` — лише отриманий транспортний фрагмент, а не вигаданий повний stderr; оригінальні tool envelopes збережено в `*.tool-output.json`. Прогони заради повторного stderr не повторювались.

П'ять старих brief fixture падінь виправлено за чинними контрактами: core/process/feature-test-authoring скасував blind mode і вимагає RED автора; projects/raf/cli-catalog вимагає перебудови compiled artifact. Каталожний тест тепер перевіряє незмінність брифа після source-only edit, компілює новий каталог і передає його через чинний аргумент composeAssignmentBrief; перевірка заміненого параметра стосується згенерованого guide, а не статичних task templates. Production flow не змінено.

Два нативні Darwin тести реєструються лише на Darwin замість реєстрації зі skip на Linux: ті самі тіла, імена й assertions виконуються на Mac. Linux раніше їх також не виконував; його adapter трактував skip як unexecuted/setup. Остаточний `removed` чесно містить ці два platform-only ID і тимчасово перейменований catalogue ID з hotfix-1; оригінальний catalogue ID повернуто й він пройшов. Це не timeout optimization і не скидання агрегату.

`npm run build`: exit 0, [команда й ізольований HOME](build.command.json), [stdout](build.stdout.txt), [stderr](build.stderr.txt), [CLI code](build.cli-exit-code). HOME збігається з QA HOME unit-групи; production HOME не використано. `git diff --check` успішний.

## Darwin докази з гілки

[mac-evidence-manifest.json](mac-evidence-manifest.json) містить source commit, точний Git path і SHA-256 для 101 скопійованого без змін артефакту. Вони походять із Mac-гілки, а не з Linux-прогону:

- [Реальний ps locale output](mac-source/evidence/mac-test-run-darwin-34-2/native-ps-locale.txt): en_NZ змінює порядок місяця/дня, LC_ALL=C відновлює parser contract.
- [Підтверджений locale RED](mac-source/evidence/mac-test-run-darwin-34-2/locale-confirmed-red.stdout.txt), [GREEN](mac-source/evidence/mac-test-run-darwin-34-2/locale-green.stdout.txt), окремі command.json, stderr та exit-code файли. Перший помилково зелений locale-red теж збережено й RED ним не обґрунтовується.
- [Нативний Mac process GREEN](mac-source/evidence/mac-test-run-darwin-34-2/native-green-darwin-process.stdout.txt): 5/5, з timezone, unknown-on-scan-failure і реальним detached child cleanup; [native locale GREEN](mac-source/evidence/mac-test-run-darwin-34-2/native-green-darwin-locale.stdout.txt): 1/1.
- [Mac unit HOME RED/GREEN і baseline controls](mac-source/evidence/mac-home-20261028/README.md). Широкі старі baseline failures не названі pass. Попередні failed native HOME/upgrade fixtures у 34-2 також не подані як GREEN.

Це прямі native node:test докази: зовнішнього raf TestRunResult/runId/group у них немає. Активацію кандидата і live Seatbelt запуск ця Linux-сесія не виконувала. Наявний Seatbelt source contract і Linux controls перевірено; історичний доказ — `evidence/fix-raf-darwin-codex-sandbox/README.md`.

## Самоперевірка читабельності й приймання

Область: база `3db25a4a104692c7cfbc3cc9aeb1ce4ab28b20e4` → RED `21a234f8bfa5f5f69d4b14efc43a8ddab0238f1b` + остаточні правки [green.workspace.diff](green.workspace.diff) та source hashes. Перевірено цілі зачеплені компоненти:

- `src/brief-guide.ts:composeBriefGuide`: явна умова stage → recipientGuidance → згенерований бриф; каталог, I/O і обробка помилок збережені. Назви пояснюють відповідальність, вкладеного ternary у prose немає.
- `src/test-run-darwin-process.ts:darwinTestStart/darwinTestRows`: явні ps arguments і локаль процесу, перевірка статусу, parsing, відсів zombie. LC_ALL змінено лише в дочірніх Darwin ps; глобальний env і Linux process observer не змінено.
- `src/test-run-runtime.ts:createTestRunPorts`, property `prepareTemporary`: канонічний configured parent передається чинному компоненту підготовки; ownership, private child identity, protected contexts, reservation і cleanup лишаються у своїх компонентах. Нових перевірок, лімітів, timeout чи прихованих станів немає.
- Test fixtures мають явні workspace/HOME/tmp і cleanup. Darwin-only реєстрація не змінює нативні assertions; канонізація upgrade fixture забезпечує збіг URL import hook. Locale test відновлює mocks та env.

Предметний висновок: основний потік даних, альтернативні гілки й побічні ефекти простежуються; зайвих обгорток або нових публічних поверхонь не додано. Поведінку підтверджують 321 GREEN checks і build. Самоперевірка передана main для приймання за чинним flow.

## Передача root документів і завершення

Спроба власного root commit відмовила на `.git/index.lock`: [повна помилка й команда](root-commit-attempt.json). [Точний tasks patch](root-tasks.patch) і шляхи передано main через agent message, receipt `3b99dd8f-3fe0-47dc-ac05-c73eb051c6d0`, accepted=true.

Main підтвердив root docs commit `0547c71e0f68b35a6beff5bf43cd68f73f5811be` і registry commit `7f3d5875dac5e4c148f4d98fe25336798ba7cf5e`; [receipt та підтвердження](coordination.json). Це коміти main, не власні коміти виконавця. Блокер root документів усунуто перед JSON-звітом.

Галочку 34.5 ставить raf після succeeded. Пункти 4, 12 та 31.3 лишаються відкритими; архівація зміни не належить цьому завершенню.
