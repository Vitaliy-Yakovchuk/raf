import type { CompiledCatalog } from './catalog.ts';
import { loadCompiledCatalog } from './compiled-catalog.ts';
import { flowQaSchema } from './flow-qa-report.ts';
import { resolveAgentResourceEstimate } from './resource-estimates.ts';
import { startupContextAssessmentSchema } from './startup-context.ts';
import { reportedCommitsSchema } from './reported-commits.ts';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { lstat, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { commandFailure } from './cli-contract.ts';
import type { RuntimeRunParameters } from './app-runtime.ts';
import type { AssignmentSnapshot } from './assignment.ts';
import type { WorkspaceProjectsConfig } from './workspace-routing.ts';
import { configuredWorkspaceRoute, resolveDevelopmentBranch } from './workspace-routing.ts';
import { sandboxRafCommandAccess } from './sandbox-test-run.ts';
import type { TestRunConfig } from './test-runs.ts';
import { descriptionSourceReferences } from './task-source-references.ts';

export interface TaskContextConfiguration {
  readonly projects: WorkspaceProjectsConfig;
  readonly reportStatuses: readonly { readonly id: string }[];
  readonly resources: unknown;
  readonly resourceEstimates?: unknown;
}

export interface TaskContextRequest {
  readonly root: string;
  readonly parameters: RuntimeRunParameters;
  readonly assignment: AssignmentSnapshot;
  readonly configuration: TaskContextConfiguration;
}

export interface TaskReportSchema extends Readonly<Record<string, unknown>> {
  readonly type: 'object';
  readonly required: readonly string[];
  readonly additionalProperties: true;
  readonly properties: {
    readonly commits: typeof reportedCommitsSchema;
    readonly context: typeof startupContextAssessmentSchema;
    readonly status: { readonly enum: readonly string[] };
    readonly answer: { readonly type: 'string' };
    readonly changes: {
      readonly type: 'array';
      readonly items: {
        readonly type: 'object';
        readonly required: readonly string[];
        readonly properties: {
          readonly id: { readonly type: 'string' };
          readonly archive: { readonly type: 'string' };
          readonly items: {
            readonly type: 'array';
            readonly items: {
              readonly type: 'object';
              readonly required: readonly string[];
              readonly properties: {
                readonly id: { readonly type: 'string' };
                readonly status: { readonly enum: readonly string[] };
                readonly reason: { readonly type: 'string' };
              };
            };
          };
        };
      };
    };
  };
}

export type TaskResourceTier = 'normal' | 'hotfix';

export interface KnownTaskResourceEstimate {
  readonly status: 'KNOWN';
  readonly tier: TaskResourceTier;
  readonly ramBytes: number;
  readonly diskBytesPerFileSystem: number;
  readonly source: string;
  readonly sources: readonly string[];
}

export interface UnknownTaskResourceEstimate {
  readonly status: 'UNKNOWN';
  readonly reason: string;
  readonly confPointer?: string;
}

export type TaskResourceEstimate = KnownTaskResourceEstimate | UnknownTaskResourceEstimate;

export interface DerivedTaskContext {
  readonly branch: string;
  readonly outcome: string;
  readonly writeBoundaries: readonly string[];
  readonly workspaceWritable: boolean;
  readonly sources: readonly string[];
  readonly reportSchema: TaskReportSchema;
  readonly estimate: TaskResourceEstimate;
}

export interface TaskContextEnvelope {
  readonly workspace?: import('./hotfix-worktree.ts').HotfixWorkspace;
  readonly version: 1;
  readonly runId: string;
  readonly parameters: RuntimeRunParameters;
  readonly assignmentFingerprint: string;
  readonly context: DerivedTaskContext;
}

export interface TaskContextFileOperations {
  rename(from: string, to: string): Promise<void>;
}

export const TASK_CONTEXT_FILE_NAME = 'task-context.json';

const contextFailure = (code: string, reason: string, received: unknown = null): never => {
  throw Object.assign(commandFailure({ code, message: reason, reason, stage: 'task-context', source: 'task-context', sourceCode: null, received, expected: null, found: null, completed: [], pending: [], retrySafe: true, remediation: ['Виправте доручення, OpenSpec або conf і повторіть запуск.'] }), { code });
};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const readJson = async (path: string, optional = false): Promise<unknown> => {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return contextFailure('CONFIGURATION_INVALID', `Не вдалося прочитати валідний JSON: ${path}`);
  }
};
const exists = async (path: string) => { try { await stat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return false; throw error; } };
function stageSourceReferences(text: string) {
  const matches = [...text.matchAll(/(?<![\p{L}\p{N}._\/-])(?:openspec|conf|skills|specs)\/[\p{L}\p{N}._\/-]+(?:#[\p{L}\p{N}._~\/-]+)?/gu)];
  const tails = matches.map((match, index) => text.slice(match.index! + match[0].length, matches[index + 1]?.index ?? text.length));
  return matches.map((match, index) => ({
    path: match[0].replace(/[.]+$/, ''),
    details: (tails.slice(index).find(tail => /\s—\s/.test(tail)) ?? tails[index]).replace(/^[`\s)]+|[`\s]+$/g, '').trim(),
  }));
}
const workspaceReadOnlyTypes = new Set(['spec', 'design']);
const coordinatingTypes = new Set(['coordinator', 'main']);

const executorRafSubcommands: readonly string[] = Object.freeze(['agent message', 'agent ps']);

export function rafCommandFor(): string {
  return `node ${realpathSync(fileURLToPath(new URL('../bin/raf.ts', import.meta.url)))}`;
}

export function rafSubcommandsFor(type: string, phase = type, phases?: TestRunConfig['phases']): readonly string[] | null {
  if (coordinatingTypes.has(type)) return null;
  if (!phases) return executorRafSubcommands;
  return sandboxRafCommandAccess({ runId: '', agentId: '', type, phase, project: '', workspace: '', branch: '', changes: [] }, 'codex', ['node', realpathSync(fileURLToPath(new URL('../bin/raf.ts', import.meta.url)))], phases).raf_subcommands;
}

export async function loadTaskContextConfiguration(confRoot: string, catalog: CompiledCatalog = loadCompiledCatalog()): Promise<TaskContextConfiguration> {
  const [projects, flow] = await Promise.all([readJson(join(confRoot, 'projects.json')), readJson(join(confRoot, 'flow.json'), true)]);
  const constants = catalog.constants;
  if (!record(projects) || !record(projects.projects)) return contextFailure('CONFIGURATION_INVALID', 'conf/projects.json#/projects має бути об’єктом');
  if (!record(constants) || !Array.isArray(constants.reportStatuses) || !constants.reportStatuses.length || !constants.reportStatuses.every(row => record(row) && typeof row.id === 'string' && row.id)) return contextFailure('CONFIGURATION_INVALID', 'conf/raf-constants.json#/reportStatuses має містити статуси з id');
  return { projects: projects as unknown as WorkspaceProjectsConfig, reportStatuses: constants.reportStatuses as { id: string }[], resources: record(flow) ? flow.resources : undefined, resourceEstimates: record(flow) ? flow.resourceEstimates : undefined };
}

function branchFor(parameters: RuntimeRunParameters, projects: WorkspaceProjectsConfig): string {
  let branch = parameters.type === 'hotfix' ? parameters.project === 'raf' ? 'hotfix' : 'main' : 'develop';
  if (workspaceReadOnlyTypes.has(parameters.type)) {
    const development = resolveDevelopmentBranch(parameters.project, projects);
    if (!development.ok) return contextFailure(development.error.code, development.error.message, parameters.project);
    branch = development.branch;
  }
  const route = configuredWorkspaceRoute({ root: '.', project: parameters.project, branch }, projects);
  if (!route.ok) return contextFailure(route.error.code, route.error.message, parameters.project);
  return branch;
}

function selectedItems(parameters: RuntimeRunParameters, assignment: AssignmentSnapshot) {
  return parameters.tasks.map(task => {
    const separator = task.indexOf(':');
    const change = assignment.changes.find(row => row.id === task.slice(0, separator));
    const item = change?.items.find(row => row.id === task.slice(separator + 1));
    if (!change || !item) return contextFailure('TASK_CONTEXT_MISMATCH', `Пункт ${task} відсутній у перевіреному snapshot OpenSpec`, task);
    return { change: change.id, item };
  });
}

function stageSourceLine(tasks: string, item: string): string {
  const section = tasks.split(/^## /m).find(part => part.startsWith('Джерела за етапом'));
  return section?.split('\n').filter(line => {
    const content = line.replace(/^\s*-\s*/, '');
    if (content.startsWith(`${item}:`)) return true;
    const label = /^\*\*[^*]+?:\*\*/.exec(content)?.[0];
    return label?.match(/[A-Za-z]+(?:\.\d+)+|\d+(?:\.\d+)*/g)?.includes(item) ?? false;
  }).join('\n') ?? '';
}

async function changeSources(root: string, change: string, hasExplicitSources: boolean): Promise<string[]> {
  const directory = join(root, 'openspec', 'changes', change);
  const lines = await exists(join(directory, 'proposal.md')) ? [`${join(directory, 'proposal.md')} — мета й межі зміни ${change}, секції Why/What Changes/Non-goals; читати зараз`] : [];
  if (!hasExplicitSources) lines.push(`${join(directory, 'tasks.md')} — лише вибрані пункти й «Джерела за етапом»; за потреби конкретного контракту шукай у ${directory} релевантну секцію design або повну вимогу delta зі сценаріями; каталог не є дорученням читати всі файли`);
  return lines;
}

async function deriveSources(root: string, selected: readonly { change: string; item: { id: string; description: string } }[]): Promise<string[]> {
  const lines: string[] = [];
  const explicit = new Map<string, { path: string; details: string }>();
  for (const change of [...new Set(selected.map(row => row.change))]) {
    const tasks = await readFile(join(root, 'openspec', 'changes', change, 'tasks.md'), 'utf8').catch(() => '');
    let allItemsHaveExplicitSources = true;
    for (const { item } of selected.filter(row => row.change === change)) {
      const stage = stageSourceLine(tasks, item.id);
      let hasExplicitSources = false;
      for (const [references, reason] of [[descriptionSourceReferences(item.description), `пункт ${change}:${item.id}`], [stageSourceReferences(stage), `«Джерела за етапом» для ${change}:${item.id}`]] as const) {
        for (const { path, details: selector } of references) {
          hasExplicitSources = true;
          const referenceFile = path.split('#')[0];
          const canonical = path.startsWith('../')
            ? `${join('openspec', 'changes', change, referenceFile)}${path.slice(referenceFile.length)}`
            : path.startsWith('specs/') ? `openspec/${path}` : path;
          const file = canonical.split('#')[0];
          const fragment = canonical.slice(file.length);
          const details = `${reason}${fragment ? ` (${fragment})` : ''}${selector ? `: ${selector}` : '; читати для виконання пункту'}; повну релевантну вимогу зі сценаріями`;
          const existing = explicit.get(file);
          explicit.set(file, { path: existing?.path ?? canonical, details: existing ? `${existing.details}; ${details}` : details });
        }
      }
      allItemsHaveExplicitSources &&= hasExplicitSources;
    }
    lines.push(...await changeSources(root, change, allItemsHaveExplicitSources));
  }
  for (const { path, details: reason } of explicit.values()) {
    const absolute = join(root, path);
    if (!await exists(absolute.split('#')[0])) contextFailure('TASK_SOURCE_MISSING', `Джерело доручення не існує: ${absolute}`, path);
    const line = `${absolute} — ${reason}`;
    const existing = lines.findIndex(row => row.startsWith(`${absolute} — `));
    if (existing < 0) lines.push(line);
    else lines[existing] += `; ${reason}`;
  }
  return lines;
}

function deriveEstimate(parameters: RuntimeRunParameters, selected: readonly { change: string; item: { id: string } }[], configuration: TaskContextConfiguration): TaskResourceEstimate {
  const tier: TaskResourceTier = parameters.type === 'hotfix' ? 'hotfix' : 'normal';
  const result = resolveAgentResourceEstimate({
    flow: { resourceEstimates: configuration.resourceEstimates }, type: parameters.type, project: parameters.project,
    tasks: selected.map(({ change, item }) => ({ project: parameters.project, change, item: item.id })), fileSystemIds: ['estimate'],
  });
  if (result.status === 'UNKNOWN') return { status: 'UNKNOWN', reason: result.reason, confPointer: result.confPointer };
  return { status: 'KNOWN', tier, ramBytes: result.reservation.ramBytes, diskBytesPerFileSystem: result.reservation.diskBytes.estimate, source: result.sources[0], sources: result.sources };
}

function reportSchema(statuses: readonly { readonly id: string }[], qa = false): TaskReportSchema {
  const values = statuses.map(status => status.id);
  return { type: 'object', required: ['status', 'answer', 'changes', 'commits', ...(qa ? ['qa'] : [])], additionalProperties: true, properties: {
    ...(qa ? { qa: flowQaSchema } : {}),
    commits: reportedCommitsSchema,
    context: startupContextAssessmentSchema, status: { enum: values }, answer: { type: 'string' },
    changes: { type: 'array', items: { type: 'object', required: ['id', 'items'], properties: { id: { type: 'string' }, archive: { type: 'string' },
      items: { type: 'array', items: { type: 'object', required: ['id', 'status'], properties: { id: { type: 'string' }, status: { enum: values }, reason: { type: 'string' } } } } } } },
  } };
}

async function archiveWriteBoundaries(root: string, selected: readonly { change: string; item: { id: string; description: string } }[]): Promise<string[]> {
  const changesRoot = join(root, 'openspec', 'changes');
  const boundaries = new Set<string>();
  const unlinked = async (path: string) => {
    for (let current = path; current !== root; current = resolve(current, '..')) {
      if (current === resolve(current, '..') || relative(root, current).startsWith(`..${sep}`)) contextFailure('TASK_CONTEXT_MISMATCH', `Archive write scope lies outside Orchestrator: ${path}`);
      const entry = await lstat(current).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return null;
      });
      if (entry?.isSymbolicLink()) contextFailure('TASK_CONTEXT_MISMATCH', `Archive write scope cannot follow a symlink: ${current}`);
    }
  };
  for (const change of new Set(selected.map(row => row.change))) {
    const directory = join(changesRoot, change);
    const content = await readFile(join(directory, 'tasks.md'), 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return '';
    });
    const rows = content.split('\n').flatMap(line => {
      const match = /^\s*(?:[-*+]|\d{1,9}[.)])\s*\[(?:\s*([^\]\s]?)\s*\](?![([])|\s+\])\s*(.*)/.exec(line);
      if (!match) return [];
      return [{ done: (match[1] ?? '').toLowerCase() === 'x', description: match[2].trim() }];
    }).map((row, index) => {
      const numbered = /^([0-9]+(?:\.[0-9]+)*|[A-Z](?:\.[0-9]+)+)\s+(.+)$/s.exec(row.description);
      return { done: row.done, id: numbered?.[1] ?? String(index + 1), description: numbered?.[2] ?? row.description };
    });
    const items = selected.filter(row => row.change === change).map(row => row.item);
    if (!rows.length || rows.some(row => !row.done && !items.some(item => item.id === row.id))) continue;
    if (items.some(item => {
      const matches = rows.filter(row => row.id === item.id);
      return matches.length !== 1 || matches[0].description !== item.description;
    })) continue;
    await unlinked(join(changesRoot, 'archive'));
    await unlinked(directory);
    boundaries.add(changesRoot + sep);
    const deltaRoot = join(directory, 'specs');
    const walk = async (path: string): Promise<void> => {
      await unlinked(path);
      const entries = await readdir(path, { withFileTypes: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return [];
      });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const child = join(path, entry.name);
        if (entry.isSymbolicLink()) contextFailure('TASK_CONTEXT_MISMATCH', `Archive delta scope cannot follow a symlink: ${child}`);
        if (entry.isDirectory()) await walk(child);
        else if (entry.isFile() && entry.name === 'spec.md') {
          const capability = relative(deltaRoot, path);
          if (!capability) contextFailure('TASK_CONTEXT_MISMATCH', `Archive delta needs a capability directory: ${child}`);
          const target = join(root, 'openspec', 'specs', capability);
          await unlinked(target);
          boundaries.add(target + sep);
        }
      }
    };
    await walk(deltaRoot);
  }
  return [...boundaries];
}

