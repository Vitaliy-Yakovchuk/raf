# QA 2.4: поточні докази, 2026-10-26

Пункт `complete-raf-flow-contracts:2.4` ще не виконаний повністю: живі L1–L4 не підтверджені. Актуальний стан — [completion.json](completion.json). Setup/refused не є red; unit і керований runner не замінюють native acceptance. Галочки/tasks.md не змінено, push/archive не виконано.

## Підтверджене інтеграційне виконання

[resumed-regressions.json](resumed-regressions.json) містить точні команди, відбір, runId, CLI/child, group state, cleanup, timeout та fingerprints. `integration-cases/*.json` містять фактичний HEAD, власний diff і hashes, identity, selection/model/effort/argv/cwd, буквальний бриф, SQLite claims/admission, before/after та результати справжніх окремих compiled CLI процесів і private main/tmux. Керований runner має версію 0.0.1; це не справжній codex.

| Прогін | Результат | Межа |
| --- | --- | --- |
| c80c3794-4c1f-4c4c-9891-2b543e8195dd | assertion-red, CLI/child 1/1, 3 passed / 9 failed | Початкові failed збережено. Виявлено ігнорування configured limit, помилку literal JSON assertion і primary failure assertion. |
| 02d94002-9aa5-4844-a46d-9234c96f17e3 | unit assertion-red, CLI/child 1/1, 48 passed / 1 failed | Додатково відтворено втрату супровідного коду LAUNCH_RECOVERABLE. |
| 6f81de0e-1de6-45da-b18f-fbb50a00106a | scoped unit green, CLI/child 0/0 | Лише нова U5 регресія; same group/HOME, group complete, knownRed/unexecuted/unknown порожні. |
| 60d18c03-4100-439e-8f11-0d79ffcd1fc4 | integration green, CLI/child 0/0, усі 12 passed | I1–I3: identity/selection, один повний буквальний brief, report/exit, late A/B, claims і cleanup. Інтеграційний канал не підтримує --only, тому той самий exact file перевірив виправлення. |

У всіх цих прогонах cleanup complete, remainingPids порожні, timedOut false, timeoutCount 0. Deadlines прочитані з відповідних unitTests/integrationTests у conf/flow.json (1200000 ms), callerPhase qa. Первинний delivery LAUNCH_FAILED залишається першим; LAUNCH_RECOVERABLE збережено як супровідний код, reservation не знімається до verified exit. Порівняння brief тепер перевіряє весь published text та decoded literal task без послаблення критеріїв.

[Адресне I4 reuse](I4-reuse.json): 50 раніше виконаних OS/socket/process фактів Z.390 з точним SHA, hashes і межами. Новий повний native/platform pass цим не заявляється. [Historical native Codex reuse](native-codex-reuse.json) має явний source drift та адресує лише фактично виконані native identity/message/IPC/git/large-result факти.

## Виправлення фікстур у цьому ж QA

- Claude brief: справжній unit red `15eea3e5-dc95-497e-be15-4bbf17d04a63` → copy selected real runner brief → scoped green `eb2c45dc-b01e-43f1-89b8-72ba80dd599a`. [Команди й докази](brief-regression-runs.json). Host setup failure не видається за red; native acceptance ще не виконана.
- L3 tmux: [host red](tmux-red/summary.json) на `836eed6bac427399e27bf02d98ad81e7b33fe1ac` справді втратив distinct protected private server. Fix `2044c1b67cd462a617851e54ed524fe111b925d8` передає actual /usr/bin/tmux через manifest; позитивна проба користується own -S socket, обходячи fixture PATH shim. [Host green](tmux-green/summary.json): rc 0, status passed, protected identity unchanged, ownSocketRemains true, cleanup complete. Обидві пари stdout/stderr/exit та SHA256 index збережено побайтово. Це регресія власної host-фікстури, не приймання native sandbox.
- Setup fixture: productionQa зберігає повний inventory/projects і state contention; старі setup failures лишилися в доказах і не зараховані як предметні red.

