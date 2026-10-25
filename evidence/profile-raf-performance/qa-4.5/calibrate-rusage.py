import json
import os
import shutil
import sys
import time
from pathlib import Path

base = Path(__file__).resolve().parent
node = shutil.which('node')
payload = """
const { spawnSync } = require('node:child_process');
const cpu = () => { const v = process.cpuUsage(); return v.user + v.system; };
const start = cpu(); while (cpu() - start < 100000) {}
const helper = spawnSync(process.execPath, ['-e', `const start = process.cpuUsage(); let used; do { used = process.cpuUsage(start); } while (used.user + used.system < 200000); console.log(JSON.stringify(process.cpuUsage()));`], {encoding:'utf8'});
if (helper.status !== 0) process.exit(helper.status ?? 1);
console.log(JSON.stringify({self:process.cpuUsage(), helper:JSON.parse(helper.stdout), helperExitCode:helper.status}));
"""
started = time.monotonic_ns()
pid = os.fork()
if pid == 0:
    out = os.open(base / 'cpu-calibration.stdout', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    err = os.open(base / 'cpu-calibration.stderr', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.dup2(out, 1)
    os.dup2(err, 2)
    os.execv(node, [node, '-e', payload])
_, status, usage = os.wait4(pid, 0)
code = os.waitstatus_to_exitcode(status)
assert code == 0
record = json.loads((base / 'cpu-calibration.stdout').read_text())
self_ms = sum(record['self'].values()) / 1000
helper_ms = sum(record['helper'].values()) / 1000
full_ms = (usage.ru_utime + usage.ru_stime) * 1000
assert full_ms + 1e-6 >= self_ms + helper_ms
result = dict(method='Linux wait4 rusage', scope='Node CLI root plus reaped Node helper',
    command=[node, '-e', payload], cliExitCode=0, childExitCode=code,
    measuredSelfMs=self_ms, measuredHelperMs=helper_ms, fullCpuMs=full_ms,
    cpuUserMs=usage.ru_utime*1000, cpuSystemMs=usage.ru_stime*1000,
    wallMs=(time.monotonic_ns()-started)/1e6, result='full counter includes both independently measured contributions')
(base / 'cpu-accounting-calibration.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
