# QA complete-raf-flow-contracts:5.4

Підсумок: **failed, пункт 5.4 відкритий**. На дозволеному main ізольованому стенді перевірені I1–I5 та частини I6/I7. Native interrupt і позитивна викладка з підтвердженою версією не виконані. Це неповне приймання, а не рішення відмовитися від реалізації. Підстави — матриця I1–I7 у `event-registry-design.md` та фактично відсутні передумови. [Структурований огляд](review.json) містить точні обмеження й повідомлення main.

| Сценарій | Результат і доказ |
| --- | --- |
| I1 | [live-1](live-1/integration.json): production `control.ps` відхиляє справжній файл некоректного звіту. Add/update, activate/close, точна адреса, інша адреса й invalid binding перевірені через CLI parser/handlers і SQL. |
| I2 | [live-1](live-1/integration.json): pending у реальній SQLite переживає процес; справжній SQL abort відкочує зміни; інший OS process тримає writer lock; обмежена помилка, release і наступна команда завершують перехід. |
| I3 | [live-2](live-2/integration.json): справжній `openspec archive`, list/show і production settle; старий/частковий архів, невдала команда, видалення без архіву та схожий чужий ID не завершують reminder. |
| I4 | [live-3](live-3/integration.json): дві одночасні команди, reopen без зміни closedAt, новий цикл того самого ID, старий архів установлено до baseline. Старі позитивні результати live-2 не замінюють цей уточнений доказ. |
| I5 | [live-1](live-1/integration.json): недоступний tmux лишає активний reminder без квитанції; відновлений реальний адресат приймає доставку; SQL receipt і [stdin marker](live-1/tmux-received.json), повтор у новому процесі без дубля. |
| I6 | Частково: [live-1](live-1/integration.json) приймає failed report при живому процесі без закриття closed-binding; фактичний exit і production finalization створюють agent.closed. I1 — адресний report-rejection smoke. Native interrupt не виконаний: контрольований stdin receiver не є справжнім native runner. Відмову доставки саме повідомлення report-rejected окремо не перевірено; I5 перевіряє загальну event-доставку. |
| I7 | Частково: [live-1](live-1/integration.json), fixture-виробник із exit 0 без доказу версії не створює deployment.completed. Реальна викладка та позитивне підтвердження версії для конкретного deployment ID не виконані: затвердженого виробника/стенда немає. Нова команда викладки не вигадувалась. |

Стенд використовує окремі HOME, SQLite, OpenSpec fixture і tmux sockets під власним `/tmp/cfc54-*`. Робочий HOME/БД не відкривається. Кожна дія виконується окремим процесом. SQL до/після, stdout/stderr окремо, точні argv, cwd, exit/signal/помилки й тривалість містяться у JSON кожної команди. Конкурентні процеси та lock мають окремі файли. Node v26.12.1, SQLite 3.54.0, tmux 3.6, OpenSpec 1.14.3; hashes конфігурації та ідентичності власних процесів збережені в integration.json. У всіх трьох прогонах cleanup власних tmux повернув 0, remainingPids порожні, fixture видалена.

Стенд збирає `git archive` committed HEAD, не чужі незакомічені файли. Виконує production CLI parser зі зібраним `dist/catalog.json` і production source-module handlers у Node через явний test runtime context. Формулювання «compiled CLI parser» у незмінених сирих integration.json означає саме цей механізм: `scripts/build.ts` генерує каталог, а не компілює JS binary. Публічний `bin/raf.ts` і provenance запуску не перевірені; tmux адресати — контрольовані живі stdin receivers. Моки SQLite/OpenSpec/процесів/доставки не застосовувались. Ці межі не дозволяють оголосити всю матрицю пройденою.

Команди та SHA:

```text
node scripts/qa-event-registry.mjs evidence/cfc54-event-registry/live-1
5d07412ed841b6023fcc63f34b99899667875bae
CLI 1: I3/I4 setup failure (у fixture .openspec.yaml не було обов'язкового schema)

node scripts/qa-event-registry.mjs evidence/cfc54-event-registry/live-2 I3,I4
0c9a1a8f3935333a9f93f19ef27ace56eaf7e092
CLI 0, status partial: I3/I4 assertions passed після виправлення fixture

node scripts/qa-event-registry.mjs evidence/cfc54-event-registry/live-3 I4
481e2a301d74c7f59a9ea1a82d220b3f30563a61
CLI 0, status partial: I4 passed після уточнення порядку baseline
```

Setup failure не зарахований як product red. Виправлені лише власні фікстури й неоднозначність доказу, повторені лише відповідні сценарії. У виконаних assertions продуктового дефекту не встановлено. Загальний `partial` і CLI 0 останніх запусків не є pass пункту 5.4. Wrapper/preset і phase integration не запускались за чинною адресною вказівкою main про недоступний канал.

Окремий unit-прогін: [точна команда](unit.command.txt), [повний незмінений TestRunResult](unit.TestRunResult.json), [tool transport](unit.transport.json), [CLI exit 0](unit.cli-exit-code.txt). RunId `a5873b43-4988-47c8-bc36-debeb74cda13`; група `complete-raf-flow-contracts/raf-event-registry`, фаза qa, файл `test/event-registry.test.ts`. Runner повідомив passed, 28 tests, child exitCode 0, 659 ms, timedOut false, cleanup complete, remainingPids [], knownRed/unexecuted/unknown [], groupSnapshot loaded, groupState complete, timeoutCount 0, nextAction complete. HOME агрегату не змінювався. Це unit-результат, не живе приймання.

**Обмеження доказу unit:** exec tool повернув об'єднаний потік. [Окремий stderr недоступний](unit.stderr-availability.json); порожній stderr не вигадується. Перед запуском спостерігався HEAD `f8584eabf8a76e5d8b636124aff6b812f2817044`, але атомарного SHA/dirty snapshot саме unit-запуску runner не надав. Через спільне дерево точна unit-версія непідтверджена. Незмінений результат збережений, повним доказом pass його не оголошено. Live-запуски мають точні committed SHA і snapshot стану shared workspace, який не включався до збірки.

Checkbox 5.4 не змінено; інші пункти відкриті. Нові tasks не додавались, sync/archive/push не виконувались. Наступні передумови — native interrupt і реальний виробник/стенд підтвердження викладки; доступність integration runner веде main.
