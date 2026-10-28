# macOS unit HOME, 2026-10-28

Корінь HOME будувався з буквального `/tmp`; на Darwin `/tmp` — системний symlink на `/private/tmp`. Фактичний каталог uid501, directory, mode0700 відмовляв лише через `realpathSync(owner) !== owner`; diagnosis.json зберігає перевірку на цій машині. Це не проблема /var/folders: поточний production-код використовує /tmp.

Регресія спочатку виконана на незміненому runtime: 1 assertion failure з точним CALLER_UNAUTHORIZED «Unit HOME root is not private or has aliases», 4 контролі pass. Помилка TypeScript setup першого запуску збережена окремо й RED не вважається. npm ci з незміненого lock-файла exit0.

Фікс: канонізувати лише системного батька `/tmp` перед побудовою owner. Наявні realpath(owner), lstat directory/uid/mode0700 перевірки не змінені. Symlink самого owner далі відмовляє; HOME/state/tmp будуються під канонічним приватним owner. На Linux, де /tmp канонічний, шлях та hash HOME не змінюються. Робочу базу/QA бюджети не переносили й не скидали.

Незмінна регресія GREEN 5/5; npm run build exit0. Тест викликає справжній runConfiguredTestRun до межі prepareUnitTestState; підмінені лише контрольна авторизація/сховище та зупинка перед SQLite. Реальна productionStateContext перевірка збережена. Контролі isolated canonical/public/symlink/file не змінюють робочий owner. Власний hash HOME після тесту видаляється.

Суміжний широкий прогін: 220 pass, 41 fail, 1 skip. Той самий прогін на початковому runtime має ті самі 41 назви падінь у тому самому порядку (baseline-comparison.json). Частина fixtures очікує sibling raf-main/src, Linux /etc/machine-id або openspec/changes у стенді; ці прогони не оголошено GREEN. Додатковий focused прогін:94 pass/4 fail (3 старі duplicate --files expectations та unit-state-upgrade fixture, що не створює openspec/changes). Непов’язані дефекти не виправлялись.

Усі команди з повним stdout/stderr/CLI exitCode у сусідніх файлах. Прямий бриф дозволяє роботу без raf_command та JSON raf-звіту; прямі node:test RED/GREEN не видаються за TestRunResult. Справжній etchly CLI smoke і застосування фіксуються окремо в /Users/val/.raf/mac-start/20261028/artifacts/raf-mac-home/.
