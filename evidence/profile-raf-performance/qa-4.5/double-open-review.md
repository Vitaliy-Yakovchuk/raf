# Дефект повторного відкриття SQLite в agent ps

Профіль першої живої пари показав 537–686 ms у стадії sqlite та більшу тривалість handler після оптимізації звірки процесів. Статична перевірка production entry виявила два openStateStore одного statePath: власник профілю та вкладений AppRuntime. Живий CPU-профіль перевіряється окремо; сам цей unit-доказ не доводить прискорення.

Регресія в існуючому test/agent-ps-cost.test.ts рахує відкриття й закриття для empty, live, finished, missing, pid-reused, unverifiable та scan-failure. Профіль і EMA мають зберігатися перед закриттям. Справжні production services і SQLite in-memory збережено; межі entry/store/context замінені для ізоляції HOME. Доставка подій перевіряється попередніми 14 сценаріями та живим стендом.

QA red: runId 523fb23b-905f-4bc6-8adb-1d7901d835e4, 14 passed, 7 assertions-failed саме `opens 2 !== 1`, CLI/child 1. Проміжний прогін 0c9bdda6-efea-4628-b24d-0cadd2552961 вже мав одне відкриття, але виявив помилку спостерігача нової фікстури: сучасний профіль записується mergeCostContribution. Виправлено спостерігач без послаблення перевірок.

QA green: runId 134bde56-2aa0-409c-a912-0b93804a0bcd, 21 passed, CLI/child 0. У всіх трьох cleanup complete, timeout false, unexecuted/unknown порожні. Незмінні group profile-raf-performance/agent-ps і QA HOME; фінальний groupState complete, nextAction complete. Повні TestRunResult, stderr і транспорт із CLI exit збережені в однойменних agent-ps-double-open-* файлах; SHA/незакомічені зміни — double-open-*-workspace.json. Build/check:comments — 0, double-open-checks.json.

Виправлення обмежене agent ps: AppRuntime позичає вже відкриту profileStore з close без дії; зовнішній власник закриває її після профілю, health і EMA, включно з помилками. Перевірки PID/start/command/boot, fresh process scan та контексту лишаються чинними. Нових таймерів, кешів чи порогів немає.
