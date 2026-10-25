Пункт add-raf-agent-run:4.1 перевіряє вже реалізовані контракти 3.1. Вихідний raf-develop: `0de1b28d7ac8bf5253102c648b2577cddcbfd5f4`, tracked workspace чистий. Підготовлені тести не змінено.

Власний unit-прогін через дозволений канал: `unit-invocation.json`, повний незмінений JSON `unit.stdout.json`, код CLI `unit.cli-exit-code`, відомості захоплення `unit.tool-metadata.json`, `unit.stderr`, компактний результат `unit-summary.json`. Run `8fdc543c-53a5-4472-ac27-6cc816487d91`: 608 passed, 0 knownRed/unexecuted/unknown, child і CLI 0, timeout false, cleanup complete, group complete/nextAction complete. Використано ту саму групу `add-raf-agent-run/contracts` та HOME агрегату, без скидання лічильників. Native exec повертає об’єднаний output; він містив рівно один валідний JSON без іншого тексту. Порожній `unit.stderr` фіксує цю відсутність додаткового тексту; окремого незалежного байтового stderr-каналу інструмент не надає.

Тести охоплюють граничні ресурси/UNKNOWN/critical, конкурентний допуск і claims, усі launchable типи, вузький контекст і selection, verified sender, main protection, заміну адресата, storage/error/recovery. Це ізольовані контракти; живі сесії вони не підтверджують. Збірка має окремі stdout/stderr/CLI у `build.*`; окремого tsc контракт 1.2 не визначає.

За повідомленням main від 2026-10-25 підготовлено host-QA `scripts/qa-agent-run-live.mjs` і допоміжні `qa-agent-run-{actor,main,audit}.mjs`. Після перегляду main запускає чистий клон точного SHA з наявними node_modules і сусіднім `conf/`:

```
node scripts/qa-agent-run-live.mjs <повний-переглянутий-SHA>
```

Оточення хоста: `CODEX_HOME=/home/dev/.codex`, `LC_ALL=C`, чинний абсолютний `GIT_CONFIG_GLOBAL` (типово `/home/dev/.gitconfig`), PATH із node/codex/tmux/bwrap/npm/openspec. Переданий HOME замінюється новим коротким `/tmp/ar41-*`; `RAF_QA_HOME` дорівнює йому. Auth і Git-конфіг не копіюються, секрети raf не потрібні. Не запускати скрипт усередині sandbox виконавця. Main зберігає stdout, stderr і CLI exit окремо.

Стенд створює власні Git/conf/OpenSpec/state і main inbox, два справжні `agent run`, native helper із gate-планами, а після негативної доставки в неагентний inbox — справжню main TUI із selection A. Run handlers і протоколи не змінюються. Єдине instrumentation stand-копії bin: незмінені результати message і бар’єр перед двома конкурентними CLI handlers; аудит доводить перетин їхніх інтервалів. Тексти/підписи звіряються з native user_message, кожний token має receive-файл від реального агента, сторонній файл не створюється. Native identity, ps type, detached state, незмінність brief/task-context, forged caller, close/interrupt main та cleanup перевіряються явно.

`completed-review-required` потребує огляду native доказів і не є автоматичним succeeded доручення. Будь-яке падіння, пропущений сценарій чи неповний cleanup дає exit 1 / failed. Артефакти зберігаються в `<stand>/ev`, стан стенда не видаляється. Receipt без native доказу не закриває 4.1. Позитивний main-сценарій навмисно використовує справжній routed runner; hardcoded Claude для `identity.runner=main` у production-runtime може виявитися дефектом і не маскується зміною markers.

Інтеграційні fixture-runner файли з design.md не включені в unit-профіль і не запускаються напряму для обходу test run. Main підтвердив, що integration preset ще не перенесено у дозволене покоління raf-main (add-raf-test-run:6.2.5); точний залишок і наступна дія — `integration-unexecuted.json`. Ці п’ять файлів не мають результату й не є pass. Інші пункти зміни відкриті; tasks.md і archive не змінюються.

Main повністю переглянув скрипти на `97eacb69fbbfc83dc8e26892e8da3391827238aa` і поставив хост-прогін у чергу: clean clone `/srv/dev/ara41q/raf`, сусідній conf, наявні node_modules, очищене env, timeout 5400 s. Заявлені шляхи — `/srv/dev/ara41q/{stdout,stderr,exit}`, очищені докази — `/srv/dev/ara41q/ev`. На момент цього запису результат ще не отримано. Сирі native transcript-и містять приватні дані та не передаються; очікуються лише очищені витяги.
