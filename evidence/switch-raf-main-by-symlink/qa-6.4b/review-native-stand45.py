"""Review copied, cleaned native evidence without reading owner state or raw reasoning."""
import collections
import hashlib
import json
from pathlib import Path
import re
import shlex

BASE = Path(__file__).parent / 'native-completed-s64-oF3uEe'
ROOT = '/srv/dev/s64-oF3uEe/root'


def read(name):
    return json.loads((BASE / name).read_text())


def digest(data):
    return hashlib.sha256(data).hexdigest()


summary = read('summary.json')
assert summary['reviewed'] == '4e1d2345b9d4134df73e03fb9fb2f88c6b311db1'
assert summary['status'] == 'native-completed-review-required'
assert not summary.get('error') and not summary.get('cleanupErrors') and not summary.get('copyErrors')
assert (BASE / 'host-exit.txt').read_text().strip() == 'sym64m=0'
assert (BASE / 'host-stderr.txt').read_text() == ''
assert [s['action'] for s in summary['switches']] == ['switch', 'switch', 'rollback']
assert [s['active'] for s in summary['switches']] == [ROOT + '/raf-main-b', ROOT + '/raf-main-a', ROOT + '/raf-main-b']
assert summary['switches'][0]['target'] == summary['switches'][2]['target']
assert summary['switches'][1]['target'] != summary['switches'][0]['target']
assert summary['serviceProcessCleanup']['complete'] and summary['serviceProcessCleanup']['remaining'] == []
assert all(r['cliExitCode'] == 0 and r['signal'] is None and not r['stderr'] for r in summary['cleanup'])
assert summary['tmuxCleanup']['cliExitCode'] == 0
assert read('metadata-before-exit.json') == read('metadata-after-exit.json')
assert read('metadata-before-policy.json') == read('metadata-after-native-launch.json') == read('metadata-after-refused-launch.json')
assert summary['refusedLaunch']['result']['cliExitCode'] != 0
assert 'STATE_CONTEXT_REFUSED' in summary['refusedLaunch']['result']['stderr']
assert summary['liveSplit']['sourceDuring'] == summary['switches'][0]['target']

for index in range(3):
    assert read(f'metadata-before-probe-{index}.json') == read(f'metadata-after-probe-{index}.json')
    assert read(f'read-controls-before-{index}.json') == read(f'read-controls-after-{index}.json')
    assert read(f'socket-controls-before-{index}.json') == read(f'socket-controls-after-{index}.json')
    before = read(f'metadata-before-probe-{index}.json')
    lock = before['production']['children']['refs']['children']['heads']['children']['qa-native-host.lock']
    assert lock == summary['hostGitControls'][index]['lawfulLock']
    assert len(summary['hostGitControls'][index]['hostCommit']) == 40
    for endpoint in range(2):
        r = read(f'after-{index}-endpoint-{endpoint}.json')
        assert r['cliExitCode'] == 0 and r['signal'] is None and not r['stderr']

for label in ['before', 'after-host-service-drain', 'unproven-reader-held', 'after-live-split', 'after-0', 'after-1', 'after-2']:
    control = read(label + '-controls.json')
    assert len(control['endpoints']) == 2 and all(e['socket'] and e['ino'] > 0 for e in control['endpoints'])
    for session in control['sessions']:
        if session['addressId'] in ['main', 'sym64-a', 'sym64-b']:
            assert session['state'] == 'running' and session['observation']['state'] == 'alive'

audits = [(p.name, json.loads(p.read_text())) for p in (BASE / 'cli-audit').glob('*.json') if not p.name.startswith('policy-')]
channels, helpers, actors, denials = [], [], [], []
counts = collections.Counter()

