# 5.11.1: адресні регресії без зміни тестів

Доручений пункт — лише `profile-raf-performance:5.11.1`. Вихідний доказ `75d0ecc912882f098ecc66a3ced32c2f09af9602` присутній у ancestry. Обидві регресії виконано у фазі hotfix за кінцевим `regressionGroups` цього пункту, повними чинними presets без `--files`/`--only`. Початковий red чужих груп не дозволений цим grant. Нового коду та власних тестів не створено.

`workspace-before.json` містить HEAD `2544b5b2b8cf26880f8c722b0fdc52af4a88bcbf`, branch, status, presets і SHA-256 усіх шести тестів; `workspace-before.patch` — порожній tracked diff. Незакомічені шляхи — власний каталог доказів і наявне `node_modules` → `/srv/dev/work/orchestrator/raf-main-b/node_modules`. `workspace-after.json` підтверджує незмінні тестові хеші після прогонів. Тести, src, conf та tasks.md цей виконавець не редагував.

## Результати

Точні повні виклики, selection, QA HOME, runId, окремі CLI/child коди, outcome, timeout/cleanup, лічильники й nextAction — у `runs.json`. Обидва результати називають той самий ізольований QA HOME `/tmp/raf-unit-1000/1ee10007bf6d5e71b39d6a2873064a767eeb928e7910599b166a0d60270ff685`; назви груп, HOME та агрегат не змінювались і не скидалися.

| Група | runId | Результат | CLI/child | passed / knownRed / unexecuted / unknown | Стан / наступна дія |
| --- | --- | --- | --- | --- | --- |
| profile-raf-performance/module-origin-cost | 962be2e1-f640-41a6-842c-b5d58daf1f4f | setup-failed; failureKinds setup, assertions | 1/1 | 176 / 85 / 0 / 0 | reconcile / reconcile |
| profile-raf-performance/agent-ps | 7d764fcc-a9c5-443d-bb84-7ed412731c2e | passed | 0/0 | 23 / 0 / 0 / 0 | complete / complete |

В обох `timedOut=false`, `timeoutCount=0`, cleanup complete, remainingPids порожній. Результат першої групи не є успішним чи валідним початковим red.

## Повна доставка

Кожен `<group>/stdout.json` — повний незмінений JSON TestRunResult, `<group>/stderr.txt` — незмінені байти stderr, `<group>/capture-result.json` — manifest каналу з CLI-кодом і довжинами. `delivery.json` фіксує read-only джерело та незалежно обчислені SHA-256. Спостерігач `capture-proof.mjs` відкрив read-only FD власного capture до його завершення, перевірив manifest/довжини/контекст і скопіював потоки без редиректу хостового виклику, доступу до SQLite чи змін capture. Наступний watcher пропускає вже наявні каталоги. `summarize-proof.mjs` перевіряє хеші, контекст, відбір та незмінність тестів і формує summary.

Для module-origin-cost збережено stdout 109495 bytes, stderr 1533 bytes, CLI 1. Tool replay після завершення хостової команди впав із кодом 101: `failed to register synthetic bubblewrap mount target /tmp/.git: Quota exceeded (os error 122)`. Це окрема транспортна помилка; `tool-result.json` зберігає її текст і код. Повний хостовий результат відновлено з уже відкритих FD, повтору не було. Для agent-ps tool exit 0, stdout 9267 bytes, stderr 1511 bytes; обрізання tool output компенсовано повним capture.

TestRunResult module-origin-cost містить 89 diagnostic entries, з яких retained 51, omitted 38, truncated=true за чинним обмеженням діагностики. Усі 50 збережених test diagnostics містять fixture BUILD_FAILED; ще один runner diagnostic має unknown origin. Наявні дані не доводять причину кожного omitted diagnostic або всіх 85 knownRed. JSON не редагувався і не відновлювався з урізаного tool output.

## Виявлена setup-розбіжність і наступна дія

`test/hotfix-fixture.ts:91` залишає у скопійованому `projects.json` лише raf та orchestrator. Чинний `/srv/dev/work/orchestrator/conf/raf-constants.json#/commands/29/examples/0` містить:

```text
raf test run --project etchly --phase main --group complete-raf-flow-contracts/catalog-generator
```

Його `project` береться з `projects.json#/projects`. `src/catalog.ts:150` перевіряє приклади через `parseCommandArguments`; `src/cli-arguments.ts:47` штатно відхиляє etchly у звуженому наборі. Отже fixture build у `test/hotfix-fixture.ts:107` отримує BUILD_FAILED/INVALID_VALUE до цільових origin assertions. Джерело чинного прикладу — Orchestrator `7f48f01582e5df16d9b5a01270cdb2040c299491` (`conf/raf-constants.json`). Це статична локалізація з адресами та збереженими diagnostics, без додаткового прямого unit-прогону.

Доручення прямо забороняє зміни тестів; conf поза write boundaries. Послаблення production-валідації приховало б справжню конфігураційну помилку. Main отримав точні результати й причину (receipts `023cf0a5-b0ba-460e-918e-990e3bfc2bec`, `28cc5551-8ce7-44f2-8d63-e476fd73b749`). Потрібно виправити сумісність conf/fixture у відповідному обсязі, звірити reconcile стан і лише тоді повторити дозволений прогін з тим самим group/HOME/агрегатом. Прогін не повторювався сліпо.

## Живі докази та завершення

За дослівним дорученням 5.11.1 «живі full-CPU/wall і activated-generation докази main виконує на хості за готовим driver d7116833 виконавця». `audit.json` фіксує відповідність поточного driver точному `d7116833a2b42e5ef4ace6b051cce05928fa223d` і SHA-256. Сам driver не доводить повний CPU persistent agent run або activated-generation; попередні обмеження `hotfix-5.11/README.md` зберігаються. Цей виконавець не запускав host-сценаріїв і не активував main.

Поки module-origin-cost не підтверджена, 5.11.1 не виконана повністю; загальний 5.11 лишається відкритим. Галочки ставить raf за валідним succeeded. Інші відкриті пункти не виконувалися, sync/archive не застосовуються.
