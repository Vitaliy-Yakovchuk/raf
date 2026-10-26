"""Separate archived CLI queue records, without running a test or changing raw files."""
import hashlib
import json
from pathlib import Path

REPORT = Path('/home/dev/.raf/tmp/9544bc6b-26ad-46b2-b451-c49084757909/raf-sym72-qa.json')
OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[2]
PREFIX = 'node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/c5d1e9bf-30a3-43b8-ae1e-0aec877403cf/raf-main/bin/raf.ts'
report = json.loads(REPORT.read_text())
references = {}
for finding in report['qa']['findings']:
    regression = finding.get('regression', {})
    if regression.get('kind') != 'unit':
        continue
    for phase in ('red', 'green'):
        reference = regression[phase]
        original = reference['stderrPath']
        if '/qa-7.2-stderr-separation/' in original:
            raise SystemExit('Already separated; refusing to replace provenance')
        references.setdefault(original, reference)
records = []
for original, reference in sorted(references.items()):
    source = Path(original)
    raw = source.read_bytes()
    result_path = Path(reference['resultPath'])
    result_raw = result_path.read_bytes()
    result = json.loads(result_raw)
    lines = raw.splitlines(keepends=True)
    queue = [json.loads(line) for line in lines]
    if not queue or any(entry.get('kind') != 'launch-queue.waiting' for entry in queue):
        raise SystemExit('Non-queue stderr found: ' + original)
    if any(entry.get('testRunId') != result['runId'] for entry in queue):
        raise SystemExit('Queue run identity mismatch: ' + original)
    stem = source.parent.name + '-' + result['phase']
    cli_path = OUT / (stem + '.cli.stderr')
    test_path = OUT / (stem + '.test.stderr')
    with cli_path.open('xb') as stream:
        stream.write(raw)
    with test_path.open('xb') as stream:
        stream.write(b'')
    records.append({
        'runId': result['runId'], 'group': result['group'], 'phase': result['phase'],
        'selection': result['selection'], 'outcome': result['outcome'],
        'command': PREFIX + ' test run --project raf --phase ' + result['phase'] + ' --group ' + result['group'] + ' --files test/production-start-layout.test.ts',
        'cliCode': reference['cliCode'], 'childExitCode': result['exitCode'],
        'originalStderrPath': original, 'originalStderrSha256': hashlib.sha256(raw).hexdigest(),
        'cliStderrPath': str(cli_path), 'cliQueueRecords': len(queue),
        'testStderrPath': str(test_path), 'testStderrBytes': 0,
        'testStderrSha256': hashlib.sha256(b'').hexdigest(),
        'resultPath': str(result_path), 'resultSha256': hashlib.sha256(result_raw).hexdigest(),
        'cleanup': result['cleanup'], 'timedOut': result['timedOut'],
        'knownRed': result['knownRed'], 'unexecuted': result['unexecuted'], 'unknown': result['unknown'],
        'groupState': result['groupState'], 'nextAction': result['nextAction'],
        'workspaceEvidenceDirectory': str(source.parent),
    })
(OUT / 'index.json').write_text(json.dumps({
    'basis': 'Main instruction in this session: broker recorded empty test stderr; old CLI queue service messages must be preserved separately. Every archived line independently parses as launch-queue.waiting for the same runId. No non-queue stderr was found.',
    'boundary': 'This is a derived separation of existing archived CLI output, not a new child stream capture or test run. Original files and complete TestRunResult bytes remain unchanged. Assertions stay in TestRunResult diagnostics, not stderr. Broker comparison is performed by raf report validation, not by this script.',
    'runs': records,
}, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'runs': len(records), 'queueRecords': sum(row['cliQueueRecords'] for row in records), 'nonQueueBytes': 0, 'index': str(OUT / 'index.json')}))
