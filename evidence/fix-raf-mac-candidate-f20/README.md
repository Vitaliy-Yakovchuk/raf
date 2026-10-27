# fix-raf-mac-candidate-f20:1.1 — Злиття `origin/hotfix` у `origin/mac`

## Злиття та публікація `origin/mac`

- Окремий worktree: `/home/dev/.raf/tmp/771d703c-b524-4fff-b525-bd018b69acc2/mac-worktree` (поза `/srv/dev/work/orchestrator/raf-hotfix` і поза активним слотом `raf-main`, прибрано після push).
- Попередній `origin/mac` (перший батьківський коміт): `1a11e66563a14ae433bdef4bbf5dd211556213aa`
- Злитий `origin/hotfix` (другий батьківський коміт): `f20dbbbbfa8f9ad40b2414f4a70b80833d0e077f`
- Спільна база (`merge-base`): `e376ba4211c3138ce4ee27077f6e68ee7a5b3697`
- Новий merge-коміт `origin/mac`: `d17923993d42c60c6027df8c0d79232234883880` (`Merge origin/hotfix (f20dbbb) into mac preserving Darwin guards`)
- Публікація: звичайний `git push origin mac:mac` (`1a11e66..d179239  mac -> mac`, без `--force`).

## Розв'язані конфлікти

1. `src/hotfix-host.ts`:
   - Збережено Darwin-специфічні гілки `origin/mac`:
     - у Python-скрипті `reclaimDeadLock`: гілка `if sys.platform=='darwin':` із `TZ='UTC'`, перевіркою префікса `darwin-utc:` та порівнянням `ps -o lstart= -p <pid>`, поруч із `else:` для Linux/portable (`ps:` та `/proc/<pid>/stat`);
     - у `processStart`: Darwin-гілка `if (process.platform === 'darwin') return (await import('./resource-wait-identity.ts')).readWaitIdentity(pid).then(identity => identity.startedAt);` перед читанням `/proc` та fallback `ps:`;
     - у `alive(pid, start)`: Darwin-гілка з перевіркою `start.startsWith('darwin-utc:')` через `processStart(pid)` та Linux-гілка `/proc` / `ps:`;
     - у `validateReleaseWorkspace` та `withReleaseWriter`: розширений тип `'hotfix' | 'develop' | 'mac'` і перевірка канонічного шляху `raf-mac` для гілки `mac`.
   - Збережено всі hotfix-фікси з `origin/hotfix`, включно з очікуванням звільнення lock-файлу через `fs.watch` без штучного таймауту в `locked()`.
2. `evidence/fix-raf-missing-catalog-generate/README.md`:
   - Збережено повний фінальний зміст із `origin/hotfix` (включно з розділом `## Завершення`).

## Перевірка збірки та тестів

### 1. Збірка та перевірка в `mac-worktree` (`d17923993d42c60c6027df8c0d79232234883880`)
- `node scripts/build.ts`: exit `0` (`Каталог перевірено та зібрано; доступність операцій визначають їхні обробники.`).
- Unit-прогін Mac-тестів та каталогу в `mac-worktree` (`test/mac-bootstrap.test.ts`, `test/mac-release-source.test.ts`, `test/mac-state-migration.test.ts`, `test/state-migration-darwin-quiescence-z477.test.ts`, `test/os-runtime-targeted-absence-z473.test.ts`, `test/z467-main-composer.test.ts`, `test/z468-main-runner-lineage.test.ts`, `test/missing-catalog-generate.test.ts`): `pass 33`, `fail 0`, `skipped 15` (Darwin-only тести на Linux-хості).
- Unit-прогін hotfix-фіксів у `mac-worktree` (`test/launch-queue-stale-entries.test.ts`, `test/owned-process-publish-race.test.ts`, `test/brief-submission-transient-screen.test.ts`, `test/codex-host-network.test.ts`, `test/codex-test-entry.test.ts`, `test/runner-limit-midrun.test.ts`, `test/agy-signin-splash.test.ts`, `test/queue-openspec-transient.test.ts`, `test/hotfix-lock-release.test.ts`, `test/hotfix-reader-admission.test.ts`): `pass 41`, `fail 0`.

