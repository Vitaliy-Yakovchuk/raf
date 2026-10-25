# Z.420: isolated unit QA state upgrade

Предмет: complete-raf-flow-contracts:Z.420; аудит proposal/tasks і state-store contract не виявив суперечностей. Перевірено лише доручений пункт. Інші відкриті задачі не виконувалися; архівація не застосовується.

## Зміна й межі

До виправлення unitContext відмовляв для справжньої SQLite schema 16 через STATE_MIGRATION_REQUIRED. Після виправлення власний helper готує лише детермінований приватний QA HOME /tmp/raf-unit-<uid>/<hash>, перевіряє контекст, власника, канонічні шляхи й відсутність hardlink у state/WAL/SHM. Для попередньої підтриманої версії використано штатний migrateState: окрема резервна копія, перевірка клієнтів до/після backup та integrity. Звичайний openStateStore не змінено; майбутня/невідома схема не мігрується автоматично. Робочої бази та перевірок походження виправлення не послаблює.

Регресія запускає runConfiguredTestRun з реальною schema 16, створеною історичним клієнтом 944ae2a615151e2b48b481b6a2306e3c9e26b6ab. Замінені лише зовнішні control/resource/queue порти та child test CLI; unitContext, state guards, штатна міграція й SQLite виконуються реально. Перевірені schema 18, backup schema 16, integrity, незмінний payload/timeoutCount=1 та байтова незмінність контрольної бази. Спочатку звичайний openStateStore(schema16) мусить відмовити. Внутрішній unit-port-result є тестовим double, не зовнішнім TestRunResult.

## Прогони

Стабільний project raf, group complete-raf-flow-contracts/z420, files [test/test-run-unit-state-upgrade.test.ts], без --only.
Команди з повним префіксом записані у manifest; використовувалися дозволені прості raf test run.
HOME усіх зовнішніх прогонів:
 /tmp/raf-unit-1000/1ee10007bf6d5e71b39d6a2873064a767eeb928e7910599b166a0d60270ff685
HOME та агрегат не змінювалися й не скидалися.

| Доказ | phase / runId | CLI / child | Результат |
| --- | --- | --- | --- |
| 00-refused | red / 4ef69160-2d34-4861-af2b-cc22fa477959 | 1 / null | Group is not configured; не red, нічого не запущено |
| 01-import-failure | red / e1d2d0d0-c119-40e7-892f-d7e5f887d6a7 | 1 / 1 | ERR_MODULE_NOT_FOUND typescript; не red, навіть попри wrapper assertions-failed |
| 02-red | red / 74bbcfde-3eb8-4bd7-8a4e-678eb0b44d84 | 1 / 1 | Справжній assert: expected exit0, actual1; schema16 explicit18 migration required |
| 03-hotfix | hotfix / 6a9106eb-de58-4eda-960d-141cfe7de8d8 | 0 / 0 | passed, 1 тест |

Для 02-red: knownRed=1, unexecuted=[], unknown=[], cleanup.complete=true, timedOut=false, timeoutCount=0, groupState=idle, nextAction=implement.
Для 03-hotfix: knownRed=[], unexecuted=[], unknown=[], cleanup.complete=true, timedOut=false, timeoutCount=0, groupState=complete, nextAction=complete.
Внутрішній fixture timeoutCount=1 навмисно відрізняється від зовнішнього агрегату timeoutCount=0 і збережений міграцією.
Обидва run були на HEAD 14bd866dd8e1ff6be3c22dd2f773d090c9cb1332 із незакоміченими змінами, вказаними у manifest/workspace. Regression committed first: dfc51119b3aa0dad4fc8c2ba7830129e513a1bef. До справжнього red виправлено лише fixture import (symlink node_modules); після red додано helper і виклик runtime. Фінальні власні commit OID наведені у JSON-звіті.

Кожний stdout.json містить повний незмінений TestRunResult. stderr та код CLI збережено окремо; child exitCode міститься у результаті та manifest. Для 01–03 збережено також сирий exec transport; API повертав комбінований output, який розділено після першого повного JSON рядка stdout. Це не native окремі потоки API. Немає урізаних TestRunResult. ResourceUsage у green має partial/unknown completeness; це обмеження вимірювання ресурсів збережено без зміни й не подається як повний ресурсний вимір.

## Додаткова перевірка й передача

HOME=/tmp/raf-z420-build-qa RAF_QA_HOME=/tmp/raf-z420-build-qa node scripts/build.ts — exit 0; каталог і політика коментарів перевірені.
git diff --check для власних змінених tracked файлів — exit 0.
Робочу raf не активовано; випуск виконує main. Галочки tasks.md залишені raf.
