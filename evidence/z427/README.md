# Z.427: version mismatch must warn during quota collection

The assignment is current: Z.335 requires a version mismatch to warn while the configured screen protocol continues. Two quota-only gates contradicted that contract: `screenDialog` rejected the capture before recognition and `parseQuotaScreen` rejected the parsed snapshot. Both gates are removed; the parser retains the actual version and adds the same warning as runner availability. Screen recognition, exact command submission, permissions, authentication, truncation and resource cleanup remain enforced.

## Test-first evidence

All commands used the trusted generation prefix:

```
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/9281a828-9083-4ebb-85d1-d129c1411c4f/raf-main/bin/raf.ts
```

Append the following exact arguments:

```
test run --project raf --phase red --group complete-raf-flow-contracts/z390-regress --files test/quota-collection.test.ts test/quota-screens.test.ts
test run --project raf --phase hotfix --group complete-raf-flow-contracts/z390-regress --files test/quota-collection.test.ts test/quota-screens.test.ts
```

The initial attempt with unconfigured `complete-raf-flow-contracts/z427` was refused before execution (files `red.*`, runId `dbbd470e-937e-48ed-80d4-bde0bb2b22cd`). It is not assertion red. Main then assigned the already registered `z390-regress` group; both files belong to it. The same group, files and QA HOME were used for the actual red and hotfix:

`/tmp/raf-unit-1000/1ee10007bf6d5e71b39d6a2873064a767eeb928e7910599b166a0d60270ff685`

| Phase | runId | CLI / child | Outcome | Group / next action |
| --- | --- | --- | --- | --- |
| red | da8b4ba9-5bb9-423e-80e7-14c48a386114 | 1 / 1 | assertions-failed; 34 passed, 3 knownRed | loaded, idle / implement |
| hotfix | d0c4c811-34fa-46df-94ec-6353f2115bbd | 0 / 0 | passed; 37 passed, no knownRed | loaded, complete / complete |

Both executed runs have empty unknown/unexecuted, no timeout, timeoutCount 0 and complete cleanup with no remaining PIDs. Full unchanged TestRunResult JSON, separated CLI exit code and stderr are stored in `red-assertions.*` and `hotfix.*`; `*.transport.json` also preserves the complete tool-returned combined stream. The base SHA is recorded in `*-head.txt` and the exact dirty tracked workspace in `*-workspace.patch`. The corrected existing agy version test had encoded the same obsolete strict gate; it now checks warning and reliable parsing. The new Claude tests cover verified 2.1.308, actual 2.1.310 (plain and decorated), and refusal of unknown/permission screens without input. `npm run build` and `git diff --check` passed; `build.transport.json` records the build completion.

## Readiness analysis

`observeRunnerScreen` in `src/runner-protocols.ts` has no version gate; readiness in `src/production-runtime.ts` uses actual screen recognition. The historical launch failure `f6b722d9-979f-4405-bee5-67b045e90768` retained `unknown_screen`, but no raw capture. Its exact historical screen cannot be established.

Main reproduced Claude 2.1.310 with `CLAUDE_CONFIG_DIR=/home/dev/.claude`, where onboarding state was absent. The supplied `/srv/dev/z427probe/cap-10.txt` is preserved as `claude-2.1.310-onboarding.txt`: it asks “Let's get started” and requests a text theme. This explains the fresh reproduction as an environment/onboarding screen; it does not prove a changed readiness protocol or the exact historical screen. No readiness recognition was relaxed or changed.

## Live host verification

Run the committed script from the root of a clean clone containing the fix:

```
node ./evidence/z427/host-quota.mjs --orchestrator /srv/dev/work/orchestrator --claude-home /home/dev --evidence /srv/dev/z427-fixed-result
```

The evidence directory must not exist. The script creates a private temporary Orchestrator Git topology and QA HOME for raf state/socket. In the isolated copy of `conf/raf.json`, Claude's quota invocation uses its supported `quota.env.HOME` override to select the real `/home/dev`; `CLAUDE_CONFIG_DIR` is removed. This preserves the required isolated raf state while Claude uses its normal authentication environment. The script never reads, copies or writes authentication/onboarding files. Claude may make its normal updates to its own HOME, as main explicitly authorized. The script requires installed 2.1.310 against configured 2.1.308, a fresh collected quota and a warning. It sends no model prompt. It records CLI exit separately, stdout/stderr, screen captures, source SHA, timeout and cleanup. Residual owned sessions/processes fail verification even when forcibly cleaned. A local TypeScript dependency is copied; no package install occurs. The host result will be recorded separately after main executes this command.

The initial committed script proposed copying authentication state into a private HOME. Main declined to run that version; the current revision removes all such reads/copies and uses the normal Claude HOME only for the Claude child invocation.

### Host result: passed

Main executed the clean clone `/srv/dev/z427h3/raf` at `2544b5b2b8cf26880f8c722b0fdc52af4a88bcbf`:

```
node ./evidence/z427/host-quota.mjs --orchestrator /srv/dev/work/orchestrator --claude-home /home/dev --evidence /srv/dev/z427-fixed-result3
```

`host-h3/` preserves the complete summary, actual Claude version, build result, quota stdout/stderr/exit metadata and outer script stdout/stderr/exit. Installed Claude is `2.1.310 (Claude Code)`, configured protocol remains `2.1.308`, fresh `collected:true` contains measured session/weekly windows and the required version warning. The runner's routing reason is `disabled`; explicit collection still succeeds as required. CLI and script both exit 0, no timeout, cleanup reports complete, no remaining observed owned processes, and the temporary stand was removed. No auth files were read/copied by the script. Main reports the secret scan found 0 hits. No screen capture files were produced by the script's observer; the actual parsed quota and native quota transport cleanup are the evidence, rather than an independently captured process lifecycle.

The first host invocation had an extra `.` argument and failed Usage validation before creating evidence. Attempt h2 at the same SHA failed during `git submodule add` because `/tmp` exceeded its disk quota (reported by main as Z.429); it never reached a quota probe. `host-attempts.json` records this distinction and the digest/size of its full summary, preserved losslessly as `host-h2-setup-summary.json.gz`. Main resolved the host setup condition before h3; no product code changed between h2 and h3.

Z.427 is complete. Other tasks in the change remain open, so this executor does not archive the change or edit its task checkboxes.

### Pre-activation regression correction

Main found that the initial fix also removed the independent version trust check for absolute agy credits. This is corrected without editing tests: version mismatch continues with a warning for quota windows, while absolute credit reliability still requires the verified version. The existing agy test was run red (39 passed, one assertion failure), then green (40 passed); the original Z.427 selection passed again (37 passed). Full commands, unchanged-test hashes, workspace snapshots, TestRunResult and build evidence are in [agy-regression/README.md](agy-regression/README.md).
