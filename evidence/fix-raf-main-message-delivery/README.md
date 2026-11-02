# fix-raf-main-message-delivery:1.1

Аудит: чинний src/message-delivery.ts на базі 2f1b9a8d303512d540a86fb1e08d0b93ad01aeb4 сприймав Claude queue placeholder як ready/empty. Зміна актуальна.

Реальні кадри tmux `/tmp/tmux-1000/default`, pane `%0`: `frame-0000.txt` — main зайнятий, черга; `frame-0455.txt` — порожнє поле. Це незмінені останні 30 рядків `capture-pane -p`. `delivery-refused.txt` — повний кадр після реальної відмови agent message `Recipient composer contains unrelated input` (CLI 1, 2026-11-02 близько 17:02 UTC); повідомлення вже видиме в черзі, відмову не можна трактувати як доказ відсутності вставки.

Уточнення main у цій сесії (2026-11-02): «Рішення: collapsed-кадр не потрібен. Довгі багаторядкові події raf (agent.succeeded/failed) до main доходять і приймаються (у сесії main вони видні як вставлений блок), тож згорнута вставка не є причиною. Причина — підтверджені тобою 2 дефекти черги (ready marker як порожній composer). Виправ їх, GREEN на тій самій групі, коміт, звіт succeeded. Слот перемикає main.» Тому collapsed не змінювався.

`claude-protocol.json` — snapshot чинного протоколу для відтворюваних unit-фікстур. `workspace.sha`, `workspace.status`, `hotfix.patch` фіксують SHA й незакомічений код під час усіх прогонів (RED — той самий SHA до зміни src/message-delivery.ts). `node_modules` — попередній чужий untracked symlink, не комітиться.

Кожний `*.cli.json` містить повну CLI-команду й окремий код CLI; `*.TestRunResult.json` — повний незмінений результат wrapper-а, `*.stderr.txt` — stderr з виводу інструмента без обрізання. Child exitCode є тільки в TestRunResult.

- RED d3a7cdd0-e822-4970-b86e-a08749a28ea9: 2 assertions-failed, knownRed — обидва нові тести; cleanup complete, без timeout, unexecuted/unknown порожні, group idle, nextAction implement.
- Розширений faf65cae-29ae-4d9a-bed1-d34a29aa3a62: 28 passed, 2 assertions-failed у test/claude-protocol.test.ts:60,125. Вони звіряють sandbox conf із застарілими точними об’єктами; файл не імпортує message-delivery.ts, наш diff не змінює конфігурації чи runner-protocols.ts. Це сторонні падіння, не виправлені цією задачею.
- GREEN 13a9bec1-538d-4302-948f-2349c98f550f: 15 passed, CLI/child 0, knownRed/unexecuted/unknown порожні, cleanup complete, timeout false/count 0, group complete, nextAction complete. Відбір звужено до доставки, той самий group та QA HOME; два сторонні тести явно зазначені у removed, а їх падіння збережені в expanded. Вони не оголошуються виправленими.

Виправлення: queue placeholder зайнятий до вставки; після вставки — in-flight, без Enter retry. Порожній composer завершує очікування. Нових обмежень чи таймаутів немає. Слот main не активувався.
