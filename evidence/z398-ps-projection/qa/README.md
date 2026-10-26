# Z.398.4 — незавершений QA, 2026-10-26

Справжній ізольований CLI-прохід **не виконано**. Z.398.4 лишається відкритим.
Unit-моки не підтверджують перевіреного live caller, власного/чужого runId,
безпечних stdout/stderr, reconciliation/report або cleanup справжнього CLI.
Повні команди, версії, відбір, runId та коди — [summary.json](summary.json).

## Виконані перевірки й виправлення

- Власний початковий QA: `9ff6dd5d-d9f5-482a-b699-cb3aefc10c96`, 37 passed,
  один failed S03; CLI/child 1, cleanup complete, timeout=false.
- Причина S03: фіксований `finishedAt=2026-10-25T00:00:01Z` перевищив retention.
  `cleanupCompleted` правомірно видалив попередній запуск, а тест очікував його
  внутрішній контекст. Це дефект фікстури, а не послаблення production retention.
- Власний адресний red того самого ID: `4bf965cb-cdda-4013-9c09-ab29c4cc83ef`,
  assertions-failed у test body, CLI/child 1, без setup/import failure.
- Одразу виправлено дату фікстури на поточну. Assertions не змінено.
- Підтверджено лише цей knownRed ID: `137e0ac5-f358-433c-880c-cf4dac3ff42e`,
  passed, CLI/child 0, cleanup complete; knownRed/unexecuted/unknown порожні,
  groupState=complete, timeoutCount=0, nextAction=complete.
- Група `complete-raf-flow-contracts/z398-ps-projection` та QA HOME незмінні.
  Решту виконаних перевірок не повторювали. S01–S07 мають лише unit-доказ.

## Відсутні передумови справжнього CLI

У поточному `conf/test-runs.json` відсутній preset
`complete-raf-flow-contracts/z398-ps-projection-cli`, а файл
`test/agent-ps-projection-cli.test.ts` не належить до `node-integration.integrationFiles`.
Точний запис для реєстрації передано в [handoff.json](../handoff.json).
Conf поза файловими межами цього виконавця; прямий runner не запускався.
Команда після відновлення передумов записана в [prerequisites.json](prerequisites.json).
Це перше невиконане виконання поточного пункту, без нового пункту повторного QA.

`agent ps` не повернув адрес: початковий виклик завершився
`PRODUCTION_ENTRY_FAILED` із повідомленням про incomplete SQLite header;
після зміни стану routing — `STATE_CONTEXT_REFUSED` через відсутній registry.
Останній повний результат — [agent-ps-current.tool.json](agent-ps-current.tool.json).
Адресата main не вгадували, operational state не читали й не змінювали.
Ці помилки не є доказом пошкодження робочої SQLite чи встановленим mainHotfix.

## Межі й збереження доказу

Повні незмінені результати та queue-діагностика збережені в `*.tool.json`;
окремі TestRunResult — `*.stdout.json`, CLI codes — `*.cli-exit.txt`.
`exec_command` поєднує stdout/stderr: поділ JSON-рядка результату й queue-рядка
в `*.stderr` зроблено за контрактом CLI. Незалежне підтвердження початкових
байтів кожного stream недоступне; це обмеження явно збережено, повної окремої
доставки не заявлено. Unit-результати не є live CLI доказом.

Відмову поєднання `--files`/`--only` збережено окремо; це не red.
Два транспортні зриви підтвердження не містять TestRunResult і не названі pass.
Повтори виконано після read-only спостережень відновлення registry та гілки main.
Нативних CLI actor-процесів/стенда цей виконавець не створював.
Dirty context/SHA та хеші коду збережені в `workspace-*.json` і summary.
Паралельні чужі правки не входять до власних комітів. Push, deployment та archive
не виконано; у зміні залишаються інші відкриті пункти.
