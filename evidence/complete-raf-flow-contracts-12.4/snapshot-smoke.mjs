import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCompiledCatalog } from '../../src/compiled-catalog.ts';
import { composeBriefGuide } from '../../src/brief-guide.ts';
import { validAgentReport } from '../../src/agent-report.ts';
import { loadEventCatalog } from '../../src/event-catalog.ts';
import { loadTaskContextConfiguration } from '../../src/task-context.ts';
import '../../src/production-runtime.ts';

const catalog = loadCompiledCatalog();
const assignment = { root: '/no-live-conf', changes: [{ id: 'complete-raf-flow-contracts', items: [{ id: '12.4', description: 'snapshot' }] }] };
const context = { cwd: '/no-live-conf/work', rafCommand: 'raf', stage: 'implement', phase: 'implement', outcome: 'snapshot', project: 'raf', agentId: 'snapshot-agent', writeBoundaries: ['/no-live-conf/work'], runner: catalog.models.runners[0].id, features: ['complete-raf-flow-contracts'], rafSubcommands: ['agent message'] };
const guide = await composeBriefGuide(assignment, context, { readText: async () => { throw new Error('Live conf read refused'); } }, catalog);
assert(guide.includes('agent message'));
assert(guide.includes(catalog.commands.find(row => row.handlerName === 'agent message').description));
const snapshot = structuredClone(catalog);
snapshot.reportStatuses = [{ id: 'snapshot-status', event: 'agent.succeeded', description: 'snapshot' }];
snapshot.constants.reportStatuses = snapshot.reportStatuses;
const report = { status: 'snapshot-status', answer: '', changes: [{ id: assignment.changes[0].id, items: [{ id: '12.4', status: 'snapshot-status' }] }] };
assert(validAgentReport(report, assignment, { catalog: snapshot }));
assert(!validAgentReport({ ...report, status: 'succeeded' }, assignment, { catalog: snapshot }));
snapshot.constants.events = [{ id: 'snapshot.event', idKind: 'agentAddress', description: 'snapshot' }];
assert.deepEqual(loadEventCatalog('/no-live-conf', snapshot).events.map(row => row.id), ['snapshot.event']);
const conf = await mkdtemp(join(tmpdir(), 'raf-catalog-snapshot-'));
try {
  await writeFile(join(conf, 'projects.json'), JSON.stringify(catalog.projects));
  const configuration = await loadTaskContextConfiguration(conf, snapshot);
  assert.deepEqual(configuration.reportStatuses, snapshot.reportStatuses);
} finally { await rm(conf, { recursive: true, force: true }); }
console.log(JSON.stringify({ outcome: 'passed', checks: ['brief uses compiled commands without live conf', 'report status membership follows supplied snapshot', 'event catalog follows supplied snapshot', 'task report schema source follows snapshot without constants file', 'production-runtime module imports'], cleanup: 'complete' }));
