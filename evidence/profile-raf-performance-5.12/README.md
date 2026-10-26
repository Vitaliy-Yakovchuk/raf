# profile-raf-performance:5.12

Виправлено повторне підтвердження звіту worker за таймером після вичерпання bounded retry. Production-порти тепер очікують подій щодо джерела доручення, конфігурації, Git refs/index/lock або звільнення внутрішньої черги writer. Після події незмінений JSON проходить повну свіжу перевірку. Збережено один deadline transitionMs, pending-звіт після виходу runner та cleanup підписок; числову політику flow не змінено. Завершений власний lock churn не змінює snapshot і не підтримує цикл.

## Перевірений red і hotfix

[runs.json](runs.json) містить точні команди, SHA/стан workspace, відбір, runId, CLI та child exitCode, cleanup/timeout, knownRed/unexecuted/unknown, стан групи й наступну дію. Незмінені JSON TestRunResult збережено окремо від CLI envelope, stderr і CLI exit. CLI повертає об'єднаний потік: рядок TestRunResult копіюється дослівно, stderr launch-queue.waiting виділено за підтвердженим джерелом. Відсутні дані не замінено вигаданими.

- Початковий red `d56a60c5-90d1-400a-b175-a4aaef5865df`: assertion щодо періодичних таймерів, CLI/child 1.
- Hotfix `97e3d095-25c6-4cd5-aa3c-ef86cdc047aa`: 7 passed, CLI/child 0; точні джерела пізніше закомічено як 841133e.
- Додаткова регресія внутрішньої черги спочатку закомічена як 356aec10. Red `05154b6b-5a28-4817-b939-93ecd422b843`: 7 passed, 1 assertion failed — звільнення writer без файлових змін не пробуджувало інший звіт, CLI/child 1. Прогін чекав ресурсу; за вказівкою main не перезапускався.
- Після події звільнення writer, коміт 8999c647, hotfix `0b1eac4e-8b16-4f48-9bc5-8b0addf39ea1`: 8 passed, CLI/child 0, knownRed/unexecuted/unknown порожні, cleanup complete, timedOut false, group complete / nextAction complete.
- Build і check:comments на фінальному коді: CLI 0, ізольований HOME=RAF_QA_HOME=/tmp/raf-prp512-checks.

Група `profile-raf-performance/worker-report-wait-cost` та QA HOME незмінні між усіма фазами; історія агрегату не скидалася. Окремий відхилений транспортом виклик не був red. Одну повторну команду виконано після підтвердженої main зміни production-generation. Один проміжний extended red відомий лише з підсумку: його raw втрачено до збереження, тому він не використаний замість повного доказу. Ці обмеження явно записані в runs.json.

## CPU-профіль і відтворення

Main запустив [stand](../../scripts/profile-worker-report-wait.ts) на хості в clean clone з HOME=RAF_QA_HOME=/tmp/prp512-*; живі production-процеси й модель не профілювалися. Команда стенда: `node scripts/profile-worker-report-wait.ts <SHA> <evidence-directory>` в ізольованому HOME. Quiet не публікує звіт; report публікує валідний succeeded із реальним fixture commit; blocked додатково утримує відомий живий raf-task-checkbox.lock 30 с і звільняє його. Worker запускається з --cpu-prof; trace фіксує його helper-команди. Значення таймера навантаження стенда не змінюють runtime flow.

Повні оригінальні stdout/stderr/exit, summary, .cpuprofile і trace для трьох режимів збережено gzip без зміни вмісту. Кожний manifest містить SHA, dirty, вихідний шлях, розмір і SHA256 розпакованих байтів. Усі 30 файлів звірено. Main повідомив secscan 0 для p5/p6.

| Режим, 30 с | Baseline 6dac8cf, worker ticks | Fix 841133e, worker ticks | Baseline / fix helper commands |
| --- | ---: | ---: | ---: |
| quiet | 100 | 94 | 0 / 0 |
| report | 167 | 159 | 117 / 117 |
| blocked | 1178 | 135 | 1820 / 45 |

