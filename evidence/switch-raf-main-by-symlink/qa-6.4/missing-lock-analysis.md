# Незавершений дефект native sandbox: відсутні Git lock-файли

Пункт switch-raf-main-by-symlink:6.4 не пройшов. Вимоги актуальні: агент має комітити власну роботу, а protected activation metadata та чужі endpoints мають залишатися недоступними для запису. Нові RAF-команди не належать до цієї зміни (proposal Non-goals). Підтвердження успіху або зміна flow без реалізації неприпустимі.

## Встановлені факти

- Raw live5 reviewed43eb3dd7: `host-setup-43eb3dd7/git-23.json` — host Git checkout128, index.lock вже існує. В agent policy `sym64-a-final/run/codex-sandbox-c3219779-f017-4818-b94c-68dea8729ef5/policy.json` є explicit read для common/index.lock, HEAD.lock, config.worktree та інших відсутніх файлів. Stat host index.lock: size0, mode0444, birth/mtime2026-10-25T02:09:13.446919262Z. Агент не видаляв lock.
- Це продовження дефекту live4: pruning43eb3dd7 прибрав redundant descendants усередині повністю read-only worktree directory, але common Git directory лишається writable для законних developer commits. Missing file mounts під таким parent створюють host mountpoints.
- Новий assertion-red `4da8714a-783b-45c2-a482-96b074198062` підтверджує explicit read для відсутнього index.lock. Повні результат, merged output, CLI/child і patch — `missing-mount-red.*`. Цей assertion перевіряє необхідну умову безпечного policy compilation, але сам не доводить достатній захист від створення lock агентом.
- Обидва справжні live Codex дійшли лише до stage0. Перемикання, message/ps після switch, negative probes та after-controls не виконані. Mock/unit не замінюють цього доказу.

## Оцінені варіанти (не впроваджені)

| Варіант | Чому не прийнятий як фікс |
| --- | --- |
| Пропустити відсутні read grants | Під writable parent агент може сам створити protected lock. Це послаблює захист, навіть якщо existing main ref лишається read-only. |
| Parent read-only із writable bind існуючого develop ref | Git потребує створити develop.lock і атомарно перейменувати його в develop; read-only parent або bind mount destination блокує цю операцію. Root Orchestrator index може бути writable, але commits raf-develop втрачаються. |
| tmpfs/tmp-overlay parent | Атомарний rename можливий у private view, але refs commits не потрапляють до host repository. Безпечного зворотного merge Git metadata з конкурентними writers не реалізовано. |
| Overlay із реальним Git parent як writable upper | Linux не дозволяє спільні/перекривні upper/work для конкурентних mounts; зовнішні зміни underlying filesystem під mounted overlay мають undefined behavior. У сценарії одночасно працюють два агенти й host робить Git switch. |
| Перевірити відсутні locks після виходу та видалити нові | Виявлення відбувається вже після host-side effect. Початкова відсутність не доводить автора файла: host Git може законно створити lock паралельно. Видалення невідомого lock порушує parallel-development; лише відмова не прибирає блокування host Git. |

Primary для overlay: [Linux OverlayFS: Sharing and copying layers](https://docs.kernel.org/filesystems/overlayfs.html#sharing-and-copying-layers), [Changes to underlying filesystems](https://docs.kernel.org/filesystems/overlayfs.html#changes-to-underlying-filesystems). Local bwrap0.11.1 man page також визначає private writes tmp-overlay та same-filesystem workdir для writable overlay. Ці обмеження перевірені за документацією; overlay runtime-експеримент у робочому репозиторії не проводився.

## Результат

Перевіреного вузького продуктового фіксу, який одночасно тримає всі чинні вимоги, немає. Новий trusted Git channel/новий syscall mediation backend не вигадується в межах QA. Main явно дозволив failed із red та описом компромісу, якщо розглянуті варіанти не тримають контракт. Product code після43eb3dd7 тут не послаблювався. Unresolved lock-red лишається в тому самому агрегаті qa64-trust-fixture та HOME. Потрібне рішення щодо механізму enforcement, після його реалізації — QA тієї самої групи та повний live stand; це не запропонована заміна виправлення чи фіктивний pass. Tasks.md не змінювався, 6.4 лишається відкритим, archive не виконується.
