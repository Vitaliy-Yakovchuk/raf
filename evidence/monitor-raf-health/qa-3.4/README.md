# monitor-raf-health:3.4

Результат: **passed**. `host-attempt-6/public/summary.json` підтверджує всі 7 перевірок на SHA `9ba404760962afaa9606690193c9e63a12878817`, launch runId `887761e0-8d90-49fe-8ade-7fca6c64cb83`. Host CLI 0, приватну fixture видалено, скан секретів main — 0 збігів. Усі скопійовані докази звірено з незміненими SHA256 manifest (`host-integrity.json`). `public/cli.json` зберігає повні команди й результати, зокрема успішні CLI 0 та очікувані відмови 1 з причинами.

Перевірено точний приватний кадр (337 bytes, digest у summary), пов'язану redacted діагностику, звичайний launch cleanup без передчасного видалення raw, доступ власного/сусіднього native sandbox, conf retention та ідемпотентність, вторинну помилку запису, відсутність маркерів у Git. Продуктових дефектів у цих сценаріях не виявлено. Три дефекти скрипта/конфігурації QA виправлено з red → QA нижче. Інші пункти зміни відкриті; архівація не виконується, додаткових tasks для цього пункту немає.

Стендовий сценарій: `node evidence/monitor-raf-health/qa-3.4/host.mjs` з чистого клону SHA, вказаного в host summary, із сусіднім `../conf`. Main переглядає коміт, запускає його поза sandbox і повертає незмінені публічні докази після скану секретів. Приватні raw та контрольні маркери не копіюються.

Скрипт використовує власні HOME/TMPDIR/state у mkdtemp під `/srv/dev`, справжні production CLI/worker/tmux та native Codex sandbox. Невідомий екран відтворює детермінований synthetic TUI без звернення до моделі чи провайдера. Перевіряється повний фактично спостережений кадр `tmux capture-pane -p`, з явним обмеженням видимої панелі. Retention перевіряється викликом cleanup на межі фактичного conf-derived expiry, без зміни conf або очікування семи днів.

Позитивний `agent ps` має CLI 0. Невдала доставка має CLI 1 та первинний `LAUNCH_FAILED` / unknown screen. Власна і сусідня sandbox читають власний control, але прямий `cat` приватного raw має ненульовий код і точну причину відмови. Помилка приватного сховища залишається вторинною до початкової невдалої доставки.

Unit-команда (стабільна група й той самий QA HOME в усіх прогонах):

```sh
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/59a18619-5f7d-4b3c-947e-4a3010820d6e/raf-main/bin/raf.ts test run --project raf --phase qa --group monitor-raf-health/delivery-evidence --files test/delivery-evidence.test.ts
```

Для трьох знайдених дефектів стендового скрипта початкові прогони виконано тією самою командою з `--phase red` перед виправленнями:

| Доказ | runId red | runId qa | Результат QA |
| --- | --- | --- | --- |
| `config-*` — production startup policy | 6406c41b-434f-45fb-a353-71f1ee26381d | 9799b8f0-a242-4ccd-a2f6-d0d7e1f5a654 | 14 passed |
| `parse-*` — JSON diagnostic перед worker stack | b52c0025-67bb-43ee-b4d8-316c6900f631 | 909d0191-4ed6-4365-8610-a5bef697402f | 15 passed |
| `scan-*` — відсутня failure у завершенні | 6d2ad469-2f52-43ad-8661-2e257ba6bfa3 | 1f9cdaf9-3c17-4086-aad6-a38b8ccbc1b3 | 16 passed |

`*.result.json` містять повний TestRunResult, `*.transport.json` — отриманий transport, `*.exit.json` — окремі CLI/child codes. `stderr` позначено null: transport об'єднує потоки, а raf не зберігає його окремо; main погодив це без повторних прогонів. `*.workspace.json` містять SHA та незакомічені правки під час відповідного прогону.

Кожний red — assertions-failed, CLI/child 1, лише новий knownRed; кожний наступний QA — passed, CLI/child 0, knownRed/unexecuted/unknown порожні, cleanup complete, timedOut false, timeoutCount 0, group complete, nextAction complete. Початковий `unit.*` — 13 passed до доповнення регресій. Build/comments підтверджено у `final-checks.json`.

`host-attempt-1` … `host-attempt-5` — невдалі прогони, не pass. Перші три зупинилися до доставки; четвертий пройшов raw/frame assertions, але неправильно парсив JSON із suffix; п'ятий пройшов обидві sandbox-проби, але не записав summary через scanner(undefined). Його приватну fixture вже видалив cleanup; metadata спостереження та запит main прибрати залишковий ізольований HOME наведено в provenance. Дефекти виправлено в цьому ж запуску, без передачі реалізації іншому агенту.
