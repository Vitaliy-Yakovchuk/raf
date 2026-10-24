# QA switch-raf-main-by-symlink:4.4

Результат: succeeded для дорученого 4.4. Linux, Node v26.12.1, справжні тимчасові Git-репозиторії/worktrees, індекс, filesystem symlink/rename й окремі CLI-процеси. Джерело стенда — raf-develop `0a253a4f3c3fc4d0143e88b6291bd9b092e3547e` з незакоміченим виправленням intent; точний diff і dirty snapshot — [stand-7/command.json](stand-7/command.json), [stand-7/result.json](stand-7/result.json). Production не перемикалася, робочий стан не відкривався.

## Виправлення intent за test-first

Регресія з попереднього коміту `35a8720` відтворила MAIN_SLOT_BUSY: спільний hotfix engine повторно перевіряє snapshot після запису власного intent, який робить activationComplete=false. Тепер повторна перевірка під publication lock допускає лише повністю тотожний власний intent; інший intent відхиляється, handover/читачі й решта snapshot-перевірок збережені.

Команди через переданий довірений prefix:

```text
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/4eb94e37-6966-4e7a-b677-82e92951ea84/raf-main/bin/raf.ts test run --project raf --phase red --group switch-raf-main-by-symlink/release --files test/main-symlink-release.test.ts
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/4eb94e37-6966-4e7a-b677-82e92951ea84/raf-main/bin/raf.ts test run --project raf --phase qa --group switch-raf-main-by-symlink/release --files test/main-symlink-release.test.ts
```

Повні незмінені TestRunResult: [red](resumed-intent-red.json), [qa](resumed-intent-qa.json). Окремі CLI codes, command і повний tool output збережено поруч. Red runId `e00708e1-8179-4952-aa72-8b5cf1f9a1a3`: assertions-failed, CLI/child 1/1, 63 passed, один knownRed — `publication admits its own durable intent during the common engine second snapshot check`, unexecuted/unknown порожні, timeout=false, cleanup complete, groupState=idle, nextAction=implement. QA runId `7121b403-728a-49ea-b2fa-22fee5c5f2a0`: passed 64/64, CLI/child 0/0, knownRed/unexecuted/unknown порожні, timeout=false, cleanup complete, groupState=complete, nextAction=complete. Група й QA HOME з попереднього запуску збережені. Деталі — [unit summary](resumed-unit-summary.json). `npm run build` → 0.

Інтерфейс exec_command повернув об'єднаний output; незалежного stderr для простих дозволених raf-команд не надав. `.stderr.txt` явно фіксують це обмеження; stderr не вигадано. Для стендових subprocess stdout/stderr записано окремо.

## Справжній стенд

[Команда та env override](stand-7/command.json) запускають `node scripts/qa-main-symlink-release.ts evidence/switch-raf-main-by-symlink/qa-4.4/stand-7` із `RAF_SYMLINK_QA_SKIP_REFUSALS=1`. Цей прапорець лише пропускає вже прийняті build/smoke відмови. Докази gate code 37 та незмінних active fingerprint/SHA/readlink/ref/index/.gitmodules — [stand-6/result.json](stand-6/result.json), повтору цих сценаріїв не було.

Стенд завершився з кодом 0, signal=null: [exit](stand-7/exit.json), [stdout](stand-7/stdout.txt), [stderr](stand-7/stderr.txt), [повні before/after fingerprints/SHA/readlink/metadata](stand-7/result.json), [стислий аудит результату](resumed-stand-summary.json).

- Два повні A→B→A: перший develop, другий постійний hotfix; кожна публікація → 0 після тих самих реальних build/regression/CLI/service gates спільного engine. JSON gates збережено в `stand-7/all-gates/` та каталогах `*-gates/`.
- Три паралельні pinned CLI-читачі на кожен перехід: 12 процесів, усі → 0. Вони виконали CLI help до/після перемикання та дочитали другий module marker з того самого physical realpath без суміші поколінь.
- Rollback → 0 зі збереженням SQLite рядка `B-write`, без restore/downgrade.
- Справжній SIGKILL у `before-intent`, `after-intent`, `before-switch`, `after-switch`, `git-refs`, `git-index`, `after-index`: recovery та повтор recovery → 0; узгоджені старе/нове покоління й Git-метадані збережені.
- Два паралельні публікатори: коди 0/1, відмова `Stale main base: active`; сторонній індекс не переписано.
- Ідентичні foreign staged entries, включно з blob `foreign.txt`, у всіх усталених before/after. HEAD/main ref/активний gitlink/.gitmodules/readlink узгоджені. Cleanup: children=0, fixtureRemoved=true.

Storage adapter виконує справжні Git/filesystem операції; verify/activate/recover — спільний продуктовий hotfix engine. Compatibility і handover задані готовими передумовами 4.4. Живий handover і native-channel належать 5.4/6.4; цей стенд не закриває їх.

## Узгодження Z.334 і unit remainder

Дозволена source item `switch-raf-main-by-symlink:4.4` → target `complete-raf-flow-contracts/z392` уже повернула [повний TestRunResult](z392-qa.json): runId `81edfded-a65a-4cab-9f74-cdf39379b5e5`, unverified-remainder, CLI 1, child null, timeoutCount=2, knownRed/unexecuted/unknown порожні, cleanup complete, groupState=unverified-remainder, nextAction=review-remainder. Прогін не повторювався, HOME/лічильник не скидались. За core/process/unit-test-runs це дозволений неперевірений unit-залишок без відомих червоних; його не названо green і не використано замість стенда.

Наскрізний hotfix→main→develop та живі reports/межі прийняті власником Z.334 окремо: [звірка джерел](z334-reconciliation.json) посилається на recovery runId `1a9b5fd0-9812-4f17-9508-90e65e3516e1` (succeeded) та прийняті two-cycles/readers/publishers/reports з resumed live `c8722281-57a6-41e9-ba3f-96bd4cf552c8`. Невдалий worker close того live-запуску не оголошено успішним. Чужі checkbox не змінювалися.

4.3 підтверджений checkbox, контракт 4.4 актуальний і не суперечить обсягу Z.334. Власні галочки не ставилися: їх комітить raf за JSON. Інші пункти зміни відкриті, тому sync/archive не виконувалися. Викладку вже охоплює 7.1; додаткового пункту чи нового проходу QA не створено.
