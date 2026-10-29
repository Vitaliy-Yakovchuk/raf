# HANDLER_FAILED: протокол main не відповідає кадру

Доручення: `/Users/val/.raf/mac-start/20261028/briefs/raf-mac-handler-failed-r4.md`.
База: `d580d8054e465374f6700b0343b15a55323f93f9`, гілка `mac`.

Причина відмови — застосування протоколу Codex до кадру Claude. У первинному
`frame.json` записано `runner: codex`, `version: 0.163.0`; на дослівному screen
Claude повертає composer `{ line: 62, input: '' }` і стан `ready`, Codex —
`null` та `unknown_screen`. Жоден із трьох запропонованих елементів не блокує
Claude: видалення бічної панелі, статусу чи рядка `Sautéed` не змінює порожнього
composer. Нижній статус якраз підтверджує `ready`. Окремий `finished`-regex не
розпізнає цей рядок done через spinner/бічну панель, але він не потрібен для
цього ready-кадру і не є причиною відмови.

[Точне походження й SHA-256 кадру](frame-source.json),
[матриця перевірки елементів](diagnosis.json),
[дослівна фікстура](../../test/fixtures/mac-handler-failed-r4/main-20261029T025904.txt).
Повний screen збережений без обрізання, пробіли й NBSP включно.

Історичного дерева процесів у доказі немає. Відтворений шлях до помилки:
зареєстрований shell main, нерозпізнаний version-title процесу та його Codex
нащадок. Наявний алгоритм виводить із такого дерева Codex. Це модель відтворення,
а не заява про точні PID/команди о 02:59:04Z. Поточний read-only tmux probe
`display-message -p -t %0 '#{pane_current_command}'` повернув `2.1.312`.

Фікс дозволяє уточнити лише виведений із дерева Codex-протокол main за першим
кадром під чинним delivery lease: якщо composer Codex відсутній, а наявні
composer Claude та його чинний ready-маркер, доставка використовує Claude.
Явно записаний runner і worker не перемикаються. Використані наявні парсери;
нових таймаутів, лімітів, валідацій чи capture не додано. Перевірки identity,
чужої чернетки, пасти, Enter і receipt лишаються у спільному механізмі доставки.
Діагностика наступної відмови записує фактично вибраний протокол.

Новий тест до source-фіксу: 4/5, рівно одна відмова —
`Recipient has no recognized empty agent composer`. Після: 5/5.
Фінальний прогін нового тесту, усіх семи заданих груп, а також
message-delivery-evidence та delivery-diagnostic: **58/58 GREEN**, exit 0.
`npm run build` і `git diff --check`: exit 0.
Команди, версія Node, exit codes, SHA-256 перевірених файлів —
[verification.json](verification.json); повні stdout/stderr лежать поруч.

Для `r-settings-literal-canon-remainder-2.1` збереженого кадру немає серед 13
наявних файлів. Журнал указує 02:10:07Z, раніше за найстарший наявний capture;
цю іншу відмову виправленою не оголошуємо. [Результат пошуку](second-frame-search.json).

Виправлення чинної вимоги `projects/raf/agent-message`, сценарію
«Спостережене прийняття без semantic ack». Окремих пунктів tasks.md доручення
не містить. Активація і production canary — за main; виконавець їх не робив.
