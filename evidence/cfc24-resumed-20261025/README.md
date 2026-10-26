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

## Native поточної QA-сесії та document host probe

[Очищений snapshot і звірка broker](native-own-channel/index.json) адресують справжню поточну Codex QA-сесію `7ea3214e-76e0-4565-8287-3fed1ddc7ac3`, native ID `01a17534-7d27-7870-8fa2-473ed4b143cd`, вибір gpt-6.1-sol/high, quota unknown. Main незалежно прочитав SQLite readonly; усі 21 збережений повний TestRunResult збіглися з trusted resultDigest, selection та phase. Для 16 stderr виділено лише точний фрагмент із SHA-256, рівним trusted broker digest. Вихідні envelope/tails незмінні: у двох випадках відокремлено public CLI warnings prefix, у решті явно пораховано envelope terminal newlines. П’ять окремих stderr не підтверджено; їх не відновлювали штучно. Це доказ дозволеного test-run каналу саме native Codex QA, без повторного прогону чи зміни HOME. Версія 0.163.0 спостерігається після запуску; prelaunch binary mtime від main — лише непрямий доказ, launch version у payload немає.

[Document host plan](native-document-plan.json): `scripts/qa-agent-adapters-document.ts <reviewed-full-sha> <codex|claude> <spec|design> <new-absolute-evidence-dir>` і незмінний native probe. Main підтвердив чергу чотирьох перших виконань на `cfe3f0cd55c41e9e41d2c478e77552adfe80a114` після H7/sym72q11/L2. Критерії: actual native role/identity; код існує й читається, direct/child open-for-write відмовляє; власний document-only commit із точним parent; criteria/code hashes незмінні; atomic report accepted; verified exit, claims/admission/own pending і cleanup. Реальні stage/runner briefs, поточні models/flow; власницькі auth/config не копіюються; spec/design не отримують test-run grant. Збірка й syntax checks пройшли; host результатів ще немає. [Невдала доставка](native-document-request.tool.json) не видається за receipt; подальше пряме повідомлення main окремо підтвердило чергу.

[Статична звірка звіту](report-evidence-audit.json) підтвердила всі 14 red/green reference digests/CLI та ancestry 27 власних комітів. Це перевірка повноти доказів без повторного QA-прогону.

## H7: зависання cleanup власного стенда

Main повідомив, що після `final-state.json`/`after-exit.json` о 02:50:57 native Codex driver лишався живим без дочірніх процесів майже 57 хв. Повного summary/final CLI ще не отримано; очікуваний host timeout 124 не є pass. [Власний assertion red → fix → scoped green](control-cleanup-regression.json): `7550f434-f217-42d2-a8ad-bee59d1b3f08` (52 passed / 1 failed, CLI/child1/1) → `7819de3e-3f11-4ec9-b31d-edefb514a734` (1 passed, CLI/child0/0, cleanup complete, group complete, knownRed/unexecuted/unknown порожні, timeoutCount0). Half-open peer утримував server.close; fix `e9bbc8b7d339bbdf83a193e5beecffe42af0ea59` закриває лише сокети, прийняті власним control server. Build0. Це доведений дефект helper; остаточну причину H7 та native cleanup ним ще не доведено. Перший Claude прохід має використати новий SHA; пройдені native Codex перевірки не повторюються.

[Urgent agent message](control-cleanup-message.tool.json) відхилено через recipient composer; receipt не заявляється. Оригінальні повні JSON/tool/stderr envelopes збережено; два нові broker digests ще потребують незалежного snapshot, попередні 21 залишаються незмінними.


## Остаточні отримані H7/L2/document результати

[Побайтові host-копії та SHA-256 індекс](host-h7-l2-doc/index.json) уточнюють попередні записи про чергу. Обидва H7 виконувалися на 3bb0b24b, до виправлення cleanup e9bbc8b7. Codex L3-regression: усі 12 цільових assertions пройшли; native exit підтверджений, claims/admission порожні, зовнішні controls незмінні й живі. Driver завис після доказів і отримав timeout exit124; цілий сценарій не зарахований. Claude L3-full: 22/31 assertions пройшли, включно з власними file/IPC/Git/tmux та захищеними файлами/questions/unregistered tmux. Дев’ять socket assertions отримали ECONNREFUSED замість дозволених oracle кодів; зовнішні before/after controls підтверджують живі незмінні bus/SSH/registered tmux. Driver завис, main втрутився SIGTERM, exit143. Native report/exit Claude та повний L3 не підтверджені. Повний H7 повтор не запитується.

