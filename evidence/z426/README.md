# Z.426 — атомарне звільнення lock

Виконано лише `complete-raf-flow-contracts:Z.426`. Аудит актуального proposal (Why/What Changes), вибраного tasks item, `core/process/test-first`, `core/process/unit-test-runs`, `projects/orchestrator/parallel-development` та вимоги аудиту autonomous-development підтвердив актуальність дефекту. Контракт test-runs прочитано в активній залежності `openspec/changes/add-raf-test-run/specs/projects/raf/test-runs/spec.md`; окремого канонічного файла ще немає. Новий unit-файл і групу зареєстрував main у Orchestrator `3eb94513a3` до запуску.

Попередній release рекурсивно видаляв активну теку, залишаючи вікно між unlink owner.json і rmdir. Конкурентний claim міг замінити порожню теку своїм підготовленим lock; release першого власника тоді падав ENOTEMPTY або торкався наступного власника. Та сама помилка була в activation і writer lock.

Тепер кожний claim повертає унікальний token разом із PID/start. Спільний release перевіряє ці три поля, атомарно перейменовує власну непорожню теку в унікальний `.released-<token>` і видаляє вже цей шлях. Після rename наступний claim може зайняти активне ім'я, а cleanup попередника його не зачіпає. Зміна власника дає явну помилку зі збереженням чужої теки. Reclaim померлого процесу, admission, бюджети та flow не змінені.

Регресія ізольована й не запускає робочі raf/service/tmux або зовнішні провайдери. Мінімальна Git-фікстура потрібна для чинних public API locked/withHotfixWriter. Контрольоване чергування файлових операцій видаляє owner.json на шляху recursive removal, допускає наступний реальний claim через ці API та зупиняє його до перевірки результату першого release. До виправлення це відтворило точний ENOTEMPTY для обох lock. Інші перевірки зберігають чужий lock того самого PID/start з іншим token і підтверджують release після помилки callback.

| Фаза | runId | Outcome | CLI / child | Passed / knownRed |
| --- | --- | --- | --- | --- |
| red | a28140c2-5abe-4fdf-800b-985aa1b2c52b | assertions-failed | 1 / 1 | 2 / 4 |
| hotfix | b94be489-1cae-4dc7-82eb-8bd00875dacd | passed | 0 / 0 | 6 / 0 |

Обидві точні прості команди наведені в `red-workspace.json` і `hotfix-workspace.json`: project=raf, стабільна group=`complete-raf-flow-contracts/z426`, files=`test/hotfix-lock-release.test.ts`; змінювалася лише phase red → hotfix. База обох прогонів — `539ee9624d412665fff68e0787056ac61ea09f90`, workspace `/srv/dev/work/orchestrator/raf-hotfix`, гілка hotfix. Snapshot містять dirty paths і SHA-256 тесту/коду. Тест не змінювався між red і hotfix; `red-workspace.patch` зберігає його повний текст, `fixed-workspace.patch` — production-виправлення. Сторонній untracked node_modules не змінювався.

Обидва прогони використовували той самий ізольований QA HOME `/tmp/raf-unit-1000/1ee10007bf6d5e71b39d6a2873064a767eeb928e7910599b166a0d60270ff685`. timedOut=false, cleanup.complete=true, remainingPids=[], timeoutCount=0, unexecuted/unknown=[] в обох результатах. Red: groupSnapshot=loaded, groupState=idle, nextAction=implement. Hotfix: groupSnapshot=loaded, groupState=complete, nextAction=complete, knownRed=[]. Setup/import failure немає.

Кожний `*.stdout.json` містить повний JSON TestRunResult без редагування, `*.stderr` — повний рядок launch-queue.waiting, `*.cli-exit-code.txt` — код CLI окремо від child exitCode. `*.tool-result.json` зберігає повну незрізану відповідь exec_command; для red відповідь точно перенесена з результату інструмента, для hotfix — безпосередньо збережена з пам'яті виклику. `red.merged-output.txt` додатково зберігає первинний об'єднаний вивід. Manifest фіксує довжини й SHA-256 артефактів.

Обмеження capture: exec_command повернув stdout і stderr разом у полі output, а не як незалежно захоплені потоки. Окремі файли — точні копії першого JSON TestRunResult і другого JSON launch-queue.waiting з повної відповіді, а не незалежний host capture. Повторів заради capture не було; немає доступу до SQLite, реконструкції з lastResult чи обходу sandbox. Main повідомив, що окремої команди отримання вже виконаного run немає; збереження merged output з цим явним обмеженням погоджено повідомленням у цій сесії. Повноту й коди додатково звіряє raf за broker resultDigest/stderrDigest. Автоматичне збереження потоків належить відкритому Q97; цей пункт його не реалізує.

`node scripts/build.ts` успішний (CLI 0, `build.*`); збірка виконана з окремим тимчасовим HOME, який видалено після завершення. Це не змінювало QA HOME чи агрегат unit-групи. `git diff --check` успішний. Live запусків агентів або production-активації це доручення не вимагало і не підтверджує.

На завершення в tasks.md залишалися 116 інших відкритих пунктів. Tasks.md не редагувався, archive не застосовується. Наступна дія — прийняття JSON і checkbox Z.426 силами raf; випуск/активацію виконує main.
