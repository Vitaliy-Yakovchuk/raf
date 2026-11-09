# fix-raf-cli-live-latency:1.1.19

Усі чотири baseline-падіння — застарілі твердження про retention, а не дефекти живої поведінки raf. Production-файли не змінювалися. Видалено хибні твердження, залишено сценарії, які перевіряють потрібну живу поведінку; мертвого production-коду в цих шляхах немає. Не повертаємо вилучений часовий retention і не додаємо нових правил.

## Актуальність і класифікація

Доручення актуальне: власний RED на HEAD `e103ae7024f34f1431414db4c536d5dea53dc121` відтворив рівно чотири передані assertion failures. Переданий файл continuation-18 у цьому дереві відсутній, тому попередній результат не використано як власний доказ.

Контракт: `openspec/specs/projects/raf/state-store/spec.md`, вимоги «Поточний стан без історичного журналу» (повністю, включно зі сценарієм «Завершена сесія з незавершеною доставкою») і «Порційне очищення дозволеної історії»: потрібні незавершені ефекти зберігаються, завершені сесії прибираються без строку історії. Часовий retention уже видалений комітом `b9fb1dd595d05c501261e7b4fd8432149e089cb3`. Також застосовані `projects/orchestrator/agent-activity` («Недоставлене повідомлення про результат») і `projects/raf/session-recovery` («Звірка живих процесів зі SQLite»): доставка видима й повторюється; unknown не означає смерть.

1. `launcher-notice-durability`: застаріле очікування видалення finished-сесії з pending notice. Тепер явно перевіряємо захист джерела до доставки та його видалення після неї. Залишені перевірки ps state/recipient/pending і повного тексту повторної доставки через separateProcess.
2. `Z.453 ps stops the orphan worker and live tmux runner before releasing handoff claims`: застаріле очікування збереження finished-сесії після повного протоколу. Перевіряємо її відсутність після cleanup та повторного ps. Перевірки смерті реального worker, закриття tmux і звільнення task/admission reservations збережені.
3. `Z.453 a dead wrapper cannot release claims while its tmux runner is still alive`: застаріле очікування finished-запису. Перевіряємо його видалення; реальні tmux termination і відсутність claims лишаються обов'язковими.
4. `Z.453 unconfirmed tmux termination keeps claims after the worker exits`: застаріле очікування finished-запису після успішного повтору. До повтору незмінно перевіряються exception, reserved-сесія, claim і живий tmux; після повтору — видалення завершеної сесії і claims.

Імена тестів збережені для стабільних knownRed IDs. «session retention cleanup» в імені означає очищення збереженого стану, не повернення строку retention. Сценарії live starter та unknown scan не змінені.

## RED / GREEN

Точні команди, SHA, вибірки, CLI/child exit codes, stderr та межі — у `runs.json`. Повні незмінені результати: `red.TestRunResult.json`, `hotfix.TestRunResult.json`. Власний diff під час GREEN — `tested-workspace.patch`; під час RED власних правок не було. Обидва прогони використали той самий налаштований QA HOME і стабільну групу `fix-raf-cli-live-latency/live-latency` без скидання агрегату.

- RED run `962a7038-8043-4b6f-866a-79e00d37b355`: phase=red, callerPhase=hotfix (роль виконавця), CLI=1, child=1, assertions-failed, 6 passed, 4 knownRed, 7084 мс. Setup/import failures немає.
- GREEN run `c02ee302-54ff-4f5f-815a-3bd534d88131`: CLI=0, child=0, passed, 10 passed, 8042 мс; diagnostics/knownRed/unexecuted/unknown порожні; groupState=complete, nextAction=complete.
- Обидва: timedOut=false, cleanup.complete=true, remainingPids=[]; timeoutCount=1 успадкований, не скидався. Зелений результат стосується цих двох файлів та поточного агрегату, не нового повного прогону всіх файлів групи чи живих latency-бюджетів.
- Інструмент обрізав об'єднаний stdout/stderr первинного RED всередині stdout JSON. Повний RAF JSON скопійовано з вказаного ним файлу; усі видимі stderr-рядки збережені окремо. GREEN-вивід захоплено повністю, stderr виділено з об'єднаного потоку. Попередження про групи інших проєктів не змінювалися.

## Самоперевірка читабельності

База й перевірена ревізія — `e103ae7024f34f1431414db4c536d5dea53dc121` із власними правками з `tested-workspace.patch`. Область — чотири названі test callbacks у двох файлах; fixture helpers і production-функції не змінено. Послідовність явна: підготовка → ps/cleanup → твердження про процеси, claims і стан; у notice-тесті — відхилена доставка → захист pending → успішна доставка → cleanup. Вхідні fixtures, дії та результати видно без нових обгорток, прихованих присвоєнь чи вкладеності. Зміни прибирають суперечливі retention-очікування; GREEN підтверджує збереження перевірок живої поведінки. Додаткові quality-утиліти для production-коду не застосовуються: production не змінено.

Пункт 1.1 лишається відкритим; активація та архівація не належать цьому результату. Checkbox 1.1.19 змінює raf після приймання JSON-звіту.
