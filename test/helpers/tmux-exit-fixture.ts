import type { AdapterCommand, AdapterCommandExecutor, AdapterCommandResult } from '../../src/agent-adapters.ts';

export function tmuxExitFixture(session: string) {
  const commands: AdapterCommand[] = [];
  const hooks = new Map<string, { global: boolean; body: string }>();
  let alive = true;
  let wake: (() => void) | undefined;
  let subscribed!: () => void;
  const waiting = new Promise<void>(resolve => subscribed = resolve);
  const ok = (stdout = ''): AdapterCommandResult => ({ exitCode: 0, stdout, stderr: '' });
  const execute: AdapterCommandExecutor = async command => {
    commands.push(command);
    const args = [...command.args];
    if (args[0] === 'set-hook') {
      for (const part of args.join('\u0000').split('\u0000;\u0000')) {
        const words = part.split('\u0000');
        const hook = words.find(word => /^(pane-died|pane-exited|session-closed)\[/.test(word))!;
        if (words.includes('-u')) hooks.delete(hook);
        else hooks.set(hook, { global: words.includes('-g'), body: words.at(-1)! });
      }
    }
    if (args[0] === 'display-message') return alive ? ok('0|') : { exitCode: 1, stdout: '', stderr: 'session absent' };
    if (args[0] === 'wait-for' && args.length === 2) {
      await new Promise<void>(resolve => { wake = resolve; subscribed(); });
    }
    return ok();
  };
  return {
    execute, commands, hooks, waiting,
    close(name = session) {
      if (name === session) alive = false;
      for (const [hook, value] of hooks) {
        if (hook.startsWith('session-closed[') && value.global &&
          (!value.body.includes('hook_session_name') || name === session)) wake?.();
      }
      if (name === session) for (const [hook, value] of hooks) if (!value.global) hooks.delete(hook);
    },
    release() { alive = false; wake?.(); },
  };
}
