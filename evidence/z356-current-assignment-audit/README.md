# Аудит complete-raf-flow-contracts:Z.356, 2026-10-26

Результат доручення — **failed**: нового підтвердженого кадру історичного збою та поведінкового red для нього немає. Product-код і тести не змінено. Додано лише цей аудит, повні результати адресних регресій і відтворюваний нативний спостерігач `scripts/qa-z356-native-delivery.mjs`. Це не відкладення за рішенням власника і не твердження, що Z.356 повністю втратила актуальність.

## Чинні джерела й межі висновку

Перевірено proposal Why/What Changes, призначений Z.356, його наявні докази, agent-adapters, unit-test-runs/test-runs та вимогу аудиту autonomous-development. У Git Orchestrator `7176dfe2663a7c2b6914e22cb77dd1818eaf36ef`, `openspec/changes/complete-raf-flow-contracts/tasks.md`, Z.356.2 дослівно вимагає: «Після перенесення діагностичного фіксу Z.356.1 у raf-main отримати перший збережений реальний кадр повторного «Unknown native input or screen during initial brief submission» з робочого запуску; за цим кадром спершу додати поведінковий red, потім розпізнати конкретний екран за контрактом agent-adapters без сліпого підтвердження.»

Та сама версія tasks.md уже позначає Z.356.1 виконаною. `z356-evidence.md` і `z356-live-summary.json` містять історичний red/fix і 4/4 живих запусків Codex 0.163.0, але прямо засвідчують deliveryFailureReproduced=false. Це попередні докази, а не новий прогін цього виконавця. Діагностичний fix `89e72316dea2b334897ddb67872e22c69089c32b` входить до HEAD hotfix; нинішній production-runtime також викликає preserveFailedDeliveryEvidence перед cleanup. Повторно реалізовувати вже виконану частину немає підстав.

Пізніший Z.4.1 також уже виконаний: тести `b18556c44497e1a56d70dc0ec9c67858c710e885`, fix `3c1097e589453307726e63a57b2f50b79cb230a3`, докази `../z41-pasted-brief/verification.json`. Він дозволяє точний власний фрагмент брифа й штатний queue footer навколо перевіреного pending paste; сторонні меню й footer відмовляють. Обидва commits входять до HEAD. Його synthetic stand red/green не доводить тотожність утраченим трьом інцидентам Z.356; сам verification.json чесно каже, що автор не виконував live Codex. Нових правил Enter або нових product-лімітів у цій сесії немає.

## Поточні unit-регресії

Повні незмінені TestRunResult — `z41-regression.stdout` і `diagnostic-hotfix.stdout`; stderr збережено окремо. Команди, SHA, відбір, hashes, CLI/child exits, cleanup, timeout і агрегати — `unit-runs.json`. Оригінальні tool envelopes також збережені. Для diagnostic-hotfix до replay відкрито власні broker-файли: `diagnostic-hotfix.transport.json` містить незалежний CLI code і точні stdoutBytes/stderrBytes. Для першої регресії збережено повний combined tool output, потім відділено JSON-рядок stdout і решту stderr без зміни тексту; первісні broker byte counts не отримано.

- Налаштована група `complete-raf-flow-contracts/z41`, без --files: runId `68909c8c-051a-4884-9417-819eb94ab4ff`, 30 passed, CLI/child 0/0, 1375 ms.
- Стабільна група цього аудиту `complete-raf-flow-contracts/z356`, --files `test/delivery-diagnostic.test.ts`: runId `077cc59c-5535-4ded-8b87-ee934ed03ca9`, 3 passed, CLI/child 0/0, 1176 ms.
- Для обох cleanup.complete=true, timedOut=false, knownRed/unexecuted/unknown порожні, groupState=complete, timeoutCount=0, nextAction=complete. Використано той самий наданий QA HOME `/tmp/raf-unit-1000/1ee10007bf6d5e71b39d6a2873064a767eeb928e7910599b166a0d60270ff685`; reset/перейменування групи не виконувались.
- SHA обох прогонів `e6e51c7f11b9604e3926e93afb38be756b04991f`: reflog фіксує commit 13:17:22Z, до startedAt обох прогонів; tracked-змін перед ними не було. Під час аудиту інший виконавець комітив лише власну документацію. Наші докази були untracked; наданий node_modules не змінювався.

