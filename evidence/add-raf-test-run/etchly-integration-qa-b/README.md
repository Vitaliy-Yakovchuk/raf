# QA 6.2.6.3 — raf-trt6263b-qa

Source item: `add-raf-test-run:6.2.6.3`; immutable assignment `project=raf`, phase `qa`, workspace `/srv/dev/work/orchestrator/raf-develop`. Це незалежний QA; автором scaffold/implement цього пункту не був.

## Unit

```text
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/de319c1f-fc5b-432e-884a-a25ac062c5bf/raf-main/bin/raf.ts test run --project raf --phase qa --group add-raf-test-run/etchly-integration --files test/test-run-etchly-integration.test.ts
```

Перший виклик, `d4e3c4d7-4fff-4a54-9087-eedf34dc9162`, спостерігався з CLI 0, child exitCode 0, outcome passed та complete cleanup. Власний `max_output_tokens=1600` урізав tool output (початковий обсяг 4756 tokens). Повного незміненого JSON немає; цей виклик **не прийнятий як доказ pass**. Main підтвердив, що raf не зберігає stdout/stderr окремо, і доручив один повтор. Це помилка capture QA, не відмова каналу.

Дозволений один повтор із лімітом 20000 tokens: `e42191ba-2510-4034-8714-1f34188b9c39`, CLI **1**, child exitCode **null**, `setup-failed`, `STATE_CONTEXT_REFUSED`, до spawn. Повний незмінений JSON — [unit-qa.result.json](unit-qa.result.json), повний tool output — [unit-qa.stdout](unit-qa.stdout), command/CLI code/tool metadata — [unit-qa.tool-capture.json](unit-qa.tool-capture.json), окремий CLI code — [unit-qa.cli-code.txt](unit-qa.cli-code.txt). Tool надає об'єднаний output: порожній [unit-qa.stderr](unit-qa.stderr) означає відсутність окремо доступного stderr, **не** незалежне OS-підтвердження порожнього stderr. JSON parse успішний; output не урізаний.

Повтор не виконав відбір: result.selection порожній, command null; timedOut=false; cleanup.complete=true, remainingPids=[]; knownRed/unexecuted/unknown порожні лише в setup-result; groupSnapshot unavailable; groupState/timeoutCount/stateAccess null; nextAction fix-setup. Це не red і не green. Лічильник/HOME не скидався; нових unit-повторів після цієї відмови не було. Останні SHA/dirty/generation/config/source hashes — [context.json](context.json); це окремий read-only snapshot після викликів, не гарантія незмінного HEAD протягом них.

Групи тієї самої зміни `add-raf-test-run/etchly-profiles` та `add-raf-test-run/integration-profiles` не виконані після втрати робочого контексту каналу. Чужі regressionGroups не декларовані й не запускалися; grants не змінювалися.

## Живі сценарії

D01–D07 вивчено за контрактом, fixture та production implementation; неповний unit-capture і setup-result не доводять виконання цих сценаріїв. D08 та D09 поки не виконані QA. Наявність файлів dependencies/app build зафіксована статично; реальний D1 setup, bridge/batches та незалежний cleanup тут не підтверджені. Власних integration-процесів чи D1-артефактів цей агент не створював.

За прямим дорученням main підготовлено [точні хостові команди та очікувані виходи](HOST.md), чисті клони/власний HOME і керований real-workerd API-стенд. До отримання повних хостових captures результат лишається pending. API-стенд не є D09 власного caller: поточне immutable доручення `project=raf` не надає права `project=etchly`.

## Канал координації

Адресу `main` перевірено через `agent ps`. Повідомлення про початок QA прийнято receipt `62ff1e46-5f13-4e46-8aa3-4ba653c1719c`; про урізаний capture — `1c0a0314-d163-493f-86ae-c683045bf6c4`. Після повторного unit setup-failure повідомлення main отримало CLI 1, `STATE_CONTEXT_REFUSED: Unregistered module origin` для переданого покоління `de319c1f-fc5b-432e-884a-a25ac062c5bf`. Receipt доставки немає. Це окрема від початкового обрізання відмова; обхід каналу не застосовувався.
