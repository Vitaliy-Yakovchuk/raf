from pathlib import Path
import json, shutil, subprocess
root=Path('/tmp/frcll-1-1-6/root')
root.mkdir(parents=True,exist_ok=True)
source=Path('/srv/dev/work/orchestrator')
shutil.copytree(source/'conf',root/'conf',dirs_exist_ok=True,ignore=shutil.ignore_patterns('.*'))
for path in (source/'openspec').rglob('*.md'):
    relative=path.relative_to(source)
    if 'evidence' in relative.parts: continue
    target=root/relative
    target.parent.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(path,target)
projects=root/'conf/projects.json'
config=json.loads(projects.read_text())
raf=config['projects']['raf']
raf.pop('mainCopies',None)
raf['branchPaths']['develop']='raf-main'
raf['branchPaths']['hotfix']='/srv/dev/work/orchestrator/raf-hotfix'
projects.write_text(json.dumps(config))
(root/'raf-main').mkdir(exist_ok=True)
subprocess.run(['git','init','--quiet',str(root/'raf-main')],check=True)
shutil.copyfile('evidence/hotfix-1.1.6/synthetic-codex.mjs','/tmp/frcll-1-1-6/profile-codex')
Path('/tmp/frcll-1-1-6/profile-codex').chmod(0o700)
