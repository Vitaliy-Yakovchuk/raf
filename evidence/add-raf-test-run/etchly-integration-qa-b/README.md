# QA 6.2.6.3 — raf-trt6263b-qa

Source item: `add-raf-test-run:6.2.6.3`; immutable assignment `project=raf`, phase `qa`, workspace `/srv/dev/work/orchestrator/raf-develop`. Це незалежний QA; автором scaffold/implement цього пункту не був.

## Unit

```text
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/de319c1f-fc5b-432e-884a-a25ac062c5bf/raf-main/bin/raf.ts test run --project raf --phase qa --group add-raf-test-run/etchly-integration --files test/test-run-etchly-integration.test.ts
```

Перший виклик, `d4e3c4d7-4fff-4a54-9087-eedf34dc9162`, спостерігався з CLI 0, child exitCode 0, outcome passed та complete cleanup. Власний `max_output_tokens=1600` урізав tool output (початковий обсяг 4756 tokens). Повного незміненого JSON немає; цей виклик **не прийнятий як доказ pass**. Main підтвердив, що raf не зберігає stdout/stderr окремо, і доручив один повтор. Це помилка capture QA, не відмова каналу.

Дозволений один повтор із лімітом 20000 tokens: `e42191ba-2510-4034-8714-1f34188b9c39`, CLI **1**, child exitCode **null**, `setup-failed`, `STATE_CONTEXT_REFUSED`, до spawn. Повний незмінений JSON — [unit-qa.result.json](unit-qa.result.json), повний tool output — [unit-qa.stdout](unit-qa.stdout), command/CLI code/tool metadata — [unit-qa.tool-capture.json](unit-qa.tool-capture.json), окремий CLI code — [unit-qa.cli-code.txt](unit-qa.cli-code.txt). Tool надає об'єднаний output: порожній [unit-qa.stderr](unit-qa.stderr) означає відсутність окремо доступного stderr, **не** незалежне OS-підтвердження порожнього stderr. JSON parse успішний; output не урізаний.

Повтор не виконав відбір: result.selection порожній, command null; timedOut=false; cleanup.complete=true, remainingPids=[]; knownRed/unexecuted/unknown порожні лише в setup-result; groupSnapshot unavailable; groupState/timeoutCount/stateAccess null; nextAction fix-setup. Це не red і не green. Лічильник/HOME не скидався; нових unit-повторів після цієї відмови не було. Останні SHA/dirty/generation/config/source hashes — [context.json](context.json); це окремий read-only snapshot після викликів, не гарантія незмінного HEAD протягом них.

Групи тієї самої зміни `add-raf-test-run/etchly-profiles` та `add-raf-test-run/integration-profiles` не виконані після втрати робочого контексту каналу. Чужі regressionGroups не декларовані й не запускалися; grants не змінювалися.

## Живі сценарії

D01–D07 вивчено за контрактом, fixture та production implementation; неповний unit-capture і setup-result не доводять виконання цих сценаріїв. D08 виконується через main-executed керований хостовий API-стенд із власними fixtures цього QA; повна поточна хронологія нижче. D09 власним довіреним caller не виконано. Результати host не є підтвердженням broker authorization чи власного etchly CLI-каналу. Безпосередньо в sandbox integration-процеси не запускалися.

За прямим дорученням main підготовлено [точні хостові команди та очікувані виходи](HOST.md), чисті клони/власний HOME і керований real-workerd API-стенд. Повні отримані хостові captures збережені окремо за кожною спробою; початкові failures не перезаписуються. API-стенд не є D09 власного caller: поточне immutable доручення `project=raf` не надає права `project=etchly`.

Main підтвердив, що suite на `df2ff8047166a45046b50fcc231ac6e9e82ae20c` стоїть у хостовій flock-черзі після двох інших прогонів. Повідомив про ймовірний зв'язок unit `STATE_CONTEXT_REFUSED` із Z.420/міграцією QA state, яке виправляє `raf-z420-hotfix`, і прямо доручив не запускати unit до підтвердження виправлення. Це точна поточна передумова, не встановлений цим QA діагноз і не закриття пункту. Подальших unit-викликів не було.

## Власний дефект build і виправлення

