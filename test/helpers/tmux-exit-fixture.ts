import type { AdapterCommand, AdapterCommandExecutor, AdapterCommandResult } from '../../src/agent-adapters.ts';

interface WaitChannel { woken: boolean; waiters: (() => void)[] }

export function tmuxExitFixture(session: string) {
  const commands: AdapterCommand[] = [];
  const hooks = new Map<string, { global: boolean; body: string }>();
  const channels = new Map<string, WaitChannel>();
  const pane = { dead: false, status: '' };
  let alive = true;
  let released = false;
  let subscribed!: () => void;
  const waiting = new Promise<void>(resolve => subscribed = resolve);
  const ok = (stdout = ''): AdapterCommandResult => ({ exitCode: 0, stdout, stderr: '' });
  const channel = (name: string) => {
    let value = channels.get(name);
    if (!value) { value = { woken: false, waiters: [] }; channels.set(name, value); }
    return value;
  };
  const signal = (name: string) => {
    const value = channel(name);
    if (!value.waiters.length && !value.woken) { value.woken = true; return; }
    for (const wake of value.waiters.splice(0)) wake();
    if (value.woken) channels.delete(name);
  };
  const wait = async (name: string) => {
    const value = channel(name);
    if (value.woken || released) { channels.delete(name); return; }
    subscribed();
    await new Promise<void>(resolve => value.waiters.push(resolve));
  };
  const channelOf = (body: string) => /wait-for -S ([^'\s]+)/.exec(body)?.[1];
  const fire = (prefix: string, name: string) => {
    for (const [hook, value] of hooks) {
      if (!hook.startsWith(prefix)) continue;
      if (value.global ? !value.body.includes('hook_session_name') || value.body.includes(`,${name}}`) : name === session) {
        const target = channelOf(value.body);
        if (target) signal(target);
      }
    }
  };
  const parts = (args: string[]) => args.join('\u0000').split('\u0000;\u0000').map(part => part.split('\u0000'));
  const events = {
    execute: undefined as unknown as AdapterCommandExecutor, commands, hooks, channels, waiting,
    before: undefined as ((command: AdapterCommand) => void | Promise<void>) | undefined,
    after: undefined as ((command: AdapterCommand) => void | Promise<void>) | undefined,
    paneDies(status: number) {
      if (!alive || pane.dead) return;
      pane.dead = true;
      pane.status = String(status);
      fire('pane-died[', session);
    },
    close(name = session) {
      if (name === session) {
        if (!alive) return;
        alive = false;
        for (const [hook, value] of hooks) if (!value.global) hooks.delete(hook);
      }
      fire('session-closed[', name);
    },
    release() {
      alive = false;
      released = true;
      for (const [name, value] of channels) { for (const wake of value.waiters.splice(0)) wake(); channels.delete(name); }
    },
  };
  events.execute = async command => {
    commands.push(command);
    await events.before?.(command);
    let result = ok();
    const args = [...command.args];
    if (args[0] === 'set-hook') {
      for (const words of parts(args)) {
        const hook = words.find(word => /^(pane-died|pane-exited|session-closed)\[/.test(word))!;
        const global = words.includes('-g');
        if (!global && !alive) { result = { exitCode: 1, stdout: '', stderr: 'session absent' }; continue; }
        if (words.includes('-u')) hooks.delete(hook);
        else hooks.set(hook, { global, body: words.at(-1)! });
      }
    } else if (args[0] === 'display-message') {
      result = alive ? ok(`${pane.dead ? '1' : '0'}|${pane.status}`) : { exitCode: 1, stdout: '', stderr: 'session absent' };
    } else if (args[0] === 'wait-for') {
      for (const words of parts(args)) {
        if (words[1] === '-S') signal(words[2]);
        else await wait(words[1]);
      }
    }
    await events.after?.(command);
    return result;
  };
  return events;
}
