# 1.1.15: lease лише для модального запиту Codex

База: 367ae0a70e41a51609b00914e092bd3fb492a9c8, власні production правки лише src/production-runtime.ts; регресія test/cli-live-latency.test.ts. main обмежив продовження lease-фіксом; launch budget не піднімався, його оптимізацію main передасть окремо після активації.

## Причина та виправлення

coordinator.observe раніше брав tryWaitLease для кожного живого Codex перед capture-pane. tryWaitLease запускає python3/fcntl, навіть коли модального запиту немає. На фікстурі 406 sessions / 7 active / 260 processes це шість зайвих helper spawn. Тепер dismissCodexLimitModal спершу підтверджує pane і читає екран; без modal завершується без message-lock. Коли потрібні клавіші, бере ту саму lease, повторно читає екран і свіжо перевіряє OS identity та pane перед send-keys. Lease звільняється у finally. Поведінка, формат результату, ліміти й таймаути збережені.

## Test-first і перевірки

Точні команди, SHA/dirty scope, CLI code окремо від child exitCode, SHA256 повних незмінених TestRunResult, knownRed/unexecuted/unknown, cleanup/timeout і groupState/nextAction — runs.json. Стабільна група fix-raf-cli-live-latency/live-latency і QA HOME не змінювались. Запуски виконані лише довіреним raf test run.

- baseline e0299679: до production правки launch budget 3003.436 >3000 мс; 16 passed, один assertion. Це не власний RED lease-фіксу.
- RED 6d2f9bc8: нове твердження про відсутність message-lock падає на pristine production source, 7 passed. ps 210.813 мс. Передано --phase red, але канал повернув callerPhase=hotfix. phase-finding.json містить expected/actual та receipt; main явно прийняв предметний RED і заведе окремий дефект каналу.
- green-fixture-failure 942a8ab1: no-modal regression пройшла; додаткова modal delivery перевірка спочатку мала synthetic PID без /proc й тому правильно не надіслала клавіші. Фікстуру виправлено, прив’язавши лише перевірювану identity до власного тестового процесу; свіже підтвердження не послаблювалось. Launch budget 2214.532 мс пройшов.
- GREEN ac082a32: 10 passed у cli-live-latency + worker-launch-latency, CLI/child 0/0, outcome passed, knownRed=[], complete. Launch overhead 2162.685 мс <3000.
- broad e02e3935: 60 passed (os-runtime, production-runtime, lifecycle, lease), один launch budget 3032.499 >3000; CLI/child 1/1. Це відоме повторення baseline-падіння. Нових production правок для підгонки бюджету немає.
- final feee7947: після спрощення читабельності фікстури всі 8 cli-live-latency passed, ps 50.236 мс; child0. CLI1/outcome assertions-failed через збережений агрегат worker budget, knownRed лишається одним. groupState idle, nextAction fix-implementation. Весь агрегат не називається GREEN.

Усі прогони: timedOut=false, cleanup.complete=true, remainingPids=[], unexecuted=[], unknown=[]. Broad і final збережено з повним combined tool output і доступним stderr окремо. Для ранніх чотирьох stderr інструмент обрізав: повні TestRunResult скопійовано без змін, але окремий повний stderr недоступний; це явний недолік доказів логування. JSON результатів не обрізано. Ненульові CLI codes збережено й не замінено child code.

Build: HOME=/tmp/raf-frcll-1-1-15-build RAF_QA_HOME=/tmp/raf-frcll-1-1-15-build node scripts/build.ts — exit0. git diff --check — exit0.

## Читабельність

Перевірено diff від зазначеної бази та власні робочі правки перед комітом. Область: новий dismissCodexLimitModal і змінений coordinator.observe у sessionTools, змінена test-функція agent ps shares one process and pane snapshot. Helper має одну дію: розпізнати та безпечно закрити modal. Передумови завершуються явно; read-only precheck передує файловому запису/lease; перехід до send видимий після recapture й fresh ownership. Побічні ефекти mkdir, lease, send та release простежуються в одному тілі. Споживач observe лишає один названий виклик. Фікстура явно відокремлює process facts, modal screens і sent keys; перевіряє відсутність lease, зникнення modal і збережену доставку клавіші. Збереження поведінки: 8 цільових та 60 ширших перевірок; окремий launch budget red не приховано. Незмінені частини великого sessionTools не перебудовувалися. Crapper/dryer/mutator доручення не призначає.

## Передача

Main активує кандидат і повторно міряє живий ps/overhead. Попередні живі докази та часові мітки — ../../live-after-1.1.14/. Пункт батьківського доручення 1.1 не завершений: ps медіана1245 мс >1000, живий overhead у кількох теплих запусках >3000, холодні повтори не підтверджено. Галочки виконавець не змінював, archive не виконував. Власний результат 1.1.15 — lease-фікс; звіт assignments містить лише первинний ID1.1.
