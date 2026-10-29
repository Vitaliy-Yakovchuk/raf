# Діагностика відмов доставки

Доручення: `/Users/val/.raf/mac-start/20261028/briefs/raf-mac-handler-failed-r3.md`.
База: `cbe346c79ad45b478d83667de7ec311781b041e0`, гілка `mac`.

Transport при відмовах `Recipient has no recognized empty agent composer` та
`Recipient composer contains unrelated input` зберігає останній фактично
отриманий `capture-pane -p`. Повторного читання pane для діагностики немає.
Використано наявні `preserveFailedDeliveryEvidence`, приватне сховище та
`conf/flow.json#/retention/failedDeliveryEvidenceMs`; cleanup лишився чинним.
Правила розпізнавання, очікування, блокування, paste, Enter і receipt не змінено.

## Де шукати

У тексті відмови (CLI `HANDLER_FAILED`, `details.found`) є
`; deliveryEvidence={...}`. Поле `path` вказує на файл:

`<tmpRoot>/.delivery-evidence/exec-<UUID>/frame.json`

Для звичайного Mac tmpRoot `/Users/val/.raf/tmp` це
`/Users/val/.raf/tmp/.delivery-evidence/exec-<UUID>/frame.json`.

У файлі: `capture.frame.screen` — точний stdout capture, `capture.recipientPane`,
`capture.capturedAt`, `capture.execId`; також runner/version, phase, firstFailureAt
та expiresAt. Exec id генерує raf для цієї відхиленої спроби; це не зовнішній id
виклику інструмента відправника. Цей самий id і pane id є в посиланні помилки.
Повторні відмови зберігаються окремо. Файл має права 0600 у приватних каталогах.
Повний кадр доступний лише у приватному файлі; у помилці діє наявна редагована
діагностика. Якщо сховище недоступне, відмова лишається відмовою з початковою
причиною та `availability=unavailable`, без вигаданого шляху до знімка.

## Перевірки

- Новий `test/message-delivery-evidence.test.ts`: 2/2 GREEN; обидві причини,
  точний кадр без recapture, pane/time/exec id, чинний retention, права файлу,
  окремі файли повторних відмов, незмінна кількість paste/Enter.
- Той самий новий тест на `git archive` базового коду: 0/2, exit 1 саме через
  відсутність `deliveryEvidence` у відмові. Це перевірка діагностики, а не
  відтворення невідомого історичного стану pane 01:36:03Z.
- Шість заданих груп: 32/32 GREEN.
- Фінальний спільний прогін нового тесту, шести груп і наявних
  delivery-evidence/delivery-diagnostic: 53/53 GREEN.
- `npm run build`: exit 0. `git diff --check`: exit 0.

[Команди, Node, exit codes і хеші перевірених файлів](verification.json).
Повні stdout/stderr та exit codes — поруч (`baseline.*`, `target.*`,
`regression.*`, `final.*`, `build.*`); [база RED](baseline.json).

Зміна лише діагностична за прямим дорученням; окремих пунктів tasks.md не задано.
Активація в raf-main-a та наступна фактична відмова — за main.
