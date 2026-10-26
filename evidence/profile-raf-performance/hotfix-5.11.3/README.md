# profile-raf-performance:5.11.3

Фікстура main у `test/hotfix-fixture.ts` записувала stdin, але не показувала native composer. Справжній `agent message` закономірно відмовляв перед вставкою. Крім того, `execFileSync` у черзі команд блокував stdin самого одержувача під час доставки повідомлення main.

Виправлення показує Claude ready/composer, приймає bracketed paste, показує pending і очищає composer після Enter. Лічильник прийнятих повідомлень змінює екран після кожного підтвердження. Черга запускає CLI асинхронно, залишаючи stdin доступним. Inbox і далі зберігає фактичні вхідні байти. Production delivery gate та його перевірки не змінено.

Регресія у `test/hotfix-activation.test.ts` викликає справжню CLI-команду двічі через main і перевіряє accepted та рівно одну вставку кожного повідомлення в inbox.

## Test-first

- `85412f65695e2054a0cd7855c5bd6a05177c6a24` — лише регресійний тест, до виправлення.
- `9a8cd3872496366da5252e8413980df8ecda0a85` — виправлення фікстури після підтвердженого red.

### Початкове падіння

Команда наведена у [workspace-red.json](workspace-red.json). Повний незмінений [TestRunResult](red/stdout.json), окремі [stderr](red/stderr.txt), [результат транспорту з кодом CLI](red/cli-result.json) і [довжини та SHA-256](red/delivery.json) збережено без залежності від обрізаного відображення exec.

Run `c6e7e982-86d0-4fb2-8745-ba5989a7687e`: `phase=red`, `callerPhase=hotfix`, outcome `timed-out`, CLI `1`, child exitCode `null`, cleanup complete, remainingPids `[]`. Виведені поля: passed 6, knownRed 11, unexecuted 50, unknown 0. Новий тест та agent-message gates падають через `Recipient has no recognized empty agent composer`. Два інші падіння зафіксували тимчасовий `BUILD_FAILED` через коментар у паралельно змінюваному `src/task-checkbox-report.ts:145:5`; цей файл не належить дорученню й тут не змінювався.

Агрегат успадкував timeoutCount 1 і після red має timeoutCount 2, `groupState=confirm-known-red`, `nextAction=confirm-known-red`. Групу й QA HOME не змінювали. Вибір лише activation-файла після успадкованого тайм-ауту не скидав історію інших тестів.

### Відмова preflight

Перший виклик hotfix помилково поєднав `--files` і `--only`. [Повний результат](hotfix-refused/TestRunResult.json) має `SELECTION_CONFLICT`, outcome `refused`, CLI `1`, child exitCode `null`; тестовий процес не запускався. [Транспорт](hotfix-refused/transport.json) не обрізаний, але окремі сирі потоки цієї швидкої відмови не захоплено; обмеження записане у [stream-limitations.txt](hotfix-refused/stream-limitations.txt). Це не pass і не red. Наступна команда прибрала `--files` і залишила точні відомі червоні IDs.

### Підтвердження виправлення

Точна команда: [hotfix-command.txt](hotfix-command.txt). Вона використовує той самий `profile-raf-performance/module-origin-cost` і тільки 11 knownRed IDs з red. [Стан дерева з незакоміченою власною правкою](workspace-hotfix.json) та [стан після коміту виправлення](workspace-hotfix-committed.json) фіксують SHA, власні шляхи й чужі незакомічені шляхи. [Додатковий diff під час прогону](workspace-during-hotfix.patch) зафіксований пізніше й не є атомарним знімком усіх входів кожної вкладеної фікстури: спільне дерево змінювали інші виконавці.

Перший hotfix run `3743e40f-ec0b-4726-a01a-fbd45d79fcf1`: [повний JSON](hotfix/stdout.json), [stderr](hotfix/stderr.txt), [CLI manifest](hotfix/cli-result.json), [контроль цілісності](hotfix/delivery.json). Дев’ять тестів пройшли, включно з новою регресією та початковими сімома gates/snapshot; diagnostics `[]`. До двох останніх snapshot-тестів прогін не встиг: outcome `timed-out`, CLI `1`, child exitCode `null`, cleanup complete, timeoutCount 3. Агрегат залишив усі 11 knownRed, оскільки timeout не дав complete event; unexecuted 52, unknown 0. Це не завершене підтвердження й не зелений прогін. Наступний відбір поділено на шість gates і п’ять snapshot knownRed, послідовно в тій самій групі.

