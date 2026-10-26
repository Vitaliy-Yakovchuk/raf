import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const evidence = new URL('../evidence/z458/', import.meta.url);
for (const runner of ['grok', 'agy'] as const) {
  test(`Z.458 live ${runner} native identity, paste, task and exit`, async () => {
    const base = await mkdtemp('/tmp/z458-');
    const home = '/home/dev';
    const work = join(base, 'work');
    const extra = join(base, 'extra');
    const socket = join(base, 'tmux.sock');
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local/share'), TMUX: '', TMUX_TMPDIR: base, GROK_HOME: join(home, '.grok') };
    const frames: { stage: string; at: string; text: string }[] = [];
    let last = '';
    let started = false;
    let failure: string | null = null;
    const tmux = (...args: string[]) => execFileSync('tmux', ['-S', socket, ...args], { env, encoding: 'utf8' });
    const capture = (stage: string) => {
      const screen = tmux('capture-pane', '-p', '-t', runner).trimEnd();
      if (screen !== last) {
        frames.push({ stage, at: new Date().toISOString(), text: screen.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]').replace(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g, '[device code]') });
        last = screen;
        writeFileSync(new URL(`progress-${runner}.json`, evidence), JSON.stringify({ runner, frames }, null, 2) + '\n');
      }
      return screen;
    };
    const keys = (...args: string[]) => tmux('send-keys', '-t', runner, ...args);
    const wait = async (stage: string, accept: (screen: string) => boolean) => {
      for (;;) {
        const screen = capture(stage);
        if (accept(screen)) return screen;
        assert.equal(tmux('display-message', '-p', '-t', runner, '#{pane_dead}').trim(), '0', `${runner} exited at ${stage}`);
        assert.ok(!/Select login method|You hit your weekly limit|out of extra usage|Authentication failed|Waiting for approval|Approve in your browser/i.test(screen), `${runner} authentication/quota screen at ${stage}`);
        await delay(100);
      }
    };
    const id = 'c82d0a64-457b-4c76-aa47-4ee1c64ce79d';
    const args = runner === 'grok'
      ? ['--no-alt-screen', '--model', 'grok-4.7', '--reasoning-effort', 'high', '--session-id', id, '--leader-socket', join(base, 'leader.sock'), '--add-dir', extra]
      : ['--model', 'gemini-4-argon-high', '--effort', 'high', '--log-file', join(base, 'agy.log'), '--add-dir', extra];
    let sessionStart: unknown = null;
    let completed = false;
    let exited = false;
    let ownTmuxServerStopped = false;
    try {
      await Promise.all([home, work, extra].map(path => mkdir(path, { recursive: true })));
      if (runner === 'agy') {
        await mkdir(join(work, '.agents'));
        const handler = join(work, '.agents/capture.mjs');
        await writeFile(handler, `import{writeFileSync}from'node:fs';let s='';for await(const c of process.stdin)s+=c;const e=JSON.parse(s);writeFileSync(${JSON.stringify(join(work, 'session-start.json'))},JSON.stringify({conversationId:e.conversationId,event:e.hook_event_name}));process.stdout.write('{}');`);
        await writeFile(join(work, '.agents/hooks.json'), JSON.stringify({ 'raf-owned-z458': { SessionStart: [{ type: 'command', command: `${process.execPath} ${handler}` }] } }));
      }
      execFileSync('git', ['init', '-q', work]);
      const conf = join(base, 'tmux.conf');
      await writeFile(conf, 'set -g remain-on-exit on\n');
      tmux('-f', conf, 'new-session', '-d', '-s', runner, '-x', '160', '-y', '55', '-c', work, `/home/dev/.local/bin/${runner}`, ...args);
      started = true;
      const ready = runner === 'grok' ? /Shift\+Tab:mode/ : /\? for shortcuts/;
      let initial = await wait('startup', screen => ready.test(screen) || /trust this folder|trust the files|trust this directory/i.test(screen));
      if (!ready.test(initial)) {
        assert.ok(initial.includes(work), 'trust prompt must name only the owned synthetic workspace');
        keys('Enter');
        initial = await wait('trusted-ready', screen => ready.test(screen));
      }
      if (runner === 'grok') {
        keys('-l', '/usage');
        await delay(200);
        keys('Enter');
        await wait('usage', screen => /Context usage|Usage limit|Session info/.test(screen));
        keys('Tab', 'Tab');
        await wait('identity', screen => screen.includes(id));
        keys('Escape');
        await wait('identity-dismissed', screen => ready.test(screen) && !screen.includes('Session ID:'));
      }
      const token = `Z458_${runner.toUpperCase()}_OK`;
      const prompt = `This is an isolated runner acceptance probe.\nDo not call tools or read files.\nReply with exactly this token: ${token}`;
      execFileSync('tmux', ['-S', socket, 'load-buffer', '-b', 'z458', '-'], { env, input: prompt });
      tmux('paste-buffer', '-b', 'z458', '-t', runner, '-p');
      await delay(300);
      capture('pending-paste');
      keys('Enter');
      await delay(200);
      let response = capture('submitted');
      if (/^\s*[>❯].*(?:Pasted|This is an isolated)/mu.test(response)) keys('Enter');
      response = await wait('task', screen => {
        return new RegExp(`^[^A-Za-z0-9\\n]*${token}\\s*$`, 'm').test(screen) && ready.test(screen);
      });
      completed = true;
      if (runner === 'agy') {
        try { sessionStart = JSON.parse(await readFile(join(work, 'session-start.json'), 'utf8')); }
        catch { sessionStart = { state: 'pending', reason: 'Owned SessionStart event not observed' }; }
      }
      keys('-l', '/exit');
      await delay(200);
      keys('Enter');
      await wait('exit', () => tmux('display-message', '-p', '-t', runner, '#{pane_dead}').trim() === '1');
      exited = true;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (started) {
        try { capture('cleanup'); } catch {}
        try { tmux('kill-server'); ownTmuxServerStopped = true; } catch {}
      }
      await rm(base, { recursive: true, force: true });
      await mkdir(evidence, { recursive: true });
      await writeFile(new URL(`live-${runner}.json`, evidence), JSON.stringify({ runner, executable: `/home/dev/.local/bin/${runner}`, args, home, work, socket, sessionStart, completed, exited, failure, credentialCopies: false, frames, cleanup: { ownTmuxServerStopped, ownDirectoryRemoved: true } }, null, 2) + '\n');
      assert.equal(ownTmuxServerStopped, true, 'own tmux server cleanup completed');
    }
  });
}
