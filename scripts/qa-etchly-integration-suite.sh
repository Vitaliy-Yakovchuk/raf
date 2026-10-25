#!/usr/bin/env bash
# Main runs this on the host. Each mode gets its own new clean stand.
set -u
source_root=$1
suite_root=$2
raf_sha=$3
etchly_sha=$4
shared_sha=$5
umask 077
mkdir -m 700 -- "$suite_root" || exit 1
suite_rc=0
for mode in smoke d08; do
  stand_root="$suite_root/$mode"
  node "$source_root/raf-develop/scripts/qa-etchly-integration-prepare.mjs" "$source_root" "$stand_root" "$raf_sha" "$etchly_sha" "$shared_sha" >"$suite_root/$mode.prepare.stdout" 2>"$suite_root/$mode.prepare.stderr"
  prepare_rc=$?
  printf '%s\n' "$prepare_rc" >"$suite_root/$mode.prepare.rc"
  if [ "$prepare_rc" -ne 0 ]; then
    suite_rc=1
    printf '%s preparation failed (rc=%s); inspect %s\n' "$mode" "$prepare_rc" "$suite_root"
    continue
  fi
  # These are explicit stand-only budgets, recorded by the driver. They do not
  # alter working configuration, unit policy or the assigned group's HOME.
  budget_ms=1200000
  watchdog_ms=3000000
  if [ "$mode" = d08 ]; then budget_ms=60000; watchdog_ms=900000; fi
  node "$stand_root/raf-develop/scripts/qa-etchly-integration-host.mjs" "$stand_root" "$stand_root/results" "$mode" "$budget_ms" "$watchdog_ms" >"$suite_root/$mode.driver.stdout" 2>"$suite_root/$mode.driver.stderr"
  driver_rc=$?
  printf '%s\n' "$driver_rc" >"$suite_root/$mode.driver.rc"
  if [ "$driver_rc" -ne 0 ]; then suite_rc=1; fi
  printf '%s driver rc=%s; artifacts=%s/results\n' "$mode" "$driver_rc" "$stand_root"
done
printf '%s\n' "$suite_rc" >"$suite_root/suite.rc"
exit "$suite_rc"
