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

Потрібні host TMPDIR на місткому filesystem під чинною політикою, існуючі owner auth selectors та придатний inventory; для grok/agy — перевірений native dialect/identity/quota. Глобальні credentials/conf та liveTaskVerified не змінювалися. L2 intentional trust/auth/permission/unknown/version і L4 native transport/concurrency/test-run/spec-design commit матриці лишаються відкритими. Скрипти готові: `scripts/qa-agent-adapters-live.ts <reviewed-full-sha> <runner> <new-absolute-evidence-dir> [L1|L3-full]`; L3-full застосовний до codex/claude. Main володіє host-lock. Новий запуск допустимий лише для ще невиконаних перевірок або підтвердження виправленої власної регресії.

## Повнота й походження потоків

`*.tool.json` зберігають повний незмінений tool envelope; `*.observed-merged-output` — точний повернений потік; `*.TestRunResult.json` — повний JSON без переформатування. Tool об'єднує stdout/stderr, тому `*.stderr` містить весь фактично спостережений envelope без рядка TestRunResult, включно з launch-queue.waiting; це не вигаданий окремий первісний pipe. CLI code збережено окремо від child exitCode. Host-потоки скопійовано окремо побайтово.

[runs.json](runs.json) зберігає початковий unit green 47 тестів і старі integration setup/refused. `integration-resumed-setup.*` — setup contention failure, не red. `tmux-setup-refused/` — setup INVALID_VALUE, не red. `channel-refusal.*`, `pending-prerequisites.json` — історична пауза до випуску Z.420–Z.426; main згодом явно повернув preset conf 1754e0f677 та дозволив exact integration. Старі відмови не переписано й не перетворено на pass.
