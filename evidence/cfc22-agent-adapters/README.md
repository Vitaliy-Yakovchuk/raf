# complete-raf-flow-contracts:2.2 — контрактні unit-тести адаптера

Автор `raf-cfc22-scaffold`, стадія test-scaffold. Підготовлено 28 нових сценаріїв у `test/agent-adapters-contract.test.ts`, без реалізації фічі. Наявний `test/agent-adapter-readiness.test.ts` не змінено. Нової production-поверхні не потрібно: використано чинні `TmuxAgentAdapter`, `createLaunchTransport`, `waitForExit` та `runLaunchWrapper` з повними fake-портами. Відповідно, нових production-методів/заглушок NotImplemented немає.

## Контракт та аудит

Очікування походять із повної delta `openspec/changes/complete-raf-flow-contracts/specs/projects/raf/agent-adapters/spec.md` і `agent-adapters-design.md`, U1–U5. Предмет чинний: 2.2 відкритий, 2.3/2.4 залишаються відкритими. Завершення scaffold не доводить реалізації, live CLI чи інтеграційного приймання; зміна не готова до архівації.

За початковим дорученням production/чужі набори не вивчалися. Після прямого уточнення main прочитано лише readiness baseline для недублювання. За наступним уточненням main актуальні декларації adapter/wrapper отримано TypeScript `emitDeclarationOnly`, без перегляду реалізації. Копії `.public.d.ts` містяться тут; порівняно з `api-snapshot-768250a` вони додають nativeIdentity/source/null-ID та публічні `waitForExit` method/option. Нову API не вигадано. Q.4.1/Y/Z, версійні parser-тести, великі результати IPC та транзакційна фіналізація не дублюються.

У новому файлі немає реального файлового I/O, subprocess, SQLite, tmux, sockets, network чи provider. Усі виклики adapter executor підмінено; wrapper використовує fake fs/watch/lifecycle, а process exit — керований Promise. Clock і delay підмінено. Реальні команди виконує лише дозволений зовнішній `raf test run`.

| Матриця | Нові інваріанти |
| --- | --- |
| U1 | Одна вставка після успіху, помилки вставки та паралельного повтору; stop/verified exit скасовують readiness. |
| U2 | Selection/cwd/report wrapper зберігаються; багаторядковий UTF-8 бриф з метасимволами доходить буквально; невдалий запуск/load-buffer не надсилає старий buffer/Enter. |
| U3 | Starting, limited із/без retryAt і failed auth/unknown зберігають лише відомі факти; exited/null та exited/0 очікують окремий порт підтвердження процесу. |
| U4 | Запізнілі ready/limited/exited старого запуску не змінюють інший runId тієї ж адреси; змінені PID/machine/boot/pane/socket/runId та unknown ownership не дозволяють input/stop. |
| U5 | Після первинної delivery-помилки та справжнього виклику підміненого stop з cleanup-помилкою первинна причина стоїть перед супутньою; немає повторної доставки, accepted report чи finish для непідтвердженого процесу. |

## Відбір та реєстрація

`inventory.json` задає точні доповнення `projects.raf.profiles.node.unitFiles` і `projects.raf.groups`. Main повідомив про застосування unit-частини комітом `030e6b4a4c`; integration не реєструється. Group/QA HOME/ledger між спробами незмінні. Deadline: `conf/flow.json#/unitTests/timeoutMs`, фактично 1200000 мс. Автор не читав і не змінював приватний ledger або conf.

Кожна спроба виконана автором окремою простою командою через наданий канал:

```text
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/3557f6a4-89a2-41a3-b963-b4343aabc699/raf-main/bin/raf.ts test run --project raf --phase red --group complete-raf-flow-contracts/raf-agent-adapters --files test/agent-adapter-readiness.test.ts test/agent-adapters-contract.test.ts
```

Передати реалізатору ту саму групу `complete-raf-flow-contracts/raf-agent-adapters`, ті самі два файли та фазу implement за його assignment. QA використовує фазу qa. Нової групи/HOME, reset бюджету або прямого node test запуску не було.

## Результати

