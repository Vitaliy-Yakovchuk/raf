# fix-raf-launch-ownership-before-brief:1.1

Аудит 2026-10-27: задача актуальна, `deliverInitialBrief` відмовляє після одного непідтвердженого ownership. Чинні launch safety checks збережено. Нових вимог, таймаутів, лімітів чи HOME не додано.

## Причина та межі встановленого

`runLaunchWrapper` спочатку отримує owned, тому до `deliverInitialBrief` локальна `actual` вже встановлена. Гілки discovery (nativeId/pane PID/ambiguous candidates) не є причиною саме цієї помилки перед gate. Повторний `ownership()` перевіряє `observeKnownProcesses([actual])`, потім `belongsToPane(actual)`.

Можливі не-owned: unknown/exited зі спостереження відомого PID, або mismatch після непідтвердженої належності pane. У `observeKnownProcesses` живий `/proc/<pid>/stat` до/після ps та відсутній рядок ps дають unknown з `PID present in targeted stat but absent from process observation`. Також unknown можливий за помилки/нечитабельного або malformed спостереження. Старий код усі стани перетворював на негайний PROCESS_IDENTITY_UNAVAILABLE без state/reason. Саме перехід unknown → негайна відмова є відтвореним дефектом; тест інжектує точний існуючий unknown reason.

Збережені e0b2f623 і f5e9ff53 last-screen показують agy 1.4.7, порожній composer і `? for shortcuts`. Вони не містять OS process observation й не доводять його підвид. Для 7c1e74ca screen/worker log відсутні. Main повідомив через agent message: «Третього екрана (7c1e74ca) і ownership.reason немає — більше даних нема. Роби за кодом ownership() і регресією; додай причину не-owned стану в текст помилки». Тому точний історичний OS-підвид не заявляється встановленим; тепер кінцева помилка містить state/reason.

## Рішення

Перед gate повторюємо лише unknown, перевіряючи поточний pane через adapter.inspect і використовуючи чинний pollMs. До gate потрібен новий owned; exited/mismatch зупиняють запуск. Помилка процесу під час повторного спостереження також лишається PROCESS_IDENTITY_UNAVAILABLE. Жодний бриф не подається до gate. Під час подальшої доставки наявні identity checks не змінено.

## Перевірка

Стабільна група `fix-raf-launch-ownership-before-brief/unit`, project raf, той самий ізольований QA HOME в усіх прогонах. Повні TestRunResult, stderr, CLI code окремо від child exitCode та metadata з командою, SHA/незакоміченими змінами і відбором — у відповідних файлах.

- red-initial f3294dba-03a9-417f-8777-b87921449d78: 2 assertion failures, 1 passed; setup чистий. Після цього виправлено похибку fixture: delivery загортає cutoff Error, тому перевірка має читати message та gate evidence, а не рівність обʼєкта Error. Це не послаблює потрібної поведінки. Первинний повний TestRunResult збережено з незміненого lastResult у QA aggregate до наступного запуску.
- red fb2ff50e-ba2b-452b-874b-7dbc973346f0: 2 цільові assertion failures, 1 passed; nextAction implement, groupState idle.
- hotfix b0c766a2-6080-445c-9583-eda1970eb834: 3 passed; knownRed/unexecuted/unknown порожні, timedOut false, cleanup complete, groupState complete, nextAction complete, timeoutCount 0.

Регресії: unknown → alive доходить до gate з перевіреним PID/pane/socket; exited одразу відхиляється; unknown → exited відхиляється після повторного спостереження. Реальний runner/провайдер не запускається — unit doubles, приватна fixture у тестовому tmp.
