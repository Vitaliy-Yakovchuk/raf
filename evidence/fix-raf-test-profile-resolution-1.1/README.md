# fix-raf-test-profile-resolution:1.1 — група запускалась з argv чужого профілю

## Механізм

`planTestRun` (`src/test-runs.ts`) визначав профіль правильно: для `--files app/tools/live-stack/live-stack.test.ts` єдиний unit-профіль з цим файлом в інвентарі — `vitest-app-tools`, і `plan.profileId`/`plan.command.argv` містили `--project tools` (у 3.7 `TestRunResult.profileId` теж `vitest-app-tools`).

Порт `spawn` у `createTestRunPorts` (`src/test-run-runtime.ts`) не брав профіль з плану, а визначав його повторно:

- якщо `project.groups[request.group]` існувала — брав профіль групи;
- інакше перебирав усі профілі всіх проєктів і брав **перший**, у якого збігались `executable`, `argv[0]` (`--import`), шлях `vitest.mjs`, суфікс `cwd` (`/app`), а `--project` порівнювався лише коли кандидат сам мав `--project`.

Для etchly першим таким кандидатом з `cwd: app` і без `--project` є `vitest-page-checks-unit`; `planVitestInvocations` будував batch з його `argv`, тобто з `--config tools/screens/page-checks.vitest.config.ts`, і Vitest відповідав «No test files found».

Умова спрацьовування — група не знайдена в `project.groups`:

- у 3.7 обидва прогони (`b73b1134…` 15:33:18Z, `84fa923f…` 15:33:43Z) відбулися до коміту реєстрації групи `dbb3c8ac89` (15:35:18Z), тобто з незареєстрованою групою та `--files`;
- зареєстрована зараз група `route-registration-to-regional-shards/smoke-tools-3-7` також пропускається валідацією (`local-mode-cases.test.ts` відсутній у `unitFiles` профілю `vitest-app-tools`, попередження «group file must belong to profile inventory; entry skipped»), тому без виправлення той самий шлях спрацьовував би й далі.

Той самий запуск 3.6 з raf-main-a проходив, бо його група вже була зареєстрована.

## Виправлення

- `src/test-runs.ts`: `TestRunPorts.spawn(command, onEvent, profile?: { project, profileId })`; `runTestRun` передає `plan.request.project` і `plan.profileId`.
- `src/test-run-reservations.ts`: обгортка `spawn` передає профіль далі.
- `src/test-run-runtime.ts`: `spawn` бере рівно профіль плану з `config.projects[project].profiles[profileId]`; евристику за argv і пошук по всіх проєктах прибрано.
- `test/hotfix-637-638.test.ts`: прямі виклики `ports.spawn` у тестах 6.3.7 передають профіль плану, як це робить `runTestRun`.

## Докази

Група `fix-raf-test-profile-resolution/profile-resolution`, профіль `node`, файли `test/test-run-profile-resolution.test.ts test/hotfix-637-638.test.ts`. Тест будує план на реальному `conf/test-runs.json` (etchly), викликає справжній `createTestRunPorts(...).spawn` з підміненим `child_process.spawn` і перевіряє `RAF_TEST_RUN_VITEST_BATCHES`.

- `unit-red.json` — runId `c021b99f-4b0d-4f3f-82c8-dfd32e9e5df1`, `--phase red --files test/test-run-profile-resolution.test.ts`, незмінений `src/` (HEAD a3ca75f8): `assertions-failed`, child exit 1, CLI 1; knownRed — «an unregistered etchly tools group with --files runs exactly the argv of its own profile» (фактичний argv містив `--config tools/screens/page-checks.vitest.config.ts` замість `--project tools`); два інші тести passed; cleanup complete, timedOut false.
- `unit-green.json` — runId `1753edfd-9a7b-4062-b288-ce0684967362`, `--phase hotfix`, робоче дерево з виправленням: passed 3/3, exit 0, CLI 0, groupState complete.
- `unit-green-both-files.json` — runId `623dbbb7-682b-4bc0-b54f-498660486a76`, `--phase hotfix --files` обидва файли групи: passed 13/13, exit 0, CLI 0, groupState complete.
- `unit-green-committed.json` — runId `92c54826-bfe9-44f1-b45f-d49a2035dd66`, `--phase hotfix` налаштованою групою на закоміченому коді b5a75259: passed 13/13, exit 0, CLI 0, knownRed/unexecuted/unknown 0, groupState complete, nextAction complete.

Регресії test-run:

- `unit-green-extended.json` — runId `ae219661-aeec-4bfc-9d8a-cc324c343179`, `--phase hotfix`, та сама група з `--files`, розширеним сусідніми suites test-run (`test-runs`, `test-run-reservations`, `test-run-etchly-profiles`, `test-run-protocol-size`, `z442-etchly-inventory-warning`, `test-run-vitest-pattern-z456`, `test-run-integration-runtime`, `sandbox-test-run`, `test-run-cli`, `test-run-etchly-integration`), закомічений код b5a75259: passed 507 у 12 файлах, exit 0, CLI 0, knownRed/unexecuted/unknown 0, groupState complete. `z442-etchly-inventory-warning.test.ts` на момент прогону був явним незареєстрованим файлом (попередження «unit inventory differs; unexpected»); далі додано до інвентаря `node` і до групи.
- `regression-timeout-warnings.json` — runId `49e84728-cb3e-479f-bf44-6e1bef9fc1f0`, налаштована група іншої зміни `audit-process-rules/timeout-warnings` (`--phase hotfix`): `timed-out` через 1 200 с, виконано лише `timeout-warning-regression` і `message-delivery-draft-z449` (19 passed), 2 unexecuted у `initial-brief-delivery.test.ts`, knownRed 0, cleanup complete; агрегат групи вже мав timeoutCount 2 до цього прогону (тепер 3, groupState unverified-remainder). Залишок групи (`launch-wrapper`, `agent-adapter-readiness`, …) не стосується `test-run`; `test-run-integration-runtime.test.ts` з цієї групи пройшов у `unit-green-extended.json`.

stderr усіх прогонів — лише попередження валідації conf (п'ять etchly-груп з файлами поза інвентарем) і `Dash refused …`; він виводився в термінал виконавця й окремо не збережений, `TestRunResult` повні. Реєстрацію групи та файлу в `conf/test-runs.json` raf закомітив автоматично (`conf: agent test group registrations (auto)`).

Локально (ізольований HOME): `node --test` 12 suites test-run (`test-run-profile-resolution`, `hotfix-637-638`, `test-run-protocol-size`, `z442-etchly-inventory-warning`, `test-run-etchly-profiles`, `test-runs`, `test-run-reservations`, `test-run-vitest-pattern-z456`, `test-run-cli`, `test-run-etchly-integration`, `test-run-integration-runtime`, `sandbox-test-run`) — 508 passed, 0 failed; `node scripts/check-comments.ts` — exit 0. `tsc` у дереві недоступний (`node_modules/.bin/tsc` вказує на відсутній `lib/tsc.js`), typecheck не виконано.