| Артефакт | Test scaffold commit | runId | knownRed IDs | CLI/child |
| --- | --- | --- | --- | --- |
| initial.TestRunResult.json | 633e77a43d18a13df2bfc8c1ea0bbabed8e07371 | 8f02fc81-6f58-4643-880e-84382d19f6f3 | 7 | 1/1 |
| fixture-corrected.TestRunResult.json | 548c65c18dc9e755ed7769862e5ca45673f5e5f4 | 0ab24448-fe6c-4672-be24-6749b3c0040d | 2 | 1/1 |
| wrapper-argv-corrected.TestRunResult.json | bab82a7ae493a1d2abf2c7054e69f1993eec6c7c | 0a7bdb7e-66ef-4151-9fbb-70c0676638f6 | 1 | 1/1 |
| final.TestRunResult.json | 4e747ed0de40bafdc39e27417ac24fabe402b6c6 | e505884c-c046-49b2-b5f9-ad1306167d0b | 1 | 1/1 |

У перших спробах виправлено власні помилки фікстури: fake display-message має повертати `0|` для живої pane (форму підтвердив main), а wrapper executable і report argument можуть бути окремими елементами argv. Не вимагати їхнього розміщення в одному shell-рядку — виправлення помилки тесту, а не послаблення контракту збереження аргументів. Перші сім падінь не видаються за сім дефектів продукту. Остання зміна додала відсутні stale limited/exited сценарії та явну перевірку, що U5 справді дійшов stop.

Остаточний результат — `assertions-failed`, 39 passed IDs і один knownRed ID:

```text
test/agent-adapters-contract.test.ts::U5 launch failure retains delivery reason before a secondary cleanup failure
```

Усі U1–U4 та readiness baseline зелені. Повторювані назви baseline агрегуються reporter-ом; кількість passed IDs не заявляє кількості фізичних викликів цих однойменних тестів. Setup/import/refused/timed-out немає; `unexecuted=[]`, `unknown=[]`, `removed=[]`, `cleanup.complete=true`, `remainingPids=[]`, `timeoutCount=0`, `groupState=idle`, `nextAction=implement`.

U5 перевірив реальний wrapper із fake-портами. Події: `start → inspect → ownership → ownership → deliver → ownership → ownership → stop`. Виклик stop кидає `SECONDARY: cleanup unavailable`; назовні та в lifecycle.failed залишається лише `PRIMARY: delivery unknown screen`. Падіння — assertion на відсутність супутньої причини, а не setup/import чи невиконаний cleanup fixture. Первинну причину продукт уже зберігає; її штучно не ламали. Main отримав точний результат для незалежної перевірки перед 2.3.

Перед і після остаточного прогону HEAD дорівнював `4e747ed0de40bafdc39e27417ac24fabe402b6c6`; чужа tracked-правка — лише `test/model-routing-integration.test.ts`, поза відбором. Власні вибрані тести чисті та закомічені. SHA-256 baseline `f492cd78a0d7dadb3330fba1e882c5c8a5b9bfa1392a906dc7b92e55b27d2052`; нового файла `8c8d4e8486c60f634e45066cdd6979d9c973502f76da9c3c4d8801859c9caf6b`.

Повні незмінені TestRunResult збережено в окремих JSON, CLI code — у capture JSON, child exitCode — у самому результаті й capture. Інструмент надав єдиний output, який є повним валідним JSON; окремий stderr канал не експоновано. Відсутність окремого stderr чесно позначено, порожній stderr не вигадано. `result-fingerprints.json` фіксує фактичні bytes/SHA-256 цих артефактів. Configuration fingerprints, command, isolation, resource admission/usage та весь group result залишені без редагування.

`node --check` і `git diff --check` власного тесту пройшли. Додаткова TypeScript-перевірка власного файла не знайшла семантичних проблем, крім відсутніх у repo type definitions для `node:assert/strict` і `node:test` (залежності не встановлювались). Production build/check:comments не потрібні: production-код не змінено. Галочку 2.2 ставить raf за прийнятим звітом; інші пункти та archive автор не змінює.