Main виявив, що чотири коментарі мого нового `scripts/qa-etchly-integration-prepare.mjs` порушують comment-free policy raf. Я сам відтворив адресне падіння `node scripts/build.ts`: [red capture](build-red.capture.json), [незмінений stderr](build-red.stderr), CLI 1 із чотирма точними діагностиками цього файла. Одразу прибрав лише ці коментарі, не змінюючи перевірку або поведінку стенда, і повторив саме build: [green capture](build-green.capture.json), [stdout](build-green.stdout), [stderr](build-green.stderr), CLI 0. Первісне падіння збережене.

Межа автоматичного доказу: це реальний build acceptance check із чинним `checkRepositoryComments` та CatalogGenerator, з окремо захопленими OS stdout/stderr й CLI code. Це не unit `TestRunResult`, не integration-прогін і не доказ D08/D09; unit-команди під час прямого hold main не запускалися. Наявний автоматичний comment-free check збережено без послаблення. Знайдений дефект не передавався іншому виконавцю, нових QA-пунктів або повторного користувацького проходу не створено.

## Канал координації

Адресу `main` перевірено через `agent ps`. Повідомлення про початок QA прийнято receipt `62ff1e46-5f13-4e46-8aa3-4ba653c1719c`; про урізаний capture — `1c0a0314-d163-493f-86ae-c683045bf6c4`. Після повторного unit setup-failure повідомлення main отримало CLI 1, `STATE_CONTEXT_REFUSED: Unregistered module origin` для переданого покоління `de319c1f-fc5b-432e-884a-a25ac062c5bf`. Receipt доставки немає. Це окрема від початкового обрізання відмова; обхід каналу не застосовувався.

## Результати перших хостових спроб

Main зберіг спробу `df2ff804` у `/srv/dev/trt6263h-initial`: quota exceeded до integration. Незмінені наявні файли та hashes — [host-initial/manifest.json](host-initial/manifest.json). Порожні prepare/suite rc збережені порожніми; зовнішній log.exit повідомляє rc=1. Це не pass і не unit-red.

Повтор на `5b21d80` у `/srv/dev/raf-etchly-6263b-host2` завершився suite CLI 1: обидва prepare CLI 0, обидва driver CLI 1. Повні незмінені stdout/stderr, TestRunResult у captures, spawn, marker і summary — [host2/manifest.json](host2/manifest.json). Smoke preset run `92734f3e-0c10-46b2-8588-8271cf661e5c` та D08 green run `a211c63c-f83c-47fc-9087-a19f67b18164` мають child 1, setup-failed, timeoutCount=0, cleanup.complete=true, remainingPids=[]; nextAction=complete-integration. Драйвери відновили конфігурацію, etchly clean і не виявили живих власних процесів після cleanup. Реального workerd/D1 setup немає; решту сценаріїв не виконано.

Причина — моя prepare fixture не копіювала потрібний etchly corpus `learning/concept-base`. Одразу додано snapshot лише цієї теки з її готовим build, learning SHA та scoped dirty context, hashes усіх файлів/посилань у corpus index. Решта learning не копіюється. Smoke/D08 критерії та etchly runner/setup не змінено. Синтаксис і build після цієї правки успішні: [build-corpus-fix.capture.json](build-corpus-fix.capture.json); це лише автоматична build-перевірка, не green live integration і не початковий unit-red. Жоден unit під час hold не запускався. Потрібне продовження невиконаних живих сценаріїв на виправленій власній fixture, без повторення вже успішних QA-сценаріїв.

Main окремо доручив не редагувати tasks.md; посилання на докази додасть сам зі звіту. Галочки не змінювалися.

## Host3: корпус доступний, два assertion failures

Повні незмінені captures, source/dependency/config hashes та corpus file-hash index — [host3/manifest.json](host3/manifest.json). Окремі full result/stdout, stderr, CLI code й child exitCode проіндексовано у [host3-result-index.json](host3-result-index.json). Prepare обох режимів CLI 0; driver/suite CLI 1. Це не повний green.

Smoke preset `39a3abbc-939b-4f29-84fa-c5591bf86e67` виконав чотири успішні тести двох файлів і перший analysis test із assertion failure: analysisCalls 1 замість 2, review queued:3. Два наступні analysis тести unexecuted, unknown=[]; cleanup complete, remainingPids=[], timeoutCount=0. Exact-files і негативні сценарії не досягнуті. Etchly SHA b8a769c; цей test файл не змінений до поточного source HEAD. Це фактична retry-поведінка etchly, причина ще не доведена. Etchly source не входить до моїх write boundaries; задачі bound-generation-retries-and-spend не виконую й критерії не послаблюю.

