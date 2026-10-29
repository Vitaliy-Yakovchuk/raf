# raf mac HANDLER_FAILED після 550a6ed5

Доручення: `/Users/val/.raf/mac-start/20261028/briefs/raf-mac-handler-failed.md`.
Гілка mac, базовий SHA 550a6ed5. Виправлення чинного контракту `projects/raf/agent-message`, без нових вимог.

## Історичні записи

SQLite відкрито через `file:/Users/val/.raf/state.sqlite?mode=ro`; лише SELECT зі schema, sessions, result_notices, pending_intents. Main runId: 73dbd8de-3b07-4e77-a5fc-89cd3d04d63d, pane %0, PID 4078. У таблицях немає журналу прямих agent-message спроб. `command_timings` містить лише агрегат, а не записи доставок.

[Точні CLI-відповіді та наступні receipts](exact-deliveries.json) отримано з `event_msg/item_completed/CommandExecution` у п'ятьох Codex session transcripts; це фактичні записи, а не переказ samples.log. Час event completion UTC:

| Відправник | Час | Відмова |
|---|---|---|
| r-password-text-undo-scope-3.2 | 00:08:47.203 | no recognized empty agent composer |
| r-synthetic-layout-duplicate-ident-3.1 | 00:09:50.912 | composer contains unrelated input |
| r-reachable-product-contrast-candi-3.2 | 00:14:05.545 | no recognized empty agent composer |
| cr-b884802e-1.1 | 00:30:47.243 | no recognized empty agent composer |
| r-shared-label-catalog-3.2 | 00:32:49.892 | no recognized empty agent composer |

У всіх п'ятьох exit 1, HANDLER_FAILED, retrySafe=true, accepted/receiptId відсутні. У вихідному samples.log наведено інший час; фактична причина cr — no recognized empty composer. Наступні прямі receipts є для password, reachable і shared (у JSON); для synthetic/cr пізнішого прямого receipt у цих transcripts не знайдено. [Result notices](result-notice-summary.json) для всіх п'ятьох згодом delivered; це окремий механізм повідомлення про результат, не receipt невдалої прямої спроби.

`src/production-runtime.ts` transport.deliver викликає capture-pane, але не зберігає кадри agent message. `AgentControl.message` лише повертає receipt або кидає помилку. Private delivery evidence у production-runtime стосується initial brief, не цієї доставки. Тому actual pane саме п'ятьох відмов відсутній у збережених доказах. Аудитні main-frame-before/after мають observedAt 2026-10-28T22:28Z, вони не кадри цих відмов. Read-only поточний capture також не є історичним доказом. Приватні SELECT-вибірки, вихідні команди/відповіді та поточний pane: `/Users/val/.raf/mac-start/20261028/artifacts/raf-mac-handler-failed/`.

## Відтворення та фікс

Нові тести у `test/mac-claude-composer.test.ts` — побудовані pane-capture фікстури, не actual failed frames:

- попередній `[raf]` текст у busy composer, тимчасове зникнення composer під час redraw, потім очищення; доставка очікує, не натискає Enter для попереднього тексту;
- шість Claude spinner glyphs: · ✢ ✳ ✶ ✻ ✽; попередня нормалізація знала лише ✻ та ✶, тому решта давали no recognized empty composer навіть під час очікування;
- own multiline paste при появі/зникненні додаткового вже налаштованого `Press up to edit queued messages` footer; старий алгоритм віднімав кількість рядків baseline-footer від current і хибно включав частину власного payload/footer у порівняння;
- foreign input, persistent pending без receipt, втрата identity та невичікуючий caller зберігають відмову.

Фікс: використовуємо існуюче очікування main також для розпізнаного кадру без composer; нормалізуємо всі spinner phases Claude; відділяємо повний власний payload від footer та згортаємо повтори відомих Claude mode rows. Невідомі footer-рядки залишаються значущими. Таймаути, lease, identity, один paste, Enter retry та критерій receipt не змінені.

## Перевірки

[Команди, SHA та source hashes](validation.json), окремі stdout/stderr/exit поряд.

- RED: оригінальні два src з 550a6ed5 в ізольованій тимчасовій фікстурі + фінальний test без змін: exit 1, 5 pass / 4 fail. Три позитивні тести відтворюють дві цільові причини; контроль identity під час redraw також RED, бо стара реалізація відмовляє до очікування. Тимчасовий каталог видалено.
- GREEN: п'ять заданих файлів та message-delivery-draft-z449: exit 0, 32 pass / 0 fail, stderr порожній.
- git diff --check: exit 0.

Не відтворено історичний pane кожної реальної відмови; зв'язок конкретного historical failure з конкретною фікстурою не доведений. Live send не виконувався: прямий виконавець не зареєстрований raf caller; activation raf-main-a доручено main. Наступна дія main після активації — один canary від зареєстрованого агента зі збереженими before/pending/accepted кадрами та receipt.
