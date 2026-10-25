# QA 10.5 — complete-raf-flow-contracts

Дата: 2026-10-25. Виконавець: raf-cfc105-qa. Підсумок: **failed / пункт 10.5 залишається відкритим**. Unit-green не підтверджує integration або справжні CLI.

## Перевірені результати та відмови

| Прогін | Фактичний результат | Доказ |
| --- | --- | --- |
| Unit, model-routing, qa | 63/63 passed; CLI 0, child 0; timedOut=false; cleanup complete, remainingPids=[]; knownRed/unexecuted/unknown=[]; groupSnapshot=loaded, groupState=complete, timeoutCount=0, nextAction=complete | [Повний незмінений TestRunResult](unit.stdout.json), [команда й transport](unit.transport.json), [окремі коди](unit.cli-exit.json) |
| Integration, phase integration | INVALID_VALUE на parser: integration відсутня в compiled каталозі. CLI 1; child/runId/TestRunResult відсутні; completed/pending=[]; retrySafe=true. Це не red і не pass | [незмінена відмова](integration-rejected.stdout.json), [команда, SHA, transport](integration-rejected.transport.json) |
| Integration, одна явно доручена main спроба phase qa | refused CALLER_UNAUTHORIZED: profile/selection не збігаються з immutable assignment. CLI 1, child exitCode=null, duration=0, timedOut=false, cleanup complete, remainingPids=[]; groupSnapshot=unavailable, groupState/timeoutCount=null, nextAction=fix-setup; knownRed/unexecuted/unknown=[] через відмову до відбору, а не через виконання | [повний незмінений TestRunResult](integration-qa-refused.TestRunResult.json), [весь merged output](integration-qa-refused.merged.txt), [transport](integration-qa-refused.transport.json), [виділене повідомлення після JSON](integration-qa-refused.stderr-extracted.txt) |

Unit runId: bbeb86e8-56a3-4828-afce-5c5f19e72d80. Відбір: test/model-routing.test.ts, test/model-routing-handoff.test.ts. Стабільна група complete-raf-flow-contracts/model-routing. HOME не мінявся для повтору чи скидання агрегату.

Відмова qa runId: ea9c0812-fb26-4947-bd45-a7358f8c0ed8. Група complete-raf-flow-contracts/model-routing-integration; фактичний selection.files=[]; profileId/testKind/timeoutPolicy/callerPhase=null; command=null. Child не виконувався, fixture tmux/SQLite цим прогоном не створювалися.

Wrapper для всіх команд: /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/3557f6a4-89a2-41a3-b963-b4343aabc699/raf-main/bin/raf.ts, Git SHA 6730c74b5ce2fae6b0f7daa05e393c5fa244b423. Перед першою integration-спробою workspace SHA 548c65c18dc9e755ed7769862e5ca45673f5e5f4; повний status у transport. [Стан після спроб і reflog](workspace-after.json) містить dirty/shared-tree контекст та ретроспективний висновок про unit HEAD cb701b1afd61fe22922455883d3c9eadf730c4db. SHA/dirty snapshot саме в момент unit не записано; його не можна представляти як чистий синхронний snapshot.

**Обмеження stderr:** exec_command надає один merged stream. Повний transport збережений, але незалежного native stderr capture для цих команд немає. Після єдиного JSON рядка qa-відмови повідомлення виділено окремим файлом; походження stream не спостерігалося незалежно. Відсутність окремого stream не видається за порожній stderr.

## Користувацькі сценарії

Усі I1–I5 мають статус **unexecuted**: integration child не запускався. Закомічений test/model-routing-integration.test.ts готує лише частину цих меж і ще не перевірений виконанням.

| Сценарій | Що залишається перевірити |
| --- | --- |
| I1 | Реальні compiled CLI enable/disable/list, persistence між процесами, initialEnabled лише при відсутності, одна enable claude, повтор, хибні параметри й чужий caller без мутацій. Fixture тест підготовлено, не виконано. |
| I2 | Живий fixture після disable, заборона нового запуску, відсутність probe, окремі cached/stale quota і warnings. Підготовлено лише process/session preservation та pure selection waiting; фактичний новий agent-run і quota/warnings потребують повного сценарію. |
| I3 | Limited до запуску/після readiness, failed startup, зникла pane при alive/unknown; неподільні claims/пункти, первинна причина й runId cleanup. Підготовлено лише реальний process scan із synthetic limit та alive/unknown guard на портах. |
| I4 | Concurrent reconciliation і відмова повної фіналізації session/reminder/reservation/events; ідемпотентність; лише новий agent-run резервує незавершене. Підготовлено лише дві SQLite connections, transaction rollback pending/session/reservation і повтор same-revision; це не доказ конкурентного reconciliation/reminder pipeline. |
| I5 | Реальний atomic JSON/OpenSpec: succeeded+nonzero, failed, старий runId, змінений опис, disable перед reroute, pause/stop; нові brief/runId/report_path без resume/повторних галочок. Integration тест цього не виконує. |
| L1 codex | unexecuted: немає наданого чинного доказу запуску через tmux із version/native/process identity/model/effort/brief/report. Робочий HOME/auth не використовувався. |
| L1 grok | unexecuted: main повідомив unavailable, quota unknown, native identity evidence відсутній. Установлений binary не доводить працездатність. |
| L1 agy | unexecuted: main повідомив unavailable, quota unknown, native identity evidence відсутній. Вигаданий ID не використовувався. |
| L1 claude | unexecuted: немає наданого чинного tmux-доказу; робочий HOME/auth/enable не використовувався. |
| L2 | unexecuted: справжній main enable claude однією командою, disable при живому runner, збереження роботи і відмова наступного запуску не виконані. |
| L3 | unexecuted: немає актуального доказу справжнього limit/refusal з version і фактами; quota не знімалась, кредити штучно не витрачалися. Докази 11.4 не надані як придатні для цього запуску. |
| L4 | unexecuted: справжня зміна моделі після підтвердженого завершення/фіналізації попередника, нові identity/path та передача лише незавершеного не виконані. |
| L5 | Причини й невідомі факти задокументовані; незалежний unit виконано; I/L не оголошені pass. |

Поточний статус runner наведено зі звернення main у цій сесії; власний runner list на робочому HOME не запускався. Наявність виконуваних файлів codex/grok/agy/claude сама по собі не є доказом availability/auth або live запуску.

## Зміни та наступна дія

Власний commit f8584eabf8a76e5d8b636124aff6b812f2817044 додає ізольований integration fixture. Перед виконанням виправлено escaping newline у generated version-only stub і прибрано невикористаний import. node --check test/model-routing-integration.test.ts і syntax-only перевірка згенерованого stub завершились 0; provider/fixture сценарії цими перевірками не виконувались. Це виправлення setup, а не red assertion чи продуктова регресія.

Main зареєстрував preset у conf комітом ffdf00f0b4 (зовнішній, не власний). Після цього parser відхилив integration, а незмінний канал відхилив qa. Повторів після відмови, ручного node --test, нового HOME, підміни фази чи обходу каналу не робилося.

Необхідна наступна дія для I: перенести актуальний raf develop→main, отримати перевірений канал/доручення з integration preset та виконати точну integration-команду з чинного брифа. Потім завершити непокриті I-сценарії й L1–L4 з дійсними передумовами. Пункт 10.5 вже містить цю невиконану роботу; зайвих задач у tasks.md не додано. Галочка, archive і push не виконувались.
