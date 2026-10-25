# profile-raf-performance:5.6

Код: `a66ad12857a36dec17772b92d59b50d611bcd349`. Реалізовано окремий runtime inventory довіреної generation publication і повторну перевірку origin без обходу evidence/docs. Full activation snapshot/gates/recovery не змінено. Тести не редагувалися; початкову реалізацію збережено до першого читання scaffold тестів.

Фінальний цільовий run `d91783dd-3fb2-437c-8a22-f8604d737d60`: passed 90/90, CLI/child 0, timeout false, cleanup complete, knownRed/unexecuted/unknown порожні, group complete / nextAction complete. Повний незмінений результат — [final-TestRunResult.json](final-TestRunResult.json), CLI — [final-cli-code.txt](final-cli-code.txt), команда, SHA/незакомічений patch і всі результати — [summary.json](summary.json). Усі три implement прогони використали ту саму групу та QA HOME, без скидання агрегату.

Перший run: 88 passed, 2 knownRed (metadata excluded root та child path без `./`); виправлено після незалежної реалізації. Проміжний і фінальний run — 90 passed. Build, check:comments і smoke повної копії runtime із TypeScript — 0; stdout/stderr/CLI кожного збережені окремо. Smoke перевіряє inventory та негайну відмову після мутації; це перевірка публікатора, а не жива acceptance 5.7.

Окремий transport stderr unit-команди недоступний через цей CLI tool: він експонує лише combined output. Не стверджується, що stderr порожній. [transport-stderr.json](transport-stderr.json) описує обмеження, підтверджене main; повний combined tool result збережено. Сам TestRunResult не урізаний.

TypeScript 6.0.3 уже зафіксований devDependency; preparation включає dev dependencies, sealed generation справді має parser без транзитивних залежностей. [sealed-parser-dependency.json](sealed-parser-dependency.json) містить перевірку фактичного generation. Parser завантажується лише під час побудови inventory. З QA `raf-sym64b-qa` узгоджено перенесення повного production runtime у fixture та окремі нові докази лише всередині інструментованих QA-копій; чужі тести/скрипти не редагувалися.

Старий registry без runtimeInventory відмовляє; guard не добудовує довіру. Зміна source digest reviewed loader або TypeScript API consumer потребує нового аудиту доказу та нового повністю перевіреного snapshot. У map наведено точні target та межі API, а фактичний production host/worker перевіряється перед завантаженням.

5.7 generation/origin регресії та живий agent ps до/після не запускалися в implement 5.6; їх приймання лишається відкритим. Галочки tasks.md, push та архівацію не виконано: інші пункти зміни відкриті.
