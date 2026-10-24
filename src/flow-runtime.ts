import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentReport } from './agent-report.ts';
import type { FlowQaLaunchContext } from './flow-qa-report.ts';
import { promises as fs, existsSync } from 'node:fs';
import { join, resolve, isAbsolute, relative, sep, dirname } from 'node:path';
import { flowDigest, type FlowQaEvidencePorts, type FlowTestRunStore } from './flow-qa-report.ts';
import { validateFlowTaskPlan, type FlowPlanDocument, type FlowPlanEvidence } from './flow-task-plan.ts';
import { loadFlowPolicy } from './flow-policy.ts';
import type { AssignmentSnapshot } from './assignment.ts';
import type { StateStore } from './state-store.ts';

export function flowSources(root: string) {
  const source = (capability: string, change?: string) => {
    const delta = change && join(root, 'openspec/changes', change, 'specs', capability, 'spec.md');
    return delta && existsSync(delta) ? delta : join(root, 'openspec/specs', capability, 'spec.md');
  };
  return { userQa: source('core/process/user-qa', 'enforce-flow-approaches'), agentReport: source('projects/raf/agent-report', 'enforce-flow-approaches'), agentRun: source('projects/raf/agent-run', 'enforce-flow-approaches'), featureTestAuthoring: source('core/process/feature-test-authoring', 'add-raf-test-run'), featureImplementation: source('core/process/feature-implementation'), unitTestRuns: source('core/process/unit-test-runs', 'add-raf-test-run'), testRuns: source('projects/raf/test-runs', 'add-raf-test-run'), flowApproval: source('projects/orchestrator/flow-approval') };
}
export function flowTestRunStore(store: StateStore): FlowTestRunStore {
  return {
    put: async fact => store.sessionRepository.transaction(tx => {
      const session = tx.getSession(fact.agentRunId);
      if (!session?.launchContext || session.result || !['running', 'exited'].includes(session.state) || session.addressId !== fact.agentId || session.activity?.project !== fact.project || session.activity?.cwd !== fact.workspace) throw new Error('Flow test caller is no longer current');
      const facts = session.launchContext.flowTestRuns ?? [];
      const existing = facts.find(row => row.testRunId === fact.testRunId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(fact)) throw new Error('Flow test result identity changed');
      tx.putSession({ ...session, launchContext: { ...session.launchContext, flowTestRuns: [...facts.filter(row => row.testRunId !== fact.testRunId), structuredClone(fact)] } });
    }),
    get: async id => store.sessionRepository.transaction(tx => {
      const facts = tx.listSessions().flatMap(session => session.launchContext?.flowTestRuns?.filter(row => row.testRunId === id) ?? []);
      return facts.length === 1 ? facts[0] : null;
    }, 'read'),
    removeForAgentRun: async id => store.sessionRepository.transaction(tx => {
      const session = tx.getSession(id);
      if (session?.launchContext) { const { flowTestRuns, ...launchContext } = session.launchContext; tx.putSession({ ...session, launchContext }); }
    }),
  };
}
export async function flowPlanDocuments(assignment: AssignmentSnapshot): Promise<FlowPlanDocument[]> {
  return Promise.all(assignment.changes.map(async change => ({ change: change.id, path: join(assignment.root, 'openspec/changes', change.id, 'tasks.md'), text: await fs.readFile(join(assignment.root, 'openspec/changes', change.id, 'tasks.md'), 'utf8') })));
}
export function flowEvidencePorts(store: StateStore, root: string): FlowQaEvidencePorts {
  const config = JSON.parse(requireText(join(root, 'conf/test-runs.json')));
  const integrationProfiles = Object.values(config.projects ?? {}).flatMap((project: any) => Object.entries(project.groups ?? {}).flatMap(([group, value]: any) => {
    const profile = project.profiles[value.profileId];
    return profile?.testKind === 'integration' ? [{ profileId: value.profileId, group, files: value.files, timeoutMs: JSON.parse(requireText(join(root, 'conf/flow.json'))).integrationTests.timeoutMs }] : [];
  }));
  return { readText: async path => { try { return await fs.readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } }, realpath: fs.realpath, lookupTestRun: flowTestRunStore(store).get, unitPolicy: loadFlowPolicy(join(root, 'conf/flow.json')).unitTests, integrationProfiles,
    readOpenItems: async change => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(change)) return [];
      const text = await fs.readFile(join(root, 'openspec/changes', change, 'tasks.md'), 'utf8');
      return [...text.matchAll(/^\s*-\s+\[ \]\s+(\S+)\s/gm)].map(match => match[1]);
    },
  };
}
import { readFileSync } from 'node:fs';
const requireText = (path: string) => readFileSync(path, 'utf8');
export async function checkFlowPlan(store: StateStore, assignment: AssignmentSnapshot, phase: 'launch' | 'report', initial: readonly FlowPlanDocument[], workingMain: { project: string; workspace: string; branch: string }, verifiedEvidence: readonly { path: string; digest: string }[] = []) {
  const current = await flowPlanDocuments(assignment);
  const evidence: FlowPlanEvidence[] = [];
  const accepted = store.sessionRepository.transaction(tx => tx.listSessions().flatMap(session => {
    const proof = session.result?.proof as { flowEvidence?: { path: string; digest: string }[] } | undefined;
    return proof?.flowEvidence ?? [];
  }), 'read').concat(verifiedEvidence);
  for (const document of current) {
    const links = [...document.text.matchAll(/\]\(([^)]+\.json)\)|(?:^|\s)([^\s`]+\.json)(?=[`\s]|$)/gm)].map(match => match[1] ?? match[2]);
    for (const link of new Set(links)) {
      const path = resolve(link.startsWith('openspec/') ? assignment.root : dirname(document.path), link);
      const roots = assignment.changes.map(change => join(assignment.root, 'openspec/changes', change.id));
      const within = (value: string) => roots.some(root => { const suffix = relative(root, value); return !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep); });
      if (!within(path)) continue;
      try {
        if (!within(await fs.realpath(path))) continue;
        const bytes = await fs.readFile(path, 'utf8');
        const report = JSON.parse(bytes);
        const qa = report.qa ?? report;
        if (!Array.isArray(qa.scenarios) || !Array.isArray(qa.findings)) continue;
        const acceptedDigest = accepted.find(row => row.path === path)?.digest ?? null;
        const hotfix = qa.findings.find((finding: any) => finding.fixed === false && finding.mainHotfix?.workspace === workingMain.workspace && finding.mainHotfix?.branch === workingMain.branch);
        evidence.push({ ...(acceptedDigest === flowDigest(bytes) && hotfix ? { workingMainHotfix: { verified: true, ...workingMain } } : {}), path: link, digest: flowDigest(bytes), acceptedDigest, agentRunId: report.runId ?? '', scenarios: qa.scenarios.map((row: any) => ({ ...row, executed: row.status === 'succeeded' || qa.findings.some((finding: any) => finding.change === row.change && finding.item === row.item && finding.scenario === row.scenario) })), findings: qa.findings });
      } catch (error) { if ((error as NodeJS.ErrnoException).code && !['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code!)) throw error; }
    }
  }
  const result = await validateFlowTaskPlan({ assignment, phase, initial, current, evidence, workingMain });
  return { ...result, documents: current };
}

