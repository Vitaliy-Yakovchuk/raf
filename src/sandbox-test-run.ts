import { runTestRunCli, type TestRunCliPorts } from './test-run-cli.ts';
import { parseTestRunArgs } from './test-runs.ts';
import type { TestRunConfig, TestRunGroupKey } from './test-runs.ts';

export interface SandboxProcessIdentity {
  readonly pid: number;
  readonly startedAt: string;
}

export interface SandboxTestAssignment {
  readonly runId: string;
  readonly agentId: string;
  readonly type: string;
  readonly phase: string;
  readonly project: string;
  readonly workspace: string;
  readonly branch: string;
  readonly changes: readonly string[];
  readonly delegatedByMain?: boolean;
}

export interface SandboxTestSession {
  readonly process: SandboxProcessIdentity;
  readonly state: 'running' | 'finished';
  readonly assignment: SandboxTestAssignment;
}

export interface SandboxTestControlSnapshot {
  readonly ancestors: readonly SandboxProcessIdentity[];
  readonly sessions: readonly SandboxTestSession[];
  readonly workspaces: readonly {
    readonly project: string;
    readonly workspace: string;
    readonly branch: string;
    readonly actualBranch: string;
  }[];
  readonly activeChanges: readonly string[];
  readonly groups: readonly TestRunGroupKey[];
}

export interface SandboxCommandRequest {
  readonly command: string;
  readonly cwd: string;
}

