# QA 7.2: production fixture layout regression

Main передав дефект: production QA фікстура залишала конфігурацію mainCopies без самих копій. Чужий run `68aea465-5fc2-47e9-86a0-c14223cd203a` (`evidence/add-raf-agent-run-4.1b/contracts.stdout.json`) містить чотири ENOENT raf-main-a; він є джерелом дефекту, а не нашим red.

Власний red: `4dcbe1be-569d-4d38-9111-ae0ef494ca85`, CLI/child 1, assertions-failed: 12 passed, 2 knownRed, unexecuted/unknown 0, timedOut false, cleanup complete, groupState idle, nextAction implement. [Повний незмінений TestRunResult](red.stdout.json), [stderr](red.stderr), [CLI code](red.cli-exit-code), [точна команда й capture boundary](red.metadata.json), [SHA/незакомічений diff/fingerprints](red.workspace.json).

Виправлення: prepareProductionQaFixture очікує спільний prepareMainLayoutForProductionStart; той готує protected production Git store, а потім configured mainCopies. Відмови writer barrier залишаються чинними.

Власний QA green: `4535ba11-fbc4-41e6-92d8-425645828789`, CLI/child 0, 14 passed, knownRed/unexecuted/unknown 0, timedOut false, cleanup complete, groupState complete, nextAction complete. [Повний незмінений TestRunResult](qa.stdout.json), [stderr](qa.stderr), [CLI code](qa.cli-exit-code), [команда й capture boundary](qa.metadata.json), [SHA/diff/fingerprints](qa.workspace.json). Обидва прогони: group switch-raf-main-by-symlink/production-start-layout, files test/production-start-layout.test.ts, однаковий QA HOME й агрегат. Нові регресії перевіряють готовність копій до entry callback, очікування незавершеної конвертації та propagation відмови store.

Перша спроба red не дійшла до CLI через sandbox quota: [незмінений результат інструмента](red.unavailable.json), [sandbox stderr](red.sandbox-stderr). Це не red. Main підтвердив усунення quota й відновлення codex-daemon-1000; після цього виконано один повтор, який дав власний assertion red.

Інструмент об'єднує stdout/stderr. У кожному merged-output збережено первісний повний вивід; перший LF-завершений JSON є TestRunResult без змін, другий — логічний stderr launch-queue.waiting. Побайтова приналежність native streams недоступна; метод та обмеження явно записані в metadata.

Межа автоматичного доказу: unit використовує віртуальні filesystem/Git/store/layout порти. Він доводить порядок підготовки, але не реальну Git-конвертацію, native runner, два switch чи handover. Чужу unit-групу add-raf-agent-run/contracts не запускали: item7.2 не містить regressionGroups grant. Чотири production-runtime сценарії після виправлення цим доказом не оголошено зеленими. Live-частина 7.2 лишається відкритою; main надав канал виконання закоміченого скрипту на чистому клоні.