`npm run build` після поточних виправлень — CLI 0; `git diff --check` — 0. Збірка не замінює I/L.

## Живий host: фактичний неперевірений залишок

[host-first-results/index.json](host-first-results/index.json) індексує 56 оригінальних файлів шести завершених host-спроб, включно з окремими stdout/stderr/exit, native --version і JSON. У всіх driver rc 1, public CLI/child 1/1, native child невідомий, checks порожні, cleanup complete:

| Режим / runner | Версія | Первісна передумова, що не виконалася |
| --- | --- | --- |
| L1 і L3-full / codex | 0.163.0 | RESOURCE_WAIT_FAILED: залишок tmpfs після reservation нижчий за незмінну runtime-політику; resource-wait також відмовив через inventory. |
| L1 / grok | 1.0.67 | NO_SUITABLE_CAPACITY: native dialect/identity evidence unavailable, quota unknown. |
| L1 / agy | 1.4.7 | NO_SUITABLE_CAPACITY: native dialect/identity evidence unavailable, quota unknown. |
| L1 і L3-full / claude | 2.1.310 | Відсутній runner brief у власній fixture; тепер виправлено з unit red/green, native запуск ще не підтверджений. |

Потрібні чинні owner auth selectors та повний runtime inventory приватної main fixture; для grok/agy — перевірений native dialect/identity/quota. H6 без спеціального TMPDIR також відмовив через inventory під час очікування ресурсів, тому TMPDIR не є доведеною єдиною причиною. Resource policy не послаблювалася. Глобальні credentials/conf та liveTaskVerified не змінювалися. L2 intentional trust/auth/permission/unknown/version і L4 native transport/concurrency/test-run/spec-design commit матриці лишаються відкритими. Скрипти готові: `scripts/qa-agent-adapters-live.ts <reviewed-full-sha> <runner> <new-absolute-evidence-dir> [L1|L3-full|L3-regression]`; L3-full застосовний до codex/claude. Main володіє host-lock. Новий запуск допустимий лише для ще невиконаних перевірок або підтвердження виправленої власної регресії.

## Повнота й походження потоків

`*.tool.json` зберігають повний незмінений tool envelope; `*.observed-merged-output` — точний повернений потік; `*.TestRunResult.json` — повний JSON без переформатування. Tool об'єднує stdout/stderr, тому `*.stderr` містить весь фактично спостережений envelope без рядка TestRunResult, включно з launch-queue.waiting; це не вигаданий окремий первісний pipe. CLI code збережено окремо від child exitCode. Host-потоки скопійовано окремо побайтово.

[runs.json](runs.json) зберігає початковий unit green 47 тестів і старі integration setup/refused. `integration-resumed-setup.*` — setup contention failure, не red. `tmux-setup-refused/` — setup INVALID_VALUE, не red. `channel-refusal.*`, `pending-prerequisites.json` — історична пауза до випуску Z.420–Z.426; main згодом явно повернув preset conf 1754e0f677 та дозволив exact integration. Старі відмови не переписано й не перетворено на pass.

## Продовження: типовий host HOME Claude

Main підтвердив наявний Claude config у справжньому HOME, включно з ~/.claude.json; CLAUDE_CONFIG_DIR навмисно не задається. Власний driver раніше відмовляв за unset selector. [Native HOME regression](native-home-regression.json): unit assertion red d04388c5-4472-46b7-afad-f1084af0b421 → негайний fix → scoped QA green db0cef94-670d-46c3-a50c-838de8196aad, CLI/child 0/0, cleanup complete, same group/HOME, group complete. Приватний PATH wrapper виконує resolved actual native executable з попереднім host HOME, не змінюючи isolated RAF_QA_HOME або model/effort/argv. Credentials/config не копіюються. H5 виявив окрему помилку життєвого циклу: caller передавав process.env уже після заміни HOME фікстурою. [Доказ і fix](native-lifecycle-home.json): 2569358986ab39d95373092f77598f7c69b992d6 зберігає selectors до створення стенда. H6 на цьому SHA не дійшов до readiness через setup inventory; native HOME green не заявляється.