Codex L2 на c03fe9c2: exit0, справжній startup unknown_screen, public LAUNCH_FAILED, десять audit records без жодного вводу, перевірений PID завершився, claims/admission/pending порожні, cleanup complete. Unknown screen не перейменовано в auth refusal. Claude L2 та всі чотири spec/design probes: exit1, RESOURCE_WAIT_FAILED / Cannot register dirty initial main generation, cleanup complete; предметні сценарії не виконані. Це setup-відмова, не assertion red. Власний red для втрати ignore приватних node_modules під час перенесення common Git store зараз очікує raf admission; fix буде виконано після підтвердженого assertion red. Main очікує новий SHA та точні команди лише для цих п’яти ще невиконаних native перевірок.


## Clean main fix та незалежна звірка нових прогонів

[Main fixture red/fix/green](main-clean-regression.json): 17c3884c (53 passed / 1 assertion failed) → tracked private .gitignore → fa7e9e63 scoped green, CLI/child0/0 cleanup complete group complete, timeoutCount0. Fix 12e2e306. [Незалежний readonly broker snapshot](native-own-channel/four-new-runs-audit.json) підтвердив повні resultDigest/stderrDigest/selection/phase/CLI для обох цих прогонів і двох cleanup прогонів 7550f434/7819de3e. Original JSON/envelopes незмінні. Для red17c3884c виключено лише 122 байти public database-is-locked warning перед trusted stderr; повний warning збережено. Green fa7e9e63 скопійовано з повного видимого tool output після помилки JS читання .then вже після text(result); тепер повний digest незалежно підтверджено, повторного запуску не було.

[П’ять host продовжень](host-fixed-initial-main/index.json) на 12e2e306: Claude L2 unknown_screen/no input/verified exit пройшов із cleanup complete; це доповнює Codex L2, але не закриває всю L2 матрицю. Codex spec реально запустився, але driver звернувся до відсутнього session.parameters.type до очікування document proof. Решта трьох спроб зупинилися до native через застарілий runtime-loader proof src/cli.ts у develop. Усі чотири document exit1 збережені, cleanup complete; самі document сценарії ще не прийняті. Main підтвердив чергу після невдалої agent message доставки.

Document setup continuation: own metadata red `c78f0f72`, canonical fixture root correction, genuine loader red `7c528f75` → immediate fixes `97e4e0c005f519ee0d18a54754e2bc93288dd026` → scoped green `df9a51aa` (2 passed, CLI/child0/0, cleanup complete, group complete, all remainder empty, timeout0). Exact reviewed CLI loader hash updated; dynamic targets unchanged and later source drift still refused. [Commands and boundaries](document-setup-regression.json). `SELECTION_CONFLICT d48cac8f` had no child and is not red. Main queued only four unexecuted document acceptance probes on this SHA, no H7/L2 rerun.

Claude L2 final host12e2e306 exit0 independently proves actual `unknown_screen`/no-input/verified-exit/empty claims/admission/pending and complete cleanup; unknown is not relabeled auth. [Byte-identical supplied clean host evidence](host-fixed-initial-main/index.json). The four document failures on that SHA remain failed after fixes.

[Five additional independent broker rows](native-own-channel/five-new-runs-audit.json) match exact result/CLI/selection/phase and stderr suffixes. The socket green observed envelope contains a627-byte public foreign-session warning prefix, retained in full, excluded only from derived broker-verified stderr. Other four need no prefix/newline exclusion. Three snapshots now address30 complete result digests and25 stderr suffixes. Native document pass remains pending.


## Native document acceptance and same-run fixes at 78e7e676

[Byte-identical main secscanned host facts](host-document-final/index.json), reviewed97e4e0c: Codex spec rc0, all4 native assertions, own document commit, accepted report, verified exit and cleanup complete. Codex design all4 document assertions passed but driver rc1 on retrySafe WORKER_RESULT_PENDING; final-state already finished/succeeded. Original failure stays failed. No successful native document assertions are rerun. Claude spec/design each rc1: direct and child code r+ opens succeeded, while readable code and own document commit passed. No source bytes were changed by the denial probe.

