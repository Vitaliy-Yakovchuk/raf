import collections
import hashlib
import json
import pathlib
import sys

output = pathlib.Path(sys.argv[1])
reviews = []
for argument in sys.argv[2:]:
    base = pathlib.Path(argument)
    manifest = base / 'MANIFEST.sha256'
    if not manifest.exists():
        manifest = pathlib.Path(str(base) + '.sha256')
    manifest_bytes = manifest.read_bytes()
    entries = {}
    for line in manifest_bytes.decode().splitlines():
        digest, name = line.split('  ', 1)
        entries[name.removeprefix('./')] = digest
    names = [name for name in entries if name.endswith('/raf-hotfix/registry.json')]
    assert len(names) == 1
    registry_path = base / names[0]
    registry_bytes = registry_path.read_bytes()
    assert hashlib.sha256(registry_bytes).hexdigest() == entries[names[0]]
    assert registry_path.stat().st_mode & 0o222 == 0
    registry = json.loads(registry_bytes)
    generation = registry['generations'][registry['current']]
    prefix = str(pathlib.Path(registry['current']).relative_to(base)) + '/'
    counts = collections.Counter()
    for row in generation['files']:
        assert entries[prefix + row['path']] == row['sha256'], row['path']
        counts[row['path'].split('/')[0]] += 1
    summary = json.loads((base / 'summary.json').read_text())
    assert summary['reviewed'] == generation['commit']
    reviews.append({'host': str(base), 'reviewed': generation['commit'], 'manifestSha256': hashlib.sha256(manifest_bytes).hexdigest(),
                    'registryPath': names[0], 'registrySha256': entries[names[0]], 'generationRoot': registry['current'],
                    'generationFiles': len(generation['files']), 'evidenceFiles': counts['evidence'], 'byTopDirectory': dict(sorted(counts.items())),
                    'everyRegisteredFileHashMatchesHostManifest': True})
output.write_text(json.dumps({'reviews': reviews,
    'interpretation': 'The current hotfix-origin inventory recursively reads and hashes the sealed generation, including evidence, on every origin check. File counts are derived from immutable registered inventories and matched to host manifests. This establishes payload growth, not a per-file time model or permission to weaken provenance guards.'}, indent=2) + '\n')
print(json.dumps({'reviewedInventories': len(reviews), 'output': str(output)}))
