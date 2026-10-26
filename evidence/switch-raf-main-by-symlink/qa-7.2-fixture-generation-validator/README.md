QA 7.2: cross-revision generation inventory

Host11 failed after the A→B symlink/Git switch, during generation registration, before handover. The driver used its own validator and consumer hash for the retained revision. Product validators remain unchanged. createStandGeneration now imports the validator from the inventoried root.

Initial setup-failed run de9644e5 is not red: the transformed fs double lacked writeFileSync after a separate fixture update. The double export was completed. Own assertion red 0267e49a (25 passed, one knownRed) reproduces the exact unproved library boundary. QA 6f6c0586 passes all 26 tests, including both revisions and rejection of mutation after sealing. Full unchanged result, stderr and CLI code are separate; child exitCode remains in result. Cleanup complete; no timeout, unknown or unexecuted tests; group complete. metadata.json preserves commands, workspace snapshot and outcomes. Unit green does not establish live release success.

The addressed host continuation --resume-after-generation-inventory asserts the exact retained intent, candidate, actor PID/runId/session and barrier. It calls product release.recover once, without re-preparing or re-publishing. It then continues the remaining native barriers, second release, rollback, pending report/message, handover and repeat-start. Live proof remains pending.