### 2. Прогін `raf test run --phase hotfix` — група `fix-raf-mac-candidate-f20/mac-unit`
- Команда:
  `node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/1a96b18f-4382-4693-8e24-e366577ff9df/raf-main/bin/raf.ts test run --project raf --phase hotfix --group fix-raf-mac-candidate-f20/mac-unit --files test/mac-state-migration.test.ts test/state-migration-darwin-quiescence-z477.test.ts test/os-runtime-targeted-absence-z473.test.ts test/z467-main-composer.test.ts test/z468-main-runner-lineage.test.ts`
- Workspace: `/srv/dev/work/orchestrator/raf-hotfix`, SHA `4338c42216ee61e9ce1e2aa8df7b2ca1e8b2eb32`, `dirtyPaths`: `["?? node_modules"]`
- `runId`: `37f8dc0f-30f4-42f7-b4ad-0c2575a28edc`
- Відбір (`selection`): `explicit_files` (`test/mac-state-migration.test.ts`, `test/state-migration-darwin-quiescence-z477.test.ts`, `test/os-runtime-targeted-absence-z473.test.ts`, `test/z467-main-composer.test.ts`, `test/z468-main-runner-lineage.test.ts`)
- CLI exit code: `0` (`mac-unit.cli-exit-code.txt`), child `exitCode`: `0`
- `outcome`: `"passed"` (28 passed, 0 failed)
- `timedOut`: `false`, `cleanup`: `{"complete":true,"remainingPids":[]}`
- `knownRed`: `[]`, `unexecuted`: `[]`, `unknown`: `[]`
- `groupState`: `"complete"`, `nextAction`: `"complete"`
- Файли доказів: `mac-unit.TestRunResult.json`, `mac-unit.stderr.txt`, `mac-unit.cli-exit-code.txt`

### 3. Прогін `raf test run --phase hotfix` — група `fix-raf-mac-candidate-f20/hotfix-fixes`
- Команда:
  `node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/1a96b18f-4382-4693-8e24-e366577ff9df/raf-main/bin/raf.ts test run --project raf --phase hotfix --group fix-raf-mac-candidate-f20/hotfix-fixes --files test/missing-catalog-generate.test.ts test/launch-queue-stale-entries.test.ts test/owned-process-publish-race.test.ts test/brief-submission-transient-screen.test.ts test/codex-host-network.test.ts test/codex-test-entry.test.ts test/runner-limit-midrun.test.ts test/agy-signin-splash.test.ts test/queue-openspec-transient.test.ts test/hotfix-lock-release.test.ts test/hotfix-reader-admission.test.ts`
- Workspace: `/srv/dev/work/orchestrator/raf-hotfix`, SHA `4338c42216ee61e9ce1e2aa8df7b2ca1e8b2eb32`, `dirtyPaths`: `["?? node_modules"]`
- `runId`: `9ae65674-9d23-4285-b628-0db36116cace`
- Відбір (`selection`): `explicit_files` (`test/missing-catalog-generate.test.ts`, `test/launch-queue-stale-entries.test.ts`, `test/owned-process-publish-race.test.ts`, `test/brief-submission-transient-screen.test.ts`, `test/codex-host-network.test.ts`, `test/codex-test-entry.test.ts`, `test/runner-limit-midrun.test.ts`, `test/agy-signin-splash.test.ts`, `test/queue-openspec-transient.test.ts`, `test/hotfix-lock-release.test.ts`, `test/hotfix-reader-admission.test.ts`)
- CLI exit code: `0` (`hotfix-fixes.cli-exit-code.txt`), child `exitCode`: `0`
- `outcome`: `"passed"` (45 passed, 0 failed)
- `timedOut`: `false`, `cleanup`: `{"complete":true,"remainingPids":[]}`
- `knownRed`: `[]`, `unexecuted`: `[]`, `unknown`: `[]`
- `groupState`: `"complete"`, `nextAction`: `"complete"`
- Файли доказів: `hotfix-fixes.TestRunResult.json`, `hotfix-fixes.stderr.txt`, `hotfix-fixes.cli-exit-code.txt`
