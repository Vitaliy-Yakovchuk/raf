# Z.395.4: хостовий стенд

Виклик із чистого checkout переданого SHA, із `conf/` поруч та встановленою локальною залежністю TypeScript:

```sh
node scripts/qa-z395-group-residue-live.mjs <повний-SHA-checkout> /srv/dev/z395-host-evidence-<унікальна-назва>
```

Main авторизував цей маршрут повідомленням у поточній сесії Z.395.4: «напиши й закоміть у raf-develop host-скрипт … Я запущу на хості в чистому clone (conf поруч, без секретів сесії)». Це ручний стенд за `qa-stand.md`, не integration preset і не unit-файл. Скрипт не запускається з sandbox агента. Його загальний дедлайн читається з `conf/flow.json#/integrationTests/timeoutMs`; конфігурація числових політик не змінюється.

Скрипт створює власну теку `/srv/dev/z395-*`, копію конфігурації, чистий clone продукту, два примітивні unit-fixture A/B та невибраний sentinel. Публічний CLI працює через версійований `scripts/raf-stand.sh`, окремі HOME/RAF_QA_HOME і незмінний автоматично обраний unit HOME. Git identity передається selector-ом чинного глобального конфіга; credentials і session environment не копіюються.

У fixture `projects.json` змінюється лише маршрут raf; повний домен зареєстрованих проєктів лишається чинним для перевірки публічних прикладів каталогу. Перший host-запуск знайшов дефект драйвера: звуження цього домену до raf ламало приклад `test run --project etchly` під час build, до будь-якого сценарію. Первісні докази збережено у `evidence/z395-group-residue/qa/host-1/`. Це manual red для fixture, не unit assertion-red продукту.

До авторизації CLI має відмовити без створення unit SQLite/runner spawn. Далі fixture реєструє лише процес драйвера зі справжніми PID/start/command/machine/boot та явним тестовим assignment. Це не доводить запуск native model runner або sandbox tool IPC. Два нові fixture-агрегати ініціалізуються `timeoutCount=1`, без боргу; після цього до їхніх рядків пише лише продукт. Це перевіряє збереження ненульового лічильника, не породжує timeout і не очищує наявний ledger.

Фактичні CLI-кроки: foreign A red; target A red/B green; foreign exact A green (target незмінний); target subset B (child 0/CLI nonzero, A лишається); target exact A green. Групи різних fixture-змін допускають однаковий exact ID без обходу overlap guard. Під час останніх двох кроків foreign payload має лишатися дослівно незмінним. Кожен крок зберігає незмінені stdout/stderr, окремі CLI/child коди, команду, хеші потоків і snapshots SQLite. `runner-executions.json` доводить фактичний запуск лише B для subset і однаковий HOME всіх нащадків.

Код 0 драйвера потребує всіх assertions та повного cleanup. Cleanup перевіряє лише процеси з cwd у власному стенді, звіряє start identity перед сигналом, після збереження доказів прибирає лише власний fixture HOME/стенд. Невдалий або невідомий результат не повторюється автоматично. Main повертає весь каталог доказів, stdout/stderr та exit драйвера цьому ж QA; дефект драйвера чи develop виправляє цей самий QA за red → fix → green без повтору вже виконаних сценаріїв.
