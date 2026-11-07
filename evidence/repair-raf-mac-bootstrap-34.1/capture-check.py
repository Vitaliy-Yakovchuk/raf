import json, os, subprocess, sys, hashlib
from pathlib import Path
name, *command = sys.argv[1:]
evidence=Path('/srv/dev/work/orchestrator/raf-hotfix/evidence/repair-raf-mac-bootstrap-34.1')
qa=Path('/tmp/raf-q7-rrmb-34-1-qa')
qa.mkdir(mode=0o700,exist_ok=True)
(qa/'tmp').mkdir(mode=0o700,exist_ok=True)
environment={k:v for k,v in os.environ.items() if not k.startswith('RAF_')}
environment.update(HOME=str(qa),RAF_QA_HOME=str(qa),TMPDIR=str(qa/'tmp'))
git=lambda *args: subprocess.check_output(['git',*args],text=True)
head=git('rev-parse','HEAD').strip()
status=git('status','--porcelain')
diff=git('diff','--binary')
(evidence/(name+'.workspace.diff')).write_text(diff)
with (evidence/(name+'.stdout.txt')).open('wb') as out, (evidence/(name+'.stderr.txt')).open('wb') as err:
    result=subprocess.run(command,env=environment,stdout=out,stderr=err)
(evidence/(name+'.exit-code.txt')).write_text(str(result.returncode)+'\n')
metadata={'command':command,'cwd':str(Path.cwd()),'head':head,'statusBefore':status,'workspaceDiff':name+'.workspace.diff','diffSha256':hashlib.sha256(diff.encode()).hexdigest(),'qaHome':str(qa),'exitCode':result.returncode,'platform':sys.platform,'kind':'direct-node-check','testRunResult':None,'reason':'Assignment 34.1 explicitly prohibits raf test run until the Darwin channel is fixed'}
(evidence/(name+'.json')).write_text(json.dumps(metadata,indent=2)+'\n')
print(json.dumps({k:metadata[k] for k in ['command','head','exitCode','qaHome']}))
print((evidence/(name+'.stdout.txt')).read_text()[-4500:])
print((evidence/(name+'.stderr.txt')).read_text()[-2000:])
sys.exit(result.returncode)
