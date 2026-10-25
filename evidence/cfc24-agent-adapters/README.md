# QA complete-raf-flow-contracts:2.4

Результат пункту: **failed / неповністю перевірено**. Галочку 2.4 не змінено; інші пункти й архівація не виконуються.

## Виправлений дефект

`production-runtime.transport.deliver` видавав receipt після paste/Enter без перевірки прийняття. Додано `message-delivery.ts`: підтриманий native context та порожній composer до вставки, повторна перевірка identity, обмежене спостереження після вставки, один Enter retry лише для незмінного власного pending, помилка замість тихого accepted. Очищений composer і зміна pane підтверджують прийняття без семантичної відповіді. Main використовує чинний Claude dialect. OS flock за socket/pane відхиляє конкурентну доставку до змішування текстів. Чужий draft і непідтриманий shell не змінюються.

## Unit

Повні незмінені JSON: `unit.TestRunResult.json` (початкові 40 passed), `red.TestRunResult.json` (4 assertion failures, runId 95a0e6f4-1578-4df0-8cd8-efc7862a27e3), `qa-failed.TestRunResult.json` (помилка аргументів нового helper, згодом виправлена), `qa.TestRunResult.json` (44 passed, 2e57d745-a476-4488-8f06-61fdc30a18b3). Початковий red перевіряв нову межу helper зі старою семантикою unconditional accepted; це не production integration red.

Після додаткової перевірки identity перед receipt та двох додаткових тестів фінальний виклик повернув **setup-failed / INVALID_ARGUMENT**, CLI 1, child exitCode null, жодного тесту: `qa-final-setup-failed.TestRunResult.json`, runId 0fa991f9-8b5e-4d7c-997f-18d162066bd9. Причину передано main; сліпого повтору та обходу test-run немає. Отже 44 passed не є unit-підтвердженням остаточного workspace. Останній доступний агрегат попереднього успішного прогону: complete, timeoutCount 0, knownRed/unexecuted/unknown порожні; фінальний setup-failed не завантажив групу.

Точні команди, відбір, cleanup/timeout, стан групи й наступна дія — `manifest.json`. Група та QA HOME незмінні. `*.capture.json` зберігають CLI окремо від child exitCode та точний tool output. Інструмент trusted command повертає злитий потік: окремий stderr для цих викликів недоступний, порожнім його не оголошено. Stand зберігає stdout/stderr окремо. Baseline SHA спостерігався 9dd18529664c77fa25c517bae63e564b4ff50668; атомарного Git snapshot кожного unit-виклику немає. Stand має SHA, незакомічені зміни й SHA256 кожного власного файла.

## Реальний ізольований стенд

`node scripts/qa-agent-message.mjs evidence/cfc24-agent-adapters/stand-final` — CLI 0; `stand-final/stand.json`, `scenarios.json`, `cleanup.json`. Власні HOME/RAF_QA_HOME/tmp/state.sqlite/tmux.sock; Node 26.12.1, tmux 3.6, SQLite 3.54.0. Built catalog + production services, реальні процеси/SQLite/tmux; керований native-screen receiver. Підтверджено буквальний shell-подібний текст без виконання, accepted main після очищення без semantic ack, pending після bounded retry → помилка, чужий draft/shell untouched, конкурентний flock. Cleanup CLI 0, remainingPids порожній. Попередній стенд `stand/` збережено окремо. Остаточний стенд включає recheck identity перед receipt.

Це адресний integration-доказ виправлення доставки, **не повний I1–I4 і не справжній AI runner**. Не використовувався public compiled `agent run`, report watcher/claims/admission матриця тут не перевірялася. Команда автоматизованого integration не запускалася: inventory/preset і `test/agent-adapters-integration.test.ts` відсутні; main повідомив, що цей прогін має відбутися після перенесення raf.

## I/L матриця

| Сценарій | Фактичний результат |
|---|---|
| I1 | Частково: production message + SQLite/tmux/literal/identity/cleanup; compiled agent run, native identity до брифа, atomic report і рестарт raf не перевірені. Відкритий. |
| I2 | Частково: чужий/непідтриманий composer, pending і конкуренція перевірені; повна exit/claims/admission/reuse матриця не перевірена. Відкритий. |
| I3 | Report watcher/exit/partial JSON/parallel reconciliation не перевірені цим запуском. Відкритий. |
| I4 | Власний endpoint працює й очищений; два незалежні HOME/TMPDIR та довгі/multibyte адреси не перевірені. Відкритий. |
| L1 | Версії: codex 0.163.0, grok 1.0.67, agy 1.4.5, Claude Code 2.1.310. Повний raf→native ID→brief→JSON→exit жодного CLI не підтверджено. Відкритий. |
| L2 | `native-startup/native-startup.json`: справжні Codex/Claude у власних HOME, без credentials. Codex показав попередження про helper під /tmp; verified ready не досягнуто за час спостереження. Claude pane зникла до capture; child exit невідомий. Бриф/клавіші довіри не надсилались. Це спостереження startup, не доказ auth refusal чи повної L2. Відкритий. |
| L3 | Позитивний/захисний sandbox цикл справжніх CLI не виконаний; заборонені host state/secrets/socket шляхи не читались. Відкритий. |
| L4 | Дозволені прості trusted ps/message/test-run працювали до фінального setup-failed; повна transport/negative/large-output/commit sandbox матриця не перевірена. Відкритий. |

Подальша дія: відновити trusted unit preflight у main, перевірити остаточний workspace тією самою групою; для незакритих I/L потрібен штатний integration inventory та придатний ізольований runner-сеанс з готовністю. Це чинний незакритий пункт 2.4, новий дубль у tasks.md не створювався. Відкладення «за рішенням власника» не заявляється.