export async function deriveTaskContext(request: TaskContextRequest): Promise<DerivedTaskContext> {
  const { root, parameters, assignment, configuration } = request;
  const branch = branchFor(parameters, configuration.projects);
  const selected = selectedItems(parameters, assignment);
  const changes = [...new Set(selected.map(row => row.change))];
  const archiveBoundaries = await archiveWriteBoundaries(root, selected);
  return {
    branch,
    outcome: selected.map(({ change, item }) => `${change}:${item.id} — ${item.description}`).join('\n'),
    writeBoundaries: [...(archiveBoundaries.length ? archiveBoundaries : changes.map(change => join(root, 'openspec', 'changes', change))), join(root, 'questions', 'projects', parameters.project, 'questions.md')],
    workspaceWritable: !workspaceReadOnlyTypes.has(parameters.type),
    sources: await deriveSources(root, selected),
    reportSchema: reportSchema(configuration.reportStatuses, parameters.phase === 'qa'),
    estimate: deriveEstimate(parameters, selected, configuration),
  };
}

export function bindWorkspaceBoundaries(context: Pick<DerivedTaskContext, 'writeBoundaries'> & Partial<Pick<DerivedTaskContext, 'workspaceWritable'>>, cwd: string): readonly string[] {
  return context.workspaceWritable ? [cwd, ...context.writeBoundaries.filter(path => path !== cwd)] : [...context.writeBoundaries];
}