for actor in summary['actors']:
    name, run_id = actor['address'], actor['runId']
    initial = read(name + '/session.json')
    final = read(name + '-final/session.json')
    assert initial['process'] == final['process'] == actor['process']
    brief = (BASE / name / 'run/brief.txt').read_bytes()
    assert digest(brief) == actor['briefSha256']
    assert brief == (BASE / (name + '-final') / 'run/brief.txt').read_bytes()
    assignment = json.loads(brief.decode()[brief.decode().rindex('\n\n{\n  "project"') + 2:])
    assert assignment['agent_id'] == name and assignment['root'] == ROOT
    assert 'agent close' not in assignment['raf_subcommands']
    prefix = assignment['raf_command']
    peer = 'sym64-b' if name == 'sym64-a' else 'sym64-a'
    events = [json.loads(line) for line in (BASE / name / (name + '.events.jsonl')).read_text().splitlines()]
    native_id = next(e['payload']['id'] for e in events if e['type'] == 'session_meta')
    assert native_id == initial['process']['runnerSessionId']
    policy_file = next((BASE / name / 'run').glob('codex-sandbox-*/policy.json'))
    policy = json.loads(policy_file.read_text())
    filesystem = policy['filesystem']
    assert filesystem[ROOT + '/raf-develop'] == 'write'
    for target in [ROOT + '/raf-main-a', ROOT + '/raf-main-b', ROOT + '/.git/modules/raf-main/raf-hotfix']:
        assert filesystem[target] == 'read'
    assert filesystem[ROOT + '/raf-develop/qa/peer.sock'] == 'none'
    assert filesystem['/srv/dev/s64-oF3uEe/.raf'] == 'none'
    actors.append({'actor': name, 'runId': run_id, 'nativeSessionId': native_id, 'process': {k: initial['process'][k] for k in ['pid', 'startedAt']}, 'briefSha256': digest(brief), 'issuedPrefix': prefix, 'policy': str(policy_file.relative_to(BASE)), 'filesystem': filesystem})

    outputs = {e['payload']['call_id']: e for e in events if e.get('payload', {}).get('type') in ['custom_tool_call_output', 'function_call_output']}
    helper_sessions = {}
    completed_stages = {}
    channel_index = 0
    for line_index, event in enumerate(events):
        payload = event.get('payload', {})
        if payload.get('type') != 'custom_tool_call':
            continue
        code = payload['input']
        command_match = re.search(r'cmd\s*:\s*("(?:\\.|[^"\\])*")', code)
        session_match = re.search(r'session_id\s*:\s*(\d+)', code)
        command = json.loads(command_match[1]) if command_match else None
        output = outputs[payload['call_id']]
        blocks = output['payload']['output']
        if isinstance(blocks, str):
            cell = re.search(r'Script running with cell ID (\S+)', blocks)[1]
            wait = next(e for e in events[line_index + 1:] if e.get('payload', {}).get('type') == 'function_call' and e['payload']['name'] == 'wait' and json.loads(e['payload']['arguments'])['cell_id'] == cell)
            output = outputs[wait['payload']['call_id']]
            blocks = output['payload']['output']
        assert isinstance(blocks, list)
        if command and command.startswith(prefix + ' agent '):
            suffix = ['after-B', 'after-A', 'after-rollback'][channel_index // 2]
            is_ps = channel_index % 2 == 1
            expected = prefix + ' agent ps' if is_ps else prefix + f' agent message --to {peer} --text {name}-{suffix}'
            assert shlex.split(command) == shlex.split(expected), (name, channel_index, command, expected)
            stdout, metadata = blocks[1]['text'], json.loads(blocks[2]['text'])
            assert metadata['exit_code'] == 0 and 'session_id' not in metadata
            argv = shlex.split(command)[2:]
            matches = [(file, audit) for file, audit in audits if audit['argv'] == argv and stdout == audit['result']['stdout'] + '\n']
            assert len(matches) == 1
            file, audit = matches[0]
            assert audit['result']['exitCode'] == 0 and audit['result']['stderr'] == ''
            index = channel_index // 2
            assert audit['module'] == 'file://' + summary['switches'][index]['generation']['root'] + '/bin/raf.ts'
            if is_ps:
                sessions = json.loads(stdout)
                assert len(sessions) == 3 and metadata['sym64PsOutputComplete']
                assert {s['addressId'] for s in sessions} == {'main', 'sym64-a', 'sym64-b'}
                assert all(s['state'] == 'running' for s in sessions)
            else:
                assert json.loads(stdout)['accepted'] is True
                assert index in completed_stages
            channels.append({'actor': name, 'runId': run_id, 'stage': index + 1, 'kind': 'ps' if is_ps else 'message', 'command': command, 'sourceLine': event['sourceLine'], 'cleanedLine': line_index + 1, 'outputSourceLine': output['sourceLine'], 'cliExitCode': 0, 'stderr': '', 'stdoutCharacters': len(stdout), 'stdoutSha256': digest(stdout.encode()), 'exactAudit': 'cli-audit/' + file, 'module': audit['module'], 'nativeStdoutExactlyEqualsAuditPlusNewline': True})
            channel_index += 1
        elif command and command.startswith('node qa/sym64-probe.mjs ') or session_match:
            stage = int(command.split()[2]) if command else helper_sessions[int(session_match[1])]
            metadata = json.loads(blocks[-1]['text'])
            if 'session_id' in metadata:
                helper_sessions[metadata['session_id']] = stage
            else:
                assert metadata['exit_code'] == 0
                receipt = json.loads(blocks[1]['text'])
                report = name + '/run/' + ('sym64-source-0.json' if stage == 0 else f'sym64-stage-{stage}.json')
                assert receipt['sha256'] == digest((BASE / report).read_bytes())
                assert receipt['stage'] == stage and receipt['runId'] == run_id and receipt['status'] == 'passed'
                completed_stages[stage] = event['sourceLine']
                helpers.append({'actor': name, 'stage': stage, 'finalExitCode': 0, 'finalOutputSourceLine': output['sourceLine'], 'report': report, 'sha256': receipt['sha256']})
        elif 'sym64NativeCompleted:3' in code:
            assert completed_stages.keys() == {0, 1, 2, 3}
            assert completed_stages[3] < event['sourceLine']
            assert json.loads(blocks[1]['text']) == {'sym64NativeCompleted': 3, 'runId': run_id, 'finalCliExitCode': 0}
    assert channel_index == 6 and completed_stages.keys() == {0, 1, 2, 3}

    for stage in range(4):
        file = name + '/run/' + ('sym64-source-0.json' if stage == 0 else f'sym64-stage-{stage}.json')
        proof = read(file)
        assert proof['status'] == 'passed' and proof['runId'] == run_id
        for result in proof['results']:
            assert result['signal'] is None and not result.get('error')
            if result['label'].startswith('deny'):
                assert result['cliExitCode'] != 0
                assert re.search(r'EROFS|EACCES|EPERM|ENOENT|Read-only file system|Permission denied', result['stderr'])
                if 'ENOENT' in result['stderr']:
                    assert result['label'].startswith(('deny state ', 'deny foreign connection '))
                    controls = read(name + f'/run/sym64-read-controls-{stage}.json')
                    assert controls['briefSha256'] == actor['briefSha256'] and controls['agentId'] == name
                    if result['label'].startswith('deny state '):
                        filename = result['label'].split()[2]
                        assert any(c['path'].endswith('/' + filename) and c['regularFile'] and c['ino'] > 0 for c in controls['files'])
                    else:
                        assert all(c['socket'] and c['ino'] > 0 and c['runId'] for c in controls['sockets'])
                if result['label'] == 'deny unauthorized CLI close':
                    assert result['command'] == ['node', prefix[5:], 'agent', 'close', '--id', peer]
                    assert result['cliExitCode'] == 1 and result['stdout'] == ''
                    error = json.loads(result['stderr'])
                    assert error['code'] == 'PRODUCTION_ENTRY_FAILED'
                    assert error['message'].startswith("EROFS: read-only file system, mkdir '" + ROOT + '/.git/modules/raf-main/raf-hotfix/activation.lock.owner-')
                    denials.append({'actor': name, 'stage': stage, 'report': file, 'actualResult': result})
                if 'foreign connection' in result['label']:
                    assert result['cliExitCode'] == 19
                counts['negative'] += 1
            else:
                assert result['cliExitCode'] == 0
                if result['label'].startswith('allow own IPC'):
                    assert result['stdout'] == 'own'
                counts['positive'] += 1
            counts['total'] += 1

assert len(channels) == 12 and len(denials) == 6 and len(helpers) == 8
assert len(summary['actorCommits']) == 16 and all(c['verifiedAfterExit'] for c in summary['actorCommits'])
git_proofs = [read(p.name) for p in BASE.glob('git-*.json')]
assert len(git_proofs) == 32 and all(p['cliExitCode'] == 0 for p in git_proofs)
for commit in summary['actorCommits']:
    for args in [['cat-file', '-e', commit['oid'] + '^{commit}'], ['merge-base', '--is-ancestor', commit['oid'], 'HEAD']]:
        assert any(p['command'] == ['git', '--no-optional-locks', '-C', commit['repository'], *args] for p in git_proofs)
incoming = read('incoming.json')
assert digest((BASE / 'incoming.json').read_bytes()) == 'a3460b94b07acd2e487f7274d02550f15952b76656582c520038ba64115ab47d'
assert incoming['redactionEdits'] == 0
native_source = read('native-source-manifest.json')
deliveries = []
for actor in actors:
    recipient = actor['actor']
    sender = 'sym64-b' if recipient == 'sym64-a' else 'sym64-a'
    sender_identity = next(a for a in actors if a['actor'] == sender)
    assert incoming['sourceSha256'][recipient + '-final'] == native_source['sourceSha256'][recipient[-1]]
    final_items = incoming['items'][recipient + '-final']
    assert final_items[:3] == incoming['items'][recipient]
    for stage, suffix in enumerate(['after-B', 'after-A', 'after-rollback'], 1):
        marker = sender + '-' + suffix
        item = final_items[stage - 1]
        assert item['kind'] == 'response_item.message.user'
        assert item['text'] == '[' + sender + '] ' + marker
        channel = next(c for c in channels if c['actor'] == sender and c['stage'] == stage and c['kind'] == 'message')
        audit = read(channel['exactAudit'])
        accepted = json.loads(audit['result']['stdout'])
        assert accepted['accepted'] is True
        # sourceLine is in the recipient transcript, independently of the sender call.
        assert isinstance(item['sourceLine'], int) and item['sourceLine'] > 0
        deliveries.append({'from': sender, 'fromRunId': sender_identity['runId'], 'to': recipient, 'toRunId': actor['runId'], 'marker': marker, 'status': 'received-in-native-user-item', 'recipientSourceLine': item['sourceLine'], 'recipientTimestamp': item['timestamp'], 'recipientNativeSha256': incoming['sourceSha256'][recipient + '-final'], 'senderSourceLine': channel['sourceLine'], 'senderCliReceipt': accepted, 'senderAudit': channel['exactAudit']})
assert len(deliveries) == 6
(BASE / 'delivery-review.json').write_text(json.dumps({'status': 'passed', 'incomingSource': read('incoming-source.json'), 'deliveries': deliveries, 'durableReceiptLimitation': 'No separate durable receipt rows exist; acceptance is demonstrated by exact native recipient user-role items plus independent sender CLI accepted receipts, linked through native source hashes and actor runIds.'}, ensure_ascii=False, indent=2) + '\n')
result = {'status': 'passed', 'reviewed': summary['reviewed'], 'actors': actors, 'channels': channels, 'negativeCli': denials, 'helperCompletions': helpers, 'probeCounts': dict(counts), 'actorCommits': summary['actorCommits'], 'postExitCommitProofCommands': len(git_proofs), 'metadataUnchangedBeforeAfterEachProbeAndExit': True, 'hostEndpointsAndAllActorsLiveAtEveryControl': True, 'cleanupComplete': True, 'nodeExitCode': 0, 'nativeSource': native_source, 'independentIncomingDeliveries': 'delivery-review.json', 'nativeAcceptance': True}
(BASE / 'execution-review.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'channels': len(channels), 'negativeCli': len(denials), 'helpers': len(helpers), 'probes': dict(counts), 'incomingDeliveries': len(deliveries), 'status': result['status']}))
