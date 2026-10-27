# fix-raf-codex-sandbox-network:1.1

Прибрано `--unshare-net` з обгортки bwrap; `policy.json` тепер повідомляє `network.namespace: host`. Нових таймаутів чи лімітів немає. Захист файлів, SSH-agent, seccomp і приватного tmux збережено та перевірено регресією.

Код і тести: `42162be92dd54bf7a551786ffb89adf490ffe6bc` у `/srv/dev/work/orchestrator/raf-hotfix`. Початковий HEAD red: `a0a6d21ffa3136e49477246c465fa313ea2bd7a5`; код мережі тоді відповідав base `bd94f0c5ddda9f30446ac82006de20dbabdec532`, нові тести були незакомічені. `red.test-sources.txt` містить їхній стан, `red.workspace.patch` порожній: продуктове виправлення ще не застосоване. Після двох цільових падінь внесено продуктові два рядки; `hotfix.workspace.patch` містить цю зміну. Старі очікування ізольованого TCP оновлено відповідно до доручення; `z421.workspace.patch` зберігає ці зміни разом із виправленням.

Повні команди, runId, відбір, CLI exit code окремо від child exitCode та підсумки — у [runs.json](runs.json). Для кожного прогону повний TestRunResult — у `*.result.json`, stderr — у `*.stderr.txt`, CLI code — у `*.cli-exit-code.txt`. Початковий повний JSON додатково відновлено без зміни полів із збереженого `lastResult` ізольованого QA aggregate до наступного прогону; цей snapshot збережено у `red.group.json`. Stderr red відповідає повному потоку попереджень початкового виклику (ідентичний потоку hotfix). Результати наступних прогонів збережено без зміни з відповіді дозволеного каналу. Неповний вивід не зараховувався як pass.

| Прогін | runId | Результат | CLI / child |
| --- | --- | --- | --- |
| red, host-network | 4371ebbd-e597-4d8a-a83c-2cbd3cfc4f9d | assertions-failed, 2 цільові knownRed | 1 / 1 |
| hotfix, host-network | a77e7780-cf99-4747-982c-3f3eae4fc0be | passed, 2/2 | 0 / 0 |
| hotfix, configured complete-raf-flow-contracts/z421 | 9b343bcf-00c2-444b-a71c-19b40c7104ba | passed, 11/11 | 0 / 0 |
| integration, host-network-live | 98631dba-0ddb-4117-a0dd-35b838aaddb9 | passed, 1/1 | 0 / 0 |

Red є падінням assertions у тілах тестів, а не setup/import. Власна unit-група залишалася `fix-raf-codex-sandbox-network/host-network`; QA HOME один і той самий у всіх результатах. Підтвердження очистило обидва knownRed. У всіх прогонах `timedOut=false`, `cleanup.complete=true`, `remainingPids=[]`, `unexecuted=[]`, `unknown=[]`, `timeoutCount=0`. Фінальні групи мають `groupState=complete`, `nextAction=complete`, `knownRed=[]`. Часткова повнота вимірювання RAM/disk у `resourceUsage` збережена як фактична діагностика; вона не підміняє outcome тестів.

Integration виконує саме справжній `prepared.toolSandbox`: DNS `example.com`, TCP до `example.com:80`, TCP до слухача хоста `127.0.0.1`, порівняння `/proc/self/ns/net` із хостом і перевірку `policy.json`. Контроль DNS/TCP на хості проходить перед sandbox. Це окрема integration-група з чинним бюджетом `conf/flow.json#/integrationTests/timeoutMs`; unit-виняток не застосовувався. Стару групу іншої зміни запущено за її налаштованим відбором без додавання чужих задач до доручення.

Спільний HEAD змінювався іншими агентами під час ресурсних черг. `tested-sources.json` ідентифікує власний code commit і SHA-256 релевантних файлів; `completion.status.txt` зберігає фактичні сторонні незакомічені зміни, які цей виконавець не комітив. До запуску integration код було вже підготовлено, під час його очікування закомічено власне виправлення. На момент завершення integration воно не мало додаткових незакомічених змін; `completion.source.patch` порожній. Нових повторних запусків для скидання aggregate/QA HOME не робилося.

Аудит: proposal/tasks актуальні щодо наявного `--unshare-net`; доручення 1.1 узгоджене з потрібною мережею хоста. Тест старої ізоляції хоста виправлено під цільову поведінку, без послаблення захисту SSH-agent чи секретів. Виконано лише 1.1; 1.2 веде `raf-csn12-hotfix`, архівація зараз не виконується. Галочки залишено raf. Основні специфікації не змінювалися (`skip_specs: true`).

Файли Orchestrator, записані у робоче дерево для коміту main за його підтвердженням: `conf/test-runs.json` (групи `host-network`, `host-network-live`, `test-entry` і їхні inventory entries) та `openspec/changes/fix-raf-codex-sandbox-network/tasks.md` (лише нотатки перевірок 1.1, без галочок). Спільні hunks `src/codex-sandbox.ts` погоджено через agent message; після власного коміту файл передано виконавцю 1.2.

Контекст: навичка cloud-environment-runtime не знайшла `/etc/codex/network-policy.json` чи інструмента environment_status у цьому CLI; це не вважалося дозволом або доказом мережі. Фактичний доступ встановлено виключно завершеним integration-прогоном через дозволений raf test run.
