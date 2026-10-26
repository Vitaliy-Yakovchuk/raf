# Z.454 — компактний публічний agent ps

Аудит чинності: доручення відповідає канонічній вимозі «Перелік активних сесій» у openspec/specs/projects/raf/agent-ps/spec.md: усі активні адреси, типи, проєкти, фічі й фази після звірки процесів. Внутрішні launch settings не належать до переліку. Суперечностей не знайдено. Main підтвердив відсутність відомих перетинів src/app-runtime.ts повідомленням у цій сесії.

Публічний handler формує окреме подання: без launchContext/modelHandoff і повного evidence.command у process, worker та observation.identity. Зберігає інші поля, зокрема activity, процесні ID, boot/machine/tmux evidence, діагностику reconciliation/resultNotice. Внутрішній control.ps, persisted identity, scanner, права й порядок reconciliation не змінено. Немає slice/truncation, ліміту агентів, розміру відповіді або нового таймауту.

## Test-first

- [Точні команди, CLI/child codes, runId](runs.json); [SHA й незакомічені власні зміни](workspace.json).
- [Повний red TestRunResult](red.stdout.json), [stderr](red.stderr.txt), [CLI exit](red.cli-exit.txt), [незмінений результат інструмента](red.tool-result.json): 570f824c-7aac-4901-a9c4-4e52eae6cdee; assertions-failed, CLI/child 1; три knownRed на витоку settings, залежності відповіді від їхнього розміру й process.evidence.command. Це assertions, не setup/import failure. groupState=idle, nextAction=implement.
- [Повний hotfix TestRunResult](hotfix.stdout.json), [stderr](hotfix.stderr.txt), [CLI exit](hotfix.cli-exit.txt), [незмінений результат інструмента](hotfix.tool-result.json): 7d103869-780e-4985-9c7c-b93eb5df5483; passed 93, CLI/child 0; knownRed/unexecuted/unknown порожні, groupState=complete, nextAction=complete.
- Обидві фази: complete-raf-flow-contracts/z454, один і той самий ізольований QA HOME/state, timeoutCount=0, timedOut=false, cleanup.complete=true, remainingPids=[]; агрегат не скидався. Додані до green списку наявні app-runtime/agent-control перевіряють збереження dispatch/reconcile/ownership поведінки.
- Новий unit перевіряє 0, 1, 32, 256 сесій, UTF-8/escaped control characters, settings понад 64 KiB, незмінність вихідних identity, pending/unknown/exited. Порівнює повні відповіді для коротких і довгих settings та JSON.parse усієї відповіді, зокрема коли сам список перевищує 64 KiB.
- [Build і check:comments](build-and-comments.jsonl): обидва exit 0 в тому самому ізольованому QA HOME. git diff --check — 0.

JSON TestRunResult збережено повністю. Поля diagnosticSummary.truncated/diagnostics[].truncated у red — штатне обрізання лише тексту великих assertion diagnostics самим runner; це не обрізаний JSON результату. Оригінальний merged tool output також збережений; перший рядок — stdout JSON, наступні рядки — stderr.

Inventory попереджає про новий явний файл; чинний канал допускає його без реєстрації. Службова команда використовує довірений production wrapper, а тестовий child — QA HOME з command.environment; warnings wrapper не означають виконання тестів на production state. Часткова атрибуція resourceUsage не видається за повний CPU/disk профіль.

Живий виклик до виправлення через виданий agent ps мав CLI 0, але інструмент повідомив 215871 токенів і обрізав транспортне відображення. Це додаткове спостереження, не JSON-доказ pass; повний working-state ps із чужими launch settings не зберігався у Git. Нове покоління не активовано: публікація належить main, поточне доручення завершується перевіреним кодом hotfix.

tasks.md не змінено; галочку Z.454 ставить raf після succeeded. Інші задачі зміни відкриті, тому sync/archive не застосовуються.
