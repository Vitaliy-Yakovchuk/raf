# Z.398.4 — продовження того самого QA

S01–S07 підтверджено unit-перевірками та справжнім ізольованим CLI. У фінальному integration run `09603f4c-904c-4de6-9e0b-5837a3da9140` усі 8 дочірніх `agent ps` мають exit 0, повний JSON і безпечні stdout/stderr. Збережено реальні PID/start/boot/runId caller, власні й чужі записи, address reuse, невідомого caller, nested result/proof/handoff, legacy metadata та два WORKER_RESULT_PENDING. Актори завершені, fixture HOME/state/tmp видалені.

Команди, відбір, коди CLI окремо від child, runId, cleanup/timeout, knownRed/unexecuted/unknown, стан групи та наступна дія: [summary.json](summary.json). SHA й незакомічені зміни: [workspace.json](workspace.json), [workspace.diff](workspace.diff). Версії Node/git/tmux/OpenSpec: [первісне середовище](../qa/summary.json); фінальний Node також є в TestRunResult і CLI summary. Робочий runner після повідомлення main — hotfix `ec8d770118d3b8d27c8a4a4da79884045addf19b`; перевіряється код develop після merge `2b40b7b` з власними двома виправленнями.

| Перевірка | runId | Outcome | CLI / child |
| --- | --- | --- | --- |
| Власний postmerge red | 7104da32-4137-440a-af15-2a7c138eaae8 | 37 passed, S07 failed | 1 / 1 |
| Неповний fix | 00739ff3-2d10-4230-8dc7-dccb5126b7f7 | S07 failed | 1 / 1 |
| Адресний unit qa | 9a55a2a4-e125-4865-ae9b-40858aabcd15 | passed, group complete | 0 / 0 |
| CLI red фікстури | 1f214e33-ec5a-48ea-b941-dfeec1796420 | assertions-failed | 1 / 1 |
| Проміжний CLI | 86ad3173-b167-4a1c-9f08-343dabe1610b | passed, згодом відновлено строгий reuse assert | 0 / 0 |
| Остаточний CLI | 09603f4c-904c-4de6-9e0b-5837a3da9140 | passed, group complete | 0 / 0 |

Production-дефект: перевірки wrapper у coordinator.observe та finalize оминали processObservationPass. Через targeted `/proc` scan синтетичний живий wrapper вважався завершеним: спершу помилка cleanup identity, після часткового виправлення — зайва зміна pending session. Обидві перевірки тепер використовують observeIdentity. Захист identity каталогу не змінено; після qa внутрішній запис і reservations незмінні, відмова WORKER_RESULT_PENDING лишається retryable. S03 у власному red вже пройшов: додатковий production-фікс для нього не потрібний.

CLI-фікстура змішувала synthetic result notice і наступний reuse тієї самої адреси. Pending notice законно залишав попередній рядок у ps. Synthetic nested result перенесено на foreign actor; початковий строгий assert відсутності попереднього runId збережено. Остаточна версія пройшла повний integration preset. Після цього вилучено лише коментар, заборонений політикою репозиторію; [build](build.json) і [check:comments](comments.json) мають exit 0. Попередні невдалі checks збережено.

Повні незмінені TestRunResult — `*.stdout.json`, окремий CLI stderr — `*.stderr`, первинна відповідь інструмента — `*.tool.json`, команда/CLI code — `*.meta.json`. Інструмент об’єднує відображення каналів: JSON-рядок TestRunResult виділено без зміни байтів; рядок launch-queue.waiting є stderr через captured port Z.423. Нові regression-пари використовують саме ці прогони, не старі stderrDigest.

Фінальні сирі CLI stdout/stderr, команда та exit для кожного виклику: [cli/a08ca369-13b5-4c32-b34e-9460c2870a4f](cli/a08ca369-13b5-4c32-b34e-9460c2870a4f/summary.json). Їх повторно перевірено на всі synthetic raw/escaped/encoded форми. Внутрішній sentinel присутній тільки в синтетичній identity-декларації; справжні runtime hooks у докази не копіювались.

Межа автоматичного доказу: первісні unit red/green до Z.423 збережено в [prior-report.json](prior-report.json) і `../qa/`; їхній старий stderrDigest не виправляється і тут не заявляється як broker-verified regression. Історичне виправлення retention-дати має manual redEvidence/greenEvidence з явним обмеженням перевірки авторства. Натомість нові production та CLI-fixture findings мають нові machine red/green. Unit report acceptance доповнює реальний CLI-прохід; він не замінює його.

Викладку проєкції в робочу raf та перше виконання після неї не виконано: це відкриті Z.398.5–Z.398.6 тієї самої зміни. Інші відкриті задачі не виконувались, archive не потрібний. Галочку Z.398.4 ставить raf після прийняття звіту.