export async function acceptedFlowEvidence(report: AgentReport | undefined, trusted: FlowQaLaunchContext): Promise<{ path: string; digest: string }[]> {
  if (!report?.qa) return [];
  const addresses = new Set<string>();
  const qa = report.qa as any;
  for (const row of [...qa.scenarios, ...qa.findings, ...qa.followUps]) for (const path of row.evidence ?? []) if (typeof path === 'string' && path.endsWith('.json')) addresses.add(path);
  const accepted: { path: string; digest: string }[] = [];
  for (const address of addresses) {
    const path = resolve(trusted.assignment.root, address);
    const root = trusted.allowedEvidenceRoots.find(root => { const suffix = relative(root, path); return suffix !== '..' && !suffix.startsWith('..' + sep) && !isAbsolute(suffix); });
    if (!root) continue;
    try {
      const canonical = await fs.realpath(path);
      const suffix = relative(await fs.realpath(root), canonical);
      if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith('..' + sep)) continue;
      const bytes = await fs.readFile(path, 'utf8');
      const evidence = JSON.parse(bytes);
      if (evidence.runId !== trusted.runId || JSON.stringify(evidence.qa ?? evidence) !== JSON.stringify(report.qa)) continue;
      let committed = false;
      for (const commit of report.commits ?? []) {
        const file = relative(commit.repository, canonical);
        if (file === '..' || file.startsWith('..' + sep) || isAbsolute(file)) continue;
        const result = await promisify(execFile)('git', ['show', `${commit.sha}:${file}`], { cwd: commit.repository, maxBuffer: Math.max(Buffer.byteLength(bytes) + 1, 1024) }).catch(() => null);
        if (result?.stdout === bytes) committed = true;
      }
      if (committed) accepted.push({ path: canonical, digest: flowDigest(bytes) });
    } catch {}
  }
  return accepted;
}
