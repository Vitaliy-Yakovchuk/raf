# fix-raf-cli-live-latency:1.1.6

Ізольована копія живого SQLite (364 sessions, 444 notices, 330 intents), конфігурації й OpenSpec Markdown; справжній tmux у приватному socket і синтетичний Codex. Живий HOME, main tmux і модельні сервіси не змінювалися. Фікстура не доводить живий бюджет справжнього Codex: активація й живий повтор належать main.

## Профіль

Базова ревізія production — `45ce4187ad282880dd426bab784e3915ce5b2465`; candidate — та сама production-основа з власним diff у `src/production-runtime.ts`. Стан і конфігурація обох прогонів однакові; SHA256 у [copy-manifest.json](copy-manifest.json). Після штатного worker settlement обидві копії мають 363 sessions / 449 notices / 331 intents.

| Етап | baseline, мс | candidate, мс |
| --- | ---: | ---: |
| OpenSpec assignment | 338.82 | 345.78 |
| Контекст задачі | 15.23 | 27.02 |
| Доступність runner-ів і routing snapshot | 400.45 | 174.23 |
| Підготовка звіту | 4.62 | 3.33 |
| Бриф | 2.54 | 1.86 |
| Admission | 244.22 | 194.47 |
| Wrapper / runner / tmux / readiness / delivery | 3182.74 | 1734.42 |
| Перевірка process identity | 30.70 | 29.65 |
| Запис started у стан | 1.75 | 1.29 |
| Разом виміряних етапів | **4221.07** | **2512.06** |

[baseline-final.json](baseline-final.json), [candidate.json](candidate.json) — сирі виміри. Це сума service-етапів, без CLI bootstrap; повний CLI окремо виміряний unit-групою. Поле `scope` у цих двох початкових JSON помилково успадковане від preparation-only harness: реально вони включають синтетичний worker, tmux і delivery, як видно з етапів та timeline. JSON залишено незміненими; актуальний harness описує scope правильно.

Worker timeline: [baseline](baseline-final.worker-timeline.jsonl) / [candidate](candidate.worker-timeline.jsonl). Початковий readiness loop чекав 4 × 500 мс: початковий екран і ще після введення `/status`, Enter та підтвердження native ID. Candidate чекає початковий екран 1 × 500 мс, а після власних дій одразу читає наступне спостереження. Якщо підтвердження ще немає, залишається чинний poll. `statusSubmissionPending` запобігає повторному Enter на першому незміненому екрані після відправлення. Таймаути й pollMs не змінені.

Runner `--version` перевіряються паралельно. Результати, причини й попередження записуються в початковому порядку конфігурації; probe обраного runner у worker збережено для перевірки фактично запущеного executable. Число parent child-викликів залишилося 13: зайвих повторних version probes у parent немає. SQLite має лише 2 `listActiveSessions` (~6 мс), 1 `listReservations`, 9 адресних `getSession`; повне читання історії в цьому шляху вже усунув попередній hotfix, нової зміни контракту стану не потрібно.

CPU profiles [baseline](baseline-final.cpuprofile), [candidate](candidate.cpuprofile) охоплюють parent service; окремий worker має span timeline. Повна жива затримка 10.09/9.82 с не розкладена сервісом: main має лише client wall та секундний process.startedAt. Вихідні runId: `2e5685e1-ca51-47bb-b669-0e71fff34b68`, `31a30718-7512-4949-af75-dd93ae957245`; admission `waited=false`, queueId `15392981`. Не приписуємо решту живого часу конкретному етапу без доказів.

## Відтворення профілю

Запускати з raf-hotfix; потрібні read-only доступ до живої SQLite, node 26, tmux і встановлені runner `--version`. SQLite, conf та OpenSpec копіюються лише у `/tmp/frcll-1-1-6`, наявний seed повторно використовується. Не копіювати secrets.json. Профільні synthetic worker-и мають власний QA HOME і socket. Синтетичний процес не викликає модель та не виконує бриф.

```sh
python3 evidence/hotfix-1.1.6/prepare-copy.py
python3 evidence/hotfix-1.1.6/profile-worker.py 45ce4187ad282880dd426bab784e3915ce5b2465
PROFILE_FULL=1 node evidence/hotfix-1.1.6/profile-copy.mjs baseline-repro
python3 evidence/hotfix-1.1.6/profile-worker.py
PROFILE_FULL=1 node evidence/hotfix-1.1.6/profile-copy.mjs candidate-repro
```

Harness завжди відкриває живу SQLite readOnly і робить backup; у копіях перенаправлено report/brief paths. Копія `projects.json` використовує приватний main/develop store, а дозволену hotfix cwd лишає production-каталогом для перевірки зареєстрованого шляху. Власний код у cwd synthetic не пише. Parent дозволяє лише read-only child-виклики; worker працює зі своїм tmp/socket. Після вимірювання harness прибирає лише свій tmux server. Сирі SQLite/conf/OpenSpec копії не включені в Git.

## Перевірки та читабельність

Незалежну початкову production-реалізацію завершено до читання підготовлених тестів. Жоден підготовлений тест не змінено. Власний `test/cli-agent-run-startup.test.ts` перевіряє паралельний старт усіх probes, початковий порядок результатів, unavailable runner, /status → Enter без poll та відсутність подвійного Enter при відкладеному статусі, native ID до доставки. Початкові варіанти власного fixture уточнено: всім runner потрібен чинний native dialect; часовий інтервал до повної доставки включав обов'язкові ownership/start-gate дії й не є одним readiness poll. Усі невдалі прогони збережені; вони не видані за GREEN.

