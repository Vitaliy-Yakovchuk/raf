# Передача add-raf-agent-run:4.1.5

Доручено лише test-scaffold регресії серіалізації повідомлень. Чинність перевірено за proposal.md, відкритим tasks.md:4.1.5 та design.md «Message: identity, конкурентність і підтвердження», пункти 3 і 7. Поточний transport одноразово викликає неблокувальну lease й відмовляє при конкуренції, тому доручення актуальне. Production-код не змінено; нової публічної поверхні немає, окремий каркас NotImplemented не потрібен.

Тест: `test/production-message-serialization.test.ts`. Публічний маршрут: `createProductionServices → control.message → production transport → deliverCheckedMessage → TmuxAgentAdapter`. Реальними лишаються серіалізація transport, native-перевірка acceptance, підпис `[raf]`, буфери адаптера та обробка відмов. OS/process observation, tmux, неблокувальна lease й час замінені ізольованими doubles. Немає живого tmux, SQLite, модельного CLI чи мережевого сервісу. Double lease одразу повертає null при зайнятості, зберігаючи контракт LOCK_NB; тест вимагає очікування саме в production message transport. Допоміжний tryWaitLease та service election/start мають зберегти неблокувальний контракт.

Інваріанти для обох runner-ів codex і claude:

- Перший виклик утримано в capture всередині справжнього native acceptance після insert/submit. Другий до того самого recipient залишається pending, не захоплює composer й не виконує inspect до release.
- Після release обидва виклики отримують успішні receipt; кожний буквальний багаторядковий текст із лапками, `$()` та backticks вставлений рівно один раз, без змішування.
- Інший recipient завершує доставку, поки перший утриманий усередині acceptance.
- Native-відмова й виняток capture звільняють lease рівно один раз; наступна доставка проходить.
- Два різні бюджети transitionMs/pollMs (90/10 та 140/20, лише unit fixture) перевіряють pending до дедлайну, відсутність spin до pollMs, повтор за pollMs, завершення до transitionMs та відсутність фонових retry/пізньої вставки. Waiter не звільняє lease власника.

Незмінна група: `add-raf-agent-run/message-serialization`, профіль `node`, єдиний файл `test/production-message-serialization.test.ts`. Точні доповнення конфігурації, передумови й команда — у [profile-handoff.json](profile-handoff.json). Main зареєстрував групу до першого red комітом Orchestrator `582b3c6867bb17a2ecbb1f852991af223effcb5a`. Наступним етапам передається ця сама група; фаза відповідає їхньому дорученню.

Автор сам виконав первинний red `e0637ab4-2af1-4d9b-a601-b0e020d14758`: CLI 1, assertions-failed, 6 knownRed, 4 passed, без setup/import, unexecuted та unknown порожні, timedOut=false, cleanup.complete=true. Артефакти мають префікс `initial-red`.

Після уточнення діагностики й усунення очікування, яке могло приховати помилковий дедлайн, остаточний файл перевірено повторно: `2e54f04a-b4ab-432a-9f6e-56b93da692ce`, CLI 1 і child exitCode 1; assertions-failed, 6 knownRed, 4 passed, unexecuted/unknown/removed порожні, timedOut=false, cleanup.complete=true, remainingPids порожні, timeoutCount=0, groupState=idle, nextAction=implement. Кожне цільове падіння називає `Message delivery failed: Another delivery owns the recipient composer`: фактично rejected замість очікуваного pending. Чотири тести cleanup уже зелені. Main має перевірити саме ці твердження перед передачею незалежному implement.

Остаточний перевірений HEAD: `c13173074f1561404b401f568808c98aacdefda4`. Перед прогоном власний тест і докази були untracked; чужі untracked-докази зафіксовані в `final-red.capture.json` і не включаються у власний коміт. Відбитки тесту та трьох production-входів теж збережені там. Production runtime, message-delivery та resource-wait-identity незмінні відносно цього HEAD.

Повний незмінений TestRunResult — [final-red.stdout.json](final-red.stdout.json); stderr черги — [final-red.stderr](final-red.stderr); окремі CLI/child коди й snapshot — [final-red.capture.json](final-red.capture.json). `*.combined.txt` зберігають увесь вивід інструмента. exec_command повернув потоки разом: окремі файли розділено за чинним контрактом CLI (один JSON TestRunResult у stdout, подія launch-queue.waiting у stderr); оригінальний capture теж лишено. Вивід не обрізано. Native manifest каналу не надано, його не вигадано. [artifact-verification.json](artifact-verification.json) містить довжини й SHA-256 збережених артефактів.

Галочки tasks.md ставить raf після прийняття succeeded. 4.1 і подальші пункти лишаються відкритими, тому sync/archive не виконуються. Виправлення продукту й live QA не входять у 4.1.5.
