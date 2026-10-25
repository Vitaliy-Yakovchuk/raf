# Передача 5.10

Підготовлено `test/runtime-verification-cost.test.ts`: 91 сценарій за матрицею design 5.9. Production-код не змінено; нової production-поверхні або каркаса методів не знадобилося.

Власний остаточний red виконано на коміті `95a260f47fddfd58d39cfdbaf370f746ba50ac4a`:

```text
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/a082d01d-15d1-4418-a307-f8f63cb140f5/raf-main/bin/raf.ts test run --project raf --phase red --group profile-raf-performance/runtime-verification-cost --files test/runtime-verification-cost.test.ts
```

Run ID `95a1a052-4abb-409f-bbc8-82fb76c1dc1f`; outcome `assertions-failed`; CLI/child **1/1**; **28 passed, 63 knownRed**. `unexecuted`, `unknown`, `removed` і `remainingPids` порожні, `timedOut=false`, `timeoutCount=0`, cleanup complete. Усі diagnostics — assertion; setup/import failure немає. Група idle, nextAction implement. Повні IDs, відбір і політика timeout містяться у незміненому результаті.

- [Повний TestRunResult, stdout](final-red/stdout.json).
- [Окремий незмінений stderr](final-red/stderr.txt).
- [Оригінальний capture manifest із CLI code та довжинами](final-red/capture-result.json).
- [Перевірені SHA-256, довжини й спосіб доставки](final-red/delivery.json).
- [Матриця, точні доповнення conf, передумови профілю та передача main](handoff.json).

Падіння фіксують 10/16/40 root traversals замість одного для 0/1/5 вкладених module checks; повторні origin-перевірки; зайві process scans у ps; глобальний ps для відомих Linux identity. Для повної agent run успішні legacy N=1/4 роблять 3/6 глобальних scans, queue — 4/7; очікується нуль. Перевірки повної команди також містять бюджет store/context/close, inventory та адресних OS-читань; вони не залежать від скидання локального лічильника ітерації.

Реальні filesystem traversal/metadata/content операції рахуються на межі fs; внутрішній open від readFile записується окремо. Реальні SQLite schema/path/claim/event/profile операції збережено. Readiness і доставка проходять через справжні entry/app-runtime/queue/adapter transport із керованими портами. Живі CPU/wall серії та production runner/delivery перевірки залишаються пункту 5.11.

Main уже зареєстрував файл у node.unitFiles і групу в conf/test-runs.json. Профіль, SHA конфігурації та точні JSON pointers наведено в handoff.json. Перед 5.11 main має перевірити саме red автора; наступний виконавець використовує незмінну групу й assertions.

Спроби 1–4 були refusals; 5 — власна синтаксична помилка фікстури, виправлена до остаточного red. Спроба 6 мала обрізаний tool output і не використовується як повний доказ. Остаточний прогін відбувся після виправлення подвійного підрахунку читань і додавання загальних процесних лічильників.

Встановлений replay видаляє capture після читання, а його manifest ще не містить context/hash полів. Для остаточного прогону власні stdout/stderr/result.json відкрито лише на читання під час виконання й скопійовано після публікації повних довжин; [скрипт збереження](capture-proof.mjs) не змінює capture та не створює hard links. SHA-256 і контекст перевірено незалежно; про відмінність каналу повідомлено main. Повтор через обрізання остаточного результату не виконувався.

Статичні перевірки TypeScript parser, check:comments і git diff --check завершилися з кодом 0. Галочки tasks.md лишено raf; зміна має інші відкриті пункти, архівація не виконується.
