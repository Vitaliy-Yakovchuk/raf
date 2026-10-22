import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandFailure } from './cli-contract.ts';
import type { RuntimeRunParameters } from './app-runtime.ts';
import type { AssignmentSnapshot } from './assignment.ts';
import type { WorkspaceProjectsConfig } from './workspace-routing.ts';

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
const explicitPaths = (text: string) => [...text.matchAll(/(?<![A-Za-z0-9._\/-])(?:openspec|conf|skills)\/[A-Za-z0-9._\/-]*/g)].map(match => match[0].replace(/[.]+$/, ''));
const workspaceReadOnlyTypes = new Set(['spec', 'design']);
const coordinatingTypes = new Set(['coordinator', 'main']);

export function rafCommandFor(type: string): string | null {
  return coordinatingTypes.has(type) ? `node ${realpathSync(fileURLToPath(new URL('../bin/raf.ts', import.meta.url)))}` : null;
}

export async function loadTaskContextConfiguration(confRoot: string): Promise<TaskContextConfiguration> {
  const [projects, constants, flow] = await Promise.all([readJson(join(confRoot, 'projects.json')), readJson(join(confRoot, 'raf-constants.json')), readJson(join(confRoot, 'flow.json'), true)]);
  if (!record(projects) || !record(projects.projects)) return contextFailure('CONFIGURATION_INVALID', 'conf/projects.json#/projects має бути об’єктом');
  if (!record(constants) || !Array.isArray(constants.reportStatuses) || !constants.reportStatuses.length || !constants.reportStatuses.every(row => record(row) && typeof row.id === 'string' && row.id)) return contextFailure('CONFIGURATION_INVALID', 'conf/raf-constants.json#/reportStatuses має містити статуси з id');
  return { projects: projects as unknown as WorkspaceProjectsConfig, reportStatuses: constants.reportStatuses as { id: string }[], resources: record(flow) ? flow.resources : undefined };
}

function branchFor(parameters: RuntimeRunParameters, projects: WorkspaceProjectsConfig): string {
  const branch = parameters.type === 'hotfix' ? 'main' : 'develop';
  const entry = Object.hasOwn(projects.projects, parameters.project) ? projects.projects[parameters.project] : undefined;
  if (!entry) return contextFailure('UNKNOWN_PROJECT', `Невідомий проєкт: ${parameters.project}`, parameters.project);
  if (!entry.branchPaths || !Object.hasOwn(entry.branchPaths, branch)) return contextFailure('UNKNOWN_BRANCH', `conf/projects.json#/projects/${parameters.project}/branchPaths/${branch} не задано для типу ${parameters.type}`, parameters.project);
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
  return section?.split('\n').find(line => line.replace(/^\s*-\s*/, '').startsWith(`${item}:`)) ?? '';
}

async function changeSources(root: string, change: string): Promise<string[]> {
  const directory = join(root, 'openspec', 'changes', change);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const designs = entries.filter(entry => entry.isFile() && (entry.name === 'design.md' || entry.name.endsWith('-design.md'))).map(entry => entry.name).sort();
  const lines = [...(await exists(join(directory, 'proposal.md')) ? [`${join(directory, 'proposal.md')} — мета й межі зміни ${change}; читати зараз`] : []),
    ...designs.map(name => `${join(directory, name)} — контракт реалізації зміни ${change}; читати зараз`)];
  const specs = await readdir(join(directory, 'specs'), { recursive: true }).catch(() => [] as string[]);
  for (const path of specs.filter(path => basename(path) === 'spec.md').sort()) lines.push(`${join(directory, 'specs', path)} — дельта вимог зміни ${change}; читати вимоги, яких стосується пункт`);
  return lines;
}

async function deriveSources(root: string, selected: readonly { change: string; item: { id: string; description: string } }[]): Promise<string[]> {
  const lines: string[] = [];
  const explicit = new Map<string, string>();
  for (const change of [...new Set(selected.map(row => row.change))]) {
    lines.push(...await changeSources(root, change));
    const tasks = await readFile(join(root, 'openspec', 'changes', change, 'tasks.md'), 'utf8').catch(() => '');
    for (const { item } of selected.filter(row => row.change === change)) {
      for (const path of explicitPaths(item.description)) if (!explicit.has(path)) explicit.set(path, `згадано в пункті ${change}:${item.id}; читати для виконання пункту`);
      for (const path of explicitPaths(stageSourceLine(tasks, item.id))) if (!explicit.has(path)) explicit.set(path, `«Джерела за етапом» для ${change}:${item.id}; читати зараз`);
    }
  }
  for (const [path, reason] of explicit) {
    const absolute = join(root, path);
    if (!await exists(absolute)) contextFailure('TASK_SOURCE_MISSING', `Джерело доручення не існує: ${absolute}`, path);
    const line = `${absolute} — ${reason}`;
    if (!lines.some(row => row.startsWith(`${absolute} — `))) lines.push(line);
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
  return { type: 'object', required: ['status', 'answer', 'changes'], additionalProperties: true, properties: {
    status: { enum: values }, answer: { type: 'string' },
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