D08 first green `3cfb73e2-49cc-4e27-9aea-4afe43eb1aeb` теж assertions-failed, але з іншої причини: моя Miniflare fixture застосувала старі single-worker options до встановленого Miniflare 5.20261019.1-beta. Одразу виправлено через `convertV4MiniflareOptions` і workers array, як у чинному etchly shared-worker-runtime; SQL assertion і критерії cleanup/timeout збережено. Додано вузький suite mode `d08` для продовження лише цього невиконаного набору, без повтору чотирьох успішних smoke тестів. Синтаксис і build green; live green для цього виправлення підтверджено в host4 нижче. Первісний failed збережено. Unit-hold не обходився; build не є unit-red або integration green.

## Host4: D1 green та виправлення ready observer

На raf `744c65299e1ee109ea53f4c4eaac69b1b63150c4` D08 prepare CLI 0, driver/suite CLI 1. Незмінені 40 отриманих host-файлів і hashes — [host4/manifest.json](host4/manifest.json), окремі CLI/child codes і повні stdout-result — [host4-result-index.json](host4-result-index.json). Green реально пройшов із Miniflare/workerd/D1; навмисні assertion/import/skip дали очікувані incomplete результати з complete cleanup. Це підтверджує виправлення Miniflare fixture, але не повний D08.

Знайдено наступний власний дефект ready observer: observer не одержав SQL-ready. Початковий діагноз про зайвий `tmp` відкликано: production runtime передає child TMPDIR як `reservedRoot/tmp`, а result command.environment зберігає reservedRoot; причина відсутності файла за попереднім шляхом не доведена. Після початкового hang timeout1 observer не побачив SQL-ready для interrupt, тому SIGINT не надсилався; виклик також timed-out із timeoutCount2. Початкові `summary.status=failed`, stack та обидва повні timeout результати збережені. Crash/concurrent/recovery не досягнуті. Після аварійного прибирання liveOwned=[], конфігурація/flow відновлені, etchly clean; повний runtime cleanup додатково перевіряється continuation.

Спочатку запропоновано зміну шляху, але статичний аудит виявив недостатність цього діагнозу; queued dd69fee попросив main зупинити до старту (receipt `241e5005-d432-40cc-b115-d673e36368e6`). Натомість fixture атомарно публікує SQL-ready у явний per-launch proof path у власному output; observer перевіряє SQL=1, mode=hang, живий власний fork, живий workerd і canonical фактичний TMPDIR усередині reservation. Критерії SQL-ready/process/deadline не послаблено; додано вузький `d08-remainder` і [resume script](../../../scripts/qa-etchly-integration-resume.sh) для того самого host4/d08. HOME/SQLite/group зберігаються з timeoutCount2, пройдені green/assertion/setup/skip пропускаються. Повтор deadline із SQL-ready — адресна регресія observer, за нею перше фактичне виконання interrupt/concurrent/crash/recovery. Синтаксис та `node scripts/build.ts` CLI 0 ([stdout](build-readiness-fix.stdout), [stderr](build-readiness-fix.stderr), [CLI code](build-readiness-fix.cli-code.txt)); це build-перевірка, не unit-red/green чи live regression green. Continuation commit `dd69fee002c2c3367e7e2908fe3f83ab564720ab`, доставка main receipt `05b6b198-1f40-4474-abbe-14f7e3da09bc`; цей варіант superseded до підтвердження live green. Новий proof-path continuation має окремі `results-readiness-regression` і `readiness-regression-capture`, HOME/group лишаються тими самими; початковий timeoutCount читається з агрегату, без припущення або скидання. Unit-hold збережено.

Main підтвердив, що dd69fee не стартував і зупинений до старту; timeoutCount лишається2. Новий explicit-proof fix: власні syntax/comment acceptance checks CLI0 ([checks](explicit-proof-checks.json)); повний build CLI1 через чужі коментарі scripts/qa-main-symlink-live.mjs:128/129 ([незмінений stderr](build-explicit-proof-fix.stderr)). Чужий файл не змінювався; це не pass і не unit-red.