export interface SandboxCommandReply {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type SandboxUnitContext = Omit<TestRunCliPorts, 'stdout' | 'stderr'>;

export interface SandboxTestRunPorts {
  readonly caller: SandboxProcessIdentity;
  readonly entrypoint: readonly string[];
  control(caller: SandboxProcessIdentity): Promise<SandboxTestControlSnapshot>;
  unitContext(key: TestRunGroupKey): Promise<SandboxUnitContext>;
  communicate(argv: readonly string[], caller: SandboxTestAssignment): Promise<SandboxCommandReply>;
}

export interface SandboxRafCommandAccess {
  readonly raf_command: string;
  readonly raf_subcommands: readonly string[];
  readonly hostCommands: readonly string[];
}

export interface SandboxTestRunEvidence {
  readonly command: string;
  readonly workspace: string;
  readonly sha: string;
  readonly dirtyPaths: readonly string[];
  readonly artifact: string;
  readonly reply: SandboxCommandReply | null;
  readonly transportError?: string;
}

export async function runSandboxTestCommand(
  request: SandboxCommandRequest,
  ports: SandboxTestRunPorts,
): Promise<SandboxCommandReply> {
  try {
    const words = parseSandboxCommand(request.command);
    if (!ports.entrypoint.length || !words || !ports.entrypoint.every((word, index) => words[index] === word)) throw new Error('Untrusted entrypoint or non-simple command');
    const argv = words.slice(ports.entrypoint.length);
    const communication = argv[0] === 'agent' && ['message', 'ps'].includes(argv[1]);
    if (!communication && !(argv[0] === 'test' && argv[1] === 'run')) throw new Error('Command is not allowed through the sandbox channel');
    const control = await ports.control(ports.caller);
    if (![ports.caller, ...control.ancestors, ...control.sessions.map(row => row.process)].every(identity => Number.isSafeInteger(identity.pid) && identity.pid > 0 && Number.isFinite(Date.parse(identity.startedAt)))) throw new Error('Process identity is invalid');
    if (!control.ancestors.some(identity => sameProcess(identity, ports.caller))) throw new Error('Caller process identity is not observable');
    let session: SandboxTestSession | undefined;
    for (const ancestor of control.ancestors) {
      const registered = control.sessions.filter(row => row.process.pid === ancestor.pid);
      if (!registered.length) continue;
      session = registered.find(row => sameProcess(row.process, ancestor));
      if (!session || session.state !== 'running') throw new Error('Nearest registered caller is closed or has a reused process identity');
      break;
    }
    if (!session) throw new Error('No registered live caller');
    const assignment = session.assignment;
    if (communication) return await ports.communicate(argv, assignment);
    const args = parseTestRunArgs(argv.slice(2));
    const coordinating = assignment.type === 'main' || assignment.type === 'coordinator' && assignment.delegatedByMain === true;
    if (!coordinating && (!executorTypes.has(assignment.type) || !executorPhases.has(assignment.phase) || args.phase !== assignment.phase)) throw new Error('Caller assignment does not authorize the requested phase');
    if (coordinating && args.phase !== 'red' && args.phase !== assignment.phase) throw new Error('Coordinator phase is not authorized');
    if (assignment.project !== args.project || request.cwd !== assignment.workspace) throw new Error('Project or workspace differs from the immutable assignment');
    if (!control.workspaces.some(row => row.project === args.project && row.workspace === request.cwd && row.branch === assignment.branch && row.actualBranch === assignment.branch)) throw new Error('Registered workspace or branch differs from the assignment');
    const change = args.group.split('/')[0];
    if (!args.group.includes('/') || !assignment.changes.includes(change) || !control.activeChanges.includes(change)) throw new Error('Group change is outside the active assignment');
    const key = { project: args.project, workspace: assignment.workspace, group: args.group };
    if (!control.groups.some(row => row.project === key.project && row.workspace === key.workspace && row.group === key.group)) throw new Error('Group is not configured for this workspace');
    const unit = await ports.unitContext(key);
    if (unit.context.workspace !== key.workspace || unit.context.cwd !== request.cwd || !unit.context.projectWorkspaces[key.project]?.includes(key.workspace)) throw new Error('Unit context workspace differs from the authorized workspace');
    let stdout = '', stderr = '';
    const code = await runTestRunCli(argv.slice(2), { ...unit, context: { ...unit.context, agentId: assignment.agentId }, stdout: value => { stdout += value; }, stderr: value => { stderr += value; } });
    return { code, stdout, stderr };
  } catch (error) {
    return { code: 1, stdout: '', stderr: `Sandbox raf command refused: ${error instanceof Error ? error.message : String(error)}; use agent message to main with the exact command; raf was not retried\n` };
  }
}

const executorPhases = new Set(['implement', 'qa', 'hotfix']);
const executorTypes = new Set(['agent', ...executorPhases]);
const sameProcess = (left: SandboxProcessIdentity, right: SandboxProcessIdentity) => left.pid === right.pid && left.startedAt === right.startedAt;
const shellLiteral = (value: string) => /^[a-zA-Z0-9_./:-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

export function parseSandboxCommand(source: string): string[] | null {
  const words: string[] = [];
  let word = '', started = false, quote = '';
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '\0' || char === '\n' || char === '\r') return null;
    if (quote === "'") {
      if (char === "'") quote = ''; else word += char;
    } else if (quote === '"') {
      if (char === '"') quote = '';
      else if (char === '$' || char === '`') return null;
      else if (char === '\\') {
        const next = source[++index];
        if (next === undefined || /[\n\r\0]/.test(next)) return null;
        word += ['$', '`', '"', '\\'].includes(next) ? next : '\\' + next;
      } else word += char;
    } else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (char === '\\') {
      const next = source[++index];
      if (next === undefined || /[\n\r\0]/.test(next)) return null;
      word += next; started = true;
    } else if (char === ' ' || char === '\t') {
      if (started) words.push(word);
      word = ''; started = false;
    } else if (/[;&|<>$`(){}*?\[\]~#]/u.test(char)) return null;
    else { word += char; started = true; }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

export function sandboxRafCommandAccess(
  assignment: SandboxTestAssignment,
  runner: 'codex' | 'claude',
  entrypoint: readonly string[],
  phases: TestRunConfig['phases'],
): SandboxRafCommandAccess {
  if (!entrypoint.length || entrypoint.some(word => !word || /[\n\r\0]/.test(word))) throw new Error('Invalid trusted raf entrypoint');
  if (runner !== 'codex' && runner !== 'claude') throw new Error('Unsupported sandbox runner');
  const raf_command = entrypoint.map(shellLiteral).join(' ');
  const raf_subcommands = ['agent message', 'agent ps'];
  const coordinating = assignment.type === 'main' || assignment.type === 'coordinator' && assignment.delegatedByMain === true;
  if (executorTypes.has(assignment.type) && executorPhases.has(assignment.phase) && phases[assignment.phase]?.allowed || coordinating && phases.red?.allowed) raf_subcommands.push('test run');
  return { raf_command, raf_subcommands, hostCommands: raf_subcommands.map(command => `${raf_command} ${command}`) };
}

export function formatSandboxTestRunEvidence(evidence: SandboxTestRunEvidence): string {
  const context = `Command: ${evidence.command}\nWorkspace: ${evidence.workspace}\nSHA: ${evidence.sha}\nDirty paths: ${JSON.stringify(evidence.dirtyPaths)}\nArtifact: ${evidence.artifact}`;
  const escalation = (reason: string) => `${context}\nUnverified test run: ${reason}. Use agent message to main with the exact command above and restore the channel; do not retry blindly.`;
  if (evidence.transportError) return escalation(`transport failure: ${evidence.transportError}`);
  if (!evidence.reply) return escalation('missing command reply');
  let result: Record<string, any>;
  try {
    result = JSON.parse(evidence.reply.stdout);
    if (!result || typeof result !== 'object' || !['passed', 'assertions-failed', 'setup-failed', 'timed-out', 'interrupted', 'refused', 'unverified-remainder'].includes(result.outcome)
      || !['runId', 'project', 'workspace', 'phase', 'group', 'groupState', 'nextAction'].every(field => typeof result[field] === 'string')
      || !['knownRed', 'unexecuted', 'unknown'].every(field => Array.isArray(result[field])) || !result.selection || !result.cleanup || typeof result.cleanup.complete !== 'boolean'
      || !Array.isArray(result.cleanup.remainingPids) || typeof result.timedOut !== 'boolean' || typeof result.timeoutCount !== 'number') throw new Error('Incomplete TestRunResult');
  } catch { return escalation('missing, malformed or truncated TestRunResult JSON'); }
  const validPass = result.outcome === 'passed' && evidence.reply.code === 0 && result.cleanup.complete && !result.cleanup.remainingPids.length && !result.timedOut && !result.knownRed.length && !result.unexecuted.length && !result.unknown.length;
  return `${context}\nCLI code: ${evidence.reply.code}; child exitCode: ${result.exitCode}\nrunId: ${result.runId}\nproject: ${result.project}; phase: ${result.phase}; group: ${result.group}\nselection: ${JSON.stringify(result.selection)}\noutcome: ${result.outcome}; verified pass: ${validPass}\ntimedOut: ${result.timedOut}; cleanup: ${JSON.stringify(result.cleanup)}\nknownRed: ${JSON.stringify(result.knownRed)}\nunexecuted: ${JSON.stringify(result.unexecuted)}\nunknown: ${JSON.stringify(result.unknown)}\ntimeoutCount: ${result.timeoutCount}; groupState: ${result.groupState}; nextAction: ${result.nextAction}\nstderr: ${evidence.reply.stderr}${result.outcome === 'passed' && !validPass ? '\nUnverified result; use agent message to main; no green claim.' : ''}`;
}
