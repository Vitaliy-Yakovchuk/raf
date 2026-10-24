import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createProductionServices, rafSystemCaller } from '../src/production-runtime.ts';
import { readWaitIdentity } from '../src/resource-wait-identity.ts';
import { loadEventCatalog } from '../src/event-catalog.ts';
import { createStoredLaunchQueueEvents } from '../src/stored-launch-queue-events.ts';
import type { StateStore } from '../src/state-store.ts';
import type { ProcessIdentity } from '../src/session-state.ts';
import type { RuntimeConfiguration } from '../src/app-runtime.ts';

const codeRoot = resolve(import.meta.dirname, '..');
const orchestratorRoot = resolve(codeRoot, '..');

export async function startQueueMainStand(directory: string) {
  const socket = join(directory, 'main.sock');
  const log = join(directory, 'main-input.jsonl');
  const receiver = join(directory, 'main-receiver.mjs');
  mkdirSync(join(directory, 'home'), { recursive: true });
  writeFileSync(receiver, `import {appendFileSync} from 'node:fs';
process.stdin.setRawMode(true); process.stdin.setEncoding('utf8');
let input=''; process.stdin.on('data', chunk=>{ input+=chunk;
  for (;;) { const at=input.search(/[\\r\\n]/); if(at<0) break;
    const line=input.slice(0,at).replace(/\\x1b\\[(?:200|201)~/g,''); input=input.slice(at+1);
    if(line) appendFileSync(process.argv[2],JSON.stringify({text:line,pid:process.pid})+'\\n');
  }
}); console.log('QUEUE_MAIN_READY');
`);
  const environment = { PATH: process.env.PATH!, HOME: join(directory, 'home'), TERM: 'xterm' };
  const tmux = (args: string[]) => spawnSync('tmux', ['-u', '-S', socket, ...args], { encoding: 'utf8', env: environment });
  const start = tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'queue-main', '-x', '140', '-y', '30', process.execPath, receiver, log]);
  assert.equal(start.status, 0, start.stderr);
  const pane = tmux(['display-message', '-p', '-t', 'queue-main:0.0', '#{pane_id}|#{pane_pid}']);
  assert.equal(pane.status, 0, pane.stderr);
  const [paneId, pidString] = pane.stdout.trim().split('|');
  const pid = Number(pidString);
  for (let attempt = 0; attempt < 100; attempt++) {
    const screen = tmux(['capture-pane', '-p', '-t', paneId]);
    if (screen.stdout.includes('QUEUE_MAIN_READY')) break;
    assert.ok(attempt < 99, JSON.stringify({ message: 'Main stand did not become ready', pane: pane.stdout, paneId, screen: screen.stdout, error: screen.stderr }));
    await delay(20);
  }
  const rows = spawnSync('ps', ['-ww', '-axo', 'pid=,lstart=,command='], { encoding: 'utf8' });
  assert.equal(rows.status, 0, rows.stderr);
  const row = rows.stdout.split('\n').map(line => line.match(/^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/)).find(row => Number(row?.[1]) === pid)!;
  assert.ok(row);
  const boot = await readWaitIdentity(pid);
  const identity: ProcessIdentity = { pid, startedAt: new Date(row[2]).toISOString(), runner: 'main', runnerSessionId: paneId,
    tmuxSession: 'queue-main', evidence: { command: row[3], tmuxSocket: socket, tmuxPane: paneId, machineId: boot.machineId, bootId: boot.bootId } };
  return { identity, runId: randomUUID(), socket,
    received: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [],
    stop: async () => {
      const stopped = tmux(['kill-server']);
      assert.equal(stopped.status, 0, stopped.stderr);
      for (let attempt = 0; attempt < 100; attempt++) {
        const stat = existsSync(`/proc/${pid}/stat`) ? readFileSync(`/proc/${pid}/stat`, 'utf8') : '';
        if (!stat || /\) [ZX] /.test(stat)) return { exitCode: stopped.status, remainingPids: [] };
        assert.ok(attempt < 99, 'Main stand remained alive after kill-server');
        await delay(20);
      }
      throw new Error('Main stand cleanup was not verified');
    },
  };
}

export async function queueCommandPorts(store: StateStore, directory: string) {
  const catalog = JSON.parse(readFileSync(join(codeRoot, 'dist/catalog.json'), 'utf8'));
  const configuration: RuntimeConfiguration = { catalog, models: { runners: [] } as unknown as RuntimeConfiguration['models'], commandTiming: { emaAlpha: 0.1 } };
  const services = await createProductionServices(store, configuration, {
    orchestratorRoot, confRoot: join(orchestratorRoot, 'conf'), artifactPath: join(codeRoot, 'dist/catalog.json'),
    statePath: join(directory, 'state.sqlite'), tmpRoot: join(directory, 'tmp'), mode: 'test', commandStartedAtMs: Date.now(), resolveCaller: async () => undefined,
  });
  const identity = { stateDomain: join(directory, 'state.sqlite'), machineId: (await readWaitIdentity()).machineId };
  return { store, catalog: loadEventCatalog(orchestratorRoot), now: Date.now, nextReminderId: randomUUID,
    validateResourceQueueId: async (id: string) => createStoredLaunchQueueEvents(store, identity).validateQueueId(id),
    deliver: (request: {to: string; text: string}) => services.control.message(request, rafSystemCaller),
  };
}
