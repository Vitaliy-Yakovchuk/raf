# monitor-raf-health:7.5

Після retry/restart один factKey не повинен повторно надсилатися main. Історичні три появи повідомлення підтверджено переданим main транскриптом, але причину саме production-інциденту не встановлено. Оригінал `production-deliveries.json` скопійовано без змін з `/srv/dev/mrh75ev/deliveries.json`; історичні межі та інтервали 16,746/43,754 с розібрано в `production-analysis.md`. Сам production-інцидент відтвореним не називається.

## Поведінка виправлення

1. healthSummary.claim атомарно зберігає спробу в payload наявного pending_intents і стан останнього підсумку `uncertain` перед викликом зовнішнього транспорту. Без активного main claim не створюється: факт лишається pending і може бути доставлений, коли main з'явиться.
2. Прийнята квитанція підтверджує mainDelivered і delivery=delivered. Тимчасові SQLITE_BUSY/SQLITE_LOCKED повторюють лише complete через наявний retryStateOperation та conf/raf.json#/state/contention (timeoutMs/retryDelayMs); send не входить у retry.
3. Неприйнятий/невідомий результат транспорту, смерть до запису квитанції чи вичерпаний бюджет complete лишають факт pending, без mainDelivered і без автоматичного повторного надсилання. Це консервативна обробка будь-якого викликаного транспорту без accepted-квитанції: accepted=false сам по собі не доводить, що текст не потрапив одержувачу.
4. command stats health показує `summary.delivery=uncertain` та `summary.uncertainDeliveries` із factKey, межами, часом спроби, recipientRunId та безпечною сталою причиною. Список береться з pending-фактів, тому старий невизначений факт видимий і після заміни singleton lastSummary наступним періодом. Факт не вважається доставленим і не активує event bindings без квитанції.
5. Уже наявний delivery_claim без нової позначки також консервативно блокує повтор і показує невизначеність; старий відправник зі своїм token ще може завершити accepted-квитанцію. Нових команд, подій, таблиць, числових defaults, історії доставки або роботи служби немає. Схема SQLite не змінена: доповнено JSON operational payload.

Невизначений результат може означати нуль прийнятих повідомлень; він не видається за успіх, не губиться і не породжує мовчазний повтор. Нового механізму ручного повтору або підтвердження не додано. Це реалізація вимог «Настав строк підсумку», «Main або виконавці були відсутні» та видимого стану health з уточненням main про один явний стан за невизначеності.

## Test-first і результати

Усі unit-прогони виконано тим самим довіреним префіксом:

`node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/90734334-b607-48d3-afc1-1ab42e1f8ad6/raf-main/bin/raf.ts`

Параметри: `test run --project raf --phase <red|hotfix> --group monitor-raf-health/summary --files test/health-summary.test.ts`.

| Етап | runId | outcome | CLI/child | passed / knownRed | groupState / nextAction |
| --- | --- | --- | --- | --- | --- |
| red запису квитанції | c20eab6c-ef38-4e3a-9da6-eb373ad9fa45 | assertions-failed | 1/1 | 51/2 | idle / implement |
| hotfix запису квитанції | 54399172-4071-486f-aa6c-e0c4a9e53d4c | passed | 0/0 | 53/0 | complete / complete |
| red решти шляхів | cdcaf3a7-704d-4346-89da-b70d17c50f5a | assertions-failed | 1/1 | 52/5 | idle / implement |
| hotfix решти шляхів | 01c62bda-adce-46b0-a07f-95be4154711b | passed | 0/0 | 57/0 | complete / complete |

У кожному прогоні timedOut=false, cleanup.complete=true, remainingPids=[], unexecuted=[], unknown=[], timeoutCount=0. Фінальний knownRed порожній. Red — перевірки поведінки, не setup/import failure. Перші дві регресії інжектують дві тимчасові помилки запису ERR_SQLITE_ERROR/errcode=5 у справжню ізольовану SQLite, використовують production settleCommandState, перевіряють один send і повторне відкриття. Другий red додав transport unconfirmed/throw після фактичного запису повідомлення фікстурою, SIGKILL реального дочірнього відправника до complete та вичерпання бюджету complete. За всіма шляхами перевірено наступну команду й відкриття бази без другої доставки. Негативну квитанцію першої регресії посилено до явного uncertain; це включено в другий red.

Повні незмінені TestRunResult: `red.TestRunResult.json`, `hotfix.TestRunResult.json`, `red-outcomes.TestRunResult.json`, `hotfix-outcomes.TestRunResult.json`. Повні відповіді інструмента: відповідні `*.transport.json`. `*.stderr.txt` зберігає решту output після повного першого JSON-рядка; інструмент повертає stdout і stderr разом, тому вихідний output додатково збережено цілком. `*.cli-exit-code.txt` — код CLI, окремо від child exitCode. `*.workspace.json` фіксує HEAD та весь dirty status, `*.workspace.patch` — точні власні code/test правки перед прогоном. Перші докази лишилися незмінними; доповнення мають суфікс outcomes.

Стабільний QA HOME та агрегат: `/tmp/raf-unit-1000/1ee10007bf6d5e71b39d6a2873064a767eeb928e7910599b166a0d60270ff685`. Групу та HOME не змінювали, лічильник не скидали. Новий conf main про queue-lifecycle врахований другим red/hotfix; CONFIGURATION_INVALID не було. Часткова атрибуція ресурсів у TestRunResult збережена без підміни на повну.

Build і check:comments у тому самому ізольованому HOME → 0; git diff --check власних шляхів → 0. `checks-outcomes.transport.json` містить фінальні перевірки. Це unit QA, не live production QA. Загальний механізм транспорту/нагадувань не переписано; чужі unit-групи не запускалися.

## Координація і межі

agent ps підтвердив адресний main. Перша передача результатів accepted=true, receiptId bf9c816d-330d-40c7-90ad-948c446f146c, CLI 0 — handoff.transport.json. Наступні повідомлення з уточненнями повертали HANDLER_FAILED «Recipient composer contains unrelated input»; за цим не стверджується ні прийняття, ні гарантована відсутність тексту, сліпого повтору не було. Main відповів через канал сесії, уточнив продовження трьох фікстур і явно передав блок healthSummary у src/state-store.ts; Z.430 його не змінює. Перед комітом звірено git log -3 цього файла та власні hunks.

Власні кодові шляхи: src/reminder-cli.ts, src/state-store.ts (healthSummary та його тип/import), src/health-summary.ts, src/health-summary-runtime.ts, test/health-summary.test.ts. Інші правки спільного дерева не комітяться. Галочки tasks.md не змінювалися. Пункти 4.1/4.2/8.1/8.2 лишаються відкритими: архівацію не виконано.

Остання передача результатів: CLI 1, HANDLER_FAILED «Recipient screen cannot confirm agent acceptance»; прийняття не підтверджене, повтор не виконувався. Повна відповідь — handoff-outcomes.transport.json. JSON-звіт залишається каналом підсумкового результату.
