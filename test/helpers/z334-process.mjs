import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const [payloadPath] = process.argv.slice(2);
const p = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
const api = await import(pathToFileURL(path.join(p.code, 'src/hotfix-activation.ts')));
const send = value => process.send(value);
try {
  if (p.mode === 'observer') {
    let stop = false;
    process.once('message', () => { stop = true; });
    const observed = new Set(); let samples = 0;
    const sample = () => {
      const fd = fs.openSync(p.main, 'r');
      try {
        const pair = ['a.mjs', 'b.mjs'].map(name => fs.readFileSync('/proc/self/fd/' + fd + '/qa-z334/' + name, 'utf8'));
        assert.equal(pair[0], pair[1], 'One opened directory must contain a complete generation');
        observed.add(pair[0]); samples++;
      } finally { fs.closeSync(fd); }
    };
    sample(); send({ ready: true });
    while (!stop) { sample(); await delay(p.pollMs); }
    sample(); send({ observations: [...observed], samples });
  } else if (p.mode === 'reader') {
    const lease = await api.acquireHotfixReader(p.host, p.kind);
    const first = await import(pathToFileURL(path.join(lease.generationRoot, 'qa-z334/a.mjs')));
    const go = once(process, 'message');
    send({ ready: true, marker: first.marker, commit: lease.commit, root: lease.generationRoot });
    await go;
    const second = await import(pathToFileURL(path.join(lease.generationRoot, 'qa-z334/b.mjs')));
    assert.equal(second.marker, first.marker, 'Deferred imports must use one generation');
    await lease.release();
    send({ pair: [first.marker, second.marker] });
  } else if (p.mode === 'recover') {
    send({ result: await api.recoverHotfixActivation(p.host) });
  } else if (p.mode === 'enter') {
    try {
      const lease = await api.acquireHotfixReader(p.host, 'cli');
      const pair = ['a.mjs', 'b.mjs'].map(name => fs.readFileSync(path.join(lease.generationRoot, 'qa-z334', name), 'utf8'));
      assert.equal(pair[0], pair[1]);
      await lease.release();
      send({ pair });
    } catch (error) { send({ refused: error.message }); }
  } else {
    if (p.mode === 'race') {
      const go = once(process, 'message'); send({ ready: true }); await go;
    }
    const real = api.createAtomicHotfixSwitch();
    const switchProvider = { probe: (...args) => real.probe(...args), exchange: async (...args) => {
      fs.appendFileSync(p.exchangeLog, JSON.stringify({ pid: process.pid, paths: args }) + '\n');
      await real.exchange(...args);
    } };
    send({ result: await api.activateHotfix(p.host, p.candidate, { switchProvider, checkpoint: async phase => {
      if (phase === p.phase) { send({ phase }); await new Promise(() => {}); }
    } }) });
  }
} catch (error) { send({ error: error.message, stack: error.stack }); process.exitCode = 1; }
finally { process.disconnect(); }
