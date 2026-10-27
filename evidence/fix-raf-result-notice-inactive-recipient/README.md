# fix-raf-result-notice-inactive-recipient:1.1

Виконано за test-first. Група незмінна: `fix-raf-result-notice-inactive-recipient/inactive-recipient`. QA HOME усіх child-прогонів: `/tmp/raf-unit-1000/1ee10007bf6d5e71b39d6a2873064a767eeb928e7910599b166a0d60270ff685`. Робочу SQLite тести не використовували.

## Аудит

Задача актуальна: proposal.md описує безкінечні спроби для завершеного отримувача. Чинний `openspec/specs/projects/orchestrator/agent-activity/spec.md:71` вимагає повтору «доки доставка можлива» та видимості причини й адресата без переадресації. Завершений або видалений pinned run більше не може отримати повідомлення. Running/reserved отримувач і ще не прив'язаний main залишаються retryable. `skip_specs: true`; нових вимог, лімітів, таймаутів і міграцій немає.

## Реалізація

`resultNotices.complete` після невдалої спроби визначає стан pinned run у тій самій транзакції. Якщо його вже немає або він exited/finished, запис стає `undelivered` із причиною. Claim вибирає лише pending, тому наступні settle не повторюють спробу. Наявні pending проходять той самий шлях зі збереженням attempts. `resultNoticeViews` показує terminal undelivered, навіть після retention вихідної сесії. Guard проти повторного вставлення повідомлення не заважає закриттю після завершення отримувача.

Для перевірки ширшої сумісності виправлено дві застарілі тестові фікстури: підмінений process table тепер обслуговує і targeted /proc stat та ps -p; migration fixture походить від pinned schema-10 client (існуючий state-migration-fixture), видалення лише result_notices відновлює schema 9. Перевірки повторної доставки живим агентам збережено, перевірка збереження сесії після міграції посилена до deepEqual.

## Прогони

Повні незмінені TestRunResult, stderr, CLI exit code та точні команди збережено окремими файлами `<name>.stdout.json`, `.stderr`, `.cli-exit-code`, `.command.txt`. `run-index.json` містить runId, selection, outcome, cleanup, timeout, knownRed/unexecuted/unknown, group state, nextAction та SHA256 повних результатів. CLI code не підміняє child exitCode.

- `red`: b9bb3ca1-477d-408e-97d8-d04883397099, assertions-failed: 3 pass, 5 red. Початковий HEAD bd94f0c5ddda9f30446ac82006de20dbabdec532; власна незакомічена зміна лише новий тест (відтворена без змін із першого коміту в red.workspace.patch). Production fix тоді відсутній. У спільному дереві також були сторонні незакомічені bug-fixture/bug-test.
- `hotfix-1`: ddfe161d-d472-4bf3-867e-15d48b9309a6, 20 pass, 4 red старих фікстур; нові 8 регресій пройшли. Setup/import failure не видавався за red.
- `selection-refusal`: 8d3d0aa4-fb5a-4a45-8945-9a384f6a0cad, refused SELECTION_CONFLICT (--files разом із --only); child не запускався. Наступні діагностики використовували лише --only. Агрегат не скидався.
- `hotfix-live-diagnostic-1..4`: адресні невдалі assertion-прогони живого coordinator. Четвертий довів, що фікстура спочатку бачила alive через ps, а потім помилково exited через реальний /proc для вигаданого PID. Третій diagnostic payload обрізано самим runner-ом; він не є pass і збережений у повному отриманому TestRunResult.
- `hotfix-2`: 8e7cbf9f-d718-48ec-b2fc-681c5d563879, 24/24 passed, group complete. Це розширена група після виправлення фікстур.
- `red-pasted`: 0a0a74e1-94d2-4ab6-8855-07f97fae7999, 24 pass + 1 assertion red для вже вставленого повідомлення завершеному отримувачу. HEAD і точний незакомічений patch збережено в red-pasted.head.txt та red-pasted.workspace.patch.
- `hotfix-final`: d56a9b7a-ec4f-4052-9cf0-96c17e1297e5, **25/25 passed**, CLI 0, child 0, group complete, nextAction complete, timeoutCount 0, timedOut false, cleanup.complete true, remainingPids [], knownRed/unexecuted/unknown []. Точний HEAD перед викликом, повний git status, SHA256 вихідних файлів і незакомічений адресний patch — hotfix-final.workspace.json та hotfix-final.workspace.patch. Спільний HEAD міг рухатись через коміти інших виконавців; hashes фіксують власний перевірений код.

Для проміжних діагностичних прогонів точний тодішній HEAD не знято; його не вигадано. Їхні повні результати і незмінна група збережені, фінальний успіх підтверджено окремим повним прогоном із capture workspace. Жодний timeout чи unknown не приховано. ResourceUsage має partial/unknown sampling, як прямо вказано у JSON; це не заява про повну метрологію ресурсів.

`openspec validate fix-raf-result-notice-inactive-recipient --strict --json --no-interactive` пройшов (exit 0, valid true, INFO skip_specs zero deltas accepted). `git diff --check` пройшов. Галочку 1.1 ставить raf після succeeded; виконавець tasks.md не редагує.
