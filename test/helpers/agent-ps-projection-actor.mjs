import { spawn } from 'node:child_process';

process.on('message', async request => {
  const child = spawn(process.execPath, [request.entry, 'agent', 'ps'], {
    cwd: request.cwd, env: process.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', spawnError = null;
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.on('error', error => { spawnError = error.code ?? error.name; });
  child.on('close', (code, signal) => process.send?.({ requestId: request.requestId, code, signal, spawnError, stdout, stderr }));
});
process.send?.({ ready: true, pid: process.pid });
