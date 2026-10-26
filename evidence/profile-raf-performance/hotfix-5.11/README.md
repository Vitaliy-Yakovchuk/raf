# 5.11: стан доказів

Кандидат реалізації: `4f089dcd6646f698dc8ab09d8c0592687b8f27f0`; основне виправлення — `11d07f787de0ec08839a19e174774662a822a6da`, додаткова консервативна обробка суперечливих targeted OS-фактів — `4f089dcd6646f698dc8ab09d8c0592687b8f27f0`. Реалізовано спільний синхронний origin-допуск, один process snapshot на прохід `agent ps`, адресне Linux-очікування, повторне використання store профілю/runtime й відкладене створення delivery claim owner. Тести не змінено. Чекбокс 5.11 не змінювався.

## Unit і перевірки

`runs.json` містить команди, runId, selection, CLI-код окремо від child exitCode, timeout/cleanup, лічильники knownRed/unexecuted/unknown, groupState і наступні дії. Кожний `stdout.json` — повний незмінений TestRunResult; `stderr.txt`, `capture-result.json` та `delivery.json` зберігаються окремо. Для частини діагностичних запусків точний тимчасовий workspace не збережено; це прямо зазначено, такі запуски не доводять green кандидата.

Авторський red 5.10 перевірено main; після окремого виправлення ізоляції 5.10.1 main підтвердив red `78561e4c-9c2e-4cc7-b8c9-f714194829fe`: 41 passed, ті самі 63 knownRed, без Controlled OS read refusal. Авторські тести перенесено main без втручання цього виконавця.

Проміжний запуск `5f1c3dbb-5831-4579-bac7-8c6c48782df9` мав child 0, але CLI 1, outcome `setup-failed`, cleanup incomplete: SQLite `database is locked` під час ResourceUsageRepository.merge. Дозволений тоді один повтор повної групи повернув той самий runId і старий `--only`: це replay, а не новий прогін. Після випуску Z.422 у робочу raf `ec8d7701` main 2026-10-26 дозволив повтор. HOME та назву групи не змінювали.

**Фінальний власний прогін `06039c7d-401d-42ab-a000-7d852ae842a7`: passed, 104 passed, CLI/child 0/0, knownRed/unexecuted/unknown/removed — 0, timeoutCount 0, cleanup complete; groupState/nextAction complete.** Відбір — повний `test/runtime-verification-cost.test.ts`, без `--only`; workspace HEAD `24555ca85f741f9bc45336554a44c25f3ac4d757`. Перед запуском записано hashes власних src і тесту, незакоміченого diff у них немає. У shared workspace паралельно були чотири незакомічені файли Z.427 (quota collection/screens і їх тести): початковий status збережено, їхній точний початковий diff не збережено; `post-run-workspace.*` містить явно позначений післятестовий snapshot. Результат стосується цього зафіксованого shared workspace, не чистого checkout.

Збирач `capture-proof.mjs` зберіг повні незмінені stdout (21504 bytes) та stderr (1492 bytes), CLI manifest і SHA-256. Його вікно очікування 30 хвилин покриває unit timeout 20 хвилин; після відкриття FD опитування сповільнене до 100 мс.

`checks.json` фіксує build та check:comments exit 0 після фінального src diff. `candidate.patch` — початковий diff 11d07f78 до коміту; `candidate-followup.patch` — додаткова правка 4f089dcd. `latestSourceChecks.workspaceAtRun` вказує фактичний HEAD та незакомічений src під час останніх перевірок і еквівалентний наступний коміт. У shared worktree чужі зміни тестів/Z.422 не входять до власних комітів.

Чужі групи без grant не запускались. У 5.11 немає кінцевої декларації regressionGroups, а launch snapshot цієї сесії — без grants (conf/briefs/README.md:37). Main 2026-10-26 підтвердив: у цій сесії їх не запускати, оформити відсутню регресію явно; окремий пункт і новий запуск із regressionGroups створить main. Непідтверджені `profile-raf-performance/module-origin-cost` (включно з generation/origin preset) та `profile-raf-performance/agent-ps` залишають загальний пункт 5.11 неповним.

