import { runSandboxTestCommand } from './sandbox-test-run.ts';
import type {
  SandboxCommandReply,
  SandboxCommandRequest,
  SandboxTestAssignment,
  SandboxTestControlSnapshot,
  SandboxTestRunPorts,
  SandboxTestSession,
  SandboxUnitContext,
} from './sandbox-test-run.ts';
import type { TestRunConfig, TestRunGroupKey, TestRunRequest } from './test-runs.ts';

export interface RegressionGrant {
  readonly sourceChange: string;
  readonly sourceItem: string;
  readonly group: string;
  readonly profileId: string;
  readonly files: readonly string[];
}

export interface RegressionTestAssignment extends SandboxTestAssignment {
  readonly regressionGroups?: readonly RegressionGrant[];
}

export interface RegressionCatalog {
  readonly config: Pick<TestRunConfig, 'projects' | 'phases'>;
  readonly activeChanges: readonly string[];
  readonly workspaces: SandboxTestControlSnapshot['workspaces'];
}

export interface RegressionLaunchInput {
  readonly assignment: SandboxTestAssignment;
  readonly selectedItems: readonly { readonly change: string; readonly item: string }[];
  readonly verifiedChanges: readonly {
    readonly id: string;
    readonly items: readonly { readonly id: string; readonly description: string }[];
  }[];
  readonly catalog: RegressionCatalog;
}

export interface RegressionTestSession extends SandboxTestSession {
  readonly assignment: RegressionTestAssignment;
}

export interface RegressionControlSnapshot extends SandboxTestControlSnapshot {
  readonly sessions: readonly RegressionTestSession[];
  readonly config: Pick<TestRunConfig, 'projects' | 'phases'>;
}

export interface RegressionAuthorization {
  readonly key: TestRunGroupKey;
  readonly profileId: string | null;
  readonly files: readonly string[];
  readonly provenance: readonly { readonly sourceChange: string; readonly sourceItem: string; readonly group: string }[];
}

export interface RegressionExecutionPorts extends Omit<SandboxTestRunPorts, 'control'> {
  control(caller: SandboxTestRunPorts['caller']): Promise<RegressionControlSnapshot>;
  wrapper(request: TestRunRequest, context: SandboxUnitContext): Promise<SandboxCommandReply>;
  evidence(authorization: RegressionAuthorization, reply: SandboxCommandReply): Promise<void>;
}

