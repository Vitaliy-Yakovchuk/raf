# QA 7.2 · Host16 первісний failed

Main виконав a2dfc7ea66a2430a3362ba1db72c89d25eee3b10 --resume-after-verification-home /srv/dev/s72-bDaBYe на чистому клоні. CLI1, completed actual-start/develop-main, решта шість pending, cleanup retained. До нових service/release/native команд: ENOENT ev-native-verification-home/runner-list.json. Branch переніс release evidence, але не runner-list/runner-limits/launch capture перед спільною валідацією. Жоден попередній release/runner command не запускається повторно для fix.

Main-supplied stdout/stderr/exit та всі ev-clean скопійовані незмінно (secscan0 за main); sha256.json адресує кожен файл. Own assertion red/green фіксуються в qa-7.2-fixture-retained-captures. Нове продовження має exclusive evidence/control prefix, спочатку перевіряє цей точний failed без service invocation, потім копіює точні captures з Host15.

Окремий read-only факт після Host16: actor5 уже мав actual production-accepted success 05:12:14.059Z, але пізніше власний wait4 завершився timeout та записав failed файл. accepted-actor-after-host16.json і post-acceptance-failed-report.json зберігають обидва оригінальні стани. Це не дозвіл підмінити failed. Native процес і початковий accepted JSON перевіряються незалежно; первісна помилка й обмеження full native proof зберігаються.
