import { basename, isAbsolute, join } from 'node:path';

export interface AssignmentCliPort {
  exec(args: readonly string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}
export interface AssignmentFilePort { readText(path: string): Promise<string>; }
export interface AssignmentPorts { cli: AssignmentCliPort; fs: AssignmentFilePort; }
export interface AssignmentSelection {
  readonly change: string;
  readonly items: readonly { readonly id: string; readonly expectedDescription?: string }[];
}
export interface AssignmentRequest { readonly root: string; readonly selections: readonly AssignmentSelection[]; }
export interface AssignmentSnapshot {
  readonly root: string;
  readonly changes: readonly { readonly id: string; readonly items: readonly { readonly id: string; readonly description: string }[] }[];
  readonly baselineArchives: readonly string[];
}
export interface AssignmentIssue {
  readonly change: string;
  readonly requestedItems: readonly string[];
  readonly reason: string;
  readonly foundItems: readonly { readonly id: string; readonly description: string; readonly done: boolean }[];
  readonly archives: readonly string[];
  readonly remedy: string;
}
export type AssignmentValidation =
  | { readonly ok: true; readonly snapshot: AssignmentSnapshot }
  | { readonly ok: false; readonly kind: 'invalid-assignment' | 'openspec-unavailable'; readonly root: string; readonly issues: readonly AssignmentIssue[] };
export interface AssignmentBriefContext {
  readonly briefsRoot: string;
  readonly runner: string;
  readonly stage: string;
  readonly project: string;
  readonly agentId: string;
  readonly sessionName: string;
  readonly features: readonly string[];
  readonly phase: string;
  readonly outcome: string;
  readonly writeBoundaries: readonly string[];
  readonly sources: readonly string[];
  readonly reportPath: string;
  readonly reportSchema: Readonly<Record<string, unknown>>;
  readonly rafCommand?: string;
  readonly rafSubcommands?: readonly string[];
  readonly commitOwnWork?: boolean;
  readonly commitPaths?: readonly string[];
  readonly commitRepositories?: readonly string[];
  readonly workspaceWritable?: boolean;
}
export interface AssignmentVerification { readonly ok: boolean; readonly issues: readonly AssignmentIssue[]; }
type Task = { id: string; description: string; done: boolean };
type Change = { name: string; completedTasks: number; totalTasks: number };
const safeName = (name: string) => typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
const taskIdPattern = /^(?:[0-9]+(?:\.[0-9]+)*|[A-Z](?:\.[0-9]+)+)$/;
const matchingArchive = (name: string, id: string) => name === id || (/^\d{4}-\d{2}-\d{2}-/.test(name) && name.slice(11) === id);
const issue = (change: string, items: readonly { id: string }[], reason: string, foundItems: Task[] = [], archives: string[] = []): AssignmentIssue => ({ change, requestedItems: items.map(item => item.id), reason, foundItems, archives, remedy: 'Уточніть доручення за актуальними даними OpenSpec і повторіть перевірку.' });
async function json(ports: AssignmentPorts, root: string, args: string[]): Promise<any> {
  const result = await ports.cli.exec(args, root);
  if (result.exitCode !== 0) throw new Error(`OpenSpec ${args.join(' ')}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
  try { return JSON.parse(result.stdout); } catch { throw new Error(`OpenSpec ${args.join(' ')}: invalid JSON`); }
}
async function list(ports: AssignmentPorts, root: string, archived = false): Promise<Change[]> {
  const data = await json(ports, root, archived ? ['list', '--archived', '--json'] : ['list', '--json']);
  if (!data || !Array.isArray(data.changes) || data.changes.some((row: Change) => !row || !safeName(row.name) || !Number.isInteger(row.completedTasks) || !Number.isInteger(row.totalTasks) || row.completedTasks < 0 || row.totalTasks < row.completedTasks)) throw new Error('OpenSpec list: malformed changes');
  if (new Set(data.changes.map((row: Change) => row.name)).size !== data.changes.length) throw new Error('OpenSpec list: ambiguous duplicate changes');
  return data.changes;
}
async function tasks(ports: AssignmentPorts, root: string, change: string): Promise<Task[]> {
  const data = await json(ports, root, ['instructions', 'apply', '--change', change, '--json']);
  if (!data || !Array.isArray(data.tasks) || data.tasks.some((task: Task) => !task || typeof task.id !== 'string' || !task.id || typeof task.description !== 'string' || !task.description || typeof task.done !== 'boolean')) throw new Error('OpenSpec instructions apply: malformed tasks');
  return data.tasks.map((task: Task, index: number) => {
    const numbered = task.description.match(/^([0-9]+(?:\.[0-9]+)*|[A-Z](?:\.[0-9]+)+)\s+(.+)$/s);
    return numbered && task.id === String(index + 1) ? { id: numbered[1], description: numbered[2], done: task.done } : task;
  });
}
export async function readAssignmentTasks(root: string, change: string, ports: AssignmentPorts): Promise<readonly { readonly id: string; readonly description: string; readonly done: boolean }[]> {
  return tasks(ports, root, change);
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
export async function validateAssignment(request: AssignmentRequest, ports: AssignmentPorts): Promise<AssignmentValidation> {
  const issues: AssignmentIssue[] = [];
  if (!isAbsolute(request.root) || !request.selections.length) return { ok: false, kind: 'invalid-assignment', root: request.root, issues: [issue('', [], 'Потрібні абсолютний корінь OpenSpec та непорожнє доручення.')] };
  let active: Change[], archived: Change[];
  try { active = await list(ports, request.root); archived = await list(ports, request.root, true); }
  catch (error) { return { ok: false, kind: 'openspec-unavailable', root: request.root, issues: [issue('', [], errorText(error))] }; }
  const changes: { id: string; items: { id: string; description: string }[] }[] = [];
  const seen = new Set<string>();
  let unavailable = false;
  for (const selection of request.selections) {
    const archives = archived.filter(row => matchingArchive(row.name, selection.change)).map(row => row.name);
    if (!safeName(selection.change) || seen.has(selection.change) || !selection.items.length || new Set(selection.items.map(item => item.id)).size !== selection.items.length) {
      issues.push(issue(selection.change, selection.items, 'Порожнє, некоректне або неоднозначне доручення.', [], archives)); continue;
    }
    seen.add(selection.change);
    if (!active.some(row => row.name === selection.change)) { issues.push(issue(selection.change, selection.items, `Активну зміну не знайдено у ${request.root}. Знайдені активні зміни: ${active.map(row => row.name).join(', ')}`, [], archives)); continue; }
    let found: Task[];
    try { found = await tasks(ports, request.root, selection.change); }
    catch (error) { unavailable = true; issues.push(issue(selection.change, selection.items, errorText(error), [], archives)); continue; }
    const selected: { id: string; description: string }[] = [];
    for (const item of selection.items) {
      if (!taskIdPattern.test(item.id)) {
        issues.push(issue(selection.change, selection.items, `Пункт ${item.id} має некоректний формат ID.`, found, archives)); continue;
      }
      const matches = found.filter(task => task.id === item.id);
      if (matches.length === 0) issues.push(issue(selection.change, selection.items, `Пункт ${item.id} відсутній: точного ID не знайдено.`, found, archives));
      else if (matches.length > 1) issues.push(issue(selection.change, selection.items, `Пункт ${item.id} неоднозначний: знайдено кілька пунктів із цим ID.`, found, archives));
      else if (item.expectedDescription !== undefined && matches[0].description !== item.expectedDescription) issues.push(issue(selection.change, selection.items, `Пункт ${item.id} змінив опис.`, found, archives));
      else selected.push({ id: matches[0].id, description: matches[0].description });
    }
    changes.push({ id: selection.change, items: selected });
  }
  if (issues.length) return { ok: false, kind: unavailable ? 'openspec-unavailable' : 'invalid-assignment', root: request.root, issues };
  const snapshot: AssignmentSnapshot = Object.freeze({ root: request.root, changes: Object.freeze(changes.map(change => Object.freeze({ id: change.id, items: Object.freeze(change.items.map(item => Object.freeze(item))) }))), baselineArchives: Object.freeze(archived.map(row => row.name)) });
  return { ok: true, snapshot };
}
export async function composeAssignmentBrief(snapshot: AssignmentSnapshot, context: AssignmentBriefContext, fs: AssignmentFilePort): Promise<string> {
  if (!safeName(context.runner) || !safeName(context.stage)) throw new Error('Invalid runner or stage template name');
  if (!isAbsolute(context.reportPath) || basename(context.reportPath) !== `${context.sessionName}.json`) throw new Error('report_path must be absolute and use <sessionName>.json');
  const templates = await Promise.all([fs.readText(join(context.briefsRoot, 'runners', `${context.runner}.md`)), fs.readText(join(context.briefsRoot, 'tasks', `${context.stage}.md`)), fs.readText(join(context.briefsRoot, 'completion.md'))]);
  const assignment = { project: context.project, agent_id: context.agentId, session_name: context.sessionName, root: snapshot.root, features: context.features, phase: context.phase, outcome: context.outcome, write_boundaries: context.writeBoundaries, sources: context.sources, assignments: snapshot.changes, report_path: context.reportPath, report_schema: context.reportSchema, ...(context.rafCommand ? { raf_command: context.rafCommand, ...(context.rafSubcommands ? { raf_subcommands: [...context.rafSubcommands] } : {}) } : {}) };
  const simple = 'окремою простою командою, без cd, конвеєрів, підстановок і змінних перед нею';
  const raf = !context.rafCommand ? ''
    : context.rafSubcommands ? ` Для узгодження з іншими виконавцями виконуй лише ${context.rafSubcommands.map(subcommand => `\`raf_command ${subcommand} …\``).join(' і ')} ${simple}: лише такі команди виконуються поза пісочницею й мають доступ до стану raf; інших команд raf не виконуй.`
    : ` Команди raf виконуй через raf_command ${simple} (\`raf_command agent run …\`): лише така команда виконується поза пісочницею й має доступ до стану raf.`;
  const commitScope = context.commitOwnWork ? ` Репозиторії коміту: ${(context.commitRepositories ?? [snapshot.root]).join(', ')} (Orchestrator: ${snapshot.root}). Дозволені файлові шляхи: ${(context.commitPaths ?? context.writeBoundaries).join(', ')}; включно з власними галочками tasks.md доручених changes. Git-права не розширюють файлових меж.${context.workspaceWritable === false ? ' Коміть лише власні OpenSpec/документні шляхи в Orchestrator; код workspace і його git-каталоги залишаються read-only.' : ''}` : '';
  const commit = context.commitOwnWork ? ' Після перевірок сам закоміть свої зміни до JSON-звіту: додавай до коміту лише власні шляхи, чужі незакомічені правки в тому самому дереві не чіпай і не комітуй, перетини й спільні незакомічені файли узгоджуй з іншими виконавцями за projects/orchestrator/parallel-development «Коміти в спільному робочому дереві». Зайнятий індекс очікуй, чужий index.lock не видаляй. Обов\'язок закомітити свою роботу входить у доручення; хеші створених комітів вкажи у звіті (поле commits). Push не виконуй: `git push` дозволено лише окремим дорученням, push визначає main.' + commitScope : '';
  return [...templates, '# Конкретне доручення\n\nПрацюй лише над дорученими пунктами. Відповідай власнику українською. Веди правдиві галочки й запиши JSON за report_path та report_schema. Коротко заповни context: unnecessary (source, reason) і missing (description, foundAt); порожні масиви допустимі.' + raf + commit + '\n\n' + JSON.stringify(assignment, null, 2)].join('\n\n');
}
export async function verifyAssignmentCompletion(snapshot: AssignmentSnapshot, ports: AssignmentPorts, archiveClaims: Readonly<Record<string, string>> = {}): Promise<AssignmentVerification> {
  const issues: AssignmentIssue[] = [];
  let active: Change[], archived: Change[];
  try { active = await list(ports, snapshot.root); archived = await list(ports, snapshot.root, true); }
  catch (error) { return { ok: false, issues: [issue('', [], errorText(error))] }; }
  for (const change of snapshot.changes) {
    const candidates = archived.filter(row => matchingArchive(row.name, change.id));
    const names = candidates.map(row => row.name);
    try {
      let found: Task[];
      if (active.some(row => row.name === change.id)) found = await tasks(ports, snapshot.root, change.id);
      else {
        const eligible = candidates.filter(row => !snapshot.baselineArchives.includes(row.name));
        const claim = Object.hasOwn(archiveClaims, change.id) ? archiveClaims[change.id] : undefined;
        const matches = claim === undefined ? eligible : eligible.filter(row => row.name === claim);
        if (matches.length !== 1) { issues.push(issue(change.id, change.items, 'Немає однозначного нового точного архіву зміни.', [], names)); continue; }
        const archive = matches[0];
        if (archive.totalTasks <= 0 || archive.completedTasks !== archive.totalTasks) { issues.push(issue(change.id, change.items, 'Архів має незавершені пункти.', [], names)); continue; }
        const content = await ports.fs.readText(join(snapshot.root, 'openspec', 'changes', 'archive', archive.name, 'tasks.md'));
        found = [...content.matchAll(/^\s*-\s+\[([ xX])\]\s+(\S+)\s+(.+?)\s*$/gm)].map(match => ({ id: match[2], description: match[3], done: match[1].toLowerCase() === 'x' }));
        if (found.length !== archive.totalTasks || found.some(task => !task.done)) { issues.push(issue(change.id, change.items, 'Архівний tasks.md не відповідає завершеним лічильникам OpenSpec.', found, names)); continue; }
      }
      for (const item of change.items) {
        const matches = found.filter(task => task.id === item.id);
        if (matches.length !== 1 || matches[0].description !== item.description || !matches[0].done) issues.push(issue(change.id, change.items, `Початковий пункт ${item.id} не підтверджено: відкритий, відсутній, неоднозначний або змінений.`, found, names));
      }
    } catch (error) { issues.push(issue(change.id, change.items, errorText(error), [], names)); }
  }
  return { ok: issues.length === 0, issues };
}
