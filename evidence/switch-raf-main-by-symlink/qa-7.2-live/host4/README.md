# Host4: версія native Claude не відповідає protocol snapshot

Main виконав чистий driver `ae1d7cce7a8f572eb0e01d50c5b16a0d2c1334ed` з `--resume-after-start /srv/dev/s72-bDaBYe`. Незмінені stdout/stderr/exit та повний новий ev-native-main скопійовані з `/srv/dev/sym72q4`; SHA256 у capture.json. CLI exit 1. Перший actual-start переноситься з Host3; конвертацію не повторено.

`version-claude.stdout` — `2.1.310 (Claude Code)`, тоді як збережений conf protocol вимагає `2.1.308`. Native coordinator відмовив до spawn Claude, `/status`, main attach, нового actor та всіх семи pending live-кроків. Це відсутня передумова сумісного CLI, не assertion red нової поведінки й не підстава послабити version validator або підставити protocol.version. Стенд і живі старі ідентичності збережені; cleanup complete=false, retained=true. Новий адресний шлях продовження має зберегти цей failed ev і не повторювати actual-start.

Окреме повідомлення до main через виданий raf_command 2026-10-26 завершилося CLI 1 / STATE_CONTEXT_REFUSED: відсутній `/srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/registry.json`. Точний tool output залишається в сесії; цей абзац — коротка транскрипція, не файл сирого stderr. Доставки немає; command не повторювався, робочий registry не змінювався. Очікується відновлений канал та чинна інструкція main щодо Z.423.

Оновлення 2026-10-26: наведений вище висновок про потрібну точну версію спростовано чинним Z.335 (рішення власника 2026-10-23). Це дефект fixture, виправлений власним red → fix → qa 19/19; [докази](../../qa-7.2-fixture-version-warning/README.md). Оригінальні stdout/stderr/summary не змінювались; live green ще очікується.
