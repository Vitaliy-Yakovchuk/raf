# Host6: native main ready, old actor close refused at arguments

Reviewed driver `c2c294699fc9abc13ec7237731289d24299f5cb8`, host `/srv/dev/sym72q6`, addressed `--resume-after-main-onboarding /srv/dev/s72-bDaBYe`. [stdout](stdout), [stderr](stderr), [exit](exit) and the complete original [ev](ev/summary.json) copied from the retained stand, with SHA-256 inventory, are preserved. Host exit is 1, cleanup incomplete/retained.

Actual Claude 2.1.310 admitted with warning, native UI empty composer and `/status` UUID verified: `7d5f21f6-8690-4d90-806d-615f4ad3d33b`, native PID 4193219. Production main attach succeeded with coordinator PID 4193184, main runId `101dc9f7-80fd-43ae-901e-cf2942692621`. See `ev/native-main-identity.json`, captured startup/status/ready screens and `ev/main-ready.json`. This is actual host evidence beyond unit environment selection.

The next request `agent close --id sym72-native --force` omitted required `--reason`; production returned CLI 1/INVALID_VALUE at arguments, completed/pending empty, retrySafe true. Original failed [request](ev/close-failed-native-attempt.json) and summary remain failed. No new actor or publication ran; actual-start remains completed from Host3, seven scenarios remain pending.

This is our driver defect, not a product validator defect. [Own red/fix/qa](../../qa-7.2-fixture-close-reason/README.md) checks the command through the actual CLI parser and supplies a factual reason. Addressed continuation reuses the already verified live main/coordinator and unique command labels; no native restart, new attachment or conversion is required. No live pass for the seven pending scenarios is claimed.
