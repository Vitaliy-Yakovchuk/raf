# Z.412 — права останнього виконавця на sync/archive

Виправлення в `src/task-context.ts`: якщо всі відкриті checkbox зміни належать точному вибраному набору ID і поточні описи збігаються зі snapshot, запуск отримує каталог `openspec/changes/` і лише каталоги canonical capability, для яких ця зміна має delta `spec.md`. Нефінальний запуск зберігає попередні межі. Граматика checkbox та ordinal ID відповідає встановленому OpenSpec; вкладені, ненумеровані, `*`, `+`, ordered lists, порожні й невідомі маркери не губляться. Symlink у шляху archive/delta/target відхиляється.

Батьківський `openspec/changes/` необхідний для справжнього `rename(active, archive/date-change)` і `.openspec-archive.lock`. Окремий bind активної теки зробив би її mount point і завадив rename, тому фінальна межа заміняє активні теки батьківською. Це мінімальний спільний directory bind для штатної операції; він неминуче охоплює сусідні зміни. Main прямо погодив цей компроміс. `openspec/specs/` цілком, корінь Orchestrator і `conf/` не додаються; workspace/git/question правила залишені наявним механізмам. Для `skip_specs` без delta canonical specs не додаються. Дозволи обчислюються на старті; вже запущені сесії їх автоматично не отримують.

## Unit: спочатку red, потім hotfix

Стабільна група `complete-raf-flow-contracts/z412`, профіль `node`, один QA HOME/state протягом усіх фаз. Повний реєстр команд, SHA, відбору, runId, CLI/child кодів, cleanup/timeout, knownRed/unexecuted/unknown та стану групи — [runs.json](runs.json). Кожний `*.TestRunResult.json` містить повний незмінений JSON відповіді; відповідний `*.tool.json` зберігає combined output і CLI exit code окремо від child `exitCode`. Окремий stderr каналу недоступний: `null` з поясненням, явно погодженим main. Вміст JSON звірений з combined output через JSON parsing; фінальний результат не урізаний.

- Початковий [red](red.TestRunResult.json), `081e2f1c-9693-47cc-beae-6cd306a8d6c5`: assertions-failed, 11 knownRed, 4 passed, CLI/child 1/1; це assertion red, не setup/import failure. Тест був закомічений у `2ad4b4a63cf3e2cde0d964861efe0c3ab2471204` до реалізації.
- Розширення checkbox-граматики й ordinal ID також мають окремі assertion red та hotfix у цій самій групі: `checkbox-*`, `ordinal-red`, `final-hotfix`.
- Остаточний [expanded hotfix](expanded-hotfix-passed.TestRunResult.json), `f3fb8ac9-b18d-485b-8ff6-11e050798c26`: **91 passed**, CLI/child **0/0**, knownRed/unexecuted/unknown/removed порожні, timedOut=false, cleanup.complete=true, remainingPids=[], groupState=complete, timeoutCount=0, nextAction=complete.
- Остаточний відбір одним списком `--files`: `test/task-context-final-archive.test.ts test/spec-design-commit.test.ts test/task-context-z12.test.ts test/task-context.test.ts`. Main зареєстрував додаткові файли у групі; HOME/лічильник не змінювалися. Жодної чужої групи не запускали.
- Разову відмову `SELECTION_CONFLICT` через несумісні `--files` та `--only` збережено як [selection-refused](selection-refused.TestRunResult.json); child не запускався. Подальша адресна діагностика використовувала тільки knownRed `--only`, без `--files`; це не приховано як pass.

## Узгодження старих fixtures

Main погодив зміни трьох fixture-файлів. Єдиний checkbox у старих boundary-тестах означав фінальний запуск: додано один unselected checkbox, щоб зберегти їхній первинний нефінальний сценарій. Assertions про межі та контекст не послаблені.