const realOrNull = async (path: string): Promise<string | null> => {
  try { return await realpath(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return null; throw error; }
};
const pointer = async (path: string, prefix: string): Promise<string | null> => {
  try {
    const text = (await readFile(path, 'utf8')).trim();
    return text.startsWith(prefix) ? text.slice(prefix.length).trim() || null : null;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR' || (error as NodeJS.ErrnoException).code === 'EISDIR') return null; throw error; }
};

async function gitDirectories(workspace: string): Promise<string[]> {
  const dotGit = join(workspace, '.git');
  const info = await stat(dotGit).catch(() => null);
  if (!info) return [];
  const linked = info.isFile() ? await pointer(dotGit, 'gitdir:') : null;
  const gitDir = info.isDirectory() ? await realOrNull(dotGit) : linked ? await realOrNull(resolve(workspace, linked)) : null;
  if (!gitDir) return [];
  const common = await pointer(join(gitDir, 'commondir'), '');
  const commonDir = common ? await realOrNull(resolve(gitDir, common)) : gitDir;
  if (!commonDir || !(await stat(join(gitDir, 'HEAD')).catch(() => null))?.isFile()
    || !(await stat(join(commonDir, 'objects')).catch(() => null))?.isDirectory()) return [];
  return [gitDir, commonDir];
}

export async function resolveGitWriteBoundaries(cwd: string, orchestratorRoot: string, writeBoundaries?: readonly string[]): Promise<readonly string[]> {
  if (writeBoundaries) {
    const root = await realOrNull(orchestratorRoot);
    if (!root || !(await gitDirectories(root)).length) return [];
    let directories: string[];
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
      const result = await promisify(execFile)('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'], { env });
      const [top, ...paths] = result.stdout.trim().split('\n');
      if (await realOrNull(top) !== root || paths.length !== 2) return [];
      const resolved = await Promise.all(paths.map(realOrNull));
      if (resolved.some(path => path === null)) return [];
      directories = [...new Set(resolved as string[])];
    } catch { return []; }
    for (const boundary of writeBoundaries) {
      let ancestor = resolve(boundary);
      for (;;) {
        const actual = await realOrNull(ancestor);
        if (actual) {
          const suffix = relative(root, actual);
          if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) break;
          if (actual === root) return directories;
          if ((await gitDirectories(actual)).length) break;
        }
        const parent = resolve(ancestor, '..');
        if (parent === ancestor) break;
        ancestor = parent;
      }
    }
    return [];
  }
  const workspace = await realOrNull(cwd);
  if (!workspace) return [];
  const candidates = [...await gitDirectories(workspace), ...await gitDirectories(orchestratorRoot)];
  return [...new Set(candidates)];
}

export function assignmentFingerprint(snapshot: AssignmentSnapshot): string {
  return createHash('sha256').update(JSON.stringify(['raf-assignment-v1', snapshot.root, snapshot.changes.map(change => [change.id, change.items.map(item => [item.id, item.description])]), [...snapshot.baselineArchives]])).digest('hex');
}

export async function writeTaskContextFile(runDirectory: string, envelope: TaskContextEnvelope, operations: Partial<TaskContextFileOperations> = {}): Promise<string> {
  const target = join(runDirectory, TASK_CONTEXT_FILE_NAME);
  const temporary = `${target}.${process.pid}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(JSON.stringify(envelope)); await handle.sync(); }
    finally { await handle.close(); }
    await (operations.rename ?? rename)(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  const directory = await open(runDirectory, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  return target;
}