[Порівняння](cpu-comparison.json): blocked — 11,78 → 1,35 с CPU worker, або 39,26 → 4,50% одного ядра, зменшення 88,54%; helper-команд менше на 97,53%. CLK_TCK=100. Це self CPU worker; CPU дочірніх процесів/моделі не включено. Одна пара прогонів, без статистичного висновку про розкид. Quiet завершується failed через відсутність звіту, що очікувано; поле lifecycle passed не підміняє приймання звіту. Report і blocked після звільнення writer завершилися succeeded без report-rejected; pending очищено, доручений fixture пункт 2.1 підтверджено, недоручений 3.1 залишився відкритим.

Профіль [baseline stacks](host-before/blocked-stacks.json) показує найбільшу активну роботу в spawn Git через validateReportedCommitGroups (~4,08 с зважених семплів), repositoryIdentity (~3,80 с), reconcileReportedCommitIndex (~1,37 с), далі запис cost profile (~0,80 с). Це семпли повного життя profiler включно зі стартом/звільненням, не сума CPU лише 30-секундного вікна. Trace baseline показує helper starts у кожному 5-секундному кошику: 219/336/316/323/273/353. Після виправлення: 24/0/21/0/0/0; останні ~19,7 с вікна без helper starts. Друга скінченна спроба близько 10 с спричинена вже поставленою в чергу подією звіту. Звільнення lock автоматично підтвердило ті самі байти JSON.

Попередній p4 також збережено, але його report/blocked після release мали fixture author identity error; він не є доказом приймання. Identity фікстури локально виправлено комітом 6dac8cf перед порівнянням p5/p6. Попередні старти p1/p2 не дійшли до readiness; вони не були unit red. Host-порівняння стосується 841133e; пізніше доповнення 8999c647 додає лише подію звільнення внутрішньої черги та перевірене тестом, окремого host CPU-прогону цього доповнення немає.

## Повільні agent ps / agent close

[Оригінальні 15 stage/executor rows та EMA](ps-close-profile.json) надав main з /srv/dev/prp512-stats/ps-close-profile.json; [аналіз](ps-close-analysis.json). На момент читання EMA ps 82,745 с, close 23,813 с. Домінантний self stage ps — reconciliation: 2375,699 с wall / 2092,021 с CPU сукупно; close — handler: 696,011 с wall / 695,356 с CPU. Це накопичені інтервали різних команд/версій/навантажень, не тривалість однієї команди й не парний benchmark. Child CPU unavailable, не нуль. Висновку про прискорення ps/close саме цим hotfix немає; у 5.12 доручено їхній замір за наявним профілем.

## Межі та актуальність

Поточний tasks.md зберігає 5.12 відкритим і містить окремий 5.12.1 для чужої report-confirmation регресії. Main прямо підтвердив відсутність grant у нашому launch; чужу групу не запускали. Невелика адаптація mocked inputs у test/report-confirmation-runtime.test.ts входить до 841133e, її ширшу регресію виконує окреме доручення 5.12.1. Production-runtime порт main звільнив після Z.428. Чужу test/hotfix-fixture.ts та чужі evidence не змінювали.

Аудит перед реалізацією й після нових обставин: 5.12 чинний, його пряме доручення усунути polling уточнює загальний Non-goals proposal щодо іншого worker-очікування 9.1.1. Інших змін flow немає. Задачі 4.5, 5.1, 5.2, 5.8, 5.11/підпункти та 5.12.1 лишаються відкритими, тому sync/archive не виконується. Галочки 5.12 ставить raf після прийняття звіту; виконавець tasks.md не змінював. Активацію коду виконує main.

## Нові дані після початкового звіту

Main підтвердив стабільну source-freshness регресію після 841133e у test/report-confirmation-progress.test.ts (три прогони clean clone); відповідний тест проходить на e73c7bd. Другий тест prepared journal падає після виправлення, але нестабільний також на базі. Деталі й межі переданого доказу — [post-report-regression.json](post-report-regression.json). Тому висновок цього запуску змінено на failed; 5.12 не випущено. Виправлення чужої групи належить окремому 5.12.1. Попередні власні green та CPU-числа не є доказом відсутності цієї регресії.

Main також уточнив, що звіт саме цього запуску не прийнятий: галочка tasks.md не доводить його прийняття. Наданий CLI не має agent report (довідка повернула UNKNOWN_COMMAND); atomic JSON залишається каналом доставки за початковим брифом.
