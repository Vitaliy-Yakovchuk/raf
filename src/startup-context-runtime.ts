import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionRecord } from './session-state.ts';
import type { StartupContextLifecyclePorts } from './startup-context-lifecycle.ts';
import { collectStartupContextJournal } from './startup-context-journal.ts';
import { readPendingAgentReport, type AgentReportResult } from './agent-report.ts';
import { verifyAssignmentCompletion } from './assignment.ts';
import { executeCommand } from './os-runtime.ts';

export function startupContextRuntimeFiles(tmpRoot: string, homeDirectory = homedir()): Pick<StartupContextLifecyclePorts, 'collectJournal' | 'readBriefParts' | 'removeRunDirectory' | 'estimateTokens' | 'diagnostic'> {
  const directory = (session: SessionRecord) => {
    if (!session.launchContext || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(session.runId) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(session.addressId) || session.launchContext.reportPath !== join(tmpRoot, session.runId, `${session.addressId}.json`) || session.launchContext.briefPath !== join(tmpRoot, session.runId, 'brief.txt')) throw new Error('Startup context run directory identity mismatch');
    return join(tmpRoot, session.runId);
  };
  return {
    estimateTokens: text => Math.ceil(Buffer.byteLength(text) / 4),
    diagnostic: reason => { process.stderr.write(`${reason}\n`); },
    collectJournal: async session => {
      const runner = session.process?.runner;
      if (runner !== 'claude' && runner !== 'codex') return { events: [], unavailableReason: 'Native runner identity unavailable' };
      return collectStartupContextJournal({ runner, runnerSessionId: session.process!.runnerSessionId, homeDirectory, environment: process.env });
    },
    readBriefParts: async session => { directory(session); return [{ source: 'brief.txt', text: await fs.readFile(session.launchContext!.briefPath, 'utf8') }]; },
    removeRunDirectory: async session => { if (session.launchContext) await fs.rm(directory(session), { recursive: true, force: true }); },
  };
}

export async function startupContextAcceptedReport(session: SessionRecord, tmpRoot: string, now: () => string): Promise<AgentReportResult> {
  if (session.result) {
    const context = (session.result.proof as { context?: any } | null)?.context;
    const status = session.result.status === 'succeeded' ? 'succeeded' : 'failed';
    return { runId: session.runId, id: session.addressId, event: `agent.${status}`, status, at: now(), report: { status, answer: session.result.response, changes: [], ...(context ? { context } : {}) } };
  }
  if (session.launchContext) {
    const result = await readPendingAgentReport({ tmpRoot, runId: session.runId, address: session.addressId, assignment: session.launchContext.assignment }, {
      fs: { readText: async path => { try { return await fs.readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } } },
      now, diagnostic: async () => {},
      verifyAssignmentCompletion: (assignment, archives) => verifyAssignmentCompletion(assignment, { cli: { exec: (args, cwd) => executeCommand({ executable: 'openspec', args, cwd }) }, fs: { readText: path => fs.readFile(path, 'utf8') } }, archives),
    });
    if (result) return result;
  }
  return { runId: session.runId, id: session.addressId, status: 'failed', event: 'agent.failed', at: now() };
}
