# Z.395.4 — незалежна QA

U1–U6 перевірено адресним unit-прогоном `complete-raf-flow-contracts/z395-group-residue`: **29/29 passed**. RunId `f498b3eb-8761-44ee-867b-11f94154a16c`, CLI 0, child 0, `cleanup.complete=true`, `timedOut=false`, залишки `knownRed/unexecuted/unknown=[]`, `timeoutCount=0`, `groupState=complete`, `nextAction=complete`.

Точна команда, SHA `4dd23c0f893a65d5df09510ca5008247b46cab8a`, незакомічені чужі шляхи, версії, fingerprints, preset та timeout policy збережені в [before-run.json](before-run.json). Повний незмінений JSON результату — [unit.result.json](unit.result.json), отриманий транспорт — [unit.transport.txt](unit.transport.txt), метадані CLI — [unit.transport.json](unit.transport.json), stderr за контрактом публічного CLI — [unit.stderr.txt](unit.stderr.txt). Інструмент повернув злитий stdout/stderr: [unit.capture.json](unit.capture.json) явно фіксує відсутність доказу первісного розділення FD; отриманий вивід не урізаний. Не видаємо реконструкцію потоків за незалежний OS capture.

Ці тести використовують fake clock/state/spawn ports; вони не замінюють користувацький стенд SQLite/runner/CLI та не очищують історичні 20 ID чужого агрегату. Повторного unit-прогону без нової підстави не було.

[Матриця unit-доказу](unit-coverage.json): U1 — 2, U2 — 6, U3 — 8, U4 — 7, U5 — 3, U6 — 3 пройдені перевірки. U5 додає відсутні негативні межі removed, як вимагає дизайн, без дублювання попереднього 5.5.11.

Main підтвердив відсутність live preset і надав host-маршрут у поточній сесії: «напиши й закоміть у raf-develop host-скрипт … Я запущу на хості в чистому clone (conf поруч, без секретів сесії)». Драйвер та явні межі доказу — [scripts/qa-z395-group-residue-live.md](../../../scripts/qa-z395-group-residue-live.md). Реальний прохід залишається непідтвердженим до повернення та перевірки host-доказів; підготовка драйвера не є pass.

[Host-передача](host-handoff.json) містить точну команду, SHA, receipt і підтверджену main чергу. Після постановки в чергу develop отримав hotfix merge `2b40b7b`; [аудит](merge-audit.json) зберігає змінені стики та fingerprints. Це не змінює SHA вже отриманого unit-доказу й не перетворює його на pass іншої або викладеної збірки.