Перша адресна частина: команда [hotfix-part1-command.txt](hotfix-part1-command.txt), workspace [workspace-hotfix-part1.json](workspace-hotfix-part1.json), run `28c24b5c-625b-4f62-979b-7bfa2e0800ba`. [Повний JSON](hotfix-part1/stdout.json), [stderr](hotfix-part1/stderr.txt), [CLI manifest](hotfix-part1/cli-result.json), [довжини та SHA-256](hotfix-part1/delivery.json). Шість gates пройшли, diagnostics `[]`, child exitCode `0`, timedOut `false`, cleanup complete. CLI `1`, outcome `assertions-failed` через п’ять попередніх knownRed поза відбором; нових assertion failures немає. KnownRed зменшено до 5, unexecuted 50, unknown 0; timeoutCount 3 збережено, groupState/nextAction `confirm-known-red`.

Остання адресна частина: команда [hotfix-part2-command.txt](hotfix-part2-command.txt), workspace [workspace-hotfix-part2.json](workspace-hotfix-part2.json), run `28d9a1c9-7046-45ea-8c60-e468e893d516`. [Повний JSON](hotfix-part2/stdout.json), [stderr](hotfix-part2/stderr.txt), [CLI manifest](hotfix-part2/cli-result.json), [довжини та SHA-256](hotfix-part2/delivery.json). Усі п’ять remaining snapshot knownRed пройшли, diagnostics `[]`, child exitCode `0`, timedOut `false`, cleanup complete, remainingPids `[]`. CLI `1`, outcome і groupState `unverified-remainder`, nextAction `review-remainder`, knownRed 0, unexecuted 50, unknown 0, timeoutCount 3.

Усі 11 knownRed підтверджено саме завершеними частинами 6+5. Успішні події з перерваного тайм-аутом прогону не використано замість завершеного підтвердження. [summary.json](summary.json) перевіряє довжини й хеші чотирьох повних результатів, покриття knownRed двома завершеними частинами й незмінний QA HOME/statePath. Потоки не змінювалися; окремі похідні файли містять коди CLI та child.

Це дозволене завершення unit-роботи з неперевіреним залишком, а не повний зелений прогін module-origin-cost. Додаткового запуску 50 unexecuted не виконано. Окрему z392 не перевірено.

## Межі та процес

За `core/process/unit-test-runs`, вимогами «Після ліміту таймаутів лише червоні тести» та «Чесний результат завершеної роботи», після timeoutCount 2 повторюються лише knownRed. Неперевірений через тайм-аут залишок не називається успішним і за відсутності knownRed не блокує завершення цієї unit-роботи.

Зміна фікстури також стосується `complete-raf-flow-contracts/z392`, але цю групу не перевірено. Вибраний пункт 5.11.3 не містить кінцевої декларації regressionGroups для чужої групи й launch snapshot не дає grant. За `conf/briefs/README.md`, абзацом «Чужу unit-регресію», цей виконавець її не запускає. Main повідомлено точну команду; остання доставка повернула непідтверджене прийняття (`Recipient screen cannot confirm agent acceptance`). Після цього main явно відповів у цій сесії: «main не може виконати test run (phases.main.allowed=false → PHASE_NOT_ALLOWED), тож z392 я адресно не прожену» й доручив завершити власні only-частини та відобразити обмеження у звіті. Main оформлює окремий підпункт 5.11.3.1 з декларацією `regressionGroups=["complete-raf-flow-contracts/z392"]` і новим довіреним запуском. Це окрема невиконана регресія, якої не закриває виняток для неперевіреного залишку module-origin-cost.

[scope-and-policy.json](scope-and-policy.json) містить SHA чинного Orchestrator, дослівний Git-запис правила чужої регресії, текст вибраного пункту та чинний `phases.main.allowed=false`.

Чинність доручення перевірено за proposal, вибраним пунктом tasks та вимогою аудиту `projects/orchestrator/autonomous-development`. Зміна conf `d1d650d6c420ef5177c6ad27dc171698fc2b5561` додала іншу групу й не змінила preset module-origin-cost. Інші пункти, зокрема 5.11.1, відкриті; галочки й архівація тут не виконуються.
