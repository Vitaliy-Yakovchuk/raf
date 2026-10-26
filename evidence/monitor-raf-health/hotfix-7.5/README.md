# monitor-raf-health:7.5

Відтворений дефект: `deliverHealthSummaries` після прийнятої транспортом квитанції викликав `healthSummary.complete` один раз. Тимчасовий SQLITE_BUSY/SQLITE_LOCKED зривав запис mainDelivered і лишав pending/claim. Після смерті власника claim можна зайняти знову, що дозволяє повторне надсилання вже прийнятого факту. За відхиленої доставки та сама помилка затримувала звільнення claim.

Виправлення: повторюється лише запис результату вже завершеної доставки через наявний retryStateOperation, у межах state.contention.timeoutMs/retryDelayMs з чинного conf. Виклик send не входить у повтор. Нової історії подій, схеми SQLite, транспортного механізму чи числових defaults немає.

Регресії використовують справжню ізольовану SQLite та production settleCommandState з портом доставки. Дві послідовні помилки запису інжектуються як ERR_SQLITE_ERROR/errcode=5; перевіряються один виклик доставки, підтверджена позначка, повторне відкриття SQLite і наступні повтори без дубля. Відхилена доставка залишається pending та повторюється після повернення main. Наявні тести покривають одночасних виконавців, restart до доставки та outbox. Це unit-перевірка, а не live production QA.

## Команди

Префікс обох прогонів:

`node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/90734334-b607-48d3-afc1-1ab42e1f8ad6/raf-main/bin/raf.ts`

- Red: `test run --project raf --phase red --group monitor-raf-health/summary --files test/health-summary.test.ts`.
- Hotfix: `test run --project raf --phase hotfix --group monitor-raf-health/summary --files test/health-summary.test.ts`.
- Build: `HOME=<той самий ізольований QA HOME> RAF_QA_HOME=<той самий ізольований QA HOME> npm run build` → 0; включає перевірку коментарів.
- `npm run check:comments` у тому самому ізольованому HOME → 0.
- `git diff --check` → 0.

Повний TestRunResult без переформатування — `red.TestRunResult.json` та `hotfix.TestRunResult.json`; повна відповідь інструмента — `*.transport.json`; stderr CLI — `*.stderr.txt`; код CLI — `*.cli-exit-code.txt`, окремо від child exitCode усередині TestRunResult. Інструмент повертає stdout і stderr одним рядком output: JSON TestRunResult вилучено як повний перший JSON-рядок, решту збережено як stderr; вихідний output також збережено повністю. SHA та чужі/власні незакомічені шляхи на момент кожного прогону — `*.workspace.json`; точні власні правки — `*.workspace.patch`.

## Результати

- Red runId `c20eab6c-ef38-4e3a-9da6-eb373ad9fa45`: assertions-failed, CLI/child 1/1, passed 51, knownRed 2, unexecuted/unknown 0/0, timedOut=false, cleanup.complete=true; groupState=idle, timeoutCount=0, nextAction=implement.
- Hotfix runId `54399172-4071-486f-aa6c-e0c4a9e53d4c`: passed, CLI/child 0/0, passed 53, knownRed/unexecuted/unknown 0/0/0, timedOut=false, cleanup.complete=true; groupState=complete, timeoutCount=0, nextAction=complete.
- Стабільний агрегат/HOME: `/tmp/raf-unit-1000/1ee10007bf6d5e71b39d6a2873064a767eeb928e7910599b166a0d60270ff685`; група не перейменовувалася, лічильник не скидався.

Межі доказу: інцидент з production factKey за 00:51–01:51 не відтворювався на робочому стані; приватна SQLite production недоступна за політикою запуску. Встановлено й виправлено конкретний відтворений шлях повторної доставки за тимчасової конкуренції SQLite. Повтор лише підтвердження не дає гарантії проти SIGKILL самого відправника між прийняттям повідомлення зовнішнім runner і збереженням квитанції; така атомарність потребує дедуплікації на боці отримувача і тут не заявляється. Перезапуск служби не є відправленням за чинним контрактом; SQLite-позначка переживає повторне відкриття.

Комунікація: agent ps підтвердив адресний main. Спроба узгодження через agent message повернула HANDLER_FAILED «Recipient has no recognized empty agent composer», ця спроба не була доставлена. Фінальне адресне повідомлення з результатами доставлено: accepted=true, receiptId bf9c816d-330d-40c7-90ad-948c446f146c, CLI 0; повна квитанція у handoff.transport.json. Власні правки обмежені src/reminder-cli.ts і test/health-summary.test.ts, src/state-store.ts не змінено. Галочки tasks.md не змінювалися; 4.1/4.2/8.1/8.2 лишаються відкритими, архівацію не виконано.
