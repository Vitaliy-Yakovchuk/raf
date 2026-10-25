O=/srv/dev/work/orchestrator; R=/srv/dev/raf-merge-67-root/raf; OUT=/srv/dev/trr67-dev10-8e8018e; EV=/srv/dev/trr67-dev10-ev
exec 9>/srv/dev/hx.lock; flock 9
cd $O/raf-main && node bin/raf.ts resource wait --level normal >/dev/null 2>&1
mkdir -p $EV /srv/dev/raf-merge-67-root/conf; cp $O/conf/*.json /srv/dev/raf-merge-67-root/conf/
ln -sfn $O/raf-develop/node_modules $R/node_modules
T=$(mktemp -d /srv/dev/h-rd-XXXX)
E="env -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_SESSION_ID -u SSH_CONNECTION -u SSH_CLIENT -u CLAUDE_CODE_BRIDGE_SESSION_ID -u CLAUDE_CODE_MESSAGING_SOCKET -u TMUX -u TMUX_PANE -u CLAUDE_CONFIG_DIR -u RAF_ORCHESTRATOR_ROOT -u RAF_STATE_DIRECTORY -u RAF_SOCKET_PATH -u NODE_OPTIONS -u NODE_PATH LC_ALL=C HOME=$T TMPDIR=$T RAF_STATE_RECOVERY_EVIDENCE_ROOT=$EV"
(cd $R && $E node scripts/build.ts > $OUT.build 2>&1; echo build=$? >> $OUT.build; $E timeout 1500 node --test test/hotfix-637-638.test.ts test/test-run-integration-runtime.test.ts test/test-run-reservations.test.ts test/test-run-legacy-in-flight.test.ts test/test-run-state-recovery-runtime.test.ts test/command-timing.test.ts test/test-run-queue.test.ts > $OUT.stdout 2> $OUT.stderr; echo $? > $OUT.exit)
echo "exit=$(cat $OUT.exit)"; tail -1 $OUT.build; grep -E '^ℹ (tests|pass|fail)' $OUT.stdout; grep -E '^✖' $OUT.stdout | head -20
for x in stdout stderr build; do python3 /tmp/claude-1000/-srv-dev-work-orchestrator/66ae6b45-d042-4411-b940-fa110545b724/scratchpad/secscan.py $OUT.$x | tail -1; done
find $EV -type f | while read f; do python3 /tmp/claude-1000/-srv-dev-work-orchestrator/66ae6b45-d042-4411-b940-fa110545b724/scratchpad/secscan.py "$f" | tail -1; done | sort | uniq -c
rm -rf $T
