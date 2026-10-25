# Хостовий стенд 6.2.6.3

Виконання доручив main у повідомленні 2026-10-25. Скрипти готують нові приватні клони; робочі SQLite/HOME/socket raf не читаються. Залежності та готовий local app build копіюються як передумови, без install/build. Код береться лише з переданих committed SHA; джерельний dirty context і hashes конфігурації/пакетів/збірки записуються у marker. Застарілий inventory, залежності чи build дають failure, без fallback.

Перевірено тут лише синтаксис (`node --check` обох mjs; `bash -n` suite). Жоден хостовий сценарій у sandbox цим скриптом не запускався. Успішний синтаксис не доводить працездатність стенда.

Main запускає з host shell; замінює `RAF_SHA` на SHA переданого коміту, інші два SHA — на підтверджені сумісні commits. Нижче зафіксовано останні спостережені etchly/shared-libs; якщо вони змінилися, main має передати фактичні SHA та результати, без прихованого оновлення інвентаря.

```bash
bash /srv/dev/work/orchestrator/raf-develop/scripts/qa-etchly-integration-suite.sh \
  /srv/dev/work/orchestrator \
  /tmp/raf-etchly-6263b-host \
  RAF_SHA \
  b8a769ccca3cd281ab80278cedc173d6df9a3dc9 \
  171441decdf6de1e57482e816f7db683765ce7f6
```

Каталог `/tmp/raf-etchly-6263b-host` має бути відсутнім. Скрипт не видаляє попередній стенд і не повторює failed/unknown прогін. Для нового узгодженого запуску вкажіть інший явний шлях.

Очікується suite rc=0, prepare rc=0 для обох режимів, driver rc=0 і `summary.status=passed`. У smoke: 11 captures (два повні green рівно трьох файлів; сім негативних відборів із CLI 1 до spawn; дві відсутні передумови із setup-failed до spawn). У D08: 12 captures, включаючи навмисний wrapper SIGKILL без JSON; recovery та delivery зберігають початковий runId, timeoutCount=2 і наступний повний green. Навмисні неуспішні child/CLI результати залишаються незміненими в captures, driver оцінює саме очікувану поведінку.

Для D08 hang fixture після SQL-підтвердження надсилає SIGSTOP лише власному fork. Це моделює завислий OS-процес, щоб перевірити зовнішній deadline/cleanup; чинні локальні etchly operation/cleanup limits не змінюються. SIGINT/SIGTERM/SIGKILL надсилаються лише власному wrapper; cleanup перевіряється за PID/start identity його нащадків.

У кожного запуску є `*.stdout`, `*.stderr`, `*.capture.json` (окремий CLI code/signal та незмінений result), `*.input.json`, фактична bridge-команда й внутрішні batches у `*.spawn.json`. `ready-*.json` доводить SQL `SELECT 1` та спостереження реального workerd. `summary.json` містить початкові SHA/dirty/config hashes, процеси з PID/start identity, відсутність залишків до аварійного cleanup, після нього й відновлення конфігурації. Власна SQLite стенда зберігається для перевірки стану групи; вона не видається за робочий стан raf.

Повернути QA весь suite rc, prepare/driver rc/stdout/stderr, `results` обох режимів і `.qa-etchly-stand.json`; не урізати TestRunResult. Якщо failure стався до results, повернути stderr і marker. Cleanup, timeout, setup, skip чи частковий результат не є проходженням integration.

Межа доказу: це main-executed API-стенд із production planner/runtime/reporter/SQLite і реальними forks/workerd. Він не створює grant, не тестує broker/caller authorization та не замінює D09 — власний QA `project=etchly` виклик через довірений канал. Для D09 після сумісного rollout потрібне нове належне immutable доручення цього виконавця; належні команди там:

```text
raf_command test run --project etchly --phase integration --group add-raf-test-run/etchly-worker-d1-smoke
raf_command test run --project etchly --phase integration --group add-raf-test-run/etchly-worker-d1-smoke --files worker/src/analysis-output-1177-agent-tests/invalid-analysis-retried.test.ts worker/src/accepted-source-1939-agent-tests/continuation.test.ts worker/src/summary-pass-language-agent-tests/english-course-prompt-form.test.ts
```

Тут `raf_command` — лише префікс нового перевіреного доручення. Це не команда для обходу поточного sandbox чи використання іншого покоління.
