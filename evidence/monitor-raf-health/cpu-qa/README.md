# monitor-raf-health 2.4 — незалежний QA

Результат 2.4: unit, локальний integration bench і незалежний CLI/worker host-прогін main пройдені. Галочку tasks.md не змінено. Інші пункти зміни відкриті, archive не виконується.

## Unit

Повна адресна команда — `unit.command.txt`. Група `monitor-raf-health/cpu`, phase `qa`, лише `test/health-cpu.test.ts`, той самий агрегат/HOME від переданого red. Перед прогоном SHA `690abcbc8c6b47ecebe82f9ac78a2002f19b09e1`, tracked/untracked status порожній (створена evidence-тека ще порожня). Знімок — `unit.workspace.json`.

`unit.TestRunResult.json` — повний незмінений JSON, `unit.tool-result.json` — транспортний результат, `unit.cli-exit.txt` — CLI окремо від child exitCode. RunId `1ed1c860-3b7a-4274-850f-ace793a0e143`: passed, 66 passed, CLI/child 0, timedOut=false, cleanup.complete=true, remainingPids=[], knownRed/unexecuted/unknown=[], timeoutCount=0, groupState=complete, nextAction=complete. Runtime v26.12.1; версії й fingerprints conf є в JSON. Повторний прогін не потрібний.

Поточний exec transport повертає об'єднаний потік. Він містив рівно один повний JSON без сторонніх байтів. `unit.stderr.txt` порожній за цим спостереженням, але незалежного захоплення stderr інструмент не надає; межу явно зафіксовано в `unit.capture-note.txt`. Не видаємо це за окремо захоплений канал stderr.

## Локальний bench

Команда `node scripts/qa-health-cpu-host.ts evidence/monitor-raf-health/cpu-qa`; повні результати `host.summary.json`, розділені stdout/stderr/CLI code — `host.*`. RunId `cf9bd829-3815-41a4-8080-3bf4ce0aec8e`, CLI 0, шість сценаріїв passed, cleanup complete. Це Linux-процеси з production RafCostRuntime, SQLite, settleRuntimeHealthCpu, event-registry та admission; synthetic CPU-лічильники не використовуються.

Три паралельні own scopes дали 6616.217 ms CPU за фактичні 2418.743453 ms wall (2.735394 ядра, поріг 1); окремий payload використав 2202.468 ms і не потрапив у профіль. Створено одну подію; повтори й reopen її не дублюють. Payload-only без нових own samples, відкритий own interval, невідомий helper CPU та несправне читання не видаються за healthy zero. Admission за незмінним входом і реальні таблиці queue/reservations не змінені. Для helper-вікна конкретна причина partial — `Own CPU intervals outside window`; окрему повноту helper CPU цей bench не доводить. Git helper `--version` → 0; невідома опція → 129 із `unknown option`. Це коди git, не raf CLI.

Перший fixture-прогін (`fixture-first.host.*`, CLI 1) хибно шукав уже доставлену подію в pending. Dispatcher коректно її прибрав. Fixture виправлено прозорим спостереженням savePending без зміни production-поведінки; це помилка стенда, не red продуктового дефекту. Production-код і unit-тести не змінювались.

`build.*`, `comments.*`, `diff-check.*`: CLI 0. Синтаксис обох host-скриптів перевірено `node --check` → 0. Ці перевірки не замінюють live CLI/worker.

## Підтверджений CLI/worker host-стенд

Main підтвердив: готового CLI/worker-стенда немає; запуск виконує main після перегляду diff, на чистому клоні з resource wait, із read-only архівом, sha256 і secret scan. Підготовлено `scripts/qa-health-cpu-cli-host.ts` на базі чинного `qa-cost-profile-host.ts`/production fixture.

Точна команда з cwd чистого клону raf (main обирає зовнішній шлях доказів):

```sh
node scripts/qa-health-cpu-cli-host.ts /srv/dev/raf-mrh24-cli-evidence
```

