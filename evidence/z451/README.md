# Z.451: запис реєстру тестів

Аудит підтвердив актуальність Z.451: до виправлення deriveTaskContext не передавав виконавцям conf/test-runs.json. Джерела: complete-raf-flow-contracts/tasks.md Z.451, proposal.md Why/What Changes; audit-process-rules/tasks.md 1.13, 1.16; delta agent-adapters «Недоступність хостових ресурсів із codex», «Збереження дозволів codex при відкритті IPC». Нових вимог, таймаутів чи валідацій не додано.

Виправлення додає точний root/conf/test-runs.json до writeBoundaries для test-scaffold, implement, qa, hotfix незалежно від project та archive scope. Чинні bindWorkspaceBoundaries/assignment/runtime передають ці межі runner. Політика Codex отримує writableFiles та exact-file bind; conf і корінь Orchestrator не стають writable. Заборона secrets.json збережена. Чинні правила координації спільного реєстру залишаються застосовними.

Регресія: 8 комбінацій ролі/проєкту з обома archive scopes, незмінна read-only поведінка spec/design, побудова Codex policy з точним bind та synthetic secrets deny. Це ізольовані unit-перевірки, не запуск живих AI runners.

Команди: red.command.txt, hotfix.command.txt. В обох прогонах та сама група complete-raf-flow-contracts/z451, файл і QA HOME/state; фазою/SHA бюджет не скидався. Повні незмінені JSON: red.TestRunResult.json, hotfix.TestRunResult.json. Окремо збережені stderr, CLI exit code і tool-result. Transport повертає stdout, потім stderr; перший завершений JSON-рядок stdout відокремлено без переформатування. Child exitCode міститься в самому TestRunResult.

Red cec7739e-d3a7-4106-9a97-9151a007734c: assertions-failed, 2 passed / 9 knownRed, CLI/child 1/1; без setup failure. Hotfix 2a2c2aba-2ec6-4c74-af8a-b99b01eb3082: passed, 11 passed / 0 knownRed, CLI/child 0/0. Обидва: timeoutCount 0, timedOut false, cleanup complete, unknown/unexecuted 0. Фінально groupState complete, nextAction complete. Деталі: summary.json.

SHA, стан спільного дерева та hash тесту перед кожним прогоном: red-workspace.json, hotfix-workspace.json. Продуктова різниця: hotfix-workspace.patch; red-workspace.patch порожній. Початкова версія тесту з перевіреним SHA-256: red-test-source.txt. Між red і hotfix виправлено лише підготовку synthetic secrets fixture: адаптер визначає home через passwd userInfo, не HOME; додано mock та наявний synthetic файл, очікування assertions незмінні (fixture-correction.patch).

Main підтвердив реєстрацію групи й відсутність іншого редактора src/task-context.ts повідомленням у цій сесії. Два вихідні agent message отримали HANDLER_FAILED / Recipient composer contains unrelated input, CLI 1, completed/pending []; доставку результату через них не підтверджено. Передача результату — атомарний JSON за report_path. Інших виконавців та чужі файли не змінено. 10 задач зміни залишалися відкритими під час перевірки; tasks.md не редагувався, archive не виконувався. Активацію виконує main; поточна сесія не одержує нові права ретроактивно.
