// Usage: node evidence/.../profile.mjs SNAPSHOT QA_ROOT before|after [busy|snapshot]
// SNAPSHOT must be an SQLite backup, never a production database path.
import { registerHooks } from 'node:module';
import { execFileSync, fork } from 'node:child_process';
import { mkdirSync, copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { once } from 'node:events';
const [snapshot, qaRoot, version, workload = 'busy'] = process.argv.slice(2);
const codeRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const root = resolve(codeRoot, '..');
const baseline = '2470a7c5d9008983556a1c67351c457908be2ead';
const storeUrl = pathToFileURL(join(codeRoot, 'src/state-store.ts')).href;
if (version === 'before') {
  const source = execFileSync('git', ['show', `${baseline}:src/state-store.ts`], { cwd: codeRoot, encoding: 'utf8' });
  registerHooks({ load(url, context, next) { return url === storeUrl ? { format: 'module-typescript', source, shortCircuit: true } : next(url, context); } });
}
const home = resolve(qaRoot, version);
mkdirSync(join(home, '.raf'), { recursive: true });
process.env.HOME = process.env.RAF_QA_HOME = home;
const settings = JSON.parse(readFileSync(join(root, 'conf/raf.json'), 'utf8'));
const statePath = join(home, '.raf', settings.state.fileName);
const { openStateStore } = await import(storeUrl);
const { createAppRuntime } = await import(pathToFileURL(join(codeRoot, 'src/app-runtime.ts')));
const { loadCompiledCatalog } = await import(pathToFileURL(join(codeRoot, 'src/compiled-catalog.ts')));
const { loadEventCatalog } = await import(pathToFileURL(join(codeRoot, 'src/event-catalog.ts')));
const { deliverCheckedMessage } = await import(pathToFileURL(join(codeRoot, 'src/message-delivery.ts')));
const socket = join(home, 'busy.sock');
const frame = join(home, 'busy-frame.txt');
writeFileSync(frame, 'Shift+Tab:mode\n│ ❯ existing unfinished draft │\n');
// An owned tmux pane supplies an actual capture; no live runner receives input.
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const pane = execFileSync('tmux', ['-S', socket, 'new-session', '-d', '-P', '-F', '#{pane_id}', '-s', 'profile', `cat ${shellQuote(frame)}; exec sleep 3600`], { encoding: 'utf8' }).trim();
await new Promise(resolve => setTimeout(resolve, 100));
const protocol = settings.runnerProtocols.find(row => row.runner === 'grok');
const samples = [];
try {
  for (const command of ['reminder list', 'reminder close']) for (let repetition = 0; repetition < 5; repetition++) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(statePath + suffix, { force: true });
    copyFileSync(snapshot, statePath);
    const service = fork(fileURLToPath(new URL('./profile-service.mjs', import.meta.url)), [codeRoot, root, home], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let serviceError = '';
    service.stderr.on('data', chunk => serviceError += chunk);
    await Promise.race([once(service, 'message'), once(service, 'exit').then(() => { throw new Error(serviceError || 'Service exited before readiness'); })]);
    const store = openStateStore(statePath);
    const db = store.startupContextDatabase;
    // Preserve the copied rows and add the observed busy-worker condition.
    // These reminders address workers, while list addresses main; settle must
    // still attempt every undelivered active reminder synchronously.
    for (let i = 0; workload === 'busy' && i < 30; i++) {
      const addressId = `profile-busy-${i}`;
      store.sessionRepository.transaction(tx => tx.putSession({ runId: addressId, addressId, state: 'running', revision: 1 }));
      store.reminderRepository.transaction(tx => tx.save({ id: addressId, createdFor: addressId, assignedTo: addressId,
        text: 'Controlled busy-recipient profile', at: '2026-10-27T03:00:00Z', binding: null, state: 'active', closedAt: null, closeReason: null }));
    }
    const size = Number(db.prepare('SELECT count(*) AS n FROM reminders').get().n);
    const sessions = Number(db.prepare('SELECT count(*) AS n FROM sessions').get().n);
    const closeId = JSON.parse(String(db.prepare("SELECT payload FROM reminders WHERE state='active' LIMIT 1").get().payload)).id;
    const prepare = db.prepare.bind(db);
    let fullSessionReads = 0, deliveries = 0, deliveryMs = 0, captures = 0, verifies = 0;
    db.prepare = sql => { if (/SELECT payload FROM sessions\s*$/i.test(sql)) fullSessionReads++; return prepare(sql); };
    const delivery = async () => {
      const started = performance.now(); deliveries++;
      const receipt = await deliverCheckedMessage({ settings: protocol, waitForComposer: false,
        verify: async () => { verifies++; return execFileSync('tmux', ['-S', socket, 'display-message', '-p', '-t', pane, '#{pane_id}'], { encoding: 'utf8' }).trim() === pane; },
        capture: async () => { captures++; return execFileSync('tmux', ['-S', socket, 'capture-pane', '-p', '-t', pane], { encoding: 'utf8' }); },
        paste: async () => { throw new Error('Busy pane must never receive input'); }, enter: async () => { throw new Error('Busy pane must never receive Enter'); },
        now: Date.now, delay: async () => { throw new Error('Busy worker must refuse without waiting'); },
      }, 'profile message');
      if (receipt.accepted || receipt.reason !== 'Recipient has no recognized empty agent composer') throw new Error(JSON.stringify(receipt));
      deliveryMs += performance.now() - started;
      return receipt;
    };
    const catalog = loadCompiledCatalog();
    const runtime = createAppRuntime({ orchestratorRoot: root, confRoot: join(root, 'conf'), artifactPath: join(codeRoot, 'dist/catalog.json'),
      statePath, tmpRoot: join(home, '.raf/tmp'), mode: 'test', commandStartedAtMs: performance.now(), resolveCaller: async () => undefined }, {
      loadConfiguration: async () => ({ catalog, models: catalog.models, commandTiming: settings.commandTiming }), openStore: async () => store,
      createServices: async () => { throw new Error('Reminder commands must not await service readiness'); }, now: performance.now.bind(performance),
      nextRunIdentity: () => { throw new Error('No launches'); }, commandState: () => ({ store, orchestratorRoot: root, catalog: loadEventCatalog(root), now: () => Date.parse('2026-10-27T03:08:00Z'), nextReminderId: () => 'profile', deliver: delivery }),
    });
    process.stderr.write(`sample ${command} ${repetition} ready\n`);
    const started = performance.now();
    await runtime.handlers[command](command === 'reminder list' ? { to: 'main' } : { id: closeId, reason: 'profile' });
    const durationMs = performance.now() - started;
    await runtime.close();
    service.send('stop');
    const [stopped] = await Promise.race([once(service, 'message'), once(service, 'exit').then(() => { throw new Error(serviceError || 'Service exited before readiness'); })]);
    await once(service, 'exit');
    if (serviceError) throw new Error(serviceError);
    samples.push({ command, repetition, reminders: size, sessions, durationMs, fullSessionReads, deliveries, deliveryMs, captures, verifies, service: stopped });
  }
} finally { execFileSync('tmux', ['-S', socket, 'kill-server']); }
console.log(JSON.stringify({ version, baseline, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: codeRoot, encoding: 'utf8' }).trim(), samples }, null, 2));
