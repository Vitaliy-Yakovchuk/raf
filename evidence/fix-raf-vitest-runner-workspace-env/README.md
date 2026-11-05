# fix-raf-vitest-runner-workspace-env:1.1

Аудит: proposal/tasks та чинні core/process/test-first, unit-test-runs і projects/raf/test-runs узгоджені з дефектом. У runner є залежність від process.env, якої немає в Workers isolate. Нових обмежень або таймаутів немає.

Підготовка тимчасового runner фіксує два адресні значення з довіреного Node-моста як JSON-літерали. Інші env не копіюються. Регресія імпортує справжню підготовлену копію після видалення env і перевіряє стандартний та custom base, включно з лапками у workspace path. Тимчасові файли прибираються чинним finally.

## Прогони

Префікс усіх команд: `node /srv/dev/work/orchestrator/raf-main/bin/raf.ts`.

| Доказ | Аргументи | runId | Результат / CLI / child |
| --- | --- | --- | --- |
| ramus-cloud-before.test-run-result.json | `test run --project ramus-cloud --phase hotfix --group retire-conductor-everywhere/ramus-cloud-2.x` | 0b913ee2-103c-4955-90f0-d84798d57953 | setup-failed / 1 / 1 |
| red.test-run-result.json | `test run --project raf --phase red --group fix-raf-vitest-runner-workspace-env/workspace-env --files test/test-run-vitest-workspace-env.test.ts` | a3d27df2-33fe-46c2-beda-c9891d650763 | assertions-failed / 1 / 1 |
| hotfix.test-run-result.json | `test run --project raf --phase hotfix --group fix-raf-vitest-runner-workspace-env/workspace-env --files test/test-run-vitest-workspace-env.test.ts` | d10ee50c-aab4-4e9c-a368-bd91eab9613e | passed / 0 / 0 |

JSON скопійовані без змін із TestRunResult-файлів raf. Stderr та CLI exit code збережені окремо; red/hotfix також мають повні tool results. Вивід цих трьох прогонів не обрізаний. CLI code не підмінено child exitCode.

У всіх трьох timedOut=false, cleanup.complete=true, remainingPids=[]. Початковий ramus-cloud setup не є RED: knownRed/unexecuted/unknown=[], groupState=idle, nextAction=fix-setup. RED має рівно два відомі assertion failures, unexecuted/unknown=[], timeoutCount=0, groupState=idle, nextAction=implement. GREEN має passed=2, knownRed/unexecuted/unknown=[], timeoutCount=0, groupState=complete, nextAction=complete. В обох raf-прогонах однаковий QA HOME та стабільна група.

## Workspace

Base SHA raf-hotfix і bridge raf-main-b: 1d2a13d079159a44b58c7a6595ff8627656a43bd. До RED код не змінено; додано лише test/test-run-vitest-workspace-env.test.ts та адресну реєстрацію conf. До GREEN додано зміну src/test-run-etchly.ts із workspace.patch. Тест однаковий між RED і GREEN (test-source.txt). Незалежний untracked node_modules не комітився. Конфігурацію внесено in-place; точні власні записи — conf-registration.json, спільний conf комітить main.

Ramus-cloud workspace: /srv/dev/work/orchestrator/ramus-cloud-develop, SHA acb91077853e3e63873a08371e86850c35487b9b. Bridge у відтворенні: raf-main-b, без незакомічених змін. Ramus-cloud мав лише сторонні untracked dotfiles/.claude/.idea, продуктових tracked змін не було. Відбір — test/access.test.ts.

## Передача

Main уточнив у цій сесії: «Активацію не роби: закоміть фікс (RED→GREEN у власній групі raf), conf внеси in-place — закомічу я. Після твого succeeded я активую raf-слот штатно, і повтор ramus-cloud групи retire-conductor-everywhere/ramus-cloud-2.x зробить окремий запуск 2.18 (нагадування d81306b8).» Це розподіл наступних дій; post-activation ramus-cloud pass тут не заявлено. Main отримує точний activation SHA у JSON-звіті. 9.1 не доручено та лишається відкритим; archive не виконано. Галочки 1.1 ставить raf.
