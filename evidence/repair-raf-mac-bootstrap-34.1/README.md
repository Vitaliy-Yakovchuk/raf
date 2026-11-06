# repair-raf-mac-bootstrap:34.1

Локальна реалізація в спільній гілці hotfix; push/створення mac-test-run-home та активація — main за прямим повідомленням власника. Вихідна база ef357ecf13da9104fddc8c1983094dfc26e1872f. RED закомічено окремо: 22f32d6de3e5a9255b4db1d4fe5560c94dc7915f.

Перенесено призначення 810dc384, d75ad98c, 2768f21e, dbaf36e8 з origin/mac, без заміни новішого runtime: нативні sysctl/ps Darwin, UTC start/boot, fenced reservation RSS, process-group/нащадки та cleanup/reconcile. Linux /proc-поведінка збережена. Передумова — нормалізація resource-wait Darwin identities (наявна в origin/mac до цих чотирьох комітів); новіший verifyWaitPeer/warning timer з поточної бази збережені. У shared hotfix також бракувало canonical /tmp HOME; перенесено мінімальні два owner-expression із доступних origin/mac 39a4f227/f8328d66. Точні OID і SHA256 усіх фінальних вихідних файлів — source-manifest.json. Однорядкова адаптація recovery-host підтримує адресу його підміни після canonical /tmp.

## Перевірки

Усі зовнішні перевірки direct, зі сталим приватним HOME=/tmp/raf-q7-rrmb-34-1-qa; capture-check.py зберігає повні stdout/stderr, окремий process exit code, точний argv, SHA, dirty-state та binary diff у <label>.*. Обрізаний показ інструмента не обрізав файли доказів. Не створювався і не заявляється managed TestRunResult для direct-команд: пункт34.1 прямо забороняє raf test run до відновлення Mac каналу. Run/session ID: q7-rrmb-34-1, запуск 3db1e541-c9d9-489e-b714-8e99c210d4bb. Група repair-raf-mac-bootstrap/darwin-process зареєстрована, managed aggregate не створювався/не скидався; registry-handoff.json та tasks-handoff.md передають запис main (коміт спільного conf — main).

| Доказ | Команда/відбір | Результат |
|---|---|---|
| red.* та red.test-source.txt | node --test --test-name-pattern Darwin\ wrapper test/test-run-darwin-process.test.ts (точний argv у JSON) | exit1: assertion Linux /proc identity замість native Darwin, до фіксу |
| home-alias-red.* | alias /tmp regression, точний argv у JSON | exit1: assertion owner неканонічний, до фіксу |
| build.* | npm run build | exit0 |
| final-targeted.* | node --test test/test-run-darwin-process.test.ts test/test-run-home-canonical.test.ts test/test-run-unit-state-upgrade.test.ts test/test-run-socket-path.test.ts | exit0, 14 pass, 2 Darwin-only skip |
| final-linux-process.* | node --test: process-liveness-z448, reservations, state-recovery, sandbox-test-run, resource-wait-service-stop-host | exit0, 198 pass |
| baseline-comparison.json | додатковий широкий набір та база ef357ec | не GREEN: початково 250 pass/19 fail; шість broker/resource-wait падінь відтворені на базі; recovery reruns мають однакові 14 fail/1 pass на базі й кандидатові |

Уточнення лічильника recovery: 15 — загальна кількість сценаріїв, із них 14 падають, один проходить. Початковий широкий прогін до відновлення підміни recovery-host мав 13 recovery-падінь; integration-refused із того прогону проходить у двох повторних стендах, тоді як normal-unit/integration-passed відмовляють в обох. Причини/стектрейси збережені повністю; це обмежує перевіреність recovery-сценаріїв, а не є доказом їх pass. Додаткових фіксів цих сторонніх проблем не внесено.

Підготовчі невдалі запуски також збережені: home-baseline (fixture бракував runId, виправлено до змістовного RED), baseline-failure-qualification (невдале створення snapshot), baseline-host (непобудований dist). Вони не зараховані як RED чи pass; baseline-build і наступні прогони виправили підготовку. База — окремий git archive із ef357ec, приватна копія conf та ізольований HOME; baseline-source.json пояснює технічний metadata HEAD snapshot.

Socket regression містить 5 повних незмінених TestRunResult внутрішнього ізольованого стенда: final-socket-stand/result-index.json дає runId, команду, SHA, відбір, cleanup/timeout, knownRed/unexecuted/unknown, aggregate/nextAction та окремі CLI/child exitCode. Чотири passed, один expected refused при одночасному виклику тієї самої групи. Усі JSON, stderr і cleanup-before/after збережено. Це внутрішні fixture-виклики, не managed прогін дорученої групи. Unknown cleanup/selection не перетворено на pass.

На Linux native Darwin timezone/scan тести пропущені; mocked Darwin перевіряє UTC/sysctl/ps без procfs, PID/boot fencing, RSS, групу та нащадків, zombie/відсутній процес і unknown scan. Native Linux runtime перевірив справжнє detached дерево та cleanup. Жодного standalone таймауту не додано.

Далі main комітить спільний реєстр/нотатки tasks, створює та пушить origin/mac-test-run-home без force; Mac main виконує RED update-rollout-service/feed-server. Native Mac execution тут не заявляється. Checkbox34.1 не змінено виконавцем; інші відкриті пункти не виконувались, archive не застосовується.
