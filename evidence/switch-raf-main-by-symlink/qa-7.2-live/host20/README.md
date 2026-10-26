# Host20: завершення cleanup, CLI 0

Main виконав на чистому клоні 98e69cc36ffb1f107af974032abf714074190e61:

```
node scripts/qa-main-symlink-cleanup.mjs 98e69cc36ffb1f107af974032abf714074190e61 /srv/dev/s72-bDaBYe
```

Оригінальні stdout/stderr/exit скопійовані з /srv/dev/sym72q20, усі чотири JSON — з /srv/dev/s72-bDaBYe/ev-native-cleanup-service. manifest.json фіксує SHA256 і довжину незмінених файлів. Stderr порожній, CLI 0. Main окремо повідомив, що Host19 із зайвим аргументом `.` відмовив 5!==4 до дій; це його помилка виклику, не дефект fixture. До повтору valid cleanup жодного stop/start не виконували.

Фактичний retained PID2047034/startTicks33672167/boot/mainPath/serviceEpoch звірено з prepared service та repeat-start. Status перед stop — ready/resourceWaitReady=true. Штатний socket stop → stopped/pid:null/Service stopped normally; після stop — stopped. Epoch у записі незмінний. Нових процесів не запускали, сигналів не надсилали. Повний scan: processes=[], nativeProcessGone=true, cleanup.complete=true. Live stages/commands не повторені.

Original Host17 summary SHA256 13f807e18d72385bb00db006281f694f89afa9370dd662d09ff1ce122fa37df0 лишився failed з усіма 8 completed і pending=[]. Accepted successful actor runId36182376-28f6-46b4-88ec-66d72f53a0d3 та current finished/succeeded перевірено без нового повідомлення чи звіту. Host17/18 failed докази зберігаються. Цей green доводить лише раніше незавершений cleanup; попередні live-результати беруться з їхніх первісних артефактів.
