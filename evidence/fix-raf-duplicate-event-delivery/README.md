# fix-raf-duplicate-event-delivery:1.1

Аудит: доручення актуальне на 9470bc02dab921f4058e79b0fe867c223c2f2438. Чинна вимога projects/raf/agent-message, сценарії «Спостережене прийняття без semantic ack» та «Прийняття чергою зайнятого агента», дозволяє підтверджувати прийняття чергою; попередня реалізація чекала очищення composer. Нове доручення уточнює попередню архівну задачу, а не вводить новий контракт.

Причина: після вставки Claude показує `Press up to edit queued messages`; повідомлення вже прийнято. Raf продовжував чекати, і наступний невпізнаний кадр повертав відмову. Result notice лишався pending і наступний settle повторював ту саму подію. Мінімальний фікс визнає чергу підтвердженням після переходу від baseline та повторної перевірки identity. До вставки черга як і раніше зайнята; нових таймаутів чи обмежень немає.

Регресія використовує незмінені записані кадри `../fix-raf-main-message-delivery/frame-0000.txt` (черга) і `frame-0455.txt` (порожнє поле), протокол `claude-protocol.json`. Опис походження кадрів: README.md тієї теки; архів попередньої зміни: openspec/changes/archive/2026-11-02-fix-raf-main-message-delivery/. SQLite тесту ізольована: справжні result_notices та delivery_claims, два settle через окремі handles. RED відтворив дві вставки однієї події. GREEN підтвердив одну вставку, delivered/attempts=1, звільнення claim і pruning notice після cleanup завершеної сесії. Робоча state.sqlite не читалася й не змінювалася напряму; наведені у proposal кількості рядків не перевірялися. Поточний state-store не містить closure_notices; код чи міграція цієї історичної таблиці не потрібні для цього дефекту.

Докази: повні незмінені *.TestRunResult.json, окремо stderr та CLI exit у *.cli.json; child exitCode міститься в TestRunResult. Вивід інструмента не обрізаний. workspace.sha/status та hotfix.patch фіксують базу й незакомічені шляхи; RED мав лише тестові зміни, GREEN — також однорядковий фікс. Перший RED передував додаванню SQLite-сценарію; другий RED перевірив повний фінальний тестовий файл до реалізації.

- RED 56494d7b-8840-446a-828a-d0afec12dd44: assertions-failed, CLI/child 1, 1 passed/2 knownRed, unexecuted/unknown порожні, cleanup complete, timedOut=false, timeoutCount=0, groupState=idle, nextAction=implement.
- RED із SQLite fd47cb38-0c41-4895-bffe-c1606c6bd27a: assertions-failed, CLI/child 1, 1 passed/3 knownRed (включно з 2 != 1 вставками події), unexecuted/unknown порожні, cleanup complete, timedOut=false, timeoutCount=0, groupState=idle, nextAction=implement.
- GREEN b6673b5c-9ed7-4b0b-bc48-550d7590d558: passed, CLI/child 0, 4 passed, knownRed/unexecuted/unknown порожні, cleanup complete, timedOut=false, timeoutCount=0, groupState=complete, nextAction=complete.

Стабільна група `fix-raf-duplicate-event-delivery/accepted-queue`, один і той самий перевірений QA HOME в усіх результатах; початкове очікування ресурсів не є timeout. Команди збережено у *.cli.json. Попередження stderr про inventory, dash і доставку сервісних повідомлень не змінюють завершений результат тестів. Конфігурація test-runs.json не змінювалася цим виконавцем: явний --files є дозволеним ad-hoc відбором.

Перемикання main виконує main. Пункт 1.2 залишається відкритим; архівація не виконується. Галочку 1.1 ставить raf після звіту.
