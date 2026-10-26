# add-raf-test-run:6.7.1

Утримання групи без процесу (`inFlight.processIdentity = null`) з минулим deadline тепер штатно звіряє наступний `raf test run` і знімає його. Після цього прогін стартує. `knownRed`, `unexecuted`, `unknown` і `timeoutCount` не змінюються. `lastResult` і `delivery` теж лишаються як були.

Утримання знімається лише тоді, коли виконано всі умови:

- у групі збережено явний `ownerIdentity`/`wrapperIdentity`, і цей власник перевірено мертвий (`owner = lost`);
- deadline минув;
- кожен resource claim цього runId або вже прив'язаний до мертвого дерева, або не має процесу й належить мертвому власнику (`unboundOwner = dead`);
- fence у транзакції не змінився.

Утримання лишається з `reconcile`, якщо: власник живий або його стан невідомий; deadline ще не минув; claim має живу чи неперевірену дитину; запис legacy без жодної ідентичності власника. Останнє зберігає safety-контракт S05 «legacy-identity» і тест 6.7 «copied legacy null identity needs verified recovery rather than a deadline reset». Утримання з живим процесом не знімається, як і раніше.

## Реальний запис

Копію `/tmp/raf-unit-1000/aa9894a6…/.raf/state.sqlite` (QA HOME shared-libs-develop) прочитано лише на читання. Група `shared-libs add-visitor-origin-analytics/consent-web` має:

- `state = reconcile`, `timeoutCount = 0`;
- `inFlight.runId = 3163a552-987d-48da-a681-a5622f022384`, `processIdentity = null`;
- `ownerIdentity` = `wrapperIdentity` = pid 2172402, boot `b1029120…` (поточний boot); процесу 2172402 на момент перевірки немає;
- `lastResult` того самого runId: setup-failed, `cleanup.complete = false`; `delivery.returned = true`.

Тобто реальний запис підпадає під нове правило. Control store `~/.raf` з resource claim не читався, бо sandbox закриває до нього доступ. Якщо claim лишився зі `spawning = true` без процесу, його звільнить перевірка `unboundOwner = dead`.

## Прогони

Усі прогони йшли через `raf_command test run` у workspace `/srv/dev/work/orchestrator/raf-hotfix` з ізольованим QA HOME `/tmp/raf-unit-1000/1ee10007…`. Повні `TestRunResult` експортовано з агрегату QA HOME (`lastResult`), бо stdout у виводі інструмента обрізано.

| Фаза | Група | runId | SHA / workspace | Результат | CLI |
|---|---|---|---|---|---|
| red (спроба) | add-raf-test-run/in-flight-unspawned | — | 5818abb + незакомічений тест | `PRODUCTION_ENTRY_FAILED` EROFS: команда з перенаправленням виконалась у sandbox, [stderr](refused-sandbox-redirect.stderr.txt). Це не red. | 1 |
| red (спроба) | add-raf-test-run/in-flight-unspawned | dabd0584-ca98-4c7a-93a8-dcb68a66f443 | те саме | refused `CALLER_UNAUTHORIZED`: групи немає в conf/test-runs.json. Це не red. | 1 |
| red | add-raf-test-run/state-open-recovery | f5ffcace-7236-4c99-a4a0-1d4ed8588190 | 5818abb + незакомічений тест (sha256 c75d03b1…), закомічено як a93769e | assertions-failed: 62 passed, 13 knownRed (усі нові 6.7.1), unexecuted/unknown 0, cleanup complete, timeoutCount 0 — [JSON](red-result.json) | 1 |
| hotfix (проміжний) | add-raf-test-run/state-open-recovery | 33fa53de-1f1b-42bd-a52f-eb824cecaa92 | a93769e + перша версія fix | assertions-failed: S05 legacy-identity зламано, тест resource port без conf. Правило й тест виправлено, див. нижче. | 1 |
| hotfix | add-raf-test-run/state-open-recovery | cea584d8-e53d-4d84-a635-5d60f3fc9b8f | a93769e + fix, закомічено як fc8a273 | passed 74/74, knownRed/unexecuted/unknown 0, cleanup complete, groupState complete — [JSON](hotfix-result.json) | 0 |
| hotfix, регресія 6.7 | add-raf-test-run/hotfix-637-638 | e9436338-2bc8-40b9-9724-60e187e12903 | те саме | passed 12/12 — [JSON](regression-hotfix-637-638-result.json) | 0 |

Тести 6.7.1 додано в налаштований файл `test/test-run-state-recovery.test.ts` (група `add-raf-test-run/state-open-recovery`). Нова група потребувала б запису в conf/test-runs.json, а conf поза межами запису цього доручення.

Після red два legacy-варіанти «released» перенесено в сценарії «kept». Причина: вони суперечили чинному S05 і тесту 6.7. До того ж реальний запис має явного власника, тож legacy-виняток не потрібен. Для тесту resource port додано корінь конфігурації `usageConfigurationRoot`. Інші red-тести не змінювались.

## Інші перевірки

- `node scripts/check-comments.ts` і `git diff --check` дали код 0. Модулі імпортуються.
- Повна перевірка типів недоступна: у workspace немає `@types/node` (як і в 6.7).
- Групи чужих змін, яких торкається код (`complete-raf-flow-contracts/z410` — test/test-run-legacy-in-flight.test.ts; `fix-raf-load-admission/test-reservations`), не запускались. Вибраний item не декларує `regressionGroups`. Main має прогнати їх за чинною політикою red.

## Наступний крок

Main переносить fix у raf-develop і робочу raf. Після випуску main повторює 1.4.1: перший прогін групи shared-libs має зняти утримання 3163a552 і стартувати.
