# fix-raf-agent-caller-readonly-state:1.1 — виконавець fracr-1-1c (claude)

Результат: RED → виправлення → GREEN виконано. Базовий HEAD `3fc362aee03aecba250f07062165564582553b6d`.

## Причина

e90c0d6 зробив PreToolUse hook Codex залежним від `RAF_CODEX_RESULTS` і `RAF_CODEX_PUBLICATION`. `prepareCodexRafCommandAccess` повертає їх у `environment`, але:

1. production worker віддавав адаптеру лише `invocation` (`src/production-runtime.ts`, `protocol.invocation`);
2. `TmuxAgentAdapter.startWithoutInput` не передавав `command.environment` у tmux-сесію.

Без цих змінних hook Codex не має каналу до хоста, команди raf виконуються в sandbox: `test run` не бачить зареєстрованого caller (CALLER_UNAUTHORIZED), `agent message` пише в state.sqlite, змонтований лише для читання (SQLite 8). Тому падали лише Codex-агенти (erb-8-3, erb-4-3), а Grok/Claude (erb-7-4, erb-8-3b) — ні; таймлайни — у `../timelines.json`.

## Виправлення

- `src/production-runtime.ts`: `protocol.invocation` додає `environment` — лише змінні, які підготовка каналу додала понад `process.env` (`commandChannelEnvironment`). Повне середовище процесу в tmux не передається.
- `src/agent-adapters.ts`: кожна змінна з `command.environment` стає `-e NAME=VALUE` у `new-session` цієї сесії (як `PLAYWRIGHT_BROWSERS_PATH`), не в shell-команду й не в глобальне середовище tmux. Екранування кінцевого `;` винесено в спільну `tmuxArgument`.
- Перевірка caller не змінена.

## Тести

Застарілі фікстури, що маскували RED (не production):
- `test/production-worker-pane.test.ts`: double `codex-raf-command-access` не мав `bridge` (`f is not defined`); фікстура tmux не знала пакетних запитів `display-message …;capture-pane`, `#{pane_pid}|#{pane_id}` і `list-panes` з 7b42a4f.
- `test/sandbox-test-caller-z400.test.ts`: очікування remediation «new assignment/launch» застаріло з 010b2b5, де текст навмисно спрощено до «restore the trusted caller channel». Твердження про відмову, відсутність fallback до main і незмінний агрегат збережені.

Прогони (група `fix-raf-agent-caller-readonly-state/caller-channel`, профіль node, QA HOME `/tmp/raf-unit-1000/1ee10007…`):

| Доказ | Фаза | runId | Outcome | knownRed | Стан групи |
|---|---|---|---|---|---|
| `red-fixture-drift.TestRunResult.json` | red | 7aef3f3c-b2dc-4edd-9562-81ca8b723ff7 | assertions-failed | 17 (з них 14 — дрейф фікстур) | idle |
| `red-fixture-list-panes.TestRunResult.json` | red | 99ed91a3-781d-49c1-b70c-900781c16475 | assertions-failed | дрейф `list-panes` | idle |
| `red.TestRunResult.json` | red | a6bc0819-133f-4ea1-982a-34f465603238 | assertions-failed | 3 регресії каналу | idle, nextAction implement |
| `hotfix.TestRunResult.json` | hotfix | 45d2a10c-9ff9-4a97-bcfe-80ee1b0fe9fd | passed, 63 | [] | complete |
| `hotfix-neighbors.TestRunResult.json` | hotfix | 8c2d2f34-7fa9-4349-80dd-bcd3495d66ec | assertions-failed + setup | 3 + unknown 1 | idle |
| `hotfix-final.TestRunResult.json` | hotfix | 77049c53-a9b5-4ded-9736-d1e6640533ef | passed, 63 | [] | complete; сусідні removed як outside-configured-selection |

Усі: CLI exit = child exitCode, timedOut false, cleanup.complete true, remainingPids [], unexecuted/unknown порожні, крім прогону сусідів.

RED (a6bc0819): падають рівно `Codex channel environment reaches batched/source-file tmux launch…` і `worker codex: the launched pane receives its prepared RAF command channel` — на assertion про відсутність `-e RAF_CODEX_RESULTS=…`.

Сусіди (8c2d2f34) — передіснуючі, не через цю зміну:
- `test/agy-production-session-start.test.ts` (2) — та сама застаріла фікстура пакетного `display-message;capture-pane`, що й у worker-pane; для agy `environment` порожнє, аргументи запуску не змінились.
- `test/codex-unix-sockets.test.ts` — setup: «codex needs an enabled catalog model» (Codex-моделі тимчасово вимкнені в conf/models.json 561df508).
- `test/codex-state-access.test.ts` (>128 KiB) — запускає справжній codex напряму з `prepared.environment`, без adapter/worker.
- `test/agent-adapters.test.ts`, `test/cli-latency-tmux.test.ts`, `test/codex-raf-command-lifetime.test.ts` — пройшли.

`tmux-session-environment-probe.txt`: справжній tmux 3.6 — змінна з `new-session -e` доходить до процесу після `respawn-pane` і не з'являється в `show-environment -g`.

Неможливий прогін між моїми RED: одна команда з редиректом (не проста) не залишила `TestRunResult`; результат невідомий, не використовується.

## Читабельність

Додано одну функцію з двох рядків (`commandChannelEnvironment`, назва `addedByChannel` пояснює фільтр) і один рядок збору `-e` в адаптері; дубль екранування `;` прибрано. Новий шлях читається напряму: prepare → protocol.invocation → new-session -e. `node scripts/check-comments.ts` — 0. `tsc` у workspace недоступний (`Cannot find module '../lib/tsc.js'`), типи перевірено лише виконанням тестів.

Чужа незакомічена зміна `src/test-run-runtime.ts` у спільному дереві не зачіпалась і не комітилась.
