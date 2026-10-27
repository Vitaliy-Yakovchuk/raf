# profile-raf-performance 5.11.1 — повторна перевірка

Виконавець `raf-prp511-hotfix`, запуск `eca28a55-f0f5-4510-a03b-a8cd7d124b74`. Реалізація від `75d0ecc912882f098ecc66a3ced32c2f09af9602` присутня в ancestry; код і тести цим виконавцем не змінені. Доручення актуальне після закритих 5.11.2/5.11.3: [audit.json](audit.json).

| Налаштована група | Результат | CLI / child | passed / knownRed / unexecuted / unknown | Стан |
| --- | --- | --- | --- | --- |
| profile-raf-performance/module-origin-cost | timed-out, 1206441 ms, SIGKILL | 1 / null | 114 / 0 / 45 / 0 | timeoutCount 5, unverified-remainder, review-remainder |
| profile-raf-performance/agent-ps | passed, 2250 ms | 0 / 0 | 23 / 0 / 0 / 0 | timeoutCount 0, complete, complete |

В обох запусках cleanup complete, remainingPids порожній. Unit-політика: timeoutMs=1200000, optimizeAfterTimeouts=1, maxGroupTimeouts=2. module-origin-cost **не є green**. За перевищеним накопиченим лімітом без knownRed чинний core/process/unit-test-runs вимагає не повторювати timeout-залишок і дозволяє завершення unit-роботи з ним. Повна оцінка, джерело Git, дослівна цитата та перелік залишку: [completion.json](completion.json). Нових прогонів цієї групи, зміни HOME, скидання ledger або редагування тестів немає. Це штатний unit timeout, тому умовний дозвіл main на повтор після обриву від рестарту не застосований.

Точні команди, SHA перед кожним викликом, відбір, timeoutPolicy, cleanup, groupSnapshot/state/nextAction: [runs.json](runs.json). Команди викликані окремо, без shell-обгорток чи env-префіксів, через виданий префікс покоління 99a1b3a9. Хостовий адаптер маршрутизує до активного покоління; фактичні покоління видно в оригінальному stderr. Дочірні прогони мають однаковий ізольований QA HOME `/tmp/raf-unit-1000/1ee10007bf6d5e71b39d6a2873064a767eeb928e7910599b166a0d60270ff685`, відмінний від робочого HOME.

У кожній теці групи `stdout.json` — повний незмінений TestRunResult; `stderr.txt` — повні незмінені байти stderr; `capture-result.json` — CLI-код і довжини від адаптера. `delivery.json` — незалежні SHA-256 та контекст. Read-only спостерігач [capture-proof.mjs](capture-proof.mjs) відкрив FD власного capture до replay і перевірив manifest/довжини/контекст без змін capture. `tool-result.json` зберігає також відповідь інструмента з її явною позначкою скорочення; вона не використовується замість повних потоків. Для module-origin-cost збережено 30428/3045 байтів stdout/stderr, для agent-ps — 9131/3027. [summarize-proof.mjs](summarize-proof.mjs) перевірив хеші, контекст, повний налаштований відбір та незмінність усіх шести файлів тестів.

Спільне дерево змінювали інші виконавці під час прогонів. Початкові HEAD/status/conf/test hashes і tracked patch: `workspace-before.json`, `workspace-before.patch`; точніший знімок другого виклику: `agent-ps/workspace-at-invocation.json` та `.patch`; фінальний стан: `workspace-after.json`, `workspace-after.patch`. Ці докази чесно фіксують незакомічені сторонні правки; вони не включені до коміту як зміни вихідних файлів. Resource usage в TestRunResult має partial completeness й не замінює живих full-CPU вимірів.

Живі full-CPU/wall та activated-generation докази залишаються окремою роботою main за прямо визначеним розподілом у 5.11.1; готовий driver `scripts/qa-runtime-verification-host.mjs` від `d7116833a2b42e5ef4ace6b051cce05928fa223d`. Батьківський 5.11 цією unit-перевіркою не закривається. Галочки tasks.md виконавець не змінював; інші відкриті задачі залишаються, sync/archive не виконується.
