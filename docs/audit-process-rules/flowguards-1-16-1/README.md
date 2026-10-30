# audit-process-rules:1.16.1 — hotfix

Виконавець: raf-flowguards-1-16-1, 2026-10-30. Код: `010b2b5580116424529cbbf037a7d54abb23bd6f` у `/srv/dev/work/orchestrator/raf-hotfix`. Main окремо виправив каталог у `5a3eccb7ce8a9f5a23656decbbb63261e7ad8f30` (цей коміт не належить виконавцю).

Перед реалізацією перевірено proposal, пункт 1.16.1, повторний аудит 2026-10-30 та чинні вимоги test-runs («Команда unit-прогону», «Авторизація хостового unit-прогону») й agent-control («Закриття виконавця без прийнятого звіту»). На вихідному HEAD `7a8edb223d9bbb8f212c83da594cc7c4c2247d32` профільний testKind і позитивні I04 вже реалізовані; їх збережено та перевірено. PHASE_NOT_ALLOWED у src відсутній.

## Результат

- Sandbox передає відсутню phase без підстановки assignment.phase; callerPhase лишається фактичним. Remediation більше не вимагає phase/grants і не забороняє main/coordinator.
- Після підтвердженої смерті runner-а replacement-панель зберігається незалежно від звіту; закриття власного worker-а завершується. При конкурентному stop помилка transport допускається лише після підтвердженого exited тієї самої process identity. Невідома чи жива identity не маскується.
- Main у цій сесії розширив пункт на baseline-падіння close: «Спершу перевір baseline на HEAD до твоїх змін: що падає й там — теж виправляй тут ... мета — група без knownRed».
- Виправлено помилки тестів: fixture фіналізує через closeSessionInTransaction із timestamp; заміна process identity завершує старий run, не сигналячи новому; cleanup перевіряє власний run-каталог, а не видалення спільних runtime-каталогів. Старий Z439 вимагав скасованої report-gate відмови; тепер перевіряє failed, cleanup власного worker-а й збереження replacement-панелі.

## Незмінна група і прогони

Група: `audit-process-rules/flowguards-1-16-1`; явні файли, без зміни QA HOME чи скидання агрегату. Команди, SHA/dirty paths, CLI exit та child exit збережено в `*.cli.json`. Повні незмінені TestRunResult — `*.result.json`, попередження stderr — `*.stderr.txt`. Інструмент повертає комбінований вивід: перший JSON-рядок відділено від наступних warning-рядків, без редагування JSON.

| Доказ | runId | Результат |
| --- | --- | --- |
| red | 8da7ca2e-462a-4137-b703-713304344c65 | 4 assertion failures: omitted phase implement/qa/hotfix та застаріла remediation; setup не підміняє red |
| hotfix-incomplete.transport.json | невідомий через обрізаний JSON | CLI 1, вивід інструмента обрізано; НЕ pass, child exit/агрегат не встановлено |
| hotfix | 50bdd3ee-48cb-4247-aae0-728f8460ac09 | 228 passed, 12 close knownRed; повний результат після діагностики обрізання |
| baseline | a4e04c57-43f0-485b-b300-670773f24527 | red на чистому вихідному HEAD: 225 passed, ті ж 12 close knownRed; власний patch тимчасово знято та відновлено |
| hotfix-close | e79fba7c-64c7-4bf5-9f53-77381efdd4e1 | 239 passed, 1 застарілий Z439 assertion |
| final | 68afc1ef-3ccf-4014-a11d-b93af656fb66 | 240 passed, CLI 0, child exitCode 0, knownRed/unexecuted/unknown порожні, complete/complete |

У всіх повних результатах timedOut=false, cleanup.complete=true, remainingPids=[], timeoutCount=0. Фінальний removed містить лише стару назву Z439; замінний тест виконався успішно в тому самому файлі, тест не вилучено з відбору. Фінальний SHA було закомічено після прогону без подальших змін коду; точний patch у tested-code.patch. Вихідний untracked node_modules не змінювався й не комітився.

Фінальна команда:

```sh
node /srv/dev/work/orchestrator/raf-main/bin/raf.ts test run --project raf --phase hotfix --group audit-process-rules/flowguards-1-16-1 --files test/sandbox-test-run.test.ts test/test-run-integration-profiles.test.ts test/agent-close-report-gate.test.ts test/agent-close-exit.test.ts test/cli-catalog.test.ts
```

Інші пункти audit-process-rules відкриті: tasks.md виконавцем не змінено, sync/archive не виконано. Активація main і push належать main.

Докази спочатку підготовлено в дозволеній теці зміни, але Git metadata батьківського репозиторію read-only: коміт не зміг створити `/srv/dev/work/orchestrator/.git/index.lock` (EROFS). Власні докази перенесено сюди для коміту довіреним hotfix-портом; батьківський індекс і tasks.md не змінювалися.
