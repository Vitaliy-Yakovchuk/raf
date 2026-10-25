# 6.7 dev11 — повні 7 файлів на c53dadb (host, main, 2026-10-25)

Злиття: 8e8018e (dev10) + hotfix 5a467dd → c53dadb502a160abe995f79be158851506fd002f (= raf-develop 23968f5 + hotfix до 5a467dd). Скрипт — runner.sh (`env -u …`, HOME/TMPDIR = свіжий mktemp у /srv/dev, RAF_STATE_RECOVERY_EVIDENCE_ROOT на build і `timeout 1500 node --test` 7 файлів: hotfix-637-638, test-run-integration-runtime, test-run-reservations, test-run-legacy-in-flight, test-run-state-recovery-runtime, command-timing, test-run-queue).

Результат: build=0; exit=0; tests 175, pass 175, fail 0. ev/ — persistent evidence стендів (secscan 0).
