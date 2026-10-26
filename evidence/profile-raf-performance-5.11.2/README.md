# profile-raf-performance 5.11.2 — hotfix fixture conf

Виконавець raf-prp5112-hotfix, raf-hotfix (baseCommit ec8d770118d3b8d27c8a4a4da79884045addf19b), 2026-10-26.

| Крок | Команда | SHA / workspace | runId | Outcome, CLI exit | Файли |
|---|---|---|---|---|---|
| red | `raf test run --project raf --phase red --group profile-raf-performance/hotfix-fixture-conf` | тест 38045baca0edd8f12f37f18ca49fba1e69db2fec; fixture незмінена | d4375473-2264-49f2-83ad-a417f7a7992d | assertions-failed, 1; knownRed 1 (BUILD_FAILED INVALID_VALUE у test/hotfix-fixture.ts:113), passed 1 (негативний), unexecuted/unknown 0, timeout ні, cleanup complete | red.result.json, red.stderr, red.cli-exit-code |
| hotfix | той самий з `--phase hotfix` | fix до коміту 91362cffa30cf08938d184fe4e03ed2a0c5437a9 (незакомічений лише test/hotfix-fixture.ts, рядок звуження projects видалено) | 5d011883-2668-4fa9-911e-99228f7944e1 | passed, 0; 2/2, groupState complete | hotfix.result.json, hotfix.cli-exit-code |
| reconcile module-origin-cost | `raf test run --project raf --phase hotfix --group profile-raf-performance/module-origin-cost` | 91362cff… | 962be2e1-f640-41a6-842c-b5d58daf1f4f (попередній прогін 5.11.1) | setup-failed, 1; «Original runner protocol unavailable after owner loss», cleanup complete, nextAction reconcile | module-origin-cost.reconcile.output |
| повтор module-origin-cost | та сама | HEAD 8999c64 (чужі коміти 5.12/Z.428 після 91362cff; незакомічені чужі зміни в робочому дереві) | 17a06f80-ce8d-4b36-abec-52773ef38143 | timed-out, 1; passed 107 (hotfix-origin-cost 101, hotfix-activation 6), knownRed 7, unexecuted 53, unknown 0, timeoutCount 1, cleanup complete, nextAction optimize | module-origin-cost.repeat.output |

Висновок: BUILD_FAILED/setup-failed у module-origin-cost усунуто. Збірка фікстури проходить, і на неї спирається 101/101 тест hotfix-origin-cost. Валідацію прикладів у src/catalog.ts не змінено, а негативний тест підтверджує відмову для незареєстрованого проєкту.

Залишок групи — окремий дефект поза 5.11.2. Сім тестів `[hotfix-gates]`/`[hotfix-snapshot]` у test/hotfix-activation.test.ts падають у verifyHotfixCandidate (src/hotfix-activation.ts:277) з «Message delivery failed: Recipient has no recognized empty agent composer» (src/message-delivery.ts:24). Після цього настає межа timeout 1200000 мс, і 53 тести лишаються невиконаними. Тому 5.11.1 лишається відкритим.