Це регресії наявної реалізації. Вони не є новим red, full production cleanup acceptance або живим прийманням Z.356. Новий тест зі штучно вигаданим failure screen не додано; product-виправлення без потрібного фактичного кадру не виконувалось. Нової реалізації, що порушувала б test-first, немає.

## Поточний живий стенд

Виконано прямий Codex 0.163.0 у власному tmux з приватними HOME/RAF_QA_HOME/CODEX_HOME. Від історичного відтворювача збережено selection gpt-6.1-sol/high; вибір моделі/effort поточного виконавця не змінювався. Скопійовано лише наявну конфігурацію та автентифікацію в приватний CODEX_HOME, значення не виводились і після завершення видалені. Робочий стан raf, agent run/main/service команди та чужий tmux не використовувались. Спостерігач використовує наявні protocol/diagnostic helpers і два інертні payload 20177/19146 символів. Він не є production wrapper і не доводить raf launch/report acceptance.

Файли знеособлених кадрів збережено незмінними:

1. `native-live-setup-attempt.json`: два native процеси; Codex відмовив створювати допоміжні файли, оскільки перший приватний CODEX_HOME лежав усередині TMPDIR. До identity й брифа не дійшло. Це setup, не red.
2. `native-live-identity-attempt.json`: CODEX_HOME винесено за TMPDIR; два процеси дійшли до composer, але спостерігач не отримав Session ID. Це також не red.
3. `native-live.json`: два процеси; `/status` надсилалось тільки після появи саме цього тексту в composer, за стабільного повтору — чинний одиничний retry. Кадри показують «Waiting for startup  · esc cancel». У межах спостереження transitionMs із чинної conf native identity не підтверджено, бриф не надсилався. Не встановлено причину startup-очікування чи неможливість пізнішого запуску. Початковий unknown_screen під час доставки не відтворено.

Нативний child exitCode невідомий: процеси інтерактивні, їх зупинено власним kill-server. Exit 0 самого спостерігача означає запис observation JSON, а не passed приймання. У всіх спробах kill-server CLI 0, remainingPids=[], приватні HOME прибрано; після розділення каталогів приватний CODEX_HOME також прибрано. Нових product timeout/validation/config правил немає.

Команда запуску: Python subprocess із приватним bootstrap HOME/RAF_QA_HOME і `CODEX_HOME=/home/dev/.codex` викликав `node scripts/qa-z356-native-delivery.mjs evidence/z356-current-assignment-audit/native-live.json`. Перед комітом шлях приватного CODEX_HOME параметризовано третім аргументом — дозволеним власним каталогом запуску. Логіка спостереження не змінювалася; фінальний script перевірено `node --check`, повторного native-прогону після параметризації не було. Для повторення передати цей третій аргумент та ізольований bootstrap HOME; raw credentials у Git не додавати.

## Доставка висновку й наступна дія

Один дозволений `agent ps` не повернув повного JSON або CLI exit на час фіксації. Власні часткові stdout/stderr/result і timestamp збережено як `agent-ps.pending.*`/`agent-ps-observation.json`; CLI exit і наслідки reconciliation невідомі. Команду не повторювали і не обходили канал. Адреса main через ps не перевірена, тому agent message з вигаданим адресатом не надсилалось. Результат доставляється атомарним JSON-звітом raf цього доручення.

Після unit-прогонів інші виконавці залишили tracked-зміни src/production-runtime.ts, src/agent-control.ts, src/session-state.ts, test/agent-close-exit.test.ts і власні нові файли Z.437/Z.438. Вони не входять до цього коміту й не покриваються наведеними результатами на e6e51c7. Спільні product-файли цим виконавцем не редагувались. Очікування tool-cell agent ps припинено без отримання CLI result; це не підтверджує завершення хостового reconciliation.

Потрібен фактичний збережений delivery frame конкретного повторного збою; після нього — поведінковий red через дозволений test run, потім виправлення й hotfix у тому самому агрегаті. Якщо main вважає Z.4.1 достатнім покриттям історичного дефекту, це потребує його звірки доказів і коригування tasks.md; цей виконавець такого висновку не встановив. Z.356 залишається failed/unmarked; tasks.md не редаговано. Інші пункти відкриті, sync/archive не застосовується.
