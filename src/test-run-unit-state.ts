import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { migrateState } from './state-migration.ts';
import { stateFailure, verifyStateContext, type StateContext } from './state-migration-guard.ts';
import { inspectStateSchema } from './state-schema.ts';
import { STATE_SCHEMA_VERSION } from './state-store.ts';
import type { TestRunGroupKey } from './test-runs.ts';

export async function prepareUnitTestState(context: StateContext, key: TestRunGroupKey): Promise<void> {
  verifyStateContext(context);
  const owner = join('/tmp', `raf-unit-${process.getuid?.() ?? 'user'}`);
  const expectedHome = join(owner, createHash('sha256').update(JSON.stringify([context.orchestratorRoot, key.project, key.workspace])).digest('hex'));
  if (context.mode !== 'qa' || context.homeDirectory !== expectedHome) {
    throw stateFailure('STATE_CONTEXT_REFUSED', 'Only the owned test-run QA HOME may be prepared automatically');
  }
  for (const path of [owner, expectedHome, dirname(context.statePath)]) {
    if (!existsSync(path)) continue;
    const identity = lstatSync(path);
    if (realpathSync(path) !== path || !identity.isDirectory() || identity.uid !== process.getuid?.() || (identity.mode & 0o077) !== 0 && path !== dirname(context.statePath)) {
      throw stateFailure('STATE_CONTEXT_REFUSED', `Unit state directory is not owned or private: ${path}`);
    }
  }
  for (const path of [context.statePath, context.statePath + '-wal', context.statePath + '-shm']) {
    if (!existsSync(path)) continue;
    const identity = lstatSync(path);
    if (!identity.isFile() || identity.nlink !== 1 || identity.uid !== process.getuid?.()) {
      throw stateFailure('STATE_CONTEXT_REFUSED', `Unit state file is not exclusively owned: ${path}`);
    }
  }
  if (!existsSync(context.statePath)) return;
  const version = inspectStateSchema(context.statePath).version;
  if (version <= 0 || version >= STATE_SCHEMA_VERSION) return;
  await migrateState({ context, statePath: context.statePath, fromVersion: version, toVersion: STATE_SCHEMA_VERSION,
    backupPath: `${context.statePath}.pre-v${version}-${randomUUID()}.sqlite` });
}
