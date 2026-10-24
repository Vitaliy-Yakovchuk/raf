import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
import { deliveryDiagnostic } from '../src/delivery-diagnostic.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';

export function traceWorkerCommands(path: string, settings: ProtocolSettings, brief: string) {
  const spawn = childProcess.spawn;
  let sequence = 0;
  childProcess.spawn = function (...args: Parameters<typeof spawn>) {
    const startedAt = Date.now();
    const id = sequence++;
    const command = args[1] as string[];
    const tmux = basename(String(args[0])) === 'tmux';
    const operation = tmux ? command[0] === '-S' ? command[2] : command[0] : basename(String(args[0]));
    const child = Reflect.apply(spawn, this, args);
    let screen = '';
    if (tmux && operation === 'capture-pane') child.stdout?.on('data', data => { screen += data; });
    child.once('close', (code, signal) => {
      appendFileSync(path, JSON.stringify({ id, operation, startedAt, durationMs: Date.now() - startedAt, code, signal,
        ...(screen ? { frame: deliveryDiagnostic(settings, { screen, brief, phase: 'awaiting_acceptance', retried: false }) } : {}),
      }) + '\n');
    });
    return child;
  } as typeof spawn;
  syncBuiltinESMExports();
}
