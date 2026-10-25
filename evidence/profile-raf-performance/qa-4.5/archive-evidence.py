import hashlib
import json
import pathlib
import sys

source, destination = map(pathlib.Path, sys.argv[1:3])
expected_hash, expected_count = sys.argv[3], int(sys.argv[4])
manifest_path = source / 'MANIFEST.sha256'
if not manifest_path.exists():
    manifest_path = pathlib.Path(str(source) + '.sha256')
manifest = manifest_path.read_bytes()
assert hashlib.sha256(manifest).hexdigest() == expected_hash
entries = {}
for line in manifest.decode().splitlines():
    digest, name = line.split('  ', 1)
    name = name.removeprefix('./')
    assert not pathlib.PurePosixPath(name).is_absolute() and '..' not in pathlib.PurePosixPath(name).parts
    assert name not in entries
    entries[name] = digest
assert len(entries) == expected_count
assert not destination.exists(), 'Do not overwrite an earlier evidence archive'
destination.mkdir(parents=True)
selected = []
for name, digest in entries.items():
    top_log = '/' not in name and (name in ['stdout', 'stderr'] or name.endswith(('.stdout', '.stderr')))
    if not (name.startswith('ev/') or name.startswith('root/conf/') or name == 'summary.json' or top_log):
        continue
    original = source / name
    assert not original.is_symlink() and original.is_file()
    assert original.stat().st_mode & 0o222 == 0, f'Host evidence must be read-only: {name}'
    content = original.read_bytes()
    assert hashlib.sha256(content).hexdigest() == digest, name
    target = destination / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)
    selected.append(f'{digest}  {name}')
(destination / 'host-MANIFEST.sha256').write_bytes(manifest)
(destination / 'selected.sha256').write_text('\n'.join(selected) + '\n')
print(json.dumps({'host': str(source), 'manifestSha256': expected_hash, 'manifestFiles': len(entries),
                  'copiedEvidenceFiles': len(selected), 'everyCopiedFileVerified': True, 'readOnlySource': True}))
