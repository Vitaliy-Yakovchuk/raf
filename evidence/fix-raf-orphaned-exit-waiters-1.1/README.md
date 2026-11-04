# fix-raf-orphaned-exit-waiters:1.1 — worker, що висить у `tmux wait-for raf-exit-<uuid>` без сесії

## Механізм

`TmuxAgentAdapter.waitForExit` підписує хуки `pane-died`/`pane-exited` (сесійні) і `session-closed` (глобальний) на канал `raf-exit-<uuid>`, чекає `tmux wait-for <ch>`, а у `finally` звільняв канал командою `wait-for -S <ch> ; wait-for <ch>`.

Семантика `wait-for` у tmux (перевірено на tmux 3.6, `tmux-channel-semantics.txt`): сигнал без очікувача ставить каналу прапорець `woken`; наступний `wait-for -S` на такому каналі не ставить прапорець, а *видаляє* канал; наступний `wait-for <ch>` створює новий канал і чекає вічно.

Отже, будь-який сигнал, що прийшов на канал без очікувача і не був спожитий до `finally`, робив завершальний `wait-for <ch>` вічним:

- `died-before-wait`: панель померла між `set-hook` і першим `wait-for` — хук уже сигналізував, `status()` бачить мертву панель, цикл не чекає, `finally` зависає;
- `closed-after-death`: панель померла (хук розбудив очікувача), а до зняття глобального хука сесію вбив інший учасник (`agent close`/`discardOwnedTmuxSession`/handover) — другий сигнал без очікувача, `finally` зависає.

Worker лишається з дитиною `tmux wait-for raf-exit-…`, не доходить до `finish`, не звільняє lease читача слоту main (`readers/<uuid>.json`), а сесії tmux/state/tmp уже прибрані.

## Виправлення

- `src/agent-adapters.ts`: звільнення каналу — `wait-for -S <ch> ; wait-for -S <ch>` (перший сигнал ставить `woken` або видаляє вже розбуджений канал, другий видаляє або лишає ненульовий `woken` без очікувача); після зняття хуків блокуючого `wait-for <ch>` більше немає.
- `src/hotfix-activation.ts`: `acquireHotfixReader` і `retainHotfixGeneration` під `activation.lock` прибирають `readers/*.json`, чий процес (pid+start) не живий.
- `test/helpers/tmux-exit-fixture.ts`: фікстура моделює канали `wait-for` з прапорцем `woken` як tmux, а не лише «розбудити очікувача».

## Докази

Група `fix-raf-orphaned-exit-waiters/exit-waiters`, профіль `node`, файли: `test/agent-adapters.test.ts test/launch-wrapper.test.ts test/hotfix-reader-admission.test.ts test/hotfix-activation.test.ts test/hotfix-activation-readers.test.ts test/main-symlink-release.test.ts test/main-symlink-storage-z461.test.ts`.

- `unit-red.json` — runId `e3aafc64-a64b-4bca-8efe-2d122bd49479`, `--phase red`, незмінені `src/` (HEAD bd3805a9, файли agent-adapters/launch-wrapper): `assertions-failed`, `knownRed` = два нові тести `worker-exit: …`.
- `unit-green.json` — runId `a8817f76-3a5d-4218-9f8e-a333fe941fff`, `--phase hotfix`, робоче дерево з виправленням: 151 passed, обидва нові `worker-exit` тести та `[fix-raf-orphaned-exit-waiters] dead reader leases …` passed; `hotfix-activation.test.ts`, `main-symlink-release.test.ts`, `main-symlink-storage-z461.test.ts`, `hotfix-reader-admission.test.ts`, `launch-wrapper.test.ts` повністю passed. `knownRed` (2) лише у `test/hotfix-activation-readers.test.ts`, див. нижче.
- `unit-green-rerun-known-red.json` — runId `a7493ddc-5775-4122-bd5d-1370aab5ac7f`, `--only` два knownRed: обидва падають повторно з тими самими повідомленнями.
- `unit-green-committed.json` — runId `6f771681-138c-46fc-9300-024d267b9b96`, той самий прогін на закоміченому коді 51a4f3a9: 151 passed, ті самі 2 knownRed.

Два knownRed не належать цій зміні:

1. `[hotfix-concurrency] conflicting main refresh cannot activate an old seal or erase either side` — «Missing expected rejection» на `assert.rejects(activateHotfix(f.host, verified), /stale|base|conflict|chang/)`: перевірку stale base прибрано комітом c0c6c1d (fix(raf): remove Git-dependent acceptance validations, 2026-10-29); сусідня зміна fix-raf-stale-snapshot-test уже видалила таку саму перевірку з `hotfix-activation-snapshot.test.ts` (607ab0c). Цей тест падає на baseline незалежно від виправлення.
2. `[hotfix-production-readers] service/worker/session identity and signed message delivery survive successful publication` — `LAUNCH_FAILED: Native runner identity changed during initial brief delivery` у живого codex 0.163.0 на етапі доставки первинного брифу (до будь-якого очікування виходу); відтворено тричі однаково. Змінений код (`waitForExit` cleanup, прибирання мертвих lease) у цьому етапі не бере участі. Запуск цього тесту на baseline у пісочниці виконавця неможливий (EROFS для `/tmp/raf-ipc-1000`), тому baseline-стан цього тесту не підтверджено.
- `tmux-red/summary.json` — `scripts/qa-tmux-worker-exit.ts` на реальному tmux 3.6 із `src/` базового коміту `bd3805a9…`: режими `closed-after-death` і `died-before-wait` завершуються `timeout` (очікувач звільнено лише ручним `wait-for -S`), у всіх режимах `blockingWaitsAfterUnsubscribe: 1`.
- `tmux-green/summary.json` — той самий сценарій на робочому дереві: усі п'ять режимів `passed: true`, `blockingWaitsAfterUnsubscribe: 0`.
- `tmux-channel-semantics.txt` — пряма перевірка семантики каналів tmux 3.6.

Виконання QA-скрипта: `HOME=<ізольований QA HOME> RAF_QA_HOME=<той самий> node scripts/qa-tmux-worker-exit.ts <bd3805a9…|workspace> evidence/fix-raf-orphaned-exit-waiters-1.1/<tmux-red|tmux-green>`.
