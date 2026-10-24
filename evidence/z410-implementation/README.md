# Z.410.1 — відновлення успадкованого inFlight

На raf-develop `3452c7504cc3aee003a24f9a4b4f59dbd2f0cc66` група `complete-raf-flow-contracts/z410` пройшла 23/23. RunId: `972ec07b-b420-4e86-a10e-0a77a7a29e03`, CLI/child: 0/0; timeout=false, cleanup.complete=true, remainingPids=[], knownRed/unexecuted/unknown=[], timeoutCount=0, groupState/nextAction=complete.

[Повний незмінений TestRunResult/stdout](implement.stdout.json), [stderr](implement.stderr.txt) (порожній), [окремий код CLI](implement.cli.json), [повна відповідь інструмента](implement.tool-result.json), [контекст, SHA, команда й обмеження](summary.json), [build](build.txt). Інструмент повернув лише один JSON без stderr чи урізання; оригінальні байти stdout збережено.

Команда дозволеного каналу:

```text
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/b72b9cb2-1336-49c8-af1e-6e31c663eefb/raf-main/bin/raf.ts test run --project raf --phase implement --group complete-raf-flow-contracts/z410 --files test/test-run-legacy-in-flight.test.ts
```

Legacy-виключення застосовується лише за відсутніх ownerIdentity/wrapperIdentity, звіреної processIdentity, підтверджено мертвого дерева та досягнутого збереженого deadline. Живий owner, живе/невідоме дерево, PID reuse, відсутня чи інша identity не дають cleanup/release. Явна owner identity зберігає попередні перевірки. Cleanup і release fence передують звільненню inFlight; результат і timeoutCount зберігаються ідемпотентно. Мертве дерево з невідомим часом завершення не створює фіктивного timeout. Відмова GROUP_IN_FLIGHT містить початкові runId/deadlineMs/processIdentity.

Початкову реалізацію завершено без читання підготовлених тестів; потім прочитано test/test-run-legacy-in-flight.test.ts. Тести та assertions не змінювалися. `npm run build` (включно з comment policy) і `git diff --check` успішні.

Попередній red: [збережений main результат](/srv/dev/work/orchestrator/openspec/changes/complete-raf-flow-contracts/z410-scaffold/red-724290e.json), runId `31ecd90f-9eee-49b0-9460-dd8ea07eab54`, 10 knownRed / 13 passed. Група, HOME, SQLite-агрегат і бюджет не змінювалися й не скидалися. Зафіксовані межі стану workspace — у summary.json: до commit лише власні src-правки, після unit tracked tree чистий, з'явився чужий untracked helper (час появи не встановлений), його не читав/не змінював/не комітив.

Це реалізація й цільова unit-перевірка Z.410.1. Z.410.2, регресії recovery та живий повтор qa 6.8.2 після перенесення raf залишаються наступному виконавцю. Інші групи не запускалися; архівація не застосовується через відкриті пункти. tasks.md не змінювався: галочку Z.410.1 ставить raf за прийнятим JSON.
