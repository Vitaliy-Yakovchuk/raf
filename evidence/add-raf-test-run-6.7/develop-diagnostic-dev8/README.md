# 6.7 dev8 — повні 7 файлів на ee99332 (host, main, 2026-10-25)

Злиття (throwaway-клон /srv/dev/raf-merge-67-root/raf): raf-develop e3a9990 (= develop 23968f5 + hotfix 6.7 до 0181b02) + hotfix 5146c11 → ee993321293ad18a50a9aab6b15d74d1015d5613. Точний скрипт — runner.sh (`env -u …` + HOME/TMPDIR = свіжий mktemp у /srv/dev + RAF_STATE_RECOVERY_EVIDENCE_ROOT=/srv/dev/trr67-dev8-ev стоять і на build, і на `timeout 1500 node --test` 7 файлів).

Увага щодо dev5/dev6: там env-префікс (з HOME/TMPDIR) стояв лише на build, а `node --test` ішов із HOME/TMPDIR сесії main.

Результат: build=0; exit=1; tests 175, pass 165, fail 10 — усі 10 «S09/S10 real unit|integration CLI loss …» з `AssertionError: Path outside owned stand: /srv/dev/trr67-dev8-ev/raf-state-recovery-host-*` (test/test-run-state-recovery-runtime.test.ts:38, виклик :69). S09 dead tree і 4 S10 normal — pass. Вміст evidence root — ev/ (secscan 0 для всіх файлів).
