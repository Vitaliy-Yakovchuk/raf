# add-raf-test-run:6.7

Виправлення `b5f363589ef337e58767e3cf15158aa7064acd9d` викликає `spawnFailed` для помилок підготовки до підтвердженого OS spawn. Це дозволяє звільнити ресурс і `group.inFlight` після ENOENT без скидання бюджету групи. Після успішного spawn помилки залишають попередній захист невідомого дерева.

- Цільовий red: чистий host-клон `5e1b200af16129d2e2ee468d9db93e05f18d2490`, 12 тестів, 11 passed / 1 failed, CLI 1. Падає саме `cleanup.complete` після підтвердженого ENOENT без child.
- Green: чистий host-клон `b5f363589ef337e58767e3cf15158aa7064acd9d`, 12/12 passed, CLI 0, stderr порожній. Перевірено повтор тієї самої групи з фазою hotfix, іншим agent/SHA та збереженим timeoutCount.
- Main виконав host-прогони за явним повідомленням у цій сесії через несправний hotfix-канал (відкрита 6.5). Власні виклики `raf test run` red/hotfix зберігають стабільну групу `add-raf-test-run/setup-reservation`; обидва refused до unit-запуску. Ці відмови та початковий нецільовий host-red не є red/pass.
- Синтаксис, `git diff --check`, build/comment policy — код 0. Повна перевірка типів недоступна через відсутній `@types/node` (TS2688).

Повні незмінені JSON результатів, stdout/stderr/коди, команди, SHA, межі host-доказу та хеші файлів наведено в [verification.json](verification.json). Host node --test не створює TestRunResult; runId чи стан постійного агрегату для нього не вигадано.

Старий run `3163a552-987d-48da-a681-a5622f022384` перевірено лише на реконструйованій копії групи з двох наданих JSON. Claim snapshot недоступний. Невідоме дерево з null identity не звільняється лише через deadline; цей safety-сценарій passed. Production HOME не читався й не змінювався. [Пропозиція для main](legacy-recovery-proposal.json) описує перевірку точного claim/fence та безпечне відновлення на ізольованій копії; жодної live-операції не виконано.
