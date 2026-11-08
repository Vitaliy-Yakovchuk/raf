# 1.2.13 — literal snapshot paths

Base: e4e1cf87643ea94415d19b181492f7228ff866fa; reviewed revision: base plus the production/test diff committed with this evidence.

The first real etchly failure is an ordinary tracked timestamped JSON filename containing colons, not shared-libs. `cause.json` and the predecessor metadata inventory identify the exact path. The configured shared-libs route is already implemented by a13230f10429e8748c7fb86c22c78ef90f374d4f.

Production scope: `src/test-run-quality.ts`, `prepareQualityExecution`, snapshot validation loop. Its responsibility remains to seal canonical inputs, validate source/baseline/selector provenance, and create the private execution copy. A named relativeSnapshotPath predicate now checks relative containment syntax independently of command selection syntax. Inputs are materialized with filesystem APIs, never shell interpolation. Request/selector validation remains at its existing boundary. Duplicate paths, absolute/parent paths, external realpaths, and changed bytes still fail before copy creation. Shared-library exceptions remain restricted to configured dependency roots. No resource limits were added.

Readability self-review: the new predicate names what it proves; the existing sharedDependency predicate names the sole external-root exception. The following guard explicitly combines path syntax, duplicate mapping, and realpath containment. Seal reads and private copy creation retain their original order and ownership. No new hidden state, helpers, nesting or user-visible UI was introduced. The rest of prepareQualityExecution was reviewed for preservation of its existing control flow; only this predicate changed.

RED used base production code (the initial candidate was saved outside the workspace and restored only after RED): 47 passed, 2 knownRed, no setup/import failures. GREEN: 49 passed, zero knownRed/unexecuted/unknown; child exit 0, CLI exit 0, cleanup complete, no timeout; group complete. See summary.json and immutable full TestRunResult files. RED displayed JSON was tool-truncated; the full raf JSON is present. stderr is saved separately from CLI and child codes. No repeat was made to recover display truncation.

The runtime regression materializes tracked and untracked timestamp/option-like/glob-like filenames and confirms copies stay unchanged when canonical files change. Existing selected tests independently verify configured shared-libs main/develop paths, dependency digests, tracked symlink materialization, rejection of foreign/wrong-branch/prefix-sibling/nested escapes and cycles, and snapshot sealing. These tests confirm existing shared-libs support without adding another exception.

Remaining: main activates the hotfix and the separately assigned etchly pilot retries against the real workspace. No real etchly quality run or activation was performed by this executor. Other change tasks remain open, so no archive.