[Own red/fix/scoped green](document-sandbox-close-regression.json): red b8ed3cb4 has57 passed/2 genuine assertion failures, CLI/child1/1, cleanup complete. Immediate product fix canonicalizes Claude spec/design code cwd outside Orchestrator root and explicitly denyWrites it; declared document/report/Git writes stay separate; contradictory writes inside code fail closed. This does not claim Orchestrator-root code isolation acceptance. Driver fix accepts only zero or explicit retrySafe WORKER_RESULT_PENDING before bounded read-only same-run/PID/start/native-ID/finished-succeeded/dead-PID/empty-claims reconciliation. No second close. Other errors, changed identity, live PID or unreleased claims cannot pass. Scoped green298dcc64:2passed, CLI/child0/0, cleanup complete, group complete, knownRed/unexecuted/unknown empty, timeoutCount0; build0.

[Independent red](native-own-channel/sandbox-close-red-audit.json) and [green](native-own-channel/sandbox-close-green-audit.json) main readonly flowTestRuns rows match exact complete JSON, selection, phase, CLI and stderr bytes. No stderr prefix/newline excluded for either. Total now32 complete result digests/27 stderr digests; original observed merged envelopes remain unchanged. Raw original separated tool stderr pipes remain unavailable. Raw workspace diff artifacts retain original diff blank context markers, so a full git whitespace check on those proof text files reports context whitespace; changed source passes diff check and build. Main-only evidence subpoint is tasks-evidence-subpoint.txt; tasks.md is untouched. Only the two originally failed Claude document scenarios were queued at78e7e676 under main host-lock.


## Final same-QA native Claude continuation

[Both corrected native Claude document scenarios](host-document-sandbox/index.json), clean clone78e7e676: spec run d8f443fc-51b2-4eb4-b69e-24c28a126117 and design run7d0f676d-5be3-4356-bb11-2f8320db0c85, both driver0/completed-review-required/cleanup complete. Each has4/4 native assertions, existing code readable, direct/child write denied EROFS, own exact document-only commit, immutable probe/manifest/source, accepted atomic report, verified native PID exit and empty claims/admission/pending. Spec commit60cd36af844e234bbe4e73d58d58cef863d24f9c; design86c29f6c87bd738f61ae2f109ce119bcfe174dd6. Both close commands actually returned CLI1 retrySafe WORKER_RESULT_PENDING, so the fixed bounded same-run driver reconciliation also has native green evidence without any second close. A zero native child exit is not assumed; after-exit observation field is null, terminal result/identity and reviewed driver dead-PID check are distinct evidence. Original failed Claude/Codex design records stay failed. No other native scenario repeated.

Main copied existing captured native-version files only, secscan0/cmp identical/no rerun: original four document probes Codex0.163.0 and Claude2.1.310, new Claude2.1.310. [Original version byte hashes](host-document-final/version-index.json), [new complete file hashes and identities/selection](host-document-sandbox/index.json). Own QA launch-time version remains separately indirect, not inferred from these host probes.

Final item2.4 remains failed/open because full L1–L4 and Grok/agy prerequisites are unverified. No new defect-fix/repeat-QA task or proposedTasks substitutes for the completed fixes. All own fixes and proofs are committed;120 open task markers mean no archive. tasks.md and assigned checkbox are untouched.

Report validation repair: main reported missing exact finding/scenario addresses and absolute machine paths. The corrected report adds17 original failed scenarios (48 total) and canonical absolute evidence paths, preserving all original results. [Read-only scoped selection audit](report-regression-selection-audit.json) also identifies a working-raf restriction at flow-qa-report.ts:261:12 legitimate knownRed file narrowings and1 aggregate-knownRed selection conflict. These are not bypassed with manual evidence or repeated tests; main must review the working validator. [Repair provenance](report-validation-repair.json).

[Current actual production integration profile audit](report-integration-profile-audit.json): both unchanged integration results match testKind, profile, group, exact file and timeout1200000; actual0a913be6 flowEvidencePorts returns the same profile. Main [acknowledged](report-z435-main-acknowledgement.json) the working-raf selection and integration-confirmation defects as Z.435 and instructed resubmission after release. No new unit, integration or host run; neither integration pair changed.


## Final handoff after main instruction

[Main’s superseding instruction and Git decision](report-final-handoff.json) ends the wait for deleted Z.435. The original 48 scenarios, 17 fixed findings, integration pairs, complete TestRunResult and stderr remain unchanged. Submit the partial failed result now; the working raf validator removal and report acceptance await main’s release and are not claimed completed. The native matrix remains incomplete for the factual reasons above. No additional test/native run, tasks.md edit, checkbox, push, sync or archive. The external atomic JSON includes this final evidence commit as well as all prior own commits.
