# QA monitor-raf-health:7.4

Початковий unit QA: [unit-review.json](unit-review.json), runId `3844b20c-d809-4925-baef-2267807d8552`, 51 passed, CLI/child 0/0, timeoutCount 0, cleanup complete, knownRed/unexecuted/unknown порожні, groupState/nextAction complete. Повний незмінений TestRunResult, envelope CLI, stderr і CLI-код збережені окремими файлами. SHA та чужі незакомічені зміни під час запуску — [workspace-before-unit.json](workspace-before-unit.json). HOME та стабільна група monitor-raf-health/summary успадковані від переданого агрегату.

Аудит: proposal Why/What Changes/Non-goals, tasks 7.1–7.4 та «Джерела за етапом», повна вимога «Підсумок стану для main», design «Архітектура та стан»/«Вікно CPU та підсумок», адресні background-runtime/event-registry/reminders узгоджені. 7.3 закритий; його runtime-smoke прямо вказує liveWorkerQA=false. Потрібен незалежний живий прохід. Інші пункти відкриті; архівація не застосовується.

Main підтвердив відсутність готового стенда та погодив підготовку host-скрипта з подальшим review/запуском на чистому клоні. Скрипт `scripts/qa-health-summary-host.mjs` використовує ізоляцію та реальний CLI/tmux/worker за зразком CPU QA і чинний agentRunFixture. Синтетичний лише термінальний runner. Production HOME, секрети й мережеві провайдери не використовуються. Стендовий summaryIntervalMs=30000; production conf не змінюється, решта health/costProfile/timeout policy з джерельного conf. Фікстурні admission thresholds не перевіряють production admission.

Команда для main після review на чистому клоні:

```sh
node scripts/qa-health-summary-host.mjs /srv/dev/raf-mrh74-evidence-1
```

Матриця: CLI підтверджує service stopped; main offline; живий worker сам створює due і лишає pending; повернений main отримує рівно один факт через справжній tmux, runner його не отримує; worker завершується; три пропущені планові межі без runtime-команд не створюють фактів; наступний CLI створює один delayed-період із фактичними межами, конкурентні повтори не дублюють доставку. Окремо перевіряються точна відмова missing recipient, health CONFIGURATION_INVALID із pointer при успішній stats та незмінні commands/profile.

Main виконав переглянутий скрипт з SHA `619ed61868052a01bec3e21a4041539d597646fc` на чистому tracked-source клоні; untracked `node_modules` забезпечує залежності. RunId `a06261ec-5954-4aa9-ad37-2bfa16155c64`, Node v26.12.1, tmux 3.6, OpenSpec 1.14.3. CLI 0, timeout false, fixture і зовнішній ізольований HOME/TMPDIR прибрані. Main підтвердив secret scan: 0 збігів. З read-only `/srv/dev/raf-mrh74-evidence-1` скопійовано всі 50 оригінальних файлів без змін у [host-attempt-1](host-attempt-1); незмінений MANIFEST.sha256 має SHA256 `3ee5c0d60f58dd6f4ea3010c97f215d9e5afed2f1348921809a3494e3b41e5b2`.

Незалежний [host-review.json](host-review.json) звіряє хеші, сирі transport stdout/stderr й коди, accepted receipts, реальні tmux-повідомлення та межі. Відтворення перевірки доказів: `python3 evidence/monitor-raf-health/qa-7.4/verify-host.py` → 0; runtime не запускається. Перший due: `03:07:54.802Z–03:08:24.806Z`, pending без main. Після повернення main — одна доставка; worker її не отримав. Після зупинки worker тиша тривала **87.395 с**, пропущено три планові межі. Один delayed-період `03:08:24.806Z–03:09:55.448Z` охопив фактичні **90.642 с**; два конкурентні повтори не створили дублів. Усього два факти, два accepted receipts і два повідомлення main. Це уточнює фразу harness «three intervals»: після зупинки worker не минуло три повних інтервали.

Позитивні CLI/child 0/0; missing recipient — 1/1, `HANDLER_FAILED`, `Unknown or ambiguous session: missing-summary-qa`. Видалений summaryIntervalMs — stats 0/0 зі збереженими commands/profile та `CONFIGURATION_INVALID`, pointer `conf/raf.json#/health/summaryIntervalMs`. Initial main і synthetic worker навмисно зупинені: їхні failed session results та діагностика вже відсутньої tmux-сесії є наслідком сценарію. Служба stopped на початку й наприкінці. Нових дефектів предметного сценарію не виявлено; red-прогін не потрібен.

7.4 перевірено успішно. Галочку tasks.md ставить raf. Інші відкриті пункти зміни не виконувались; архівація не застосовується.
