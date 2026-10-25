# 6.7 dev10 — повні 7 файлів на 8e8018e (host, main, 2026-10-25)

Злиття: 0b644c0 (dev9) + hotfix b0045f2 → 8e8018e4b57a502532151ebd5014d8e787d512ed. Скрипт — runner.sh (як dev9: `env -u …`, HOME/TMPDIR = свіжий mktemp у /srv/dev, RAF_STATE_RECOVERY_EVIDENCE_ROOT на build і `timeout 1500 node --test` 7 файлів).

Результат: build=0; exit=1; tests 175, pass 173, fail 2: «S09/S10 real unit|integration CLI loss after-commit-before-delivery, child=early-exit» (~3.6–3.9 с, без SIGKILL) — AssertionError deepStrictEqual у original() (test/test-run-state-recovery-runtime.test.ts:46, виклик :131): actual command env містить зайвий `TMPDIR: …/raf-state-recovery-host-*/t/r-*`, якого немає в очікуваному. Решта — pass. ev/ — persistent evidence (secscan 0).