Після цього залишилося 13 падінь, незалежних від Z.412: production queue перевіряла вигаданий `fixture-model` за справжнім catalog і повертала `RUNNER_UNAVAILABLE` до очікуваної точки reserve (див. [queue-diagnostic](queue-diagnostic.TestRunResult.json)). У unit harness ізольовано optional `agentQueue`, як у ручній fixture сервісів spec-design; production queue не змінювали. Це усунуло 12 падінь. Останній sources-тест мав ще старі plain-path literals: чинний parser приймає code spans/links, тому два fixture-посилання оформлено backticks. Assertions залишені дослівно. [Sources diagnostic](sources-diagnostic.TestRunResult.json) чесно містить truncated diagnostic, не є pass. Остаточний expanded run підтвердив усі 91 сценарій. Точний [diff fixtures](legacy-fixtures-final.diff).

## Справжній archive у файловій пісочниці

Команда: `node evidence/z412/archive-stand.mjs evidence/z412/archive-final`.

[Стенд](archive-stand.mjs) запускає встановлений OpenSpec 1.14.3 у вкладеному `/usr/bin/bwrap`: весь `/` read-only, writable directory binds отримані безпосередньо з deriveTaskContext; HOME/TMPDIR ізольовані. Зовнішні filesystem/network обмеження зберігаються. Підготовка відсутніх каталогів відповідає production runner preparation. Результат на HEAD `79cae54acdf240bdd614cf4930d9091a5946f985` — [summary](archive-final/summary.json), passed:

1. Фінальний sync: lock + справжній rename активної теки в `2026-10-25-archive-demo-sync`, створення нової й оновлення наявної capability, active ENOENT після rename; `readPendingAgentReport` із реальною `verifyAssignmentCompletion` та справжніми `openspec list` приймає точний archived report (`agent.succeeded`).
2. Фінальний `skip_specs`: archive `2026-10-25-archive-demo-skip`, без canonical specs grant, фінальний report прийнятий.
3. Нефінальний запуск: попередні межі, справжній archive відхилено EROFS на `.openspec-archive.lock`, активна зміна лишається.
4. Для кожного режиму спроби запису сторонньої canonical capability, conf та readonly code cwd відхилені. Fixture scratch поза глобальним `/tmp`, тому tmp-дозвіл не маскує перевірку.

Кожна команда стенда має окремі stdout, stderr та result з argv/code/signal/error. Cleanup власної scratch-теки підтверджено; sandbox-процеси завершилися без timeout. Це перевірка справжнього archive і прийняття звіту, а не повний запуск Codex/перевірка production commit provenance. Unit окремо перевіряє pending до архіву та exact archived report після checkbox confirmation.

Початковий вкладений `codex sandbox` відмовляв до виконання archive через app-server socket directory mode 0700 (`native-red`); helper bwrap з повторною network namespace preparation мав NETLINK_ROUTE setup-відмову (`native-hotfix`). Ці результати збережено, вони не є red або pass. Для незалежного filesystem proof використано системний bwrap всередині незміненої зовнішньої пісочниці. Попередній `bwrap-hotfix` підтвердив sync/skip, але мав недостатньо точну перевірку відмови без наявної archive-теки; фінальний стенд створює порожню archive-теку й доводить саме відмову lock. `bwrap-verified` — проміжний успішний стенд; `archive-final` — остаточний.

## Версії та завершення

Власні коміти: тест `2ad4b4a63cf3e2cde0d964861efe0c3ab2471204`, fix/tests `749eabfc1909b9205aa1717b7e7d81968c69001a`, legacy fixtures `79cae54acdf240bdd614cf4930d9091a5946f985`; коміт цих доказів є наступним власним комітом. Спільний сторонній `fa871b1327ba51fb1f63e64339573e56802f7c6a` не належить виконавцю й не включається у report.commits. SHA та незакомічені зміни кожного unit-прогону в tool metadata; [остаточні hashes файлів](source-sha256.json), [source diff](final-source.diff), [workspace](expanded-workspace.txt). Початковий сторонній untracked `node_modules` не змінювали й не комітили.

[Build](build.result.json): exit 0, включає repository comment gate; stdout/stderr окремо. `git diff --check` успішний. [Аудит завершення](completion-audit.json): крім Z.412 лишається 132 відкритих пункти, тому виконавець не змінює tasks.md і не архівує complete-raf-flow-contracts. Succeeded JSON передається raf для відмітки лише Z.412; активацію/push виконує main.
