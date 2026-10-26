# Z.395.4 — незалежна QA

U1–U6 перевірено адресним unit-прогоном `complete-raf-flow-contracts/z395-group-residue`: **29/29 passed**. RunId `f498b3eb-8761-44ee-867b-11f94154a16c`, CLI 0, child 0, `cleanup.complete=true`, `timedOut=false`, залишки `knownRed/unexecuted/unknown=[]`, `timeoutCount=0`, `groupState=complete`, `nextAction=complete`.

Точна команда, SHA `4dd23c0f893a65d5df09510ca5008247b46cab8a`, незакомічені чужі шляхи, версії, fingerprints, preset та timeout policy збережені в [before-run.json](before-run.json). Повний незмінений JSON результату — [unit.result.json](unit.result.json), отриманий транспорт — [unit.transport.txt](unit.transport.txt), метадані CLI — [unit.transport.json](unit.transport.json), stderr за контрактом публічного CLI — [unit.stderr.txt](unit.stderr.txt). Інструмент повернув злитий stdout/stderr: [unit.capture.json](unit.capture.json) явно фіксує відсутність доказу первісного розділення FD; отриманий вивід не урізаний. Не видаємо реконструкцію потоків за незалежний OS capture.

Ці тести використовують fake clock/state/spawn ports; вони не замінюють користувацький стенд SQLite/runner/CLI та не очищують історичні 20 ID чужого агрегату. Повторного unit-прогону без нової підстави не було.

[Матриця unit-доказу](unit-coverage.json): U1 — 2, U2 — 6, U3 — 8, U4 — 7, U5 — 3, U6 — 3 пройдені перевірки. U5 додає відсутні негативні межі removed, як вимагає дизайн, без дублювання попереднього 5.5.11.

Main підтвердив відсутність live preset і надав host-маршрут у поточній сесії: «напиши й закоміть у raf-develop host-скрипт … Я запущу на хості в чистому clone (conf поруч, без секретів сесії)». Драйвер та явні межі доказу — [scripts/qa-z395-group-residue-live.md](../../../scripts/qa-z395-group-residue-live.md).

[Host-передача](host-handoff.json) містить точну команду, SHA, receipt і підтверджену main чергу. Після постановки в чергу develop отримав hotfix merge `2b40b7b`; [аудит](merge-audit.json) зберігає змінені стики та fingerprints. Це не змінює SHA вже отриманого unit-доказу й не перетворює його на pass іншої або викладеної збірки.

Реальний host-стенд **succeeded**, драйвер CLI 0, [повний підсумок](host-2/evidence/summary.json). Перевірена збірка продукту — `2b521aa7350772752e1b3f23d9d8de70ddfdb4e3`, чистий source та чиста fixture `e46ede569bb38dca33d9d1620742bde0e4afa2ec` (додано лише два тести й sentinel). Node v26.12.1, Git 2.53.0, tmux 3.6. Build/fingerprints/config fingerprints/точні команди є у summary та `*.command.json`. Загальний дедлайн стенда — 1200000 ms з `integrationTests`; дочірні примітивні unit-fixtures дотримуються чинної unit policy. Жодного integration preset у conf не створено.

| Крок | runId | CLI / child | Результат |
| --- | --- | --- | --- |
| До авторизації | `554a184c-958a-407f-9d39-607cb32e5c25` | 1 / null | CALLER_UNAUTHORIZED; runner не стартував, unit SQLite не створена |
| Foreign A red | `4d387c06-0fbe-4c2a-9a45-de121c6a794a` | 1 / 1 | Assertions-failed, knownRed A |
| Target A red / B green | `20644f4a-0d8a-45ec-82e2-cf8a1456937c` | 1 / 1 | Assertions-failed, knownRed A, passed B |
| Foreign exact A green | `635ee218-111c-4275-98ea-4abe3156f44c` | 0 / 0 | Complete; target payload дослівно незмінний |
| Target лише B | `3692f058-d69a-4fc4-b210-a0c7b3532d6e` | 1 / 0 | Assertions-failed; A збережено, confirm-known-red, лише B в argv/passed/runner |
| Target exact A | `c6d7658e-1f86-4f3e-8a41-fb3cd0724236` | 0 / 0 | Passed/complete; knownRed/unexecuted/unknown порожні |

Усі прийняті кроки зберегли один автоматично обраний HOME, `timeoutCount=1`, `timedOut=false`, `cleanup.complete=true`. Snapshots 07/09 доводять ізоляцію target під час foreign pass; 09/11/13 — дослівне збереження foreign payload. Фінальний cleanup: процесів до cleanup і залишених процесів немає; власні stand/unit HOME видалені. [Оцінка прогонів](host-assessment.json), [перевірка 163 властивостей артефактів](artifact-verification.json), [manifest усіх незмінених потоків і метаданих](host-2/manifest.json). Самі `*.stdout` містять незмінений повний TestRunResult; `*.stderr`, `*.codes.json` і `*.command.json` відокремлюють stderr, CLI та child exitCode. Повторного QA-сценарію для оцінки артефактів не запускали.

Знайдено й виправлено один дефект власної fixture: видалення інших projects ламало чинний example `test run --project etchly` під час build. Початковий **failed** збережено у [host-1 summary](host-1/evidence/summary.json), [build stderr](host-1/evidence/build.stderr) та [manifest](host-1/manifest.json). На цій спробі всі користувацькі сценарії ще не виконувалися (`checks=[]`, `unitOwned=false`). Після власного fix `2b521aa7350772752e1b3f23d9d8de70ddfdb4e3` [той самий build](host-2/evidence/build.command.json) і перше виконання сценаріїв успішні. Це manual red → fix → green fixture; build/setup failure не видається за unit assertion-red продукту. Main виконав тільки дозволений host-запуск; діагностику, fix і оцінку зробив цей самий QA.

Межа автоматичного доказу: driver перевіряє реальні SQLite/runner/CLI, але caller зареєстрований fixture-записом із реальним PID/start/command. Native model runner, tool sandbox IPC, індукований timeout і викладка тут не перевірялися. Лічильник нової fixture ініціалізовано 1 до прийнятих запусків; після того рядки змінював лише продукт. Історичні 20 ID іншої групи не очищено. Tasks.md/checkbox не редагувалися: main підтвердив, що додасть цю адресу результату сам. Інші задачі зміни відкриті; archive/push не виконувалися.
