import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { executeCommand } from '../src/os-runtime.ts';

const [revision, destination] = process.argv.slice(2);
assert.ok(revision && destination && process.env.HOME === process.env.RAF_QA_HOME && process.env.HOME?.startsWith('/tmp/'), 'isolated QA HOME required');
const evidence = resolve(destination);
await fs.mkdir(evidence, { recursive: true });
const root = await fs.mkdtemp(join(tmpdir(), 'raf-exit-'));
const source = resolve(import.meta.dirname, '..');
const git = (args: string[]) => {
  const result = spawnSync('git', args, { cwd: source, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const sha = git(['rev-parse', revision === 'workspace' ? 'HEAD' : revision]);
const timeout = JSON.parse(await fs.readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8')).runnerProtocols.find((row: any) => row.runner === 'codex').timeouts;
const results: any[] = [];
try {
  let adapterPath = join(source, 'src/agent-adapters.ts');
  if (revision !== 'workspace') {
    const archive = join(root, 'source.tar');
    git(['archive', '--output', archive, sha, 'src']);
    assert.equal(spawnSync('tar', ['-xf', archive, '-C', root]).status, 0);
    adapterPath = join(root, 'src/agent-adapters.ts');
  }
  const { TmuxAgentAdapter } = await import(pathToFileURL(adapterPath).href);
  for (const mode of ['kill-session', 'kill-pane', 'pane-died', 'closed-after-death', 'died-before-wait']) {
    const socket = join(root, mode + '.sock');
    const commands: any[] = [];
    const immediate = mode === 'died-before-wait';
    let notifySubscribed!: () => void;
    const subscribed = new Promise<void>(resolve => notifySubscribed = resolve);
    const tmux = async (args: string[]) => {
      const result = await executeCommand({ executable: 'tmux', args: ['-S', socket, ...args] });
      assert.equal(result.exitCode, 0, result.stderr);
      return result.stdout;
    };
    const paneDead = async () => (await executeCommand({ executable: 'tmux', args: ['-S', socket, 'display-message', '-p', '-t', '=owned:0.0', '#{pane_dead}'] })).stdout.trim() === '1';
    const execute = async (command: any) => {
      const entry = { args: command.args, at: Date.now() };
      commands.push(entry);
      if (command.args[0] === 'wait-for' && command.args.length === 2) notifySubscribed();
      if (mode === 'closed-after-death' && command.args[0] === 'set-hook' && command.args.includes('-u') && command.args.some((arg: string) => arg.startsWith('pane-died['))) await tmux(['kill-session', '-t', '=owned']);
      const result = await executeCommand({ ...command, args: ['-S', socket, ...command.args] });
      if (immediate && command.args[0] === 'set-hook' && !command.args.includes('-u')) {
        await tmux(['send-keys', '-t', '=owned:0.0', 'Enter']);
        while (!await paneDead()) await delay(timeout.pollMs);
        await delay(timeout.pollMs);
      }
      return result;
    };
    const row: any = { mode };
    let waiting: Promise<any> | undefined;
    try {
      await tmux(['new-session', '-d', '-s', 'keeper', 'sleep', '600']);
      await tmux(['new-session', '-d', '-s', 'owned', 'sh', '-c', `read -r line; exit 27`]);
      await tmux(['set-option', '-p', '-t', '=owned:0.0', 'remain-on-exit', 'on']);
      const adapter = new TmuxAgentAdapter({ execute, protocols: {} });
      let exited = false;
      const started = Date.now();
      waiting = adapter.waitForExit({ tmuxSession: 'owned', selection: { runner: 'codex', model: 'synthetic', effort: 'high' } }).then((value: any) => { exited = true; return value; });
      if (!immediate) {
        await subscribed;
        const count = commands.length;
        await delay(timeout.pollMs * 10);
        row.idleCommandCount = commands.length - count;
        await tmux(['new-session', '-d', '-s', 'unrelated', 'sleep', '600']);
        await tmux(['kill-session', '-t', '=unrelated']);
        await delay(timeout.pollMs);
        row.unrelatedWakeCommands = commands.length - count;
        row.unrelatedExit = exited;
        if (mode === 'pane-died' || mode === 'closed-after-death') await tmux(['send-keys', '-t', '=owned:0.0', 'Enter']);
        else await tmux([mode, '-t', mode === 'kill-pane' ? '=owned:0.0' : '=owned']);
      }
      let timer: ReturnType<typeof setTimeout>;
      row.exit = await Promise.race([waiting, new Promise(resolve => timer = setTimeout(() => resolve('timeout'), timeout.transitionMs))]).finally(() => clearTimeout(timer!));
      row.transitionMs = Date.now() - started;
      const expectedCode = mode === 'kill-session' || mode === 'kill-pane' ? null : 27;
      const blocking = (args: string[]) => args.join('\u0000').split('\u0000;\u0000').map(part => part.split('\u0000')).filter(part => part[0] === 'wait-for' && part[1] !== '-S').length;
      row.blockingWaitsAfterUnsubscribe = commands.slice(commands.findLastIndex(command => command.args[0] === 'set-hook' && command.args.includes('-u')) + 1).reduce((sum, command) => sum + blocking(command.args), 0);
      row.passed = row.exit !== 'timeout' && row.exit.code === expectedCode && row.blockingWaitsAfterUnsubscribe === 0 && (immediate || row.idleCommandCount === 0 && row.unrelatedWakeCommands === 0 && !row.unrelatedExit);
      if (row.exit === 'timeout') {
        const command = commands.find(command => command.args[0] === 'wait-for');
        const channel = command.args[1] === '-S' ? command.args[2] : command.args[1];
        await tmux(['wait-for', '-S', channel]);
        await waiting;
      }
      row.remainingHooks = await tmux(['show-hooks', '-g']);
      assert.equal(/raf-exit-/.test(row.remainingHooks), false, 'own global hooks removed');
    } catch (error) { row.error = String(error); row.passed = false; }
    finally {
      await executeCommand({ executable: 'tmux', args: ['-S', socket, 'kill-server'] });
      await waiting?.catch(() => undefined);
      row.commands = commands;
      results.push(row);
    }
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
  await fs.writeFile(join(evidence, 'summary.json'), JSON.stringify({ revision, sha, dirty: git(['status', '--short']), timeouts: timeout, results, cleanup: 'owned tmux servers stopped and fixture removed' }, null, 2));
}
console.log(JSON.stringify(results.map(({ mode, exit, transitionMs, idleCommandCount, unrelatedWakeCommands, blockingWaitsAfterUnsubscribe, passed, error }) => ({ mode, exit, transitionMs, idleCommandCount, unrelatedWakeCommands, blockingWaitsAfterUnsubscribe, passed, error }))));
process.exitCode = results.every(row => row.passed) ? 0 : 1;
