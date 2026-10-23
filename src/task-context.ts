import { startupContextAssessmentSchema } from './startup-context.ts';
import { reportedCommitsSchema } from './reported-commits.ts';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
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

export interface TaskContextConfiguration {
  readonly projects: WorkspaceProjectsConfig;
  readonly reportStatuses: readonly { readonly id: string }[];
  readonly resources: unknown;
}

export interface TaskContextRequest {
  readonly root: string;
  readonly parameters: RuntimeRunParameters;
  readonly assignment: AssignmentSnapshot;
  readonly configuration: TaskContextConfiguration;
}

export interface TaskReportSchema {
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
}

export interface UnknownTaskResourceEstimate {
  readonly status: 'UNKNOWN';
  readonly reason: string;
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
  throw commandFailure({ code, message: reason, reason, stage: 'task-context', source: 'task-context', sourceCode: null, received, expected: null, found: null, completed: [], pending: [], retrySafe: true, remediation: ['Виправте доручення, OpenSpec або conf і повторіть запуск.'] });
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
function explicitReferences(text: string) {
  const matches = [...text.matchAll(/(?<![A-Za-z0-9._\/-])(?:openspec|conf|skills|specs)\/[A-Za-z0-9._\/-]+(?:#[A-Za-z0-9_~\/-]+)?/g)];
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

export async function loadTaskContextConfiguration(confRoot: string): Promise<TaskContextConfiguration> {
  const [projects, constants, flow] = await Promise.all([readJson(join(confRoot, 'projects.json')), readJson(join(confRoot, 'raf-constants.json')), readJson(join(confRoot, 'flow.json'), true)]);
  if (!record(projects) || !record(projects.projects)) return contextFailure('CONFIGURATION_INVALID', 'conf/projects.json#/projects має бути об’єктом');
  if (!record(constants) || !Array.isArray(constants.reportStatuses) || !constants.reportStatuses.length || !constants.reportStatuses.every(row => record(row) && typeof row.id === 'string' && row.id)) return contextFailure('CONFIGURATION_INVALID', 'conf/raf-constants.json#/reportStatuses має містити статуси з id');
  return { projects: projects as unknown as WorkspaceProjectsConfig, reportStatuses: constants.reportStatuses as { id: string }[], resources: record(flow) ? flow.resources : undefined };
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
  return section?.split('\n').filter(line => line.replace(/^\s*-\s*/, '').startsWith(`${item}:`)).join('\n') ?? '';
}

async function changeSources(root: string, change: string, hasExplicitSources: boolean): Promise<string[]> {
  const directory = join(root, 'openspec', 'changes', change);
  const lines = await exists(join(directory, 'proposal.md')) ? [`${join(directory, 'proposal.md')} — мета й межі зміни ${change}, секції Why/What Changes/Non-goals; читати зараз`] : [];
  if (!hasExplicitSources) lines.push(`${join(directory, 'tasks.md')} — лише вибрані пункти й «Джерела за етапом»; за потреби конкретного контракту шукай у ${directory} релевантну секцію design або повну вимогу delta зі сценаріями; каталог не є дорученням читати всі файли`);
  return lines;
}

async function deriveSources(root: string, selected: readonly { change: string; item: { id: string; description: string } }[]): Promise<string[]> {
  const lines: string[] = [];
  const explicit = new Map<string, string>();
  for (const change of [...new Set(selected.map(row => row.change))]) {
    const tasks = await readFile(join(root, 'openspec', 'changes', change, 'tasks.md'), 'utf8').catch(() => '');
    let allItemsHaveExplicitSources = true;
    for (const { item } of selected.filter(row => row.change === change)) {
      const stage = stageSourceLine(tasks, item.id);
      let hasExplicitSources = false;
      for (const [text, reason] of [[item.description, `пункт ${change}:${item.id}`], [stage, `«Джерела за етапом» для ${change}:${item.id}`]]) {
        for (const { path, details: selector } of explicitReferences(text)) {
          hasExplicitSources = true;
          const canonical = path.startsWith('specs/') ? `openspec/${path}` : path;
          const details = `${reason}${selector ? `: ${selector}` : '; читати для виконання пункту'}; повну релевантну вимогу зі сценаріями`;
          explicit.set(canonical, explicit.has(canonical) ? `${explicit.get(canonical)}; ${details}` : details);
        }
      }
      allItemsHaveExplicitSources &&= hasExplicitSources;
    }
    lines.push(...await changeSources(root, change, allItemsHaveExplicitSources));
  }
  for (const [path, reason] of explicit) {
    const absolute = join(root, path);
    if (!await exists(absolute.split('#')[0])) contextFailure('TASK_SOURCE_MISSING', `Джерело доручення не існує: ${absolute}`, path);
    const line = `${absolute} — ${reason}`;
    const existing = lines.findIndex(row => row.startsWith(`${absolute} — `));
    if (existing < 0) lines.push(line);
    else lines[existing] += `; ${reason}`;
  }
  return lines;
}

function deriveEstimate(type: string, resources: unknown): TaskResourceEstimate {
  const tier: TaskResourceTier = type === 'hotfix' ? 'hotfix' : 'normal';
  const pointer = `conf/flow.json#/resources/${tier}`;
  const unknown = (path: string): TaskResourceEstimate => ({ status: 'UNKNOWN', reason: `оцінка резерву не налаштована: ${path} має бути додатним цілим числом байтів` });
  if (!record(resources)) return unknown('conf/flow.json#/resources');
  const level = resources[tier];
  if (!record(level)) return unknown(pointer);
  for (const key of ['minRamBytes', 'minDiskBytes']) {
    const value = level[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return unknown(`${pointer}/${key}`);
  }
  return { status: 'KNOWN', tier, ramBytes: level.minRamBytes as number, diskBytesPerFileSystem: level.minDiskBytes as number, source: pointer };
}

function reportSchema(statuses: readonly { readonly id: string }[]): TaskReportSchema {
  const values = statuses.map(status => status.id);
  return { type: 'object', required: ['status', 'answer', 'changes', 'commits'], additionalProperties: true, properties: {
    commits: reportedCommitsSchema,
    context: startupContextAssessmentSchema, status: { enum: values }, answer: { type: 'string' },
    changes: { type: 'array', items: { type: 'object', required: ['id', 'items'], properties: { id: { type: 'string' }, archive: { type: 'string' },
      items: { type: 'array', items: { type: 'object', required: ['id', 'status'], properties: { id: { type: 'string' }, status: { enum: values }, reason: { type: 'string' } } } } } } },
  } };
}

export async function deriveTaskContext(request: TaskContextRequest): Promise<DerivedTaskContext> {
  const { root, parameters, assignment, configuration } = request;
  const branch = branchFor(parameters, configuration.projects);
  const selected = selectedItems(parameters, assignment);
  const changes = [...new Set(selected.map(row => row.change))];
  return {
    branch,
    outcome: selected.map(({ change, item }) => `${change}:${item.id} — ${item.description}`).join('\n'),
    writeBoundaries: [...changes.map(change => join(root, 'openspec', 'changes', change)), join(root, 'questions', 'projects', parameters.project, 'questions.md')],
    workspaceWritable: !workspaceReadOnlyTypes.has(parameters.type),
    sources: await deriveSources(root, selected),
    reportSchema: reportSchema(configuration.reportStatuses),
    estimate: deriveEstimate(parameters.type, configuration.resources),
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