`shared-head-checks.json` — додаткові build, check:comments та diff check на `ec8d770118d3b8d27c8a4a4da79884045addf19b`: усі CLI 0. Наступний `24555ca8` змінює тільки цей evidence-файл.

## Host-серії

Новий driver `scripts/qa-runtime-verification-host.mjs` використовує чинні реальні ізольовані стенди `qa-agent-ps-comparison.mjs` та `qa-agent-run-live.mjs`. Підготовка двох native harness файлів перевіряє точні місця заміни; runtime handler не підмінюється. Як у вихідному live harness, QA entry instrumentation записує результати message і синхронізує concurrent delivery; його hashes збережено в оригінальних live доказах. До/після використовують один driver і конфігурацію. SHA, OS, конфігураційні fingerprints, кількість/розкид, навантаження, початкові/кінцеві SQLite, profile deltas та первинні CLI-помилки зберігаються.

На хості main, з поточного checkout зі скриптом, приклад серій по три повтори (число повторів експериментальне, це не поріг):

```sh
LC_ALL=C CODEX_HOME=/home/dev/.codex node scripts/qa-runtime-verification-host.mjs run 30eaf7f91d52ca7ca71e205ab35d70f4985dd852 /srv/dev/work/orchestrator/conf 3 /srv/dev/prp511-before
LC_ALL=C CODEX_HOME=/home/dev/.codex node scripts/qa-runtime-verification-host.mjs run 4f089dcd6646f698dc8ab09d8c0592687b8f27f0 /srv/dev/work/orchestrator/conf 3 /srv/dev/prp511-after
node scripts/qa-runtime-verification-host.mjs compare /srv/dev/prp511-before/summary.json /srv/dev/prp511-after/summary.json /srv/dev/prp511-comparison
```

Каталоги output мають бути новими. Невідому команду чи запуск після помилки не повторювати. Код 1 означає помилку сценарію; код 2 означає неповні докази, навіть якщо native сценарії пройшли. Код 2 не є pass. Cleanup належить вихідним live harness; driver не вбиває чужих процесів і не видаляє стенди з доказами.

`agent ps` вимірює повний CLI/helper CPU через wait4, коли службу стенда зупинено й provider відсутній. Чинний verifier перевіряє SQLite/події/claims, первинні unknown errors і розкид; integrity verdict не замінює speed acceptance.

Для `agent run` driver записує CLI wait4, завершені self/helper profile-внески й wall окремо для першого та другого запуску (різне число живих сесій). Свіжі native стенди перевіряють справжні readiness, вузькі завдання, ownership, literal/concurrent delivery, receipts і primary refusals. **CLI wait4 не враховує весь persistent worker/tmux/service CPU. `fullRuntimeCpuMs` і `fullCpuNonIncrease` лишаються null; це не доказ виконання CPU-вимоги 5.11.** Main підтвердив, що делегованої cgroup v2 на хості немає. Потрібен незалежний повний облік перед прийняттям 5.11.

Обидва чинні стенди запускають зареєстрований main-код із точного SHA у власному клоні. Вони самі не доводять живої вартості guard активованого hotfix generation. Відповідний generation/activation сценарій та повний CPU облік залишаються відкритими. Публікацію/активацію робочої raf цей виконавець не виконував.

## Підсумковий статус доручення

Виправлення реалізовано, власна повна unit-група й обов’язкові статичні перевірки пройшли. Загальний статус 5.11 — failed (неповне виконання): немає чужих регресій і завершених зіставних живих серій із повним CPU та activated-generation сценарієм. Host driver готовий, але сам по собі не є доказом живих вимірів. Галочка tasks.md залишається відкритою, архівація не виконується.
