import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync, watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { release } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { ComponentOwner, ComponentRole, HandoverContext, HandoverRuntime, HandoverState, HandoverStore, PendingFact } from '../src/main-generation-handover.ts';

const self = import.meta.filename;
const source = resolve(import.meta.dirname, '..');
const roles: ComponentRole[] = ['service', 'worker', 'notice'];
const kinds = ['report', 'event', 'message', 'reminder', 'address'] as const;
const atomic = (path: string, value: unknown) => {
  const temporary = path + '.' + randomUUID();
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  renameSync(temporary, path);
};
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const identity = (pid: number) => {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return { pid, startTicks: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
};
const [mode, argument] = process.argv.slice(2);

function connection(root: string) {
  const db = new DatabaseSync(join(root, 'state.sqlite'));
  db.exec('PRAGMA busy_timeout=10000');
  const store: HandoverStore = {
    async read() { return JSON.parse(db.prepare('SELECT payload FROM state WHERE id=1').get()!.payload as string); },
    async transaction(update) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const state = JSON.parse(db.prepare('SELECT payload FROM state WHERE id=1').get()!.payload as string);
        const result = update(state);
        db.prepare('UPDATE state SET payload=? WHERE id=1').run(JSON.stringify(state));
        db.exec('COMMIT');
        return structuredClone(result);
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  return { db, store };
}

if (mode === 'actor') {
  const config = JSON.parse(argument);
  const { db, store } = connection(config.root);
  const engine = await import(pathToFileURL(join(config.slot, 'handover.ts')).href);
  const { generation: executableVersion } = await import(pathToFileURL(join(config.slot, 'generation.ts')).href);
  const restored = await store.read();
  const version = JSON.parse(readFileSync(join(config.slot, 'version.json'), 'utf8'));
  assert.equal(executableVersion, version.id);
  const owner: ComponentOwner = config.owner;
  let loseAcknowledgement = false;
  const ingest = async () => {
    if (owner.role !== 'worker' || !existsSync(config.report)) return;
    const fact: PendingFact = JSON.parse(readFileSync(config.report, 'utf8'));
    await engine.recordMainFact({ store }, fact);
  };
  const watcher = owner.role === 'worker' ? watch(config.reportDirectory, () => void ingest().catch(error => process.stderr.write(String(error) + '\n'))) : undefined;
  await ingest();
  process.send!({ ready: true, identity: identity(process.pid), owner, version, restored: { runners: restored.runners, resourceWait: restored.resourceWait, bugSync: restored.bugSync } });
  process.on('message', async (message: any) => {
    try {
      if (message.operation === 'lose-ack') { loseAcknowledgement = true; process.send!({ id: message.id, ok: true }); return; }
      if (message.operation === 'ingest') { await ingest(); process.send!({ id: message.id, ok: true }); return; }
      if (message.operation === 'effect') {
        const { fact, key } = message;
        assert.equal(key, fact.id);
        db.exec('BEGIN IMMEDIATE');
        try {
          const state: HandoverState = JSON.parse(db.prepare('SELECT payload FROM state WHERE id=1').get()!.payload as string);
          const current = state.owners[state.activeOwners[owner.role]];
          assert.equal(current.ownerId, owner.ownerId);
          assert.equal(current.epoch, owner.epoch);
          assert.equal(current.phase, 'active');
          assert.notEqual(owner.role, 'service');
          db.prepare('INSERT INTO attempts(fact,owner,epoch,version) VALUES (?,?,?,?)').run(key, owner.ownerId, owner.epoch, version.id);
          const old = db.prepare('SELECT payload FROM deliveries WHERE id=?').get(key);
          if (old) assert.deepEqual(JSON.parse(old.payload as string), fact);
          else db.prepare('INSERT INTO deliveries VALUES (?,?,?,?)').run(key, JSON.stringify(fact), owner.ownerId, version.id);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        if (loseAcknowledgement) {
          atomic(join(config.root, 'lost-ack.json'), { owner, key, identity: identity(process.pid), version });
          process.kill(process.pid, 'SIGKILL');
          return;
        }
        process.send!({ id: message.id, ok: true });
      }
      if (message.operation === 'stop') {
        watcher?.close(); db.close(); process.send!({ id: message.id, ok: true }); process.disconnect();
      }
    } catch (error: any) { process.send!({ id: message.id, ok: false, error: error.message }); }
  });
} else if (mode === 'runner') {
  const config = JSON.parse(argument);
  process.send!({ ready: true, identity: identity(process.pid) });
  process.on('message', (message: any) => {
    if (message.operation === 'write') atomic(config.report, message.fact);
    process.send!({ id: message.id, ok: true });
    if (message.operation === 'stop') process.disconnect();
  });
} else if (mode === 'command') {
  const config = JSON.parse(argument);
  const { db, store } = connection(config.root);
  const slot = realpathSync(join(config.root, 'raf-main'));
  const engine = await import(pathToFileURL(join(slot, 'handover.ts')).href);
  const { generation: executableVersion } = await import(pathToFileURL(join(slot, 'generation.ts')).href);
  const requests = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
  process.on('message', (message: any) => {
    const request = requests.get(message.id);
    if (!request) return;
    requests.delete(message.id);
    if (message.ok) request.resolve(message.value); else request.reject(new Error(message.error));
  });
  const remote = (name: string, args: unknown[]) => new Promise<any>((resolveRequest, reject) => {
    const id = randomUUID(); requests.set(id, { resolve: resolveRequest, reject }); process.send!({ remote: true, id, name, args });
  });
  const runtime = Object.fromEntries(['start', 'readiness', 'isAlive', 'stop', 'loadAsset', 'acceptFact', 'runnerAction'].map(name => [name, (...args: unknown[]) => remote(name, args)])) as unknown as HandoverRuntime;
  const context: HandoverContext = { store, runtime };
  try {
    const functions: Record<string, (...args: any[]) => Promise<any>> = {
      begin: engine.beginMainHandover, advance: engine.advanceMainHandover, recover: engine.recoverMainHandover,
      pin: engine.pinMainOperation, finish: engine.finishMainOperation, asset: engine.loadPinnedMainAsset,
      fact: engine.recordMainFact, drain: engine.drainMainFacts, reusable: engine.assertMainSlotReusable,
    };
    assert.ok(functions[config.operation]);
    const value = await functions[config.operation](context, ...config.args);
    process.stdout.write(JSON.stringify({ value: value ?? null, executableVersion, version: JSON.parse(readFileSync(join(slot, 'version.json'), 'utf8')), identity: identity(process.pid) }) + '\n');
    if (value?.status === 'waiting' || value?.status === 'blocked') process.exitCode = 1;
  } catch (error: any) { process.stdout.write(JSON.stringify({ error: error.message, code: error.code ?? null, identity: identity(process.pid) }) + '\n'); process.exitCode = 1; }
  finally { db.close(); process.disconnect(); }
} else {
  const output = resolve(mode ?? 'evidence/switch-raf-main-by-symlink/qa-5.4/live');
  assert.ok(!existsSync(join(output, 'summary.json')), 'Do not replay an existing stand result');
  mkdirSync(output, { recursive: true });
  const root = mkdtempSync('/tmp/raf-handover-qa-');
  const home = join(root, 'home'); mkdirSync(home);
  const reportDirectory = join(root, 'runner'); mkdirSync(reportDirectory);
  const report = join(reportDirectory, 'report.json');
  const env = { HOME: home, RAF_QA_HOME: home, TMPDIR: root, PATH: process.env.PATH ?? '' };
  const evidence: any = {
    outcome: 'incomplete', command: [process.execPath, ...process.argv.slice(1)], root,
    sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(),
    workspaceStatus: execFileSync('git', ['status', '--short'], { cwd: source, encoding: 'utf8' }),
    fingerprints: Object.fromEntries(['src/main-generation-handover.ts', 'scripts/qa-main-generation-handover.ts'].map(file => [file, hash(join(source, file))])),
    environment: { node: process.version, sqlite: process.versions.sqlite, os: release(), platform: process.platform },
    scope: 'Real isolated processes and SQLite adapters of the handover engine, atomic code-selection symlink A/B, filesystem report watcher and fenced idempotent delivery. Not a native model session or full production service/worker rollout; Git publication is covered by 4.4.',
    processes: [], commands: [], scenarios: [], snapshots: {}, cleanup: { complete: false },
  };
  const children: any[] = [];
  const actors = new Map<string, any>();
  const blockReady = new Set<string>();
  let db: DatabaseSync | undefined;
  let store: HandoverStore;
  const until = async (condition: () => boolean, label: string) => {
    const end = Date.now() + 30000;
    while (!condition()) { if (Date.now() >= end) throw new Error('Stand readiness unavailable: ' + label); await delay(20); }
  };
  function launch(kind: string, config: any) {
    const child = fork(self, [kind, JSON.stringify(config)], { env, cwd: source, execArgv: [], silent: true });
    const entry: any = { pid: child.pid, kind, config, stdout: '', stderr: '', exitCode: null, signal: null };
    evidence.processes.push(entry);
    child.stdout!.on('data', chunk => entry.stdout += chunk);
    child.stderr!.on('data', chunk => entry.stderr += chunk);
    let ready: any;
    const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
    child.on('message', (message: any) => {
      if (message.ready) { ready = message; entry.ready = message; return; }
      if (message.remote) {
        void (async () => {
          try { const value = await (runtime as any)[message.name](...message.args); child.send({ id: message.id, ok: true, value }); }
          catch (error: any) { if (child.connected) child.send({ id: message.id, ok: false, error: error.message }); }
        })();
        return;
      }
      const request = pending.get(message.id);
      if (request) { pending.delete(message.id); if (message.ok) request.resolve(message); else request.reject(new Error(message.error)); }
    });
    const done = new Promise<any>(resolveDone => child.on('close', (code, signal) => {
      entry.exitCode = code; entry.signal = signal;
      for (const request of pending.values()) request.reject(new Error('Observer exited before acknowledgement'));
      pending.clear(); resolveDone(entry);
    }));
    const rpc = (operation: string, value: any = {}) => new Promise<any>((resolveRequest, reject) => {
      const id = randomUUID(); pending.set(id, { resolve: resolveRequest, reject });
      child.send({ id, operation, ...value }, error => { if (error) { pending.delete(id); reject(error); } });
    });
    const result = { child, done, entry, rpc, ready: () => ready }; children.push(result); return result;
  }
  const live = (item: any) => {
    if (!item?.ready() || item.child.exitCode !== null || item.child.signalCode !== null) return false;
    try { return JSON.stringify(identity(item.child.pid)) === JSON.stringify(item.ready().identity); } catch { return false; }
  };
  const runtime: HandoverRuntime = {
    async start(owner, duties) {
      const item = launch('actor', { root, slot: join(root, owner.generation), owner, duties, report, reportDirectory });
      actors.set(owner.ownerId, item);
      await until(() => !!item.ready(), owner.ownerId);
      assert.equal(item.ready().version.id, owner.generation);
      const state = await store.read();
      assert.deepEqual(item.ready().restored.resourceWait, state.resourceWait);
      assert.deepEqual(item.ready().restored.runners, state.runners);
    },
    async readiness(owner) {
      const item = actors.get(owner.ownerId);
      if (!live(item) || blockReady.has(item.ready().owner.generation + ':' + item.ready().owner.role)) return null;
      return { ...owner, restored: true };
    },
    async isAlive(owner) { return live(actors.get(owner.ownerId)); },
    async stop(owner) {
      const item = actors.get(owner.ownerId);
      if (live(item)) await item.rpc('stop');
      await item?.done;
    },
    async loadAsset(root, kind) { return readFileSync(join(root, kind + '.txt'), 'utf8'); },
    async acceptFact(owner, fact, key) { await actors.get(owner.ownerId).rpc('effect', { fact, key }); },
    async runnerAction() { assert.fail('Handover must not touch the live runner'); },
  };
  async function command(operation: string, args: any[] = [], expected = 0, reason?: string) {
    const child = launch('command', { root, operation, args });
    const result = await child.done;
    const record = { operation, args, cliExitCode: result.exitCode, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
    evidence.commands.push(record);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.exitCode, expected, JSON.stringify(record));
    const decoded = JSON.parse(result.stdout);
    if (expected === 0) assert.equal(decoded.error, undefined, JSON.stringify(record));
    else {
      assert.ok(reason, 'Every expected refusal must verify its cause');
      assert.match(decoded.error ?? decoded.value?.reason ?? '', new RegExp(reason));
      if (decoded.value) assert.equal(decoded.value.status, 'waiting');
    }
    return decoded.value;
  }
  const confirmable = (state: HandoverState) => state.transition?.status === 'complete'
    && state.transition.to === state.activeGeneration
    && roles.every(role => state.owners[state.activeOwners[role]].generation === state.activeGeneration);
  const snapshot = async (name: string) => {
    const state = await store.read();
    evidence.snapshots[name] = { state, handoverConfirmable: confirmable(state), readlink: realpathSync(join(root, 'raf-main')), deliveries: db!.prepare('SELECT * FROM deliveries ORDER BY id').all(), attempts: db!.prepare('SELECT * FROM attempts ORDER BY seq').all() };
    return state;
  };
  const publish = async (generation: string) => {
    symlinkSync(generation, join(root, 'raf-main.next')); renameSync(join(root, 'raf-main.next'), join(root, 'raf-main'));
    await store.transaction(state => { state.activeGeneration = generation; });
  };
  const fact = (kind: PendingFact['kind'], id: string, generation = 'A'): PendingFact => ({ id, kind, generation, protocol: generation === 'A' ? 1 : 2, address: 'live-agent', runId: evidence.runId, payload: { text: id, status: 'succeeded', reportPath: report } });
  const guard = setTimeout(() => { evidence.timedOut = true; for (const item of children) if (live(item) || item.child.exitCode === null && item.child.signalCode === null) item.child.kill('SIGKILL'); }, 180000);
  try {
    for (const id of ['A', 'B']) {
      const slot = join(root, id); mkdirSync(slot);
      cpSync(join(source, 'src/main-generation-handover.ts'), join(slot, 'handover.ts'));
      writeFileSync(join(slot, 'generation.ts'), `export const generation = ${JSON.stringify(id)};\n`);
      atomic(join(slot, 'version.json'), { id, protocol: id === 'A' ? 1 : 2, engineHash: hash(join(slot, 'handover.ts')), versionHash: hash(join(slot, 'generation.ts')) });
      for (const asset of ['catalog', 'module']) writeFileSync(join(slot, asset + '.txt'), id + ':' + asset);
    }
    symlinkSync('A', join(root, 'raf-main'));
    const setup = new DatabaseSync(join(root, 'state.sqlite'));
    setup.exec('PRAGMA journal_mode=WAL; CREATE TABLE state(id INTEGER PRIMARY KEY,payload TEXT); CREATE TABLE deliveries(id TEXT PRIMARY KEY,payload TEXT,owner TEXT,version TEXT); CREATE TABLE attempts(seq INTEGER PRIMARY KEY,fact TEXT,owner TEXT,epoch INTEGER,version TEXT)');
    const runner = launch('runner', { report }); await until(() => !!runner.ready(), 'runner');
    evidence.runId = randomUUID();
    const runnerIdentity = { address: 'live-agent', runId: evidence.runId, pid: runner.child.pid!, startedAt: runner.ready().identity.startTicks, session: 'live-session', runnerSessionId: randomUUID(), tmp: reportDirectory, report };
    evidence.runner = { ...runnerIdentity, processIdentity: runner.ready().identity };
    const initial: HandoverState = {
      activeGeneration: 'A', generations: Object.fromEntries(['A', 'B'].map(id => [id, { id, root: join(root, id), published: true, protocols: Object.fromEntries(kinds.map(kind => [kind, { emits: id === 'A' ? 1 : 2, accepts: [1, 2] }])) }])) as HandoverState['generations'],
      owners: Object.fromEntries(roles.map(role => ['A-' + role, { ownerId: 'A-' + role, epoch: 1, role, generation: 'A', phase: 'active' }])), activeOwners: { service: 'A-service', worker: 'A-worker', notice: 'A-notice' },
      runners: { [evidence.runId]: runnerIdentity }, operations: {}, facts: {}, transition: null,
      resourceWait: { queue: ['resource-first', 'resource-second'], lastGrant: 1729 }, bugSync: { cursor: 'bugs-before-switch' },
    };
    setup.prepare('INSERT INTO state VALUES(1,?)').run(JSON.stringify(initial)); setup.close();
    ({ db, store } = connection(root));
    for (const owner of Object.values(initial.owners)) await runtime.start(owner, owner.role === 'service' ? ['bugs', 'resource-wait'] : owner.role === 'notice' ? ['reminders'] : ['reports', 'events', 'messages']);
    const invariant = async () => {
      const state = await store.read();
      assert.deepEqual(state.runners, initial.runners); assert.deepEqual(state.resourceWait, initial.resourceWait); assert.deepEqual(state.bugSync, initial.bugSync);
      assert.ok(live(runner)); assert.ok(existsSync(reportDirectory));
      for (const role of roles) assert.equal(Object.values(state.owners).filter(owner => owner.role === role && owner.phase === 'active').length, 1);
    };
    await snapshot('initial');
    await runner.rpc('write', { fact: fact('report', 'before') });
    await until(() => JSON.parse(db!.prepare('SELECT payload FROM state').get()!.payload as string).facts.before, 'report before handover');
    await command('drain', [initial.owners['A-worker']]);
    await command('pin', [{ id: 'service-queue', ownerId: 'A-service', kind: 'resource-wait' }]);
    await command('pin', [{ id: 'deferred-import', ownerId: 'A-worker', kind: 'worker-import' }]);
    blockReady.add('B:worker'); await publish('B');
    const forward = await command('begin', ['B']);
    await command('advance', [forward], 1, 'readiness is not restored: worker');
    assert.equal(confirmable(await store.read()), false);
    assert.equal(await command('asset', ['deferred-import', 'module']), 'A:module');
    await runner.rpc('write', { fact: fact('report', 'during') });
    await until(() => JSON.parse(db!.prepare('SELECT payload FROM state').get()!.payload as string).facts.during, 'report during handover');
    await command('reusable', ['A'], 1, 'SLOT_IN_USE');
    await snapshot('unready'); await invariant();
    blockReady.clear(); await command('advance', [forward], 1, 'pinned operations must drain');
    await command('finish', ['service-queue']); await command('finish', ['deferred-import']);
    const old = actors.get('A-worker'); old.child.kill('SIGKILL'); await old.done;
    await command('recover'); await invariant(); await snapshot('forward-recovered');
    assert.equal(confirmable(await store.read()), true);
    await command('reusable', ['A']);
    evidence.scenarios.push('A-to-B: unready refusal, old-generation deferred import and resource operation drain, report during transfer, old observer SIGKILL and recovery');
    const activeB = (await store.read()).owners[(await store.read()).activeOwners.worker];
    await actors.get(activeB.ownerId).rpc('lose-ack');
    await command('fact', [fact('report', 'lost-ack', 'B')]);
    await command('drain', [activeB], 1, 'Observer exited before acknowledgement');
    assert.ok(existsSync(join(root, 'lost-ack.json')));
    await command('recover');
    assert.equal(db!.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE id='lost-ack'").get()!.n, 1);
    assert.equal(db!.prepare("SELECT COUNT(*) AS n FROM attempts WHERE fact='lost-ack'").get()!.n, 2);
    await invariant(); await snapshot('new-observer-recovered');
    evidence.scenarios.push('B observer SIGKILL after durable delivery before acknowledgement: two attempts, one delivery, recovered ownership epoch');
    for (const kind of ['event', 'message', 'reminder'] as const) await command('fact', [fact(kind, kind + '-rollback', 'B')]);
    await publish('A'); const reverse = await command('begin', ['A']);
    await command('advance', [reverse]); await invariant(); await command('reusable', ['B']);
    await runner.rpc('write', { fact: fact('report', 'after', 'B') });
    await until(() => JSON.parse(db!.prepare('SELECT payload FROM state').get()!.payload as string).facts.after, 'report after rollback');
    const activeA = (await store.read()).owners[(await store.read()).activeOwners.worker];
    await command('drain', [activeA]); await command('recover');
    await snapshot('rollback-complete');
    evidence.scenarios.push('B-to-A rollback: both protocols, events/messages/reminders and report after transfer, unchanged runner and resource queue');
    await store.transaction(state => { state.generations.B.protocols.report.accepts = [2]; });
    await publish('B'); await command('begin', ['B'], 1, 'MAIN_PROTOCOL_INCOMPATIBLE');
    assert.equal(confirmable(await store.read()), false);
    assert.equal((await store.read()).transition!.status, 'complete');
    assert.equal((await store.read()).owners[(await store.read()).activeOwners.worker].generation, 'A');
    await snapshot('incompatible-refused');
    await publish('A'); await store.transaction(state => { state.generations.B.protocols.report.accepts = [1, 2]; });
    evidence.scenarios.push('Incompatible B report protocol: nonzero before new owners, original observation survives, release remains incomplete');
    blockReady.add('B:worker'); await publish('B');
    const unready = await command('begin', ['B']); await command('advance', [unready], 1, 'readiness is not restored: worker');
    assert.equal(confirmable(await store.read()), false);
    await runner.rpc('write', { fact: fact('report', 'rollback-unready') });
    await until(() => JSON.parse(db!.prepare('SELECT payload FROM state').get()!.payload as string).facts['rollback-unready'], 'report before unready rollback');
    const retained = (await store.read()).activeOwners;
    await publish('A'); const cancelled = await command('begin', ['A']); await command('advance', [cancelled]);
    assert.deepEqual((await store.read()).activeOwners, retained);
    await command('recover'); await command('reusable', ['B']); await invariant();
    evidence.scenarios.push('Rollback of unready handover: original A owners preserved, B drained, pending report accepted');
    const final = await snapshot('final');
    assert.equal(confirmable(final), true);
    assert.equal(Object.keys(final.facts).length, 8);
    assert.ok(Object.values(final.facts).every(fact => fact.status === 'accepted'));
    assert.equal(db!.prepare('SELECT COUNT(*) AS n FROM deliveries').get()!.n, 8);
    assert.equal(db!.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE version='B'").get()!.n > 0, true);
    assert.equal(db!.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE version='A'").get()!.n > 0, true);
    evidence.outcome = 'passed';
  } catch (error: any) { evidence.error = { message: error.message, stack: error.stack }; evidence.outcome = 'failed'; process.exitCode = 1; }
  finally {
    clearTimeout(guard);
    for (const item of children) {
      if (item.child.exitCode === null && item.child.signalCode === null) { if (live(item)) item.child.kill('SIGTERM'); else item.child.kill('SIGKILL'); }
      await item.done;
    }
    evidence.cleanup = { complete: children.every(item => item.child.exitCode !== null || item.child.signalCode !== null), remainingPids: children.filter(item => item.child.exitCode === null && item.child.signalCode === null).map(item => item.child.pid) };
    evidence.finishedAt = new Date().toISOString();
    db?.close(); atomic(join(output, 'summary.json'), evidence);
    console.log(JSON.stringify({ outcome: evidence.outcome, root, runId: evidence.runId, evidence: join(output, 'summary.json'), cleanup: evidence.cleanup, error: evidence.error?.message }));
  }
}
