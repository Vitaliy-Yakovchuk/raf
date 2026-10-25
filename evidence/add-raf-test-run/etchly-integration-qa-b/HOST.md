# Хостовий стенд 6.2.6.3

Виконання доручив main у повідомленні 2026-10-25. Скрипти готують нові приватні клони; робочі SQLite/HOME/socket raf не читаються. Залежності, готовий local app build та лише corpus `learning/concept-base` із його готовим build копіюються як передумови, без install/build. Код береться лише з переданих committed SHA; джерельний dirty context і hashes конфігурації/пакетів/збірки записуються у marker. Застарілий inventory, залежності чи build дають failure, без fallback.

Перевірено тут лише синтаксис (`node --check` обох mjs; `bash -n` suite). Жоден хостовий сценарій у sandbox цим скриптом не запускався. Успішний синтаксис не доводить працездатність стенда.

Main запускає з host shell; замінює `RAF_SHA` на SHA переданого коміту, інші два SHA — на підтверджені сумісні commits. Нижче зафіксовано останні спостережені etchly/shared-libs; якщо вони змінилися, main має передати фактичні SHA та результати, без прихованого оновлення інвентаря.

```bash
bash /srv/dev/work/orchestrator/raf-develop/scripts/qa-etchly-integration-suite.sh \
  /srv/dev/work/orchestrator \
  /srv/dev/raf-etchly-6263b-host3 \
  RAF_SHA \
  b8a769ccca3cd281ab80278cedc173d6df9a3dc9 \
  171441decdf6de1e57482e816f7db683765ce7f6
```

Каталог `/srv/dev/raf-etchly-6263b-host3` має бути відсутнім. Скрипт не видаляє попередній стенд і не повторює failed/unknown прогін. Для нового узгодженого запуску вкажіть інший явний шлях.

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

Після host2 setup-failure до D1 потрібен виправлений prepare із concept-base. Це продовження початкових невиконаних сценаріїв; host2 результати не перезаписуються. Підготовка додає `learning-corpus-hashes.json` та `marker.learning` (SHA, scoped dirty, число файлів і hash індексу). Повернути також цей індекс; він містить лише імена та hashes, без тексту корпусу. Unit-hold main залишається чинним.

Host3 показав Miniflare 5 API mismatch у власній D08 fixture. Після виправлення наступне продовження запускає лише D08: додати останній шостий аргумент `d08` до suite, новий suite root `/srv/dev/raf-etchly-6263b-host4` і SHA коміту з fixture fix. Очікуються тільки D08 prepare/driver/suite rc0 та 12 captures; smoke повторно не виконується. Поточний smoke retry assertion лишається відкритим із чотирма passed та двома unexecuted, без послаблення контракту.

Host4 виявив неправильний шлях у власному ready observer. Продовження для виправлення виконується лише скриптом `scripts/qa-etchly-integration-resume.sh SOURCE_ROOT EXISTING_STAND_ROOT FIX_SHA`, де EXISTING_STAND_ROOT = `/srv/dev/raf-etchly-6263b-host4/d08`. Він перевіряє власний private marker і clean clones, оновлює лише код raf-develop у клоні на переданий committed SHA та запускає `d08-remainder` у новий `results-continuation`. Старий `results`, marker, etchly, HOME/SQLite/group не змінюються або не копіюються для скидання стану. HOME/SQLite використовує штатний wrapper; агрегат продовжується з timeoutCount=2. Ранній green/assertion/setup/skip не повторюються. SQL-ready+deadline є власною адресною регресією observer; за ним interruption/concurrent/crash/recovery та after-recovery green. Очікується 8 captures, driver rc0, початковий timeoutCount2 → deadline3 → interruption3 → crash recovery4 → after-recovery4. Зберегти весь results-continuation та continuation-capture; попередній failed залишається в доказах.
