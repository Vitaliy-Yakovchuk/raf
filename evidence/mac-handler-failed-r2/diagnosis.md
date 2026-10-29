# Повторний HANDLER_FAILED після fcfbde69

Статус: failed — фактичний стан composer не відтворюється з наявних даних.
Доручення: `/Users/val/.raf/mac-start/20261028/briefs/raf-mac-handler-failed-r2.md`.
База дослідження: raf/mac `fcfbde695b8f390c7b0ed8100d075369624d346d`.

## Встановлено

- Точна пряма спроба `r-hand-cursor-composite-2.1 → main`: event `exec-aa972ea2-f256-496b-9c7f-f448ca94fd06`, завершення **2026-10-29T01:36:03.836Z**, тривалість 0.870577625 s, exit 1. У samples.log вказано 01:36:30Z; він відрізняється від точного timestamp CLI event. Причину цієї різниці не встановлено.
- Відповідь: `HANDLER_FAILED`, `Message delivery failed: Recipient has no recognized empty agent composer`, `retrySafe=true`, без accepted/receiptId. У transcript відправника знайдено одну завершену команду прямої доставки. Команда, повна відповідь, файл і рядок джерела: [investigation-summary.json](investigation-summary.json).
- SQLite відкрито лише через `mode=ro`, виконано SELECT. Sender runId `bace748f-19e5-4aac-b4f0-533414a08bc1`; main runId `73dbd8de-3b07-4e77-a5fc-89cd3d04d63d`, PID 4078, pane `%0`. Таблиці прямих message receipts/frames немає; `delivery_claims` зберігає поточного власника lease, не історію кадрів чи receipt.
- Окремий `result_notices` для цього sender має state=delivered, attempts=2, lastError=null; це результат іншого механізму, не receipt невдалої прямої спроби. Pending intents відправника: 0 на момент SELECT.
- У `src/production-runtime.ts:804–818` capture повертає stdout tmux без збереження, а receiptId створюється лише для accepted. `src/agent-control.ts:205–209` кидає помилку при rejected. Цей transport не викликає збереження failed-delivery evidence (воно застосовується до initial brief в іншому шляху).
- Для main `waitForComposer=true`. У `src/message-delivery.ts:33–46` ця причина означає відмову `recognized(before)`; однак вона не визначає, що саме було на екрані. Без кадру неможливо відрізнити невідомий footer/working state, модальне вікно, redraw чи інший стан. Жоден із цих варіантів не вважається встановленою причиною.

## Перевірка збережених кадрів

Адресно перевірено tmp конкретного sender та інвентар релевантних артефактів `.raf/tmp`, `.raf/mac-start/20261028/artifacts`, logs і попередні evidence. У tmp sender є report, brief, runtime/task context, worker log і checkbox operations; кадру доставки немає. Інвентар кандидатів збережено приватно в `artifact-candidates.json`.

[Кандидати кадрів і mtime](frame-candidates.json): notice frames створено 2026-10-28 близько 15:00Z; audit frames мають власний observedAt 22:28Z; попередній current-pane має mtime 2026-10-29T00:52:52Z. Усі передують досліджуваній відмові. Mtime використано лише для відсіву кандидатів, не як доказ стану composer. Новий current capture не відтворив би історичний кадр, тому не виконувався.

## Чого бракує і наступна дія

1. Точного тексту `capture-pane -p` main `%0`, який повернув `recognized=false` в цій доставці, з timestamp та прив’язкою до спроби.
2. Ефективного runner/protocol settings цієї спроби, щоб відтворення використовувало той самий dialect і markers. Запис main у state зберігає runner=main, а transport обирає фактичний runner через lineage/fallback під час виклику.
3. Для безпечного перевіреного фікса — сусідніх кадрів до/після відмови, щоб розрізнити перехід і стійкий стан та перевірити acceptance/receipt.

Main має доручити зареєстрованому відправнику контрольну доставку зі збереженням цих даних (і CLI response/receipt). Після отримання actual rejected frame — окремий RED біля mac-claude-composer, вузький фікс та шість заданих GREEN-груп.

Нових тестів, змін src, вимог, таймаутів, лімітів чи валідацій немає. Тести не запускалися: фактичний reproducer відсутній. Tasks не позначалися; активну raf-main-a не змінено. Commit містить лише докази діагностики.

Приватні SELECT-вибірки й точні transcript events: `/Users/val/.raf/mac-start/20261028/artifacts/raf-mac-handler-failed-r2/`.
