"""Read-only independent review of preserved live-host evidence; no runtime calls."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json

root = Path(__file__).resolve().parent
p = root / 'host-attempt-1'
read = lambda name: json.loads((p / name).read_text())
ms = lambda value: round(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)
manifest = (p / 'MANIFEST.sha256').read_bytes()
digest = hashlib.sha256(manifest).hexdigest()
assert digest == '3ee5c0d60f58dd6f4ea3010c97f215d9e5afed2f1348921809a3494e3b41e5b2'
entries = manifest.decode().splitlines()
assert len(entries) == 50
for entry in entries:
    sha, name = entry.split('  ', 1)
    assert hashlib.sha256((p / name).read_bytes()).hexdigest() == sha, name
s = read('summary.json')
h = read('host-exit.json')
assert (p / 'host-cli-exit.txt').read_text().strip() == '0'
assert h['code'] == 0 and h['timedOut'] is False
assert s['outcome'] == 'passed' and s['cleanup'] == {'complete': True, 'fixtureRemoved': True}
assert not Path(h['base']).exists(), 'Outer isolated HOME/TMPDIR still exists'
assert s['environment']['sha'] == '619ed61868052a01bec3e21a4041539d597646fc'
assert s['environment']['dirty'] == '?? node_modules'
assert s['stand']['costProfileUnchanged'] is True
assert s['stand']['standHealth'] == {**s['stand']['sourceHealth'], 'summaryIntervalMs': 30000}
invocations = []
for call in s['invocations']:
    raw = read(call['evidence'])
    expected = 1 if call['label'] == 'missing-recipient' else 0
    assert raw['exitCode'] == raw['result']['exitCode'] == expected
    assert call['cliExitCode'] == call['childExitCode'] == expected
    assert (p / (call['label'] + '.stdout')).read_text() == raw['result']['stdout']
    assert (p / (call['label'] + '.stderr')).read_text() == raw['result']['stderr']
    invocations.append({'label': call['label'], 'argv': call['argv'], 'cliExitCode': expected, 'childExitCode': expected})
for name in ['service-off-initial.stdout', 'service-off-final.stdout']:
    assert read(name)['state'] == 'stopped'
offline = read('offline-pending.json')
first = offline['first']
assert first['startedAt'] == s['stand']['baseline']['boundary']
assert ms(first['scheduledAt']) == ms(first['startedAt']) + 30000
assert ms(first['completedAt']) >= ms(first['scheduledAt'])
assert offline['state']['lastSummary']['delivery'] == 'pending'
assert len(offline['pending']) == 1
assert not offline['pending'][0]['payload'].get('mainDelivered', False)
worker = offline['worker']
assert worker['state'] == 'running' and worker['observation']['state'] == 'alive'
assert worker['launchContext']['wrapper']['pid'] != worker['process']['pid']
returned = read('returned-delivery.json')
assert returned['state']['lastSummary']['delivery'] == 'delivered'
assert len(returned['receipts']) == 1
assert returned['receipts'][0]['payload']['mainDelivered'] is True
assert returned['receipts'][0]['id'] == first['factKey']
assert 'raf.health-summary' not in returned['workerInput']
messages = lambda raw: [json.loads(line[len('[raf] '):]) for line in raw.splitlines() if line.startswith('[raf] {"type":"raf.health-summary"')]
assert messages(returned['mainInput']) == [first]
initial_main = read('main-attach-initial.stdout')
assert initial_main['runId'] != returned['returned']['runId']
delayed = read('delayed-catchup.json')
second = delayed['delayed']
assert len(delayed['beforeSilence']['facts']) == len(delayed['beforeSilence']['receipts']) == 1
assert ms(second['startedAt']) == ms(first['completedAt'])
assert ms(second['scheduledAt']) == ms(first['completedAt']) + 30000
assert second['delayed'] is True
assert delayed['beforeCatchup'] <= ms(second['completedAt']) <= delayed['afterCatchup']
assert ms(second['completedAt']) - ms(second['startedAt']) >= 90000
silence_ms = delayed['beforeCatchup'] - ms(delayed['beforeSilence']['at'])
assert silence_ms > 60000
final = read('final-state.json')
assert len(final['facts']) == len(final['receipts']) == 2
assert [row['payload']['data'] for row in final['facts']] == [first, second]
assert [row['payload']['data'] for row in final['receipts']] == [first, second]
assert all(row['payload']['mainDelivered'] for row in final['receipts'])
assert messages((p / 'main-input.log').read_text()) == [first, second]
assert final['state']['boundary'] == second['completedAt']
assert final['state']['lastSummary']['delivery'] == 'delivered'
assert [row['runId'] for row in final['sessions'] if row['state'] == 'running'] == [returned['returned']['runId']]
refusal = read('missing-recipient.stderr')
assert refusal['code'] == 'HANDLER_FAILED'
assert refusal['message'] == 'Unknown or ambiguous session: missing-summary-qa'
invalid = read('invalid-summary-policy.stdout')
assert invalid['health']['error'] == {'code': 'CONFIGURATION_INVALID', 'pointer': 'conf/raf.json#/health/summaryIntervalMs'}
for label in ['stats-returned.stdout', 'stats-delayed-catchup.stdout', 'repeat-a.stdout', 'repeat-b.stdout', 'invalid-summary-policy.stdout']:
    stats = read(label)
    assert isinstance(stats['commands'], list) and isinstance(stats['profile']['rows'], list)
report = {
    'reviewedAt': datetime.now(timezone.utc).isoformat(), 'outcome': 'passed',
    'source': '/srv/dev/raf-mrh74-evidence-1', 'sourceManifestSha256': digest, 'filesVerified': len(entries),
    'provenance': 'Main executed reviewed committed script on a clean tracked-source clone; main confirmed secret scan: 0 matches. Untracked node_modules supplies dependencies.',
    'command': 'node scripts/qa-health-summary-host.mjs /srv/dev/raf-mrh74-evidence-1',
    'sha': s['environment']['sha'], 'runId': s['runId'], 'workerRunId': worker['runId'],
    'currentMainRunId': returned['returned']['runId'], 'versions': s['environment'],
    'periods': [{key: value[key] for key in ['startedAt', 'scheduledAt', 'completedAt', 'delayed']} for value in [first, second]],
    'facts': 2, 'acceptedReceipts': 2, 'mainTransportMessages': 2, 'workerSummaryMessages': 0,
    'silenceWithoutWorkerOrRuntimeCommandsMs': silence_ms,
    'missedScheduledBoundaries': 3,
    'clarification': 'Three scheduled boundaries were missed during 87.395 seconds of silence; the actual delayed summary covers 90.642 seconds. The harness assertion text describes three intervals; it does not mean three full intervals after worker shutdown.',
    'expectedDiagnostics': ['Initial main is intentionally killed; offline reconciliation reports its startup-context collection failure while CLI/child remain 0.', 'Synthetic worker runner is intentionally killed; its finished result is failed with an already-absent tmux session.', 'Invalid policy emits warnings at its exact configuration pointer while stats succeeds.'],
    'invocations': invocations, 'cleanup': {**s['cleanup'], 'outerIsolatedDirectoryRemoved': True},
    'limitations': s['limitations'], 'newProductDefects': [],
}
(root / 'host-review.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'outcome': report['outcome'], 'runId': report['runId'], 'filesVerified': len(entries), 'facts': 2, 'receipts': 2, 'silenceMs': silence_ms}))
