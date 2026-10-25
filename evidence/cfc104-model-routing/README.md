# 10.4: model-routing

Реалізація: 1f917b15d4bb3612d01a9177d937e5df47e3b064 та 46c9acce373dc2dbac511b0d5e9018922ced260e. Власні шляхи: model-routing, model-routing-handoff, app-runtime, production-agent-queue, production-entry (export чинного reader), production-runtime, production-model-handoff, session-state. Адаптери й state-store повторно не реалізовано; схему SQLite не змінено.

Чистий handoff перевіряє runId, owner action, фінальний звіт, підтверджений вихід, чинну фіналізацію та звільнення claims. Новий agent-run отримує лише незавершені пункти з незмінними описами, актуальний routing, іншу модель, нові runId/native context/report path та причину/докази попередника. Succeeded не повторюється.

Production зберігає pending work у чинному JSON SessionRecord під час атомарного закриття, виконує handoff після worker exit або reconciliation ps та резервує наступника чинним agent-run/task-reservations. Маркер successorRunId і резерв нового запуску записуються в одній транзакції; конкурентний спостерігач не може резервувати другого наступника. Явні pause/stop фіксуються перед керувальним сигналом. Очікування не очищає pending work. Старий failed залишається failed.

## Перевірки

Повна команда, wrapper SHA, відбір, CLI/child exit, cleanup/timeout, агрегат та стан групи для кожного запуску: [runs.json](runs.json). Незмінені повні TestRunResult: implement-1/2/3/4/5.stdout.json. Стан робочого дерева фінального прогону до й після: final-workspace-before.json, final-workspace-after.json (HEAD 46c9acce373dc2dbac511b0d5e9018922ced260e, власний код чистий; сторонні правки не включено).

- Початковий незалежний implement: f554ef48-d528-4a3e-96df-824df1936463, 46 passed / 17 red. Виправлено зайву вимогу дубльованого стану після авторитетного finalize port, що блокувала launchNew.
- Другий: 1a661709-750e-433b-a4e9-65fba8e3c7d0, 59 passed / 4 red; main підтвердив дефект commandTiming fixture і доручив іншому автору 10.3.1. Підготовлені тести виконавець 10.4 не редагував.
- Після незалежного fixture fix 6b405ace3ec324592bf550e8f1f8d56fa50ddf9b: 699d261e-61d7-4ec5-a4c5-829ca84d02bd, 63/63 passed.
- Повтор після власного commit та production audit: 80621d10-a05f-4a65-aab5-0fa0c9f0a787, 63/63 passed; CLI=0, child=0, knownRed/unexecuted/unknown=[], timedOut=false, cleanup.complete=true, remainingPids=[], timeoutCount=0, groupState=complete, nextAction=complete. QA HOME не змінювався, групу не перейменовано.
- Остаточний після уточнення startup cause (failed з реальною причиною, а не вигаданий exited без process observation): 95e783ab-03c6-4e7e-98b5-0ea51ceec5a6, 63/63 passed; CLI/child 0, knownRed/unexecuted/unknown=[], cleanup complete, timedOut=false, groupState=complete, nextAction=complete. Черга ресурсів зачекала й дозволила запуск; її діагностику збережено окремо у implement-5.stderr.txt.
- npm run build: 0 (build.stdout/stderr/exit.json); npm run check:comments: 0 (comments.*); імпорт восьми змінених модулів: 0 (imports.json).
- Додаткова спроба TypeScript noEmit без проєктного tsconfig не пройшла (types.*): 860 діагностик, зокрема відсутні Node type definitions. Це не успішна typecheck-перевірка; стандартний build пройшов.

## Межі доказу

exec_command віддає об'єднаний output. Окремого native raw stderr capture main не має (Q97). Повні JSON рядки збережено без змін. Перший рядок TestRunResult та подальші queue/refusal діагностики розділено за CLI протоколом; повний merged transport для непорожнього stderr збережено. Порожні stderr файли перших чотирьох прогонів відображають відсутність додаткових байтів за stdout/stderr контрактом CLI. Це protocol split, не незалежний capture двох потоків. Код CLI збережено окремо від TestRunResult.exitCode.

Signals спроба ade72a7e-fcd5-4499-9b69-33878e94bd92 — refused/CALLER_UNAUTHORIZED, без child process, повністю збережена у signals-refused.*. Повтору не було. Main уточнив: signals не потрібна для 10.4, бо quota-screens уже в z390-regress і файл не може мати дві групи однієї зміни. Це не pass.

10.5 лишається відкритим: реальні SQLite/tmux/CLI integration та живі чотири провайдери цими unit-портами не підтверджені. Checkbox 10.4 ставить raf за succeeded JSON. Інші пункти відкриті, sync/archive не виконується.
