# QA add-raf-test-run:6.2.6.3 — незавершено

Виконавець `raf-trt6263-qa`, запуск `9babaa4d-02cb-4877-8e5d-d2992db3ecba`, 2026-10-25. Призначення `project=raf`, `phase=qa`, workspace `/srv/dev/work/orchestrator/raf-develop`, branch `develop`. Виконавець не є автором scaffold або implement. Предметний контракт актуальний: proposal, tasks 6.2.6.3, etchly-integration-profile D01–D09, integration-profile та delta test-runs узгоджуються. Rollout зафіксований у tasks 6.2.6.2.1; це не доказ живого D1-прогону.

## Фактичний виклик

```text
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/c5d1e9bf-30a3-43b8-ae1e-0aec877403cf/raf-main/bin/raf.ts test run --project raf --phase qa --group add-raf-test-run/etchly-integration --files test/test-run-etchly-integration.test.ts
```

На момент виклику raf SHA `458981836cbae571a95173e58e03a72df4bd5233`, робоче дерево чисте. [Незмінений JSON](unit-qa.result.json), [stdout](unit-qa.stdout), [stderr](unit-qa.stderr), [CLI code](unit-qa.cli-code.txt), [повний результат інструмента з командою](unit-qa.tool-capture.json).

- RunId `45f28a08-e8c4-4576-8447-4409ff640237`; CLI **1**, child `exitCode=null`.
- Outcome **refused**, `errorCode=CALLER_UNAUTHORIZED`: `QA channel unavailable: unit context could not be verified`.
- `callerPhase=qa`; `testKind=null`, `timeoutPolicy=null`, `command=null`, `profileId=null`. Запитаний файл не запущено; фактичний `selection.files=[]`.
- `timedOut=false`, `cleanup.complete=true`, `remainingPids=[]`; `knownRed/unexecuted/unknown=[]` описують відмову до запуску, а не перевірений набір.
- `groupSnapshot=unavailable`, `groupState=null`, `timeoutCount=null`, `stateAccess=null`, `nextAction=fix-setup`. Стан і бюджет агрегату не перевірені. HOME/group/phase не підмінялися, скидання чи повтору не було.

Інструмент повертає об'єднаний output. У ньому один повний JSON у першому рядку та diagnostic наступним рядком. Вони збережені окремо без переформатування; межа stdout/stderr виведена зі спостережуваного формату, незалежного захоплення OS streams немає. Оригінал повністю збережено у tool-capture. У власній теці `codex-raf-results-G1bync` після replay готових файлів не було. Незалежний stream capture не вигадується. Цей результат не є pass або test-first red.

## Статичні передумови та межа доказу

[context.json](context.json), відтворювач [collect-context.mjs](collect-context.mjs): тільки read-only Git/metadata/hash/JSON comparison, без test runner, імпорту test bodies, Vitest discovery, D1, install/build чи читання операційного стану raf. Код метаданих завершився з CLI 0; цей код не є результатом QA тестів.

Etchly SHA `aaf955e3ebfec33188838283b6f2f1ac5361617e`, branch develop, чистий tracked та untracked стан під час знімка. Усі п'ять registration entries точно збігаються з patch scaffold. Зареєстровано 621 унікальний integration-файл: відсутніх шляхів і перетинів із unitFiles немає. Smoke містить рівно три контрактні файли. Це перевірка реєстрації та існування, не повторна type-aware класифікація чи поведінкова перевірка.

Всі profile.checks існують; workerd/esbuild мають execute bits. Збережено package versions, hashes конфігурації й D1 helpers, local build та shared-libs alias/branch. Local index.html існує і не містить dev1 favicon; придатність build для живого setup не підтверджена. Десять адресних entrypoint/bridge/runtime/reporter файлів покоління `c5d1e9bf-30a3-43b8-ae1e-0aec877403cf` мають ті самі hashes, що raf-develop. Збережено повні шляхи; фактичні executable/argv/cwd bridge та внутрішнього Vitest **не спостерігалися**, бо runner не стартував. Node `/opt/dev/node/bin/node` v26.12.1, Linux x64.

## Невиконані сценарії

| Контракт | Фактичний стан |
| --- | --- |
| D01–D07 wrapper-конфігурація, класифікація, точні/негативні відбори, бюджети, guards, events та caller | Цільова unit-група відхилена довіреним каналом; поведінка не перевірена. Статичні метадані вище не замінюють сценарії. |
| Узгоджені власні etchly-profiles/integration-profiles unit-регресії | Не запускалися після встановленої несправності unit context; немає підстав сліпо повторювати той самий канал. Чужі regressionGroups не декларовані вибраним item і не запускалися. |
| D08 deadline/interruption/concurrent/crash/recovery із реальними forks/workerd | Не виконано: немає належного etchly призначення/керованого integration стенда. Cleanup відмови не підтверджує цей lifecycle. |
| D09 own etchly smoke preset та exact --files, негативні відбори/передумови | Не виконано: immutable assignment має project=raf. Канал не обходився викликом etchly під чужим project/workspace, прямим runner, іншим HOME чи фазою. |

Жодного власного тестового/D1 процесу або runtime-артефакту не створено. `cleanup.complete=true` у відмові стосується лише відсутнього запуску. Незалежна перевірка cleanup реальних forks/workerd залишається невиконаною. Продуктових дефектів за цим проходом не встановлено; немає підстав заявляти red/fix/green або mainHotfix. Точна першопричина unitContext прихована загальним повідомленням каналу; metadata `/tmp/raf-unit-1000` показала uid/gid 1000, mode 0700, але далі QA/операційний state не читався.

## Передача та наступна дія

`agent ps` підтвердив адресу `main`. Дві різні адресні доставки (запит etchly передумов, потім фактична діагностика відмови) повернули CLI 1 `HANDLER_FAILED`, `Recipient has no recognized empty agent composer`, completed/pending порожні, retrySafe=true. Доставки не підтверджені. Останню повну команду та receipt збережено у [main-message.capture.json](main-message.capture.json) і [main-message.result.json](main-message.result.json). Великий agent ps не включено: адресна перевірка не потребує чужих launch contexts.

Потрібно відновити довірений unit context і канал повідомлень; забезпечити належне власне `project=etchly` призначення/workspace для active change `add-raf-test-run` та керований D08 стенд. Після відновлення передумов виконавець сам проводить **перші невиконані** сценарії; прогін main, unit-моки або окремий ланцюжок defect-fix/repeat-qa не замінюють цієї роботи. Відомий результат відмови не повторювався сліпо. Наявні файли dependencies/build не є заявою про їх відсутність або готовий D1 setup.

6.2.6.3 залишається відкритим. Галочки не змінювалися; нових QA/defect-fix задач не додано. Інші пункти зміни відкриті; sync/archive та push не виконувалися. Це failed через відсутні передумови, а не відкладення за рішенням власника.
