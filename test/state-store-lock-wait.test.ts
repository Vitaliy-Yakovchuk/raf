import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { openStateStore, type StateStore } from '../src/state-store.ts';

const policy = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8')).state.contention as {
  busyTimeoutMs: number;
  timeoutMs: number;
  retryDelayMs: number;
};

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'raf-z475-'));
  const path = join(directory, 'state.sqlite');
  const opened = new Set<StateStore>();
  t.after(() => {
    for (const store of opened) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    path,
    open() {
      const store = openStateStore(path);
      opened.add(store);
      return store;
    },
    close(store: StateStore) {
      store.close();
      opened.delete(store);
    },
  };
}

async function holdWriteTransaction(t: TestContext, path: string, holdMs: number) {
  const source = `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
    process.send('locked');
    process.once('message', () => {
      setTimeout(() => { db.exec('COMMIT'); db.close(); process.disconnect(); }, ${holdMs});
      process.send('holding');
    });
  `;
  const child: ChildProcess = spawn(process.execPath, ['--input-type=module', '--eval', source, path], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr!.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`Lock holder failed (${code ?? signal}): ${stderr}`)));
  });
  void closed.catch(() => {});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed.catch(() => {});
  });
  const message = () => Promise.race([
    new Promise(resolve => child.once('message', resolve)),
    closed.then(() => { throw new Error('Lock holder closed before acknowledgement'); }),
  ]);
  assert.equal(await message(), 'locked');
  const holding = message();
  child.send('hold');
  assert.equal(await holding, 'holding');
  return { closed };
}

test('Z475: a parallel state write does not refuse readers or writers after the contention warning threshold', async t => {
  assert.ok(policy.timeoutMs > policy.busyTimeoutMs && policy.retryDelayMs > 0, 'contention policy is required');
  const f = fixture(t);
  const store = f.open();
  store.initializeRunners([{ id: 'codex', initialEnabled: true }]);
  const holdMs = policy.timeoutMs + policy.busyTimeoutMs * 8;
  const { closed: released } = await holdWriteTransaction(t, f.path, holdMs);
  const warnings: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    warnings.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return Reflect.apply(write, process.stderr, [chunk, ...rest]);
  }) as typeof process.stderr.write;
  t.after(() => { process.stderr.write = write; });

  const readStarted = performance.now();
  assert.equal(store.getRunnerEnabled('codex'), true);
  assert.deepEqual(store.sessionRepository.transaction(tx => tx.listSessions(), 'read'), []);
  assert.ok(performance.now() - readStarted < policy.timeoutMs, 'a reader is not refused while another process holds the write lock');

  const writeStarted = performance.now();
  store.sessionRepository.transaction(tx => tx.putSession({ runId: 'z475', addressId: 'z475-agent', revision: 1, state: 'reserved' }));
  store.setRunnerEnabled('codex', false);
  const waited = performance.now() - writeStarted;
  assert.ok(waited >= policy.timeoutMs, 'the writer waits out the parallel lock instead of failing at the warning threshold');
  const waiting = warnings.filter(line => line.includes('phase=lock') && line.includes('sqlite=5'));
  assert.equal(waiting.length, 1, 'crossing the contention threshold warns once and keeps waiting');
  assert.ok(waiting.every(line => !line.includes('INSERT') && !line.includes('payload') && !line.includes('z475')));

  await released;
  assert.equal(store.getRunnerEnabled('codex'), false);
  assert.equal(store.sessionRepository.transaction(tx => tx.listSessions(), 'read').filter(row => row.runId === 'z475').length, 1);
  f.close(store);
  const reopened = f.open();
  assert.equal(reopened.getRunnerEnabled('codex'), false);
  assert.equal(reopened.sessionRepository.transaction(tx => tx.getSession('z475'), 'read')?.state, 'reserved');
});