const marker = '; regressionGroups=';
const safeFile = (file: unknown): file is string => typeof file === 'string' && /\.[cm]?[jt]sx?$/.test(file) && !/^[A-Za-z]:|[\\*?\[\]{}\0]/.test(file) && !file.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('-'));
const exactGroup = (group: unknown): group is string => typeof group === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*\/[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(group) && group.split('/').every(part => part && part !== '.' && part !== '..');
const refuse = (reason: string): never => { throw Object.assign(new Error(`CALLER_UNAUTHORIZED: ${reason}; main must issue a new verified assignment`), { code: 'CALLER_UNAUTHORIZED' }); };
const invalid = (reason: string): never => { throw Object.assign(new Error(`Invalid regressionGroups declaration: ${reason}; correct the selected OpenSpec item and launch a new verified assignment`), { code: 'INVALID_ASSIGNMENT' }); };
const workspaceMatches = (assignment: SandboxTestAssignment, catalog: RegressionCatalog) => catalog.workspaces.some(row => row.project === assignment.project && row.workspace === assignment.workspace && row.branch === assignment.branch && row.actualBranch === assignment.branch);
const filesEqual = (left: readonly string[], right: readonly string[]) => left.length === right.length && new Set(left).size === left.length && left.every(file => right.includes(file));
const frozenGrants = (grants: readonly RegressionGrant[]): readonly RegressionGrant[] => Object.freeze(grants.map(grant => Object.freeze({ ...grant, files: Object.freeze([...grant.files]) })));

function presetFor(group: string, assignment: SandboxTestAssignment, catalog: RegressionCatalog) {
  if (!exactGroup(group)) return refuse(`Group ${group} is not an exact change/group key`);
  if (!catalog.activeChanges.includes(group.split('/')[0])) return refuse(`Target change for ${group} is inactive`);
  if (!workspaceMatches(assignment, catalog)) return refuse('Project/workspace/branch differs from the immutable assignment');
  const project = catalog.config.projects[assignment.project];
  const preset = project?.groups[group];
  const profile = preset && project.profiles[preset.profileId];
  if (!preset || !profile || !Array.isArray(preset.files) || !preset.files.length || new Set(preset.files).size !== preset.files.length || preset.files.some(file => !safeFile(file) || profile.testKind === 'integration' || !(profile.unitFiles ?? []).includes(file))) return refuse(`Preset ${group} or its unit inventory is invalid for project ${assignment.project}`);
  return preset;
}

export function normalizeRegressionGroups(input: RegressionLaunchInput): readonly RegressionGrant[] {
  const grants: RegressionGrant[] = [];
  for (const selection of input.selectedItems) {
    if (!input.assignment.changes.includes(selection.change)) invalid(`Source change ${selection.change} is outside the assignment`);
    const changes = input.verifiedChanges.filter(change => change.id === selection.change);
    const items = changes.length === 1 ? changes[0].items.filter(item => item.id === selection.item) : [];
    if (items.length !== 1) invalid(`Selected source ${selection.change}:${selection.item} is absent or ambiguous in the verified snapshot`);
    const description = items[0].description;
    const start = description.indexOf(marker);
    if (start < 0) continue;
    if (description.indexOf(marker, start + marker.length) >= 0) invalid(`Repeated declaration at ${selection.change}:${selection.item}`);
    let groups: unknown;
    try { groups = JSON.parse(description.slice(start + marker.length)); }
    catch { invalid(`Malformed terminal JSON at ${selection.change}:${selection.item}`); }
    if (!Array.isArray(groups) || groups.some(group => !exactGroup(group)) || new Set(groups).size !== groups.length) invalid(`Expected unique exact group keys at ${selection.change}:${selection.item}`);
    for (const group of groups as string[]) {
      let preset: ReturnType<typeof presetFor>;
      try { preset = presetFor(group, input.assignment, input.catalog); }
      catch (error) { return invalid(error instanceof Error ? error.message : String(error)); }
      grants.push({ sourceChange: selection.change, sourceItem: selection.item, group, profileId: preset.profileId, files: [...preset.files] });
    }
  }
  return frozenGrants(grants);
}

export function snapshotRegressionAssignment(input: RegressionLaunchInput): RegressionTestAssignment {
  return Object.freeze({ ...input.assignment, changes: Object.freeze([...input.assignment.changes]), regressionGroups: normalizeRegressionGroups(input) });
}

export function resumeRegressionAssignment(snapshot: RegressionTestAssignment): RegressionTestAssignment {
  return Object.freeze({ ...snapshot, changes: Object.freeze([...snapshot.changes]), ...(snapshot.regressionGroups ? { regressionGroups: frozenGrants(snapshot.regressionGroups) } : {}) });
}

export function authorizeRegressionRun(
  request: TestRunRequest,
  assignment: RegressionTestAssignment,
  control: RegressionControlSnapshot,
): RegressionAuthorization {
  const coordinating = assignment.type === 'main' || assignment.type === 'coordinator' && assignment.delegatedByMain === true;
  if (!coordinating && (!['agent', 'implement', 'qa', 'hotfix'].includes(assignment.type) || !['implement', 'qa', 'hotfix'].includes(assignment.phase) || (request.phase !== assignment.phase && request.phase !== 'integration') || !coordinating && assignment.type !== 'agent' && assignment.type !== assignment.phase)) refuse('Caller role or phase is not authorized');
  if (coordinating && request.phase !== 'red' && request.phase !== 'integration' && request.phase !== assignment.phase) refuse('Coordinator phase is not authorized');
  if (!control.config.phases[request.phase]?.allowed) refuse('Requested phase is disabled');
  if (request.project !== assignment.project || !workspaceMatches(assignment, control)) refuse('Project/workspace/branch differs from the immutable assignment');
  if (!exactGroup(request.group) || !control.activeChanges.includes(request.group.split('/')[0])) refuse('Group change is outside the active assignment');
  if (request.phase === 'integration') {
    const project = control.config.projects[request.project];
    const preset = project?.groups[request.group];
    const profile = preset && project.profiles[preset.profileId];
    if (!coordinating && !assignment.changes.includes(request.group.split('/')[0])) refuse('Foreign integration is not authorized by unit regression grants');
    if (!preset || !profile || profile.testKind !== 'integration' || request.only !== undefined || !Array.isArray(profile.integrationFiles) || !preset.files.length || new Set(preset.files).size !== preset.files.length || preset.files.some(file => !safeFile(file) || !profile.integrationFiles!.includes(file)) || request.files !== undefined && !filesEqual(request.files, preset.files)) refuse('Integration requires the exact configured preset');
    return { key: { project: request.project, workspace: assignment.workspace, group: request.group }, profileId: preset.profileId, files: [...preset.files], provenance: [] };
  }
  const key = { project: request.project, workspace: assignment.workspace, group: request.group };
  if (assignment.changes.includes(request.group.split('/')[0])) return { key, profileId: null, files: [...(request.files ?? request.only?.map(id => id.file) ?? [])], provenance: [] };
  if (!assignment.changes.every(change => control.activeChanges.includes(change))) refuse('Source assignment change is inactive');
  if (coordinating) refuse('Foreign regression requires an implement/qa/hotfix assignment');
  const grants = (assignment.regressionGroups ?? []).filter(grant => grant.group === request.group);
  if (!grants.length) refuse(`No exact regression grant for ${request.group}`);
  const preset = presetFor(request.group, assignment, control);
  for (const grant of grants) {
    if (!assignment.changes.includes(grant.sourceChange) || (typeof grant.sourceItem !== 'string' || !grant.sourceItem.trim()) || !Array.isArray(grant.files) || grant.profileId !== preset.profileId || !filesEqual(grant.files, preset.files)) refuse(`Regression provenance or preset snapshot drift for ${request.group}`);
  }
  if (request.files !== undefined && request.only !== undefined) refuse('Conflicting selection');
  const files = request.files ?? request.only?.map(id => id.file) ?? preset.files;
  if (!files.length || files.some(file => !safeFile(file) || !preset.files.includes(file))) refuse('Selection is outside the granted preset files');
  if (request.only?.some(id => typeof id.name !== 'string' || !id.name.trim())) refuse('Invalid exact knownRed test-id');
  return { key, profileId: preset.profileId, files: [...new Set(files)], provenance: grants.map(({ sourceChange, sourceItem, group }) => ({ sourceChange, sourceItem, group })) };
}

export async function executeRegressionRun(
  request: SandboxCommandRequest,
  ports: RegressionExecutionPorts,
): Promise<SandboxCommandReply> {
  return runSandboxTestCommand(request, ports);
}
