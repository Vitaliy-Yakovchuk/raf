# CPU очікування raf

База коду: `91fdddf05d4b4a325f44bcfe51c34e0fda94f2c5`. Виправлення змінює лише два idle-інтервали в `deliverCheckedMessage`: очікування чужої чернетки або delivery lease використовує чинний `transitionMs`. Перевірка identity перед вставленням і receipt, ownership, відмова не-main та швидке bounded-підтвердження після вставлення збережені. Нових timeout, конфігураційних параметрів або порогів немає. Затримка помічання звільненого composer/lease тепер може сягати чинного `transitionMs` (10 с у delivery-стенді).

## 60-секундні виміри живих процесів

Без CPU-profiler. Дельта `/proc/<pid>/stat` utime+stime, `getconf CLK_TCK` = 100; startup виключений. Сирі лічильники, фактичні інтервали, stdout/stderr та exit codes містяться у JSON поруч і в `measurements.json`.

| Процес і стан | До, CPU-мс | Після, CPU-мс |
| --- | ---: | ---: |
| `raf.ts agent message`, чернетка main зайнята | 2640 | 60 |
| `raf.ts test run`, pending notice main у `claimGroup → settleCommandState` до admission | 3420 | 140 |
| `raf.ts test run`, socket-очікування `NO_RESOURCES` | 0 | 0 |
| idle `runProductionWorker` | 0 | 0 |
| idle `runPublishedAgentChannel` | 0 | 0 |

Причина активного очікування — часті `ps` identity checks, tmux capture/display або спроби lease в спільній доставці. Чистий resource waiter уже використовує socket, worker — tmux wait-for, published channel — child close. Хостові результати main збережено як повідомлені власником, а не як наш повторний хостовий вимір. Відтворення дорогого `test run` уточнює його фазу: CPU витрачається на службову доставку перед допуском, а не на socket-очікування допуску.

Main окремо змінив production `pollMs` 100→500 (повідомлений коміт `2efe3ebd9c`). Для зіставності delivery-стенди явно залишають 100 мс з обох боків. Зміна коду працює і з новими 500 мс; idle-інтервал визначає `transitionMs`.

## Відтворення

Усі стенди створюють власні Git/SQLite/tmux фікстури та QA HOME; справжня модель не запускається. Запускати з кореня raf-hotfix:

```sh
HOME=/tmp/raf-waiting-cpu-stand RAF_QA_HOME=/tmp/raf-waiting-cpu-stand node scripts/profile-message-wait-cpu.ts before
HOME=/tmp/raf-waiting-cpu-stand RAF_QA_HOME=/tmp/raf-waiting-cpu-stand node scripts/profile-message-wait-cpu.ts after
HOME=/tmp/raf-waiting-cpu-stand RAF_QA_HOME=/tmp/raf-waiting-cpu-stand node scripts/profile-message-wait-cpu.ts before queue
HOME=/tmp/raf-waiting-cpu-stand RAF_QA_HOME=/tmp/raf-waiting-cpu-stand node scripts/profile-message-wait-cpu.ts after queue
HOME=/tmp/raf-waiting-cpu-stand RAF_QA_HOME=/tmp/raf-waiting-cpu-stand node scripts/profile-message-wait-cpu.ts before test-delivery
HOME=/tmp/raf-waiting-cpu-stand RAF_QA_HOME=/tmp/raf-waiting-cpu-stand node scripts/profile-message-wait-cpu.ts after test-delivery
HOME=/tmp/raf-waiting-cpu-stand RAF_QA_HOME=/tmp/raf-waiting-cpu-stand node scripts/profile-waiting-cpu.ts before-unprofiled quiet
HOME=/tmp/raf-waiting-cpu-stand RAF_QA_HOME=/tmp/raf-waiting-cpu-stand node scripts/profile-waiting-cpu.ts after quiet
HOME=/tmp/raf-waiting-cpu-stand RAF_QA_HOME=/tmp/raf-waiting-cpu-stand node scripts/profile-published-channel-cpu.ts before
HOME=/tmp/raf-waiting-cpu-stand RAF_QA_HOME=/tmp/raf-waiting-cpu-stand node scripts/profile-published-channel-cpu.ts after
```

Режим `before` доставки бере оригінальний `message-delivery.ts` із базового Git-коміту лише у копію стенда. Worker/channel не мають змін у своїх event waits. Queue-стенд використовує справжній public CLI, авторизацію, admission і queue runtime; loader hook заміняє лише старт service на власний Unix socket, без запуску робочого service. `NO_RESOURCES` забезпечує ізольована RAM-фікстура; production flow не змінюється. Після виміру SIGTERM навмисно завершує queue-стенд: `outcome=interrupted`, CLI=1, child exitCode=null, cleanup complete, тестовий child не стартував. Це доказ CPU, не unit red/pass. Message завершується receipt та CLI=0; worker/channel завершуються штатно. Власні процеси, tmux та каталоги фікстур прибрані.

## Test-first

Авторські прогони виконуються тільки через переданий `raf ... test run`, у стабільній групі `fix-raf-waiting-cli-cpu/unit` і тому самому QA HOME. `red-initial.*` містить два правильні assertion failures і додатковий TypeError неповної фікстури active acceptance. Після додавання `pendingPaste` повторний `red.*` підтверджує рівно дві assertion-помилки; active acceptance проходить. Виправлення коду зроблено після цього результату. Повні незмінені JSON, stderr, CLI code та окремий child exitCode зберігаються поруч; SQLite snapshot додатково підтверджує red до зміни коду.

Регресія чужої зміни виконується її налаштованою групою `complete-raf-flow-contracts/z449`, без додавання її задач до доручення. Остаточні результати hotfix додаються окремими артефактами.
