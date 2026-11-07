# repair-raf-mac-bootstrap:34.1 — нативна Darwin-ідентичність test run

Гілка `hotfix` (raf-hotfix), база 50197d23. Перенесено призначення комітів origin/mac 810dc384, d75ad98c, 2768f21e, dbaf36e8 на нову базу: Darwin-ідентичність і дерево процесів test run читають `ps`/`sysctl` замість `/proc`; кодування start/boot нормалізоване (`darwin-utc:` з TZ=UTC, `darwin-boot:sec:usec`) і самодостатнє у `src/test-run-darwin-process.ts` — `resource-wait-identity.ts` (лізинги) на цій базі не змінено. Linux-гілки коду без змін.

Усі прогони виконано в пісочниці виконавця (macOS Seatbelt), де `ps` і `sysctl` заборонені (`operation not permitted`, EPERM), а `/tmp` не записується. Тому Darwin-специфічні тести тут не можуть бути зелені; це не зміна коду.

- `red.*` — `node --test test/test-run-darwin-process.test.ts` до виправлення: 5/5 падають; причини `ENOENT open /proc/<pid>/stat` (testWrapperIdentity), `treeControlSupported` false, і сандбоксне `Cannot establish OS boot identity` в оракулі.
- `build.*` — `npm run build` після виправлення: exit 0 (типи й політика коментарів).
- `test-run-darwin-process.*` — після виправлення в пісочниці: 5/5 падають через заборонені `ps`/`sysctl` (EPERM), не через код. Потребує прогону поза пісочницею (Mac main).
- `test-run-home-canonical.*` — 3 pass / 2 fail; ті самі 2 падіння відтворюються на чистому HEAD 50197d23 у цій пісочниці (`The "path" argument must be of type string`), не регресія.
- `test-run-unit-state-upgrade.*` — fail: `EPERM mkdir /tmp/raf-unit-501/...` (пісочниця), те саме на чистому HEAD.
- `test-run-socket-path.*` — 2 fail: тест вимагає Linux (`expected 'linux', actual 'darwin'`), як і на origin/mac.
- `test-run-process-liveness-z448.*` — 7/7 pass (Linux-порти reconcile/cleanup).
- `test-run-cli.*` — 94/94 pass; ідентично на чистому HEAD.
- `importer-*.*`, `importers-per-file.summary.txt` — інші тести, що імпортують змінені модулі, по одному файлу.

Команди: `npm run build`; `node --test test/<file>.test.ts` з cwd raf-hotfix, node v26.12.1, typescript 6.0.3 (скопійовано з raf-main, бо npm-кеш у пісочниці недоступний).

Продовження 2026-11-05: це історичні sandbox-прогони попередньої сесії. Нативні перевірки main, locale RED → GREEN і завершення наведено в [mac-test-run-darwin-34-2](../mac-test-run-darwin-34-2/README.md).
