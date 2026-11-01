# Перевірка 1.1

Аудит: proposal/tasks актуальні; `src/quota-screens.ts` та `coordinator.observe` перед виправленням розпізнавали лише grok. Змін вимог немає, `skip_specs: true`. Код: `08ebfc773811d64fa2db4f4451370f9c0fdfc046` у `/srv/dev/work/orchestrator/raf-hotfix`.

Обидва прогони використовували стабільну групу `fix-raf-detect-agy-quota-midrun/unit` та той самий ізольований QA HOME, вказаний у JSON. `callerPhase=hotfix` означає фазу виконавця; фактичні фази прогонів — `red` і `hotfix`. Повний незмінений TestRunResult — перший JSON-рядок транспорту, stderr збережено окремо; `*-transport.json` також зберігає повну відповідь інструмента. CLI exit code збережено окремо від child `exitCode` у TestRunResult.

## Первинне падіння

```sh
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/48889aa3-a33b-463c-8786-d86fc5beeb60/raf-main/bin/raf.ts test run --project raf --phase red --group fix-raf-detect-agy-quota-midrun/unit --files test/runner-limit-midrun.test.ts
```

runId `f8f455c3-d822-4de3-9964-55f1ee1e627b`: `outcome=assertions-failed`, CLI=1, child=1. 7 passed, 4 knownRed (парсер і closure для кадрів із survey та composer); setup/import failures немає. `unexecuted=[]`, `unknown=[]`, `timedOut=false`, `cleanup.complete=true`, `groupState=idle`, `timeoutCount=0`, `nextAction=implement`.

[TestRunResult](red-result.json), [stderr](red-stderr.txt), [CLI code](red-cli-exit.txt), [transport](red-transport.json), [незакомічений тест на base HEAD](red-workspace.patch).

## Підтвердження

```sh
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/48889aa3-a33b-463c-8786-d86fc5beeb60/raf-main/bin/raf.ts test run --project raf --phase hotfix --group fix-raf-detect-agy-quota-midrun/unit --files test/runner-limit-midrun.test.ts test/quota-screens.test.ts
```

runId `dd21a43d-4578-46c9-a451-aee7071ede04`: `outcome=passed`, CLI=0, child=0. 32 passed; `knownRed=[]`, `unexecuted=[]`, `unknown=[]`, `removed=[]`, `timedOut=false`, `cleanup.complete=true`, `groupState=complete`, `timeoutCount=0`, `nextAction=complete`. Ресурсна черга дочекалася допуску; повторних викликів для обходу очікування не було.

[TestRunResult](hotfix-result.json), [stderr](hotfix-stderr.txt), [CLI code](hotfix-cli-exit.txt), [transport](hotfix-transport.json), [перевірений patch на base HEAD](hotfix-workspace.patch), [SHA/workspace](workspace.json).

Кадри agy 1.4.7 містять дослівне попередження з `Resets in 3h26m57s.`, Error ID та survey або порожній composer з `? for shortcuts`. Перевірено exhausted для обох пулів, точний reset `2026-10-27T07:26:57.000Z` від спостереження о 04:00 UTC, завершення failed з `quota exhausted: agy`, звільнення резервів, kill лише власної pane, виключення agy з наступного добору. Збережено grok і негативні сценарії (звичайний екран, цитата у brief, чужа pane).

Чинна freshness-політика не змінена: актуальний exhausted snapshot блокує runner; після `collection.staleAfterMs` квота стає unknown, а після відомого reset також unknown до нового заміру. Тест не стверджує безперервного блокування за простроченого snapshot. Це відповідає `projects/raf/quota-collection`, «Стан пулу квот»; нових таймаутів, лімітів чи правил stale не додано.

`openspec validate fix-raf-detect-agy-quota-midrun --strict` — exit 0, change valid; `skip_specs` дозволяє нуль delta.
