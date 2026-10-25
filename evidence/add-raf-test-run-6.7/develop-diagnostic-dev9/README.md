# 6.7 dev9 — повні 7 файлів на 0b644c0 (host, main, 2026-10-25)

Злиття: ee99332 (dev8) + hotfix f509d4f → 0b644c0d36abdc77fa5b55ba8d1c5468ee9172d1. Скрипт — runner.sh (як dev8: `env -u …`, HOME/TMPDIR = свіжий mktemp у /srv/dev, RAF_STATE_RECOVERY_EVIDENCE_ROOT=/srv/dev/trr67-dev9-ev на build і на `timeout 1500 node --test` 7 файлів).

Результат: build=0; exit=1; tests 175, pass 173, fail 2: «S09/S10 real unit|integration CLI loss after-commit-before-delivery, child=early-exit» (~41.8 с кожен) — `Error: Stand CLI interrupted: SIGKILL` (test/helpers/state-recovery-host.ts:239). Решта S09/S10 CLI loss, S09 dead tree і 4 S10 normal — pass. Вміст evidence root — ev/ (secscan 0).
