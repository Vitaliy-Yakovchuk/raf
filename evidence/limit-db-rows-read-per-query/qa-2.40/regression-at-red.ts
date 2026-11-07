import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateStore } from '../src/state-store.ts';
import { initializeQaStartupContext } from './database-read-limit-qa-fixture.ts';

test('QA fixture initializes the lazy startup-context schema before seeding completions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raf-qa-startup-schema-'));
  const state = openStateStore(join(directory, 'state.sqlite'));
  try {
    const db = initializeQaStartupContext(state.startupContextDatabase);
    const columns = db.prepare('PRAGMA table_info(startup_context_completions)').all();
    assert.ok(columns.some(column => column.name === 'run_id'), 'Fresh state store needs startup-context initialization before fixture inserts');
  } finally {
    state.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
