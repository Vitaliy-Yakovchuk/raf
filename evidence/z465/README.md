# Z.465 — пріоритет допуску тестів

Аудит 2026-10-26: доручення актуальне. Вимога «Єдина пріоритетна черга служби» у `openspec/changes/complete-raf-flow-contracts/specs/projects/raf/resource-wait/spec.md` задає hotfix/test → hotfix/agent → normal/test → normal/agent та FIFO класу. Початкові hasPending/prepare перевіряли сам факт непорожньої черги агентів.

Виправлення: dcf1fa29c3034e29037d8f5b7937e0fd1c56f0f3. Обидва gates використовують hasTestRunPredecessor з тим самим tier. Чергові записи зберігають довірений requestedTier; старі записи сумісні без міграції. Уже виданий permit та deferReservation збережені, інші ресурси перевіряються перед резервом. Не додано лімітів, timeout, відмов або CLI-параметрів.

## Перевірки

- Red: d7b045c8-188a-4633-8747-af54444ab3ef, CLI=1, child=1, assertions-failed; 4 knownRed, 5 passed; timeoutCount=0, timedOut=false, cleanup complete; unexecuted/unknown порожні; groupState=idle, nextAction=implement.
- Hotfix: 2cbd35d8-da78-4dc6-adb1-e74beba45149, CLI=0, child=0, passed; 151 passed, knownRed/unexecuted/unknown порожні; timeoutCount=0, timedOut=false, cleanup complete; groupState=complete, nextAction=complete. Початковий файл збережено у розширеному відборі тієї самої групи complete-raf-flow-contracts/z465; QA HOME не змінено.
- build: код 0, включає перевірку заборонених коментарів; git diff --check для власних шляхів — 0.

Точні команди, вибір, SHA/незакомічений стан, повні незмінені TestRunResult, stderr та окремі CLI/child exit codes — [manifest.json](manifest.json), red.* та hotfix.*. Знімок початкового тесту — red.test.txt; helper на час green — hotfix.helper.txt.

## Облік runtime

src/launch-state.ts:evaluateLaunchAdmissionInTransaction уже виключає runtime-reservation із unusedReservations, якщо живий процес підтверджений тією самою OS identity. OS available RAM уже враховує фактичне споживання; оцінка 1–2 GiB повторно не віднімається. Регресія 14 runtime × 2 GiB за 15 GiB available та запиту тесту 1 GiB дає 14 GiB remaining, а не від'ємний залишок. Непідтверджені резерви залишаються зарезервованими. Зміни цього обліку не потрібні. resource_usage містить sampled/partial значення, тому historical peak не підміняє поточний OS вимір.

Межа висновку: це unit-відтворення та аудит чинного коду, не реконструкція історичного production стану. Живе перенесення коду виконує main. Дві доставки main повернули HANDLER_FAILED («Recipient composer contains unrelated input»), без підтвердженої доставки; сторонні незакомічені файли не змінено.

Z.465 checkbox залишено raf. Інші відкриті S.5, M.2, Z.326, Z.403 не виконувалися; зміна не архівується.
