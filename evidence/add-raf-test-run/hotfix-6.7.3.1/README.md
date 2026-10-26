# Регресія 6.7.3.1

Джерело дозволу: `add-raf-test-run:6.7.3.1`, кінцева декларація
`regressionGroups=["complete-raf-flow-contracts/z384","complete-raf-flow-contracts/z426"]`.
Чужі items не виконувалися; тести, production-код і tasks.md не змінювалися.

## Workspace і команда

Тестований HEAD: `21728b012d888206d5e6e297fa5cc97f83d5097e`, гілка `hotfix`.
Він містить `f67ea61e52f0cae33025c49e0d5d2167c107587f`.
Перед першим прогоном tracked/index diff порожній; untracked: `node_modules`.
Перед другим також присутні власні untracked докази в цій теці; production/test diff порожній.
QA HOME вибрав довірений канал; HOME, group і timeout-агрегат не змінювалися вручну.

Обидва виклики виконані окремими простими командами з cwd
`/srv/dev/work/orchestrator/raf-hotfix`:

```text
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/0a913be6-e5f6-46fb-8be9-ac332d97edc8/raf-main/bin/raf.ts test run --project raf --phase hotfix --group complete-raf-flow-contracts/z384
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/0a913be6-e5f6-46fb-8be9-ac332d97edc8/raf-main/bin/raf.ts test run --project raf --phase hotfix --group complete-raf-flow-contracts/z426
```

## Z.384: підготовка fixture не відповідає чинному Git layout

Run `60c4ed72-be9c-47c3-8e6f-e2763f2a57e6`: CLI 1, child 1,
`outcome=assertions-failed`, passed 0, knownRed 10, unexecuted/unknown 0,
cleanup complete, timedOut false, timeoutCount 0, groupState idle,
nextAction fix-implementation. Повний результат і stderr збережені окремо.
Попри класифікацію wrapper, це не підтверджений початковий red поведінки
activation.lock: усі тести падають у створенні fixture до відповідних перевірок.

`test/hotfix-reader-admission.test.ts:50` записує лише `branchPaths.main`,
а main є окремим `git init`, без Orchestrator submodule та develop worktree.
`mainRoute` викликає `resolveProductionStore`, де `sourceStore` використовує
`branchPaths.develop`; результат — `ERR_INVALID_ARG_TYPE`, paths[1] undefined,
`src/main-production-store.ts:41`. Цей шлях додано в
`e7d0d164222940d486cc06536a65bde7fe7726a9`, до виправлення 6.7.3.

Підстава не додавати обхід перевірки identity:
`openspec/changes/switch-raf-main-by-symlink/specs/projects/raf/workspace-routing/spec.md`,
вимога «Дозволений канал агента переживає перемикання main», сценарій
«Розділення source та production Git»:

> довірена реєстрація перевіряє точну пару D/P, роль, object format та snapshot OID замість рівності всіх common-dir; довільний clone з тією самою URL/гілкою/OID, env-підміна чи підмінений commondir не підтверджують identity або production-origin

Design тієї ж зміни, «Межі каталогів та identity», визначає D через
зареєстровані develop/постійний hotfix та збереження C під D.
Надання позитивного production-origin цій fixture без реєстрації означало б
послаблення чинного контракту. Водночас вибраний item прямо вимагає
«без зміни їхніх тестів». Потрібно узгодити міграцію fixture зі збереженням
усіх assertions; це передано main через дозволений agent message.

Це висновок аудиту сумісності доручення за autonomous-development
«Аудит та вилучення неактуальних змін», а не відкладення за рішенням власника.
Початковий red нової власної регресії та реалізація не заявляються.

## Z.426: успішна регресія

Run `c72df6ce-defa-4587-82bb-0fdf3a748fc2`: CLI 0, child 0,
`outcome=passed`, passed 6, knownRed/unexecuted/unknown 0,
cleanup complete, timedOut false, timeoutCount 0, groupState complete,
nextAction complete. Перевірені activation/writer claim-release race,
збереження foreign owner і початкового callback error.
Черга ресурсу очікувала дозволу; це не timeout тестів. JSON і stderr
повернулися повністю (original token count 2106).

## Походження доказів

CLI transport повернув повні неурізані результати (Z.384: original token count
4690). Інструмент поєднав один JSON-рядок stdout і один JSON-рядок stderr;
вони розділені по першому LF без зміни байтів JSON. CLI code взято з
`exec_command.exit_code`, child exitCode — лише з TestRunResult.
Метадані та SHA-256 файлів наведені в summary.json.

Інші пункти add-raf-test-run відкриті; sync/archive не виконуються.
Галочки доручення належать raf; failed не дає підстав їх ставити.
