import hashlib
import json
import os
from pathlib import Path
import sys
import time

source = Path('/home/dev/.raf/tmp/7925501e-dffa-4cb5-8606-da86aec8e50a/codex-raf-results-PR5Cil')
target = Path(sys.argv[1])
target.mkdir(parents=True, exist_ok=True)
deadline = time.monotonic() + 1260
while time.monotonic() < deadline:
    for directory in source.iterdir():
        if not directory.is_dir():
            continue
        handles = []
        try:
            handles = [open(directory / name, 'rb') for name in ('stdout', 'stderr', 'result.json')]
            while time.monotonic() < deadline:
                handles[2].seek(0)
                manifest = handles[2].read()
                if manifest:
                    try:
                        result = json.loads(manifest)
                    except json.JSONDecodeError:
                        time.sleep(.01)
                        continue
                    streams = []
                    for handle in handles[:2]:
                        handle.seek(0)
                        streams.append(handle.read())
                    assert [len(stream) for stream in streams] == [result['stdoutBytes'], result['stderrBytes']]
                    public = json.loads(streams[0])
                    assert public['group'] == 'complete-raf-flow-contracts/z429'
                    for name, data in zip(('stdout.json', 'stderr.txt', 'capture.json'), [*streams, manifest]):
                        (target / name).write_bytes(data)
                    (target / 'sha256.json').write_text(json.dumps({name: hashlib.sha256((target / name).read_bytes()).hexdigest() for name in ('stdout.json', 'stderr.txt', 'capture.json')}, indent=2) + '\n')
                    print(json.dumps({'saved': str(target), 'runId': public['runId'], 'cliExitCode': result['code'], 'childExitCode': public['exitCode'], 'outcome': public['outcome']}))
                    sys.exit(0)
                time.sleep(.01)
        except FileNotFoundError:
            pass
        finally:
            for handle in handles:
                handle.close()
    time.sleep(.01)
raise TimeoutError('No complete result captured; do not rerun an unknown test outcome')
