import json, os, pathlib, subprocess, sys, time
root = pathlib.Path('/srv/dev/work/orchestrator/raf-hotfix')
output = root / 'evidence/fix-raf-command-latency'
phase = sys.argv[1]
qa_home = pathlib.Path('/home/dev/.raf/tmp/8cb76ba0-f144-4569-9f8a-426e111dcfe6/latency-qa-home')
qa_home.mkdir(exist_ok=True)
env = dict(os.environ, HOME=str(qa_home), RAF_QA_HOME=str(qa_home), RAF_ORCHESTRATOR_ROOT=str(root.parent))
for name in ['TMUX', 'TMUX_PANE', 'RAF_STATE_DIRECTORY', 'RAF_SOCKET_PATH']:
    env.pop(name, None)
command = ['node', 'bin/raf.ts', 'reminder', 'list']
start = time.monotonic()
result = subprocess.run(command, cwd=root, env=env, capture_output=True, text=True)
elapsed = (time.monotonic() - start) * 1000
(output / (phase + '.stdout')).write_text(result.stdout)
(output / (phase + '.stderr')).write_text(result.stderr)
metadata = dict(command=command, cwd=str(root), qaHome=str(qa_home), elapsedMs=elapsed, cliExitCode=result.returncode,
    sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),
    workspace=subprocess.check_output(['git','status','--short'],cwd=root,text=True),
    codeDiff=subprocess.check_output(['git','diff','--','src/archive-events-runtime.ts'],cwd=root,text=True))
(output / (phase + '.json')).write_text(json.dumps(metadata, indent=2) + '\n')
print(json.dumps(metadata))
