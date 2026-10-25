# Передача 5.10.1

Виправлено ізоляцію фікстур у `test/runtime-verification-cost.test.ts` (коміт `bf3f00a2db234945ec41c1b7a7bb3af43a96e8ff`, blob `cabeeddc11460f710ac54bd04c5e09b4b0004b76`). Матрицю сценаріїв 5.10 не змінено; production-код не змінено.

## Причина

`processFixture` і `fileMeter` мокували ті самі `fs.readFileSync` / `fs.promises.readFile`, причому другий мок зберігав як «оригінал» обгортку першого. У Node 26 `t.mock.restoreAll()` відновлює моки в порядку створення: спершу ставиться справжня функція, потім другий мок «відновлює» обгортку першої фікстури. Обгортка з режимом попереднього тесту (`missing`/`denied`/`disappeared`) залишалась у `fs`, і наступна незалежна `processFixture` захоплювала її як оригінал.

## Виправлення

- Справжні функції `fs` / `fs.promises` для всіх вимірюваних операцій фіксуються під час завантаження модуля.
- `fsInterposition(t)` ставить на тест рівно один мок кожного методу поверх цих оригіналів; `processFixture` і `fileMeter` лише додають власні обробники. Порядок композиції той самий, що в колишніх вкладених обгортках: `before` — від останньої фікстури до першої, перетворення результату — від першої до останньої.
- Перша фікстура тесту перевіряє, що `fs` (включно з ESM-прив'язками `node:fs`/`node:fs/promises`) не містить чужої обгортки; after-хук після `restoreAll` перевіряє повне відновлення.

## Регресія

Тест `fixture isolation: layered process and file fixtures restore real fs for the next fixture`: обидва порядки фікстур × режими `missing`/`denied`/`disappeared` у підтестах; після кожного — відсутність обгорток і справжні читання `/proc`, а наступна незалежна фікстура бачить власний режим `alive`.

[На старих фікстурах](pre-fix-regression-demo.txt) та сама перевірка падає: `pre-fix fixtures leave fs wrapper behind` (`[false, false]`) і наступна фікстура отримує `Error: Controlled missing process` — саме спостережений у 5.11 симптом. Демонстраційний файл був тимчасовим і видалений.

## Власний red

```text
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/efd45e4d-b49f-42fe-9c21-dc5495f71b98/raf-main/bin/raf.ts test run --project raf --phase red --group profile-raf-performance/runtime-verification-cost --files test/runtime-verification-cost.test.ts
```

Run ID `78561e4c-9c2e-4cc7-b8c9-f714194829fe`; outcome `assertions-failed`; CLI/child **1/1**; **41 passed, 63 knownRed**; `unexecuted`, `unknown`, `removed`, `remainingPids` порожні; `timedOut=false`, `timeoutCount=0`, cleanup complete; усі diagnostics — assertion, жодного повідомлення `Controlled…`. Група `profile-raf-performance/runtime-verification-cost` незмінна, idle, nextAction implement.

Порівняно з red 5.10 (`95a1a052-4abb-409f-bbc8-82fb76c1dc1f`): множина knownRed ідентична (63), усі 28 колишніх passed лишаються passed, додано 13 passed регресії ізоляції.

- [Повний TestRunResult, stdout](final-red/stdout.json), [stderr](final-red/stderr.txt).
- [SHA-256, довжини, спосіб збереження й порівняння з 5.10](final-red/delivery.json).

Попередній прогін `81b57297-9ea0-41e3-a9b3-f4a0b62f2cef` того самого вмісту мав обрізаний вивід інструмента і як повний доказ не використовується. Stdout і stderr остаточного прогону збережено з одного файла фонового виводу Claude Code, де потоки злиті рядками (рядок 1 — stderr події черги, рядок 2 — stdout).

Конфігурація: файл уже є в `node.unitFiles`, група — у `conf/test-runs.json`; доповнень conf не потрібно. `check:comments` і `git diff --check` — 0. Галочку 5.10.1 ставить raf.
