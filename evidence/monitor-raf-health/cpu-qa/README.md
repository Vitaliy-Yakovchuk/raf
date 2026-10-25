# monitor-raf-health 2.4 — незалежний QA

Стан на підготовку host-стенда: unit і локальний integration bench пройдені; остаточне приймання 2.4 очікує CLI/worker host-прогону main. Галочку tasks.md не змінено. Інші пункти зміни відкриті, archive не виконується.

## Unit

Повна адресна команда — `unit.command.txt`. Група `monitor-raf-health/cpu`, phase `qa`, лише `test/health-cpu.test.ts`, той самий агрегат/HOME від переданого red. Перед прогоном SHA `690abcbc8c6b47ecebe82f9ac78a2002f19b09e1`, tracked/untracked status порожній (створена evidence-тека ще порожня). Знімок — `unit.workspace.json`.

`unit.TestRunResult.json` — повний незмінений JSON, `unit.tool-result.json` — транспортний результат, `unit.cli-exit.txt` — CLI окремо від child exitCode. RunId `1ed1c860-3b7a-4274-850f-ace793a0e143`: passed, 66 passed, CLI/child 0, timedOut=false, cleanup.complete=true, remainingPids=[], knownRed/unexecuted/unknown=[], timeoutCount=0, groupState=complete, nextAction=complete. Runtime v26.12.1; версії й fingerprints conf є в JSON. Повторний прогін не потрібний.

Поточний exec transport повертає об'єднаний потік. Він містив рівно один повний JSON без сторонніх байтів. `unit.stderr.txt` порожній за цим спостереженням, але незалежного захоплення stderr інструмент не надає; межу явно зафіксовано в `unit.capture-note.txt`. Не видаємо це за окремо захоплений канал stderr.

## Локальний bench

Команда `node scripts/qa-health-cpu-host.ts evidence/monitor-raf-health/cpu-qa`; повні результати `host.summary.json`, розділені stdout/stderr/CLI code — `host.*`. RunId `cf9bd829-3815-41a4-8080-3bf4ce0aec8e`, CLI 0, шість сценаріїв passed, cleanup complete. Це Linux-процеси з production RafCostRuntime, SQLite, settleRuntimeHealthCpu, event-registry та admission; synthetic CPU-лічильники не використовуються.

Три паралельні own scopes дали 6616.217 ms CPU за фактичні 2418.743453 ms wall (2.735394 ядра, поріг 1); окремий payload використав 2202.468 ms і не потрапив у профіль. Створено одну подію; повтори й reopen її не дублюють. Payload-only без нових own samples, відкритий own interval, невідомий helper CPU та несправне читання не видаються за healthy zero. Admission за незмінним входом і реальні таблиці queue/reservations не змінені. Для helper-вікна конкретна причина partial — `Own CPU intervals outside window`; окрему повноту helper CPU цей bench не доводить. Git helper `--version` → 0; невідома опція → 129 із `unknown option`. Це коди git, не raf CLI.

Перший fixture-прогін (`fixture-first.host.*`, CLI 1) хибно шукав уже доставлену подію в pending. Dispatcher коректно її прибрав. Fixture виправлено прозорим спостереженням savePending без зміни production-поведінки; це помилка стенда, не red продуктового дефекту. Production-код і unit-тести не змінювались.

`build.*`, `comments.*`, `diff-check.*`: CLI 0. Синтаксис обох host-скриптів перевірено `node --check` → 0. Ці перевірки не замінюють live CLI/worker.

## Стенд для main

Main підтвердив: готового CLI/worker-стенда немає; запуск виконує main після перегляду diff, на чистому клоні з resource wait, із read-only архівом, sha256 і secret scan. Підготовлено `scripts/qa-health-cpu-cli-host.ts` на базі чинного `qa-cost-profile-host.ts`/production fixture.

Точна команда з cwd чистого клону raf (main обирає зовнішній шлях доказів):

```sh
node scripts/qa-health-cpu-cli-host.ts /srv/dev/raf-mrh24-cli-evidence
```

Скрипт сам створює `/srv/dev/raf-health-cpu-cli-*`, ізольовані HOME/TMPDIR, fixture Git/main, власну службу, реальний tmux/production worker і synthetic busy runner без провайдера. Змінює CPU window лише у fixture conf на 1000 ms, поріг лишає production. Реальний production CLI зберігає stdout/stderr/exit та commands/profile/health. Прямі вимірювані contributors доводять повне вікно й одну подію до старту служби; живі service/worker windows із відкритими інтервалами перевіряються як partial/unavailable. SQLite audit trigger лише у fixture спостерігає всі записи події до штатного dispatch. Для admission-інваріантів worker/service спочатку штатно завершуються, щоб не порівнювати випадкові lifecycle-зміни.

Невалідний health state тимчасово вводиться лише у fixture; позитивний command stats лишається CLI 0 із unavailable CPU, missing-recipient message — nonzero з причиною. Відновлення стану й cleanup виконуються у finally. Чотири повні сценарії й cleanup потрібні для CLI 0; setup/assertion/cleanup failure дає CLI 1, не pass. Скрипт ще не запущений у цьому sandbox: він потребує хостового `/srv/dev`, власних сокетів і дозволеного CLI-каналу main.