## H5: справжній native red та межі фікстури

[Host continuations](host-continuations/index.json) зберігають H3–H6. У H5 Codex справді запустився, отримав native identity й виконав probe. L3-full підтвердив власні file/IPC/git commit/tmux та відмову доступу до state/WAL/SHM/secrets, включно із symlink/child і registered private main tmux. Незалежні host controls до/після підтверджують існування, inode/device та незмінність захищених файлів і живість сокетів. Усі початкові driver exit 1 та failed assertions збережені.

Читання сусідніх questions справді дозволялося: це дефект продукту, а не setup. Власний unit red 9eadedf7-4c1d-4163-bfe9-d6a371423fde: 50 passed / 1 assertion failed, CLI/child 1/1. Негайне виправлення маскує лише недоручені questions, зберігаючи точний дозвіл запису до призначеного файла. Подальші scoped green: be835751 — CONFIGURATION_INVALID; 91dbe5fc — RESOURCE_WAIT_FAILED Service stopped під час випуску робочої raf, child null, cleanup incomplete, group reconcile. Це не green. Після відновлення служби дозволений scoped green b1dfa57e-c01d-4161-a9a1-a741d15fb2ba пройшов: CLI/child 0/0, cleanup complete, knownRed/unexecuted/unknown порожні, group complete. [Повний агрегат](question-read-regression.json). HOME/group збережено; unit не підміняє native sandbox.

Окремі помилки host oracle виправляються без послаблення захисту: L1 тепер використовує незалежні manifest before/after controls і той самий критерій EACCES/EPERM/ENOENT, що L3-full; ENOENT приймається лише для ресурсу, існування якого підтверджено зовні. Bus/SSH-адреси тепер успадковує worker; раніше стенд створював сокети, але не передавав їхніх адрес. Unregistered socket розташований у захищеній private .raf, а довільний файл поза захищеним простором не видається за предметний red. Probe і спільний denial helper мають hashes до/після виконання. Позитивні та захисні половини залишаються обов'язковими. Host green цих змін ще не виконаний.

H6 RESOURCE_WAIT_FAILED спричинений порожнім Git main fixture, який resource-wait використовує як runtime source. Підготовлено повну копію src/bin/scripts/test/package.json, compiled catalog і приватного TypeScript для цього main. Це виправлення setup, не підтверджений assertion red і не приймання native CLI. [Поточна збірка](question-fix-build.cli.json): exit 0; окремі unit/host підтвердження мають власні результати.

## Claude inherited host endpoints

[Власна регресія](claude-endpoints-regression.json): первісний SQLite header refusal 0d079cdc — setup, не red; main підтвердив цілісність DB, завів робочу hotfix Z.431 й дозволив один незмінний повтор. Справжній assertion-red 62ca7475 (51 passed / 1 failed) передує production fix. Scoped green 3d0f76a8: CLI/child 0/0, cleanup complete, group complete, knownRed/unexecuted/unknown порожні. Claude settings тепер приховують inherited TMUX/SSH/XDG/DBus filesystem endpoints перед відкриттям own Unix IPC; непідтримувані bus transports відмовляють до запуску. Код Codex не змінено. Це unit доказ побудови policy, не native acceptance.

Новий host режим L3-regression виконує лише 12 первісно failed direct/symlink/child questions/bus/ssh/protected-unregistered assertions; пропущені позитивні/state/tmux сценарії явно перелічено. Усі 12 обов’язкові, before/after controls і probe/helper hashes незмінні. Повний L3-full Claude залишається першим реальним native проходом, оскільки попередні спроби мали checks=[]. [Post-fix workspace](post-fix-workspace.json) зберігає спостережені HEAD/diff/hashes з явною межею щодо часу запуску child.
