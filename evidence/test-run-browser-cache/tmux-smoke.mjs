import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { TmuxAgentAdapter } from '../../src/agent-adapters.ts';

const exec = promisify(execFile);
const root = await mkdtemp('/tmp/raf-browser-smoke-');
const qaHome = join(root, 'qa-home');
const socket = join(root, 'tmux.sock');
await mkdir(qaHome);
process.env.HOME = qaHome;
process.env.RAF_QA_HOME = qaHome;
delete process.env.XDG_CACHE_HOME;
delete process.env.PLAYWRIGHT_BROWSERS_PATH;
delete process.env.TMUX;
delete process.env.TMUX_PANE;
const observations = [];
const invoke = args => exec('tmux', ['-S', socket, '-f', '/dev/null', ...args], { env: process.env, timeout: 10000 });
const timeout = setTimeout(() => { void invoke(['kill-server']); }, 15000);
try {
  for (const cycle of ['fresh-server', 'restarted-server', 'stale-server']) {
    if (cycle === 'stale-server') {
      process.env.PLAYWRIGHT_BROWSERS_PATH = '/stale/server-cache';
      await invoke(['new-session', '-d', '-s', 'warmup', 'sleep', 'infinity']);
      process.env.PLAYWRIGHT_BROWSERS_PATH = '/trusted/host cache/$literal;value';
    }
    const output = join(root, cycle + '.json');
    const source = `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({home:process.env.HOME,cache:process.env.PLAYWRIGHT_BROWSERS_PATH}))`;
    const protocol = { invocation: () => ({ executable: process.execPath, args: ['-e', source] }), observe: () => ({ status: 'starting' }) };
    const commands = [];
    const adapter = new TmuxAgentAdapter({
      protocols: { codex: protocol },
      execute: async command => {
        commands.push(command.args);
        const result = await invoke(command.args);
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
      },
    });
    await adapter.startWithoutInput({ selection: { runner: 'codex', model: 'fixture', effort: 'fixture' }, tmuxSession: 'cache-smoke', cwd: root, reportWrapper: { wrap: value => value } });
    let observed;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try { observed = JSON.parse(await readFile(output, 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(observed, 'fixture runner must execute after respawn-pane');
    assert.equal(observed.home, qaHome);
    assert.equal(observed.cache, process.env.PLAYWRIGHT_BROWSERS_PATH || join(userInfo().homedir, '.cache', 'ms-playwright'));
    observations.push({ cycle, observed, commands });
    await invoke(['kill-server']);
  }
  console.log(JSON.stringify({ outcome: 'passed', observations, cleanup: 'all owned tmux servers stopped; private fixture directory removed in finally' }, null, 2));
} finally {
  clearTimeout(timeout);
  await invoke(['kill-server']).catch(error => { if (!/no server running|No such file or directory/.test(error.stderr || '')) throw error; });
  await rm(root, { recursive: true, force: true });
}
