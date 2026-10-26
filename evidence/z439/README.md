# Z.439: readiness Codex і cleanup agent close

Доручення: `complete-raf-flow-contracts:Z.439`. Аудит proposal, вибраного пункту tasks.md і чинних контрактів agent-adapters/agent-control не виявив суперечностей. Інші відкриті пункти зміни не виконувалися; tasks.md виконавець не змінював, архівація не застосовується.

## Виправлення

Codex може завершити `/status` відповіддю `Limits: refresh requested; run /status again shortly.` без Session ID і повернути порожній composer. Попередній стан залишав `submittedStatus=true`, тому worker лише очікував. Тепер повернення до готового порожнього composer після відправленої команди дозволяє повторно прочитати `/status`. Native identity та durable start gate збережено; регресія викликає справжні production readiness/protocol/delivery функції й перевіряє доставку повного брифа лише після native ID та gate. Нових дедлайнів чи лімітів немає.

`agent close` для вже finished-сесії раніше завершував лише worker. Тепер cleanup перевіряє й прибирає також записаний runner/tmux, використовуючи його socket. Коли runner завершився, записаний pane ID дозволяє прибрати власну залишену сесію існуючим механізмом cleanup, навіть якщо в pane ще живий дочірній процес. Підмінений pane і невідома process identity зберігаються; прийняті результати й події не повторюються.

Історичний екран Codex і повідомлення worker надані main у повідомленнях цієї сесії; оригінальні capture-pane та worker.log уже видалені. Це не live-доказ production. Виправлення перевірено ізольованими регресіями; production не активувалася.

## Команди та результати

Для кожного рядка таблиці виконана окрема проста команда (без shell-обгортки):

```text
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/ed631d3c-ff4f-433c-8cc8-72caf3eedc1a/raf-main/bin/raf.ts test run --project raf --phase PHASE --group complete-raf-flow-contracts/z439 --files test/z432-native-readiness.test.ts test/agent-close-exit.test.ts
```

`PHASE` = `red` для red-N, `hotfix` для hotfix-N. Відбір незмінний: два повні файли, без `--only`. Група і QA HOME не скидалися між прогонами:
`/tmp/raf-unit-1000/1ee10007bf6d5e71b39d6a2873064a767eeb928e7910599b166a0d60270ff685`.

| Доказ | runId | outcome | passed / knownRed | CLI / child exit | groupState / nextAction |
| --- | --- | --- | --- | --- | --- |
| red-1 | ad9888c9-b38b-41f3-9935-d661b84f10f9 | assertions-failed | 12 / 4 | 1 / 1 | idle / implement |
| red-2 | 31a5700c-cbaa-428b-ab2e-5066f6a936e6 | assertions-failed | 13 / 3 | 1 / 1 | idle / implement |
| red-3 | 7cd8c5ba-f804-41e5-8dab-63b0fd93ed19 | assertions-failed | 13 / 4 | 1 / 1 | idle / implement |
| hotfix-1 | 305460bc-b483-4f1a-a423-e541cbc944e2 | passed | 17 / 0 | 0 / 0 | complete / complete |
| red-4 | c084d157-1c70-4571-8669-98d109b554c0 | assertions-failed | 18 / 1 | 1 / 1 | idle / implement |
| hotfix-2 | 5a54f195-b218-4214-835f-64022902955d | passed | 19 / 0 | 0 / 0 | complete / complete |

У red-1 обидва native-тести мали помилку fixture `screenCapturedAt is not defined`; це не валідний red readiness. Fixture виправлено до зміни production. red-2 підтвердив реальне падіння refresh-сценарію та двох close-сценаріїв; звичайний `/status` уже проходив. red-3 додав реальне падіння cleanup dead pane. Після першого green red-4 окремо відтворив зайве обмеження cleanup лише мертвим pane: власний pane із живим процесом також треба прибирати. Обмеження прибрано, фінальний hotfix-2 підтвердив увесь відбір і доставку брифа.

У всіх шести результатах `cleanup.complete=true`, remainingPids порожній, `timedOut=false`, `timeoutCount=0`, `unexecuted=[]`, `unknown=[]`. Фінальний агрегат: `knownRed=[]`, `groupState=complete`, `nextAction=complete`. Часткова resourceUsage telemetry у результатах не означає неповне виконання тестів.

Кожен `NAME.json` містить повний незмінений JSON TestRunResult із stdout, `NAME.stderr.txt` — решту CLI-виводу (stderr за контрактом команди), `NAME.cli-exit-code.txt` — код CLI окремо від child `exitCode`. `NAME.transport.json` зберігає повний отриманий інструментальний результат; результат не урізаний.

## Workspace та додаткова перевірка

`red-head.txt`, `red-workspace.txt`, `red-tests.patch` фіксують базу та незакомічені тести перед production-виправленням (red-3). `hotfix-1-*`, `red-4-*`, `hotfix-2-*` фіксують SHA/workspace patches відповідних етапів. На фінальному прогоні початковий HEAD: `b1de7d951d7ecc51c2d30fdd366f3fbabf368162`; власний patch — `hotfix-2-workspace.patch`. Це спільне hotfix-дерево, чужі коміти можуть рухати HEAD; власні зміни обмежені production-runtime.ts і двома тестами. Незакомічені чужі файли не включено у власний коміт.

Фінальна збірка:

```text
HOME=/tmp/raf-unit-1000/1ee10007bf6d5e71b39d6a2873064a767eeb928e7910599b166a0d60270ff685 RAF_QA_HOME=/tmp/raf-unit-1000/1ee10007bf6d5e71b39d6a2873064a767eeb928e7910599b166a0d60270ff685 node scripts/build.ts
```

Код 0, повні stdout/stderr у `build.stdout.txt` / `build.stderr.txt`, код у `build.cli-exit-code.txt`. `git diff --check` — код 0. Увесь доручений обсяг виконано; активацію робочої raf виконує main окремо.
