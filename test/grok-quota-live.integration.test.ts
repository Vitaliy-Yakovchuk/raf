import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compileCatalog } from '../src/catalog.ts';
import { openStateStore } from '../src/state-store.ts';
import { prepareProductionQaFixture } from './production-qa-fixture.ts';

test('live Grok 1.0.70 runner limits collects through the production quota transport in QA HOME', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rqp-live-'));
  const root = join(directory, 'orchestrator');
  const home = join(directory, 'home');
  const conf = join(root, 'conf');
  const evidence = new URL('../evidence/fix-raf-quota-probe-collection/live-probe/', import.meta.url);
  mkdirSync(conf, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(evidence, { recursive: true });
  const read = (name: string) => JSON.parse(readFileSync(new URL(`../../conf/${name}`, import.meta.url), 'utf8'));
  const constants = read('raf-constants.json');
  const models = read('models.json');
  const projects = read('projects.json');
  const settings = read('raf.json');
  for (const [name, value] of Object.entries({ 'raf-constants.json': constants, 'models.json': models, 'projects.json': projects, 'raf.json': settings })) writeFileSync(join(conf, name), JSON.stringify(value));
  const artifactPath = join(directory, 'catalog.json');
  writeFileSync(artifactPath, JSON.stringify(compileCatalog(constants, models, constants.commands.map((command: { path: string[] }) => command.path.join(' ')), projects)));
  const run = await prepareProductionQaFixture(t, { root, home });
  const inherited = process.env.GROK_HOME;
  process.env.GROK_HOME = join(userInfo().homedir, '.grok');
  const socket = join(home, '.raf/tmp/tmux/server.sock');
  const tmux = (...args: string[]) => spawnSync('tmux', ['-S', socket, ...args], { encoding: 'utf8' });
  const clean = (text: string) => text.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]').replace(/\b(?:xai-|sk-)[\w-]+/g, '[token]').replace(/(Bearer\s+)\S+/gi, '$1[token]');
  const frames: { at: string; text: string }[] = [];
  const capture = () => {
    const sessions = tmux('list-sessions', '-F', '#{session_name}');
    for (const session of sessions.stdout.trim().split('\n').filter(value => value.startsWith('raf-quota-grok-'))) {
      const pane = tmux('capture-pane', '-p', '-J', '-S', '-', '-t', session);
      if (pane.status !== 0) continue;
      const text = clean(pane.stdout);
      if (text !== frames.at(-1)?.text) {
        frames.push({ at: new Date().toISOString(), text });
        writeFileSync(new URL('frames.json', evidence), JSON.stringify(frames, null, 2) + '\n');
      }
    }
  };
  let result;
  const observer = setInterval(capture, 200);
  try {
    result = await run(['runner', 'limits', '--runners', 'grok'], { orchestratorRoot: root, homeDirectory: home, artifactPath });
    writeFileSync(new URL('cli-result.json', evidence), clean(JSON.stringify(result, null, 2)) + '\n');
    assert.equal(result.exitCode, 0, result.stderr);
    const store = openStateStore(join(home, '.raf', settings.state.fileName));
    try {
      const row = store.getQuota('grok');
      assert.ok(row?.snapshot);
      assert.equal(row.snapshot.reliable, true);
      assert.equal(row.snapshot.completeness, 'complete');
      writeFileSync(new URL('saved-quota.json', evidence), JSON.stringify(row, null, 2) + '\n');
    } finally { store.close(); }
  } finally {
    clearInterval(observer);
    const remaining = tmux('list-sessions', '-F', '#{session_name}');
    const cleaned = remaining.status !== 0 || remaining.stdout.trim() === '';
    writeFileSync(new URL('provenance.json', evidence), JSON.stringify({ command: ['runner', 'limits', '--runners', 'grok'], home, root, socket, grokHome: process.env.GROK_HOME, credentialCopies: false, frameCount: frames.length, probeCleanupComplete: cleaned, cliExitCode: result?.exitCode ?? null }, null, 2) + '\n');
    tmux('kill-server');
    rmSync(directory, { recursive: true, force: true });
    if (inherited === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = inherited;
    assert.ok(cleaned, 'production transport must clean its own probe session');
  }
});