Скрипт сам створює `/srv/dev/raf-health-cpu-cli-*`, ізольовані HOME/TMPDIR, fixture Git/main, власну службу, реальний tmux/production worker і synthetic busy runner без провайдера. Змінює CPU window лише у fixture conf на 1000 ms, поріг лишає production. Реальний production CLI зберігає stdout/stderr/exit та commands/profile/health. Прямі вимірювані contributors доводять повне вікно й одну подію до старту служби; живі service/worker windows із відкритими інтервалами перевіряються як partial/unavailable. SQLite audit trigger лише у fixture спостерігає всі записи події до штатного dispatch. Для admission-інваріантів worker/service спочатку штатно завершуються, щоб не порівнювати випадкові lifecycle-зміни.

Невалідний health state тимчасово вводиться лише у fixture; позитивний command stats лишається CLI 0 із unavailable CPU. Відновлення стану й cleanup виконуються у finally. Чотири повні сценарії й cleanup потрібні для CLI 0; setup/assertion/cleanup failure дає CLI 1, не pass.

Main виконав скрипт на SHA `5c7107de1bd1c26e8ce9ee2e465a9e76b205bf64`; runId `9e4f443a-e123-4e80-8504-9f035e018040`, CLI 0, status passed, 4/4 сценарії. Незмінені результати — `cli-host/summary.json`, кожна CLI-команда має окремі stdout/stderr і code/signal у summary; повний stdout/stderr host-процесу також збережено. Node v26.12.1, git 2.53.0, tmux 3.6, openspec 1.14.3; повні версії, команди/argv і conf — у summary.

Read-only джерело `/srv/dev/raf-mrh24-cli-evidence` і manifest `/srv/dev/raf-mrh24-cli-evidence.sha256` скопійовано побайтно; усі 21 SHA256 підтверджено. Оригінальний manifest — `cli-host.sha256` (шляхи відносно `cli-host/`). Погоджений канал main передбачає clean clone і resource wait; фінальна передача підтвердила CLI 0, 4/4 та secret scan 0. Команду та сирий результат secret scan main не передавав, тому scan — атрибутований результат main. Наші перевірки копії й підсумок приймання — `acceptance.json`.

Повне виміряне вікно: 6615.353 ms own CPU за 2482.975571 ms wall, 2.664284368 ядра при порозі 1. Окремий payload використав 2204.557 ms CPU й виключений. Audit містить одну `raf.cpu-exceeded`; повторне settle/CLI її не дублює. Власна служба й production worker (`fixture-run-1`) живі, synthetic runner реально зайняв CPU; одна доставка брифа. Живе вікно повернуло `partial`, причину `Profile attribution incomplete`, `cores: null`. Зіпсований fixture health повернув `unavailable`, `cores: null`, точну JSON parse-причину; command stats → 0. Admission за однаковим входом та реальні queue/reservations до/після однакові. Cleanup complete, failures/remainingChildPids порожні, тимчасову теку видалено.

Точний негативний результат: `agent message --to missing-health-qa --text CPU_QA_NON_SECRET_CANARY` → CLI 1, `CALLER_UNVERIFIED`, `Current process ancestry has no verified registered agent or attached main pane`. Перевірка ancestry спрацювала до пошуку одержувача. Назва четвертого сценарію згадує missing-recipient, але доказ не підтверджує окрему помилку пошуку чи доставки; він підтверджує фактичну авторизаційну відмову. Сирий stderr з попередженнями навмисно збережено.

Межі: synthetic runner без AI provider; повне CPU-вікно виміряне реальними RafCostRuntime contributors до старту служби, а наступний live worker/service сценарій перевіряє чесний partial. Fixture window 1000 ms замість production 600000 ms, threshold незмінний. Недоступний per-child helper CPU не підміняється нулем. Продуктових дефектів не виявлено; production-код і unit-тести не змінювалися. Галочку 2.4 ставить raf за JSON-звітом; інші пункти відкриті, archive не потрібний.
