# fix-raf-main-event-duplicate-delivery:1.1

Аудит: доручення актуальне на базі e9288eb5cc264e56266bba611ac1daa50d4c8365 (`workspace.sha`). Чинна вимога projects/raf/agent-message дозволяє підтверджувати прийняття чергою Claude Code; попередні виправлення (archive 2026-11-02-fix-raf-main-message-delivery, fix-raf-duplicate-event-delivery) покрили лише placeholder черги `Press up to edit queued messages`. Дві інші рамки Claude Code 2.1.318, що з'являються між вставкою та чергою, лишалися невпізнаними.

## Відтворення на живому main (Claude Code 2.1.318, tmux `/tmp/tmux-1000/default`, pane `%0`, 190x50)

Кадри — незмінений `capture-pane -p`, записаний кожні 50 мс під час справжніх доставок у main 2026-11-04 (12:55–13:05 UTC).

- `main-before.txt` → `main-pending.txt` → `main-queued.txt`: власний `agent message --to main` (текст у `main-message.txt`, з префіксом `[frmed-1-1] `, який додає agent-control) у зайнятий main. CLI повернув `MESSAGE_NOT_ACCEPTED: Recipient composer contains unrelated input` (exit 1), хоча через 65 мс повідомлення вже стояло в черзі. На кадрі `main-pending.txt` текст лежить у композері двома рядками (перенесення за шириною), а рядок режиму втратив ` · esc to interrupt`. `pendingWrappedMessage` порівнював footer до/після дослівно, тож власний текст визнавався «unrelated input».
- `main-idle-before.txt` → `main-idle-pasted.txt` → `main-idle-submitted.txt`: справжня подія `raf event: agent.succeeded` агента reup-100-5 (6 рядків) у main, що щойно завершив хід. Вставка показує `❯ [Pasted text #5073 +5 lines]`; після Enter композер порожній, але рядок режиму замінений підказкою `paste again to expand` (без ready-маркера й без `esc to interrupt`), а спінер `✢ Doing…` не відповідає regex `working` протоколу. `recognized()` повертав false → `Recipient screen cannot confirm agent acceptance` → notice лишався pending → наступний settle вставляв подію знову. `agent ps` показав для reup-100-5 `resultNotice.attempts = 3` при одному delivered; аналогічно aseb-80-8-2 ×4, fesol-1-1 ×13, frcc-1-1 ×13 на момент початку роботи.
- `agent-before.txt` → `agent-queued.txt` (`agent-message.txt`): контрольна самовставка в власну зайняту сесію claude 2.1.318 у screen-reader-режимі (80x24): текст одразу стає в чергу над спінером, композер `$` порожній, рядок режиму замінений `paste again to expand`. Цей шлях уже приймався (порожній composer + змінений екран) і зафіксований як регресія.

`claude-protocol.json` — snapshot `conf/raf.json#/runnerProtocols` для claude 2.1.318, використаний у тестах.

## Де повторюється доставка

`settleResultNotices` (`src/reminder-cli.ts`) повторно claim-ить кожен pending notice на кожному settle; відмови зі списку `resultAlreadyPasted` пропускаються лише коли джерельна сесія вже `finished` (Z.474). Claude-сесії виконавців лишаються `running` після звіту, тож кожна помилкова відмова після фактичної вставки давала ще одну вставку тієї самої події. Повтор не змінювався: він доречний для справді невставлених подій; усунуто саме хибні відмови після вставки.

## Виправлення (`hotfix.patch`, лише `src/message-delivery.ts`)

1. `pendingWrappedMessage`: рядки footer, що є ready-маркером або modeHint протоколу, нормалізуються (як у `nativeDeliveryContext`), тому зміна підказки режиму під час роботи не робить власний перенесений текст «unrelated input».
2. `recognized`: `unknown_screen` із рядком modeHint протоколу (`paste again to expand`) визнається кадром живого композера, тож порожній composer після submit або placeholder `[Pasted text …]` під підказкою підтверджують/очікують прийняття замість відмови.

Нових вимог, таймаутів чи обмежень немає; чужий чернетковий текст і placeholder іншої довжини й далі відхиляються (тести-охоронці).

## Прогони (`raf test run`, група `fix-raf-main-event-duplicate-delivery/busy-main-composer`, той самий ізольований QA HOME)

Повні незмінені `*.TestRunResult.json`, окремо команда й код CLI у `*.cli.json`, stderr у `*.stderr.txt`; child exitCode усередині TestRunResult. `*.workspace.status`/`*.workspace.patch` фіксують незакомічений стан під час RED.

- RED `red.*` 0818ef37-7b64-4c2a-bd44-64a09e3d6637 (`--phase red`, явний `--files`, до будь-яких змін src): assertions-failed, CLI/child 1, 17 passed / 3 knownRed (wrapped agent message, inline multi-line event, 2≠1 вставки через settle), unexecuted/unknown порожні, cleanup complete, timedOut=false, timeoutCount=0, groupState=idle, nextAction=implement. Група в conf була пропущена через відсутність файлів в інвентарі профілю (попередження в `red.stderr.txt`); після цього файли додано до `profiles/node/unitFiles`.
- GREEN1 `green1.*` 1aac5a80-f40a-4354-b1c9-345d03df35c0 (`--phase hotfix`, налаштована група, після виправлення 1): passed, CLI/child 0, 20 passed, groupState=complete.
- Розширений `expanded.*` 032dec38-ee09-4e42-b52c-bc5566c0a15c (та сама група, `--files` + production-claude-delivery-qa, claude-delivery-context, cli-main-delivery-nonblocking, agent-close-z474): 28 passed, 12 knownRed — усі в `test/production-claude-delivery-qa.test.ts`, падають у fixture на `CONFIGURATION_INVALID: Invalid conf/raf.json#/state/contention` до будь-якої доставки; сторонні, не оголошуються виправленими.
- RED2 `red2.*` 735873b1-14cd-415c-97db-9f9683521d6d (`--phase red`, налаштована група, після виправлення 1, до виправлення 2): assertions-failed, CLI/child 1, 20 passed / 4 knownRed (idle collapsed event, busy collapsed event, guard різної довжини, 2≠1 вставки через settle на idle-кадрах), removed = 12 сторонніх з expanded.
- GREEN `green.*` 2ed0f62d-ee4d-409a-9bd9-a6ffa3957c4d (`--phase hotfix`, налаштована група, обидва виправлення): passed, CLI/child 0, 24 passed, knownRed/unexecuted/unknown/removed порожні, cleanup complete, timedOut=false, timeoutCount=0, groupState=complete, nextAction=complete.

Регресія суміжної групи `audit-process-rules/timeout-warnings` — див. `timeout-warnings.*` (додано окремим комітом після завершення прогону).

Слот main не перемикався; галочку 1.1 ставить raf після звіту; 9.1 (активація, validate, archive) лишається за main.
