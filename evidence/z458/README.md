# Z.458 — native Grok/Agy: незавершено

Результат: **failed**. Підтверджено початковий unit red; повного native-діалекту й успішного модельного завдання обох CLI немає. `conf/raf.json` та `liveTaskVerified=false` не змінені. Код продукту не змінювався; acceptance-тест навмисно лишається red. Галочки tasks.md не змінювалися, архівації немає.

Аудит: пункт Z.458 у `openspec/changes/complete-raf-flow-contracts/tasks.md`, Why/What Changes proposal та чинна delta agent-adapters залишають вимогу живого підтвердження. Відсутні native-блоки у конфігурації пояснюють початкову відмову `RUNNER_IDENTITY_UNAVAILABLE` у `protocolFor`; наявна схема вже підтримує assigned Grok та session_start Agy. Протиріччя чи підстави оголосити вимогу неактуальною не виявлено. Авторизація є фактичною непідтвердженою передумовою, а не відмовою від вимоги за рішенням власника.

## Артефакти й межі патча

`conf-raf.native.partial.patch` — **лише часткова дослідницька заготовка, не повний операційний патч**. Його не можна застосовувати як завершене виправлення: чинна перевірка діалекту відхилить відсутні required-поля. Додані тільки поля з джерел у `native-draft-sources.json`. Для Grok не підтверджені pendingPaste/working/exit/startup та навігація вкладками identity; для Agy — pendingPaste/working/finished/startup і поточний composer/exit. Історичні кадри не замінюють поточний live QA. Main попереджений про ці межі; кореневий conf поза правами запису цього виконавця.

`test/runner-native-config-z458.test.ts` перевіряє native launch і liveTaskVerified для обох runners. `test/runner-native-live-z458.test.ts` — незавершений live scaffold: ізольовані workspace/tmux, звичайний HOME лише для native CLI, без копій credentials. Raf wrapper/ledger користувався одним QA HOME, записаним у кожному TestRunResult. Остаточний scaffold з виправленою ранньою класифікацією Agy, перевіркою cleanup і збереженням успадкованого RAF_QA_HOME **не запускався повторно**. Ready/identity/paste/task/exit стадії не підтверджені; scaffold потребує перегляду й живого проходження після відновлення передумов.

## Прогони

Для кожного рядка незмінений повний JSON міститься в `<label>.TestRunResult.json`, точна команда — `<label>.command.txt`, stderr — `<label>.stderr.txt`, код CLI — `<label>.cli-exit-code.txt`. Child exitCode міститься окремо в JSON. Усі CLI/child exitCode дорівнюють 1, outcome `assertions-failed`; setup/import failure не використовувався як red.

| label | runId | group / phase | результат групи / nextAction |
| --- | --- | --- | --- |
| red | d92a5bd7-e610-47e4-95dd-b7f56bb22962 | complete-raf-flow-contracts/z458-native / red | idle / implement |
| live-1 | 0292e83d-a5de-43ee-a403-aac9503984f3 | complete-raf-flow-contracts/z458-native-live / integration | incomplete / complete-integration |
| live-2 | 316e163a-a282-46e7-8bad-4e711cc08a34 | complete-raf-flow-contracts/z458-native-live / integration | incomplete / complete-integration |

Unit selection: `test/runner-native-config-z458.test.ts`; integration selection: `test/runner-native-live-z458.test.ts`, налаштована група. Кожен результат має два knownRed, порожні unexecuted/unknown/removed, timedOut=false, timeoutCount=0, cleanup.complete=true, remainingPids=[]. Точні назви knownRed і політика timeout збережені в JSON; нових timeout не додавалося. Повторний hotfix unit-прогін не виконувався, оскільки виправлення немає. Green/pass не заявляється.

SHA й незакомічені власні шляхи наведені в `run-workspaces.json`; SHA **відновлені за часом комітів**, а не захоплені перед spawn. Повного первісного diff/source digest немає. `workspace-at-close.json` — окремий зріз спільного дерева; чужі зміни не включені до власного коміту. Така межа доказів не дозволяє заявляти повністю відтворюваний snapshot кожного історичного запуску.

## Живі спостереження й auth

Встановлено Grok 1.0.67 та Agy 1.4.7. `attempt-2-live-grok.json` показує очікування browser approval; модельного завдання не виконано. Agy показав `currently not signed in` / `Signing in`; тодішній harness передчасно визнав цей проміжний стан помилкою. Отже постійна відмова авторизації Agy незалежно не доведена, а його готовність і live task залишилися неперевіреними. Детектор скориговано, але після вказівки main не робити нових запусків його не перевіряли. Raf не відмовляв у запуску цих integration-груп: обидві допущені; це не новий код відмови raf.

Перший запуск (`attempt-1-*`, `probe-setup.json`) помилково використовував копії credentials у власному тимчасовому HOME. Main заборонив це; копії та `/tmp/raf-z458` видалені, власний probe tmux зупинений. Цей запуск має невалідну передумову й не є прийманням. Другий використовував звичайний HOME без копій. Збережені кадри редагують email/device code, файлів auth чи їхнього вмісту серед доказів немає. У першому Grok probe main завершив власну pane через C-q, тому child failure також не доводить самостійного завершення Grok. Інтеграційні власні тимчасові теки прибрані у finally.

Наступна дія: отримати доступну авторизовану сесію поза цією роботою, потім підтвердити повний діалект та модельний task обох CLI у тій самій налаштованій integration-групі; доповнити conf лише спостереженими полями й тоді liveTaskVerified=true. Після виправлення прогнати unit `--phase hotfix` з тією самою групою й тим самим списком файлів. Лічильники, QA HOME та назви груп не скидати. До цього Z.458 залишається відкритим.
