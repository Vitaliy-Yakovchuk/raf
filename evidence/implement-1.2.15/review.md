# 1.2.15 — private branch materialization

Доручений дефект виправлено лише в raf. Контракт пункту 1.2.15 узгоджений із proposal (ізольована перевірювана копія, незмінний скрипт продукту, без нових лімітів); суперечностей або застарілості не знайдено. Скрипт Etchly не змінено. Активація main та реальний baseline/coverage/overlays належать наступному 1.2.11.3, не є доведеними цими component tests.

## Реалізація та provenance

`src/test-run-quality-runtime.ts:53` бере гілку й шаблони каталогів/link/target з conf/projects.json під час snapshot. Маршрут входить у configDigest, тому baseline з іншим маршрутом не перевикористовується. Live Git metadata shared-libs виключено з dependency traversal; створюється мінімальний приватний `.git` з objects, refs/heads, HEAD та core config без історії, hooks або live gitdir.

`createPrivateCopy` створює owned container `.raf-quality-*` на тому самому data volume, у ньому сусідні `<product>-<branch>` і `shared-libs-<branch>`, та відносний symlink із конфігурації. Всі вхідні байти й далі проходять seal і copy digest verification; жодного live link немає. Ownership marker залишається на контейнері, cleanup за executionRoot знаходить саме цей контейнер, прибирає і продукт, і бібліотеку та допускає повторний виклик.

`src/test-run-quality-loader.ts:11` дозволяє лише додатковий явно записаний приватний dependencyRoot. Його імпорти перевіряються так само, як імпорти продукту; сторонній/live імпорт не стає дозволеним. Реальний target production source і його coverage mapping залишаються під executionRoot.

## Перевірки

Стабільна група: `adopt-ub-mode-quality-gates/quality-branch-materialization`, `test/quality-branch-materialization.test.ts`. Повні команди, CLI codes окремо від child exitCode, SHA256 файлів та послідовність — `runs.json`. Усі повні незмінені TestRunResult скопійовані з названих raf файлів, не з відновленого stdout. Комбіновані tool replies і виділений stderr збережено окремо; обрізання в цих test replies немає. Initial RED stderr відтворено з повністю видимого виводу; первинний tool envelope не збережено, це явно позначено в runs.json.

| Доказ | runId | Результат | CLI / child |
| --- | --- | --- | --- |
| red.TestRunResult.json | 75effc27-0f67-4533-aa8f-0c398857875c | 2 assertions failed | 1 / 1 |
| green-attempt.TestRunResult.json | fbcd25ab-5788-4b0c-b5d5-24c1c5283f6b | setup-failed: повторний cleanup | 1 / 1 |
| green.TestRunResult.json | 9a4c4073-ee35-4544-a388-ff2f6261ad5a | 2 passed | 0 / 0 |
| green-final.TestRunResult.json | 9440e63b-5f21-4aa0-9d5a-742d11a6fddd | 2 passed, додано negative import check | 0 / 0 |
| snapshot-paths.TestRunResult.json | 7eb07756-fa1f-4587-9f76-9443cd9d75c9 | 49 passed | 0 / 0 |
| storage.TestRunResult.json | f2b0412a-e85c-4c00-ab48-1f44b7d7d5e5 | 7 passed | 0 / 0 |

Фінальні GREEN: cleanup complete, timedOut false, timeoutCount 0, knownRed/unexecuted/unknown порожні, groupState/nextAction complete. Початковий RED — цільові assertions, не setup/import. Проміжний setup failure збережено чесно; виправлено ідемпотентність cleanup без послаблення тесту. Повтор фінальної адресної групи обґрунтований доданою перевіркою блокування сторонніх імпортів, а не отриманням stderr.

Фікстура перевіряє обидві гілки main/develop, Git root, symbolic HEAD, точний relative link target, відсутність live Git metadata в manifest, імпорт shared-libs і alias у node_modules після фізичного видалення live product/shared-libs, відмову стороннього імпорту з приватної бібліотеки та збереження копії до terminated cleanup. Наявні snapshot-paths і storage регресії підтверджують відмови escape/cycle, sealing, відсутність full-file dependency buffering та cleanup при помилці копіювання.

База всіх прогонів: 6ea805b4e8f4f313471cee666409598231f89e18 плюс власні незакомічені правки (digest у runs.json); чужі робочі правки перелічено там і не зачеплено. Незалежний початковий draft створено до читання наявних тестів, як вимагав implement brief. Потім draft збережено в /tmp, production повернуто до HEAD для власного RED і лише після RED відновлено виправлення. Початковий draft передував власному тесту; це явна відмінність від суворої послідовності test-first, не прихована за GREEN.

## Самоперевірка читабельності

Область: base 6ea805b4e8f4f313471cee666409598231f89e18 → власні src/test-run-quality-runtime.ts, src/test-run-quality-loader.ts та нова регресія; кінцева ревізія — коміт, що містить цей review. Інші функції/файли не є областю.

- `configuredSharedLibraries:53`: один результат із названими branch, productDirectory, libraryDirectory, target; усі значення простежуються до conf/workspace. Відсутній маршрут повертається рано.
- `writeBranchMetadata:69`: одна відповідальність — створити мінімальний Git root заданої гілки. Побічні ефекти обмежено переданим приватним root; live Git не читається.
- `snapshotWorkspace:77`, dependency walker: зміна лише виключає кореневий .git бібліотеки; наявні перевірки canonical/shared roots і cycles залишаються явними.
- `createQualityRuntime:139`, callbacks snapshot/createPrivateCopy/remove і settings: конфігурація захоплюється до виконання; map явно поєднує executionRoot з owned container. Видно порядок create layout → metadata → copy sealed inputs → execute → cleanup. При відмові копіювання catch прибирає контейнер.
- Loader `privatePath:11` і resolve hook: один явний список приватних коренів, умова відмови охоплює також dependency parent. Негативна регресія доводить, що дозвіл sibling не відкриває імпорти за його межі.

Зайвих користувацьких елементів, нових timeout/limits або змін product script немає. Предметні функції мають явні входи й ефекти; числових метрик читабельності не вигадано. Утиліти crapper/dryer/mutator не призначені окремо для цього hotfix; їх згадка в completion не є вимогою запуску.

## Передача

`registry-handoff.json` — одна повна адресна передача unitFiles/group; внесено in-place, коміт main. `tasks.patch` — точна секція перевірки без галочок. Root commit був відхилений read-only index.lock (CLI128); повідомлення доставлено, main підтвердив коміти tasks 4794856ae4 і registry 02d273abf9. Ці коміти не заявлено власними. `communication.json` містить receipts і підтвердження.

Власний код і докази комітяться trusted hotfix port; push/активації не виконуються. У зміні є інші відкриті пункти, sync/archive не виконано. Наступна дія main: активувати перевірений hotfix; потім продовжити 1.2.11.3 із новим baseline, бо config/dependency fingerprints закономірно змінені.