Файли `*.TestRunResult.json` скопійовані byte-for-byte з автоматичного tmp-файла raf. `*.cli.json` розрізняють CLI code і child exitCode, а `*.stderr` містять доступний stderr. `*.tool-output.txt` — сирий комбінований вивід інструмента; великі JSON виводу обрізані, але автоматичний TestRunResult повний. Окрема preflight-відмова `SELECTION_CONFLICT` сталася через поєднання --files/--only; child не запускався, наступні команди використовують лише один тип відбору. Файл ранньої відмови автоматично не створено, тому збережено весь tool JSON як діагностику, а не як pass.

Самоперевірка читабельності: база 45ce4187, перевірювана ревізія — власний diff `production-runtime.ts`, тести й допоміжні профільні скрипти цього коміту. Переглянуто всю `routingSnapshot`: конфігурація → незалежні probes → ordered maps → quota views; результат і побічні ефекти явні, помилка одного probe залишається unavailable. У worker переглянуто весь компонент `transport.waitReady` і його локальні стани: спостереження → trust/navigation/status → native identity → ready; зміни статусу відбуваються перед `continue`, очікування лишається лише за непідтвердженого переходу. `statusSubmissionPending` має одного writer-а в циклі: встановлюється після першого Enter і скидається після poll; додаткового таймера або прихованого I/O не додано. Окремих механічних обгорток чи змін інтерфейсу немає. Тестові helpers явно задають native protocol, synthetic input/output, ізольований HOME та cleanup у наявному fixture. Профілювання ізольоване у evidence; не додає production tracing. Результати збереження поведінки — у підсумку прогонів нижче.

Узгодження й дослівне рішення main про приймання з 5 pre-existing падіннями: [coordination.json](coordination.json). Це чинне уточнення обсягу; п'ять перевірок залишені в стабільній групі, їхній загальний результат не названо pass. [test-registry-additions.json](test-registry-additions.json) — повна передача доповнень, уже внесених in-place; shared registry комітить main.

### Остаточний результат

| Прогін | runId | Результат |
| --- | --- | --- |
| Повна implement-група | `979a2c1c-b652-4ba8-a334-0f268621c4da` | 450 passed, 8 knownRed (включно з початковими власними fixtures) |
| База без власної правки, ті самі 8 ID | `c8cc7272-9665-45a2-9ea1-3c64bf5ac33f` | усі 8 red; підтверджені 5 pre-existing |
| Остаточний RED власних 3 | `b25628c9-3b09-4ceb-a057-f028647e684d` | усі 3 red, решта 5 збережені в агрегаті |
| Остаточний implement, ті самі 8 ID | `48d20c6d-2a51-4859-8d7b-71c043d8bc77` | **власні 3 GREEN**, рівно ті самі 5 knownRed |

Початковий повний прогін [implement-1.TestRunResult.json](implement-1.TestRunResult.json) містить budget diagnostics: повний CLI agent run **2383.844564 мс < 3000**, agent ps **407.002383 мс < 1000**, reminder list **352.052997 мс < 500**; окремий run при 29 pending notices — 2670.31 мс. Production-код після цих замірів не змінювався. Усі завершені прогони: timeout=false, cleanup.complete=true, remainingPids=[], unexecuted=[], unknown=[]. CLI code=1 і child exitCode=1 для red/відомих падінь; загальна група **assertions-failed**, groupState=idle, nextAction=fix-implementation (залишок 1.1.7). Це не загальний pass. Повний опис відборів/команд і станів — [test-summary.json](test-summary.json), companion cli metadata та незмінені TestRunResult.

Незмінні pre-existing ID (перевірено рівність множин baseline/candidate, [acceptance.json](acceptance.json)):

- `test/production-runtime.test.ts::[production-factory] assignment uses authoritative OpenSpec argv and the configured root`
- `test/production-runtime.test.ts::[production-factory] compose reuses runner, stage and completion templates with the exact report path`
- `test/production-runtime.test.ts::[production-factory] task context is derived from parameters, OpenSpec snapshot and conf instead of a trusted file`
- `test/production-codex-delivery-qa.test.ts::[production-codex-delivery-qa] repainting-paste: parent handshake follows native acceptance`
- `test/production-codex-delivery-qa.test.ts::[production-codex-delivery-qa] pending-forever: no false handshake or blind submission`

Прийняття саме 1.1.6 — за дослівним уточненням main у coordination.json і вже відкритим у Git пунктом 1.1.7 в tasks.md. Жоден із п'яти тестів не видалено, не пропущено й не змінено.

`npm run build` пройшов; [build.json](build.json). Root-документація доповнена секцією доказів, без галочок; її коміт відхилено read-only `.git/index.lock` (exit128). Точний [patch](tasks-handoff.patch) і [стан](tasks-handoff.json) доставлені main, receipt `64973346-ad95-4989-be3e-04005a374c4b`. Одна попередня доставка baseline-повідомлення мала MESSAGE_NOT_ACCEPTED (exit1, чужий input у composer); вона не видана за доставлену, повна причина/remediation у coordination.json.

Профільний маршрут перевірено повторно на актуальній копії conf: **4178.73 → 2599.93 мс**, однакові після settlement counts357/444/332; [reproduction-check.json](reproduction-check.json). База й candidate завантажувались з окремого instrumented module у /tmp, спільний production-файл для цього повтору не змінювався. Оновлення conf та зміна liveness копій пояснюють інші counts, порівняння всередині кожної пари однакове. Обидва приватні tmux server після профілю відсутні. `prepare-copy.py` виключає приховані конфіги; первинну відмову копіювання .mcp.json зафіксовано, для профілю він не потрібен. Для наступного повтору передавати нові labels, щоб не змішувати артефакти.
