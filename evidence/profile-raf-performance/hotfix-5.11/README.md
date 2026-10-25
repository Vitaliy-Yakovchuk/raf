# 5.11: стан доказів

Кандидат реалізації: `11d07f787de0ec08839a19e174774662a822a6da`. Реалізовано спільний синхронний origin-допуск, один process snapshot на прохід `agent ps`, адресне Linux-очікування, повторне використання store профілю/runtime й відкладене створення delivery claim owner. Тести не змінено. Чекбокс 5.11 не змінювався.

## Unit і перевірки

`runs.json` містить команди, runId, selection, CLI-код окремо від child exitCode, timeout/cleanup, лічильники knownRed/unexecuted/unknown, groupState і наступні дії. Кожний `stdout.json` — повний незмінений TestRunResult; `stderr.txt`, `capture-result.json` та `delivery.json` зберігаються окремо. Для частини діагностичних запусків точний тимчасовий workspace не збережено; це прямо зазначено, такі запуски не доводять green кандидата.

Авторський red 5.10 перевірено main; після окремого виправлення ізоляції 5.10.1 main підтвердив red `78561e4c-9c2e-4cc7-b8c9-f714194829fe`: 41 passed, ті самі 63 knownRed, без Controlled OS read refusal. Авторські тести перенесено main без втручання цього виконавця.

Останній власний запуск `5f1c3dbb-5831-4579-bac7-8c6c48782df9` має child 0, але CLI 1, outcome `setup-failed`, cleanup incomplete: SQLite `database is locked` під час ResourceUsageRepository.merge. Дозволений main один повтор повної групи повернув той самий runId і старий `--only`: це replay, а не новий прогін. Main завів Z.422 і заборонив повтори до його випуску. HOME та назву групи не змінювали. **Unit green наразі не підтверджено.**

`checks.json` фіксує build та check:comments exit 0 після фінального src diff. `candidate.patch` — цей diff до коміту. У shared worktree чужі зміни тестів/Z.422 не входять до власних комітів.

Чужі групи без grant не запускались; main прийняв точні команди для `profile-raf-performance/module-origin-cost` (включно з generation/origin preset) та `profile-raf-performance/agent-ps`.

## Host-серії

Новий driver `scripts/qa-runtime-verification-host.mjs` використовує чинні реальні ізольовані стенди `qa-agent-ps-comparison.mjs` та `qa-agent-run-live.mjs`. Підготовка двох native harness файлів перевіряє точні місця заміни; runtime handler не підмінюється. Як у вихідному live harness, QA entry instrumentation записує результати message і синхронізує concurrent delivery; його hashes збережено в оригінальних live доказах. До/після використовують один driver і конфігурацію. SHA, OS, конфігураційні fingerprints, кількість/розкид, навантаження, початкові/кінцеві SQLite, profile deltas та первинні CLI-помилки зберігаються.

На хості main, з поточного checkout зі скриптом, приклад серій по три повтори (число повторів експериментальне, це не поріг):

```sh
LC_ALL=C CODEX_HOME=/home/dev/.codex node scripts/qa-runtime-verification-host.mjs run 30eaf7f91d52ca7ca71e205ab35d70f4985dd852 /srv/dev/work/orchestrator/conf 3 /srv/dev/prp511-before
LC_ALL=C CODEX_HOME=/home/dev/.codex node scripts/qa-runtime-verification-host.mjs run 11d07f787de0ec08839a19e174774662a822a6da /srv/dev/work/orchestrator/conf 3 /srv/dev/prp511-after
node scripts/qa-runtime-verification-host.mjs compare /srv/dev/prp511-before/summary.json /srv/dev/prp511-after/summary.json /srv/dev/prp511-comparison
```

Каталоги output мають бути новими. Невідому команду чи запуск після помилки не повторювати. Код 1 означає помилку сценарію; код 2 означає неповні докази, навіть якщо native сценарії пройшли. Код 2 не є pass. Cleanup належить вихідним live harness; driver не вбиває чужих процесів і не видаляє стенди з доказами.

`agent ps` вимірює повний CLI/helper CPU через wait4, коли службу стенда зупинено й provider відсутній. Чинний verifier перевіряє SQLite/події/claims, первинні unknown errors і розкид; integrity verdict не замінює speed acceptance.

Для `agent run` driver записує CLI wait4, завершені self/helper profile-внески й wall окремо для першого та другого запуску (різне число живих сесій). Свіжі native стенди перевіряють справжні readiness, вузькі завдання, ownership, literal/concurrent delivery, receipts і primary refusals. **CLI wait4 не враховує весь persistent worker/tmux/service CPU. `fullRuntimeCpuMs` і `fullCpuNonIncrease` лишаються null; це не доказ виконання CPU-вимоги 5.11.** Main підтвердив, що делегованої cgroup v2 на хості немає. Потрібен незалежний повний облік перед прийняттям 5.11.

Обидва чинні стенди запускають зареєстрований main-код із точного SHA у власному клоні. Вони самі не доводять живої вартості guard активованого hotfix generation. Відповідний generation/activation сценарій та повний CPU облік залишаються відкритими. Публікацію/активацію робочої raf цей виконавець не виконував.
