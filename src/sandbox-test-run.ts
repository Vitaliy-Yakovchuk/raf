import { validateStateRecoveryResult } from './test-run-state-recovery.ts';
import { runTestRunCli, type TestRunCliPorts } from './test-run-cli.ts';
import { resolveSandboxTestCaller, SandboxCallerRefusal } from './sandbox-test-caller.ts';
import type { SandboxCallerSnapshot } from './sandbox-test-caller.ts';
import { parseTestRunArgs } from './test-runs.ts';
import type { TestRunConfig, TestRunGroupKey, TestRunRequest } from './test-runs.ts';

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
  readonly callerEvidence?: SandboxCallerSnapshot;
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
  readonly config?: Pick<TestRunConfig, 'projects' | 'phases'>;
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
  unitContext(key: TestRunGroupKey, assignment: SandboxTestAssignment): Promise<SandboxUnitContext>;
  wrapper?(request: TestRunRequest, context: SandboxUnitContext): Promise<SandboxCommandReply>;
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
  let executingWrapper = false;
  let selectingUnit = false;
  try {
    const words = parseSandboxCommand(request.command);
    if (!ports.entrypoint.length || !words || !ports.entrypoint.every((word, index) => words[index] === word)) throw new SandboxCallerRefusal('Untrusted entrypoint or non-simple command');
    const argv = words.slice(ports.entrypoint.length);
    const communication = argv[0] === 'agent' && ['message', 'ps'].includes(argv[1]);
    if (!communication && !(argv[0] === 'test' && argv[1] === 'run')) throw new SandboxCallerRefusal('Command is not allowed through the sandbox channel');
    const control = await ports.control(ports.caller);
    let assignment: SandboxTestAssignment;
    if (control.callerEvidence) {
      if (!sameProcess(control.callerEvidence.caller, ports.caller)) throw new SandboxCallerRefusal('Caller identity differs from the trusted host snapshot');
      assignment = resolveSandboxTestCaller(control.callerEvidence);
    } else {
      if (![ports.caller, ...control.ancestors].every(identity => Number.isSafeInteger(identity.pid) && identity.pid > 0 && typeof identity.startedAt === 'string' && identity.startedAt.length > 0)) throw new SandboxCallerRefusal('Process identity is invalid');
      if (!control.ancestors.length || !sameProcess(control.ancestors[0], ports.caller)) throw new SandboxCallerRefusal('Caller process ancestry is not observable');
      let session: SandboxTestSession | undefined;
      for (const ancestor of control.ancestors) {
        const registered = control.sessions.filter(row => row.process.pid === ancestor.pid);
        if (!registered.length) continue;
        const current = registered.filter(row => sameProcess(row.process, ancestor) && row.state === 'running');
        if (current.length > 1) throw new SandboxCallerRefusal('Ambiguous caller: conflicting live run claims');
        if (!current.length) throw new SandboxCallerRefusal(registered.some(row => sameProcess(row.process, ancestor)) ? 'Nearest registered caller run is closed' : 'Caller process identity mismatch: PID reused');
        session = current[0];
        break;
      }
      if (!session) throw new SandboxCallerRefusal('Unknown caller ancestry: no registered live caller');
      if (!session.assignment?.runId) throw new SandboxCallerRefusal('Caller immutable assignment is missing');
      assignment = session.assignment;
    }
    if (communication) return await ports.communicate(argv, assignment);
    const args = parseTestRunArgs(argv.slice(2));
    if (assignment.project !== args.project || request.cwd !== assignment.workspace) throw new SandboxCallerRefusal('Project or workspace differs from the immutable assignment');
    if (!control.workspaces.some(row => row.project === args.project && row.workspace === request.cwd && row.branch === assignment.branch && row.actualBranch === assignment.branch)) throw new SandboxCallerRefusal('Registered workspace or branch differs from the assignment');
    const { only, ...selectionArgs } = args;
    const requestArgs: TestRunRequest = { ...selectionArgs, phase: args.phase ?? assignment.phase, ...(only ? { only: only.map(value => {
      const separator = value.indexOf('::');
      const id = value.startsWith('{') ? JSON.parse(value) : { file: value.slice(0, separator), name: value.slice(separator + 2) };
      if ((!value.startsWith('{') && separator < 1) || !id || typeof id.file !== 'string' || typeof id.name !== 'string' || !id.name.length) throw new SandboxCallerRefusal('Invalid exact test-id');
      return id;
    }) } : {}) };
    if (args.phase === 'integration' && !control.config) throw new SandboxCallerRefusal('Integration requires a trusted preset catalog');
    const key = { project: args.project, workspace: assignment.workspace, group: args.group };
    if ((!control.config || !ports.wrapper) && !control.groups.some(row => row.project === key.project && row.workspace === key.workspace && row.group === key.group)) throw new SandboxCallerRefusal('Group is not configured for this workspace');
    selectingUnit = true;
    const selectedUnit = await ports.unitContext(key, assignment);
    selectingUnit = false;
    const unit = control.callerEvidence && ports.wrapper ? { ...selectedUnit, context: { ...selectedUnit.context, agentId: assignment.agentId, callerPhase: assignment.phase } } : selectedUnit;
    if (ports.wrapper) {
      executingWrapper = true;
      return await ports.wrapper(requestArgs, unit);
    }
    if (unit.context.workspace !== key.workspace || unit.context.cwd !== request.cwd || !unit.context.projectWorkspaces[key.project]?.includes(key.workspace)) throw new SandboxCallerRefusal('Unit context workspace differs from the authorized workspace');
    let stdout = '', stderr = '';
    const code = await runTestRunCli(argv.slice(2), { ...unit, context: { ...unit.context, agentId: assignment.agentId, callerPhase: assignment.phase }, stdout: value => { stdout += value; }, stderr: value => { stderr += value; } });
    return { code, stdout, stderr };
  } catch (error) {
    if (executingWrapper) throw error;
    const code = typeof (error as { code?: unknown })?.code === 'string' ? `${(error as { code: string }).code}: ` : '';
    const cause = `${code}${error instanceof Error ? error.message : String(error)}`.replace(/\s+/g, ' ').slice(0, 300);
    const reason = error instanceof SandboxCallerRefusal ? error.message : selectingUnit ? `QA channel unavailable: unit context could not be verified (${cause})` : 'Trusted caller channel or request could not be verified';
    return { code: 1, stdout: '', stderr: `Sandbox raf command refused (CALLER_UNAUTHORIZED): ${reason}; restore the trusted channel or obtain a new verified assignment with the required phase and grants; the executor must run its own authorized tests; do not delegate the run to main or coordinator; do not retry blindly; raf was not retried\n` };
  }
}

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
  runner: 'codex' | 'claude',
  entrypoint: readonly string[],
): SandboxRafCommandAccess {
  if (!entrypoint.length || entrypoint.some(word => !word || /[\n\r\0]/.test(word))) throw new SandboxCallerRefusal('Invalid trusted raf entrypoint');
  if (runner !== 'codex' && runner !== 'claude') throw new SandboxCallerRefusal('Unsupported sandbox runner');
  const raf_command = entrypoint.map(shellLiteral).join(' ');
  const raf_subcommands = ['agent message', 'agent ps', 'test run'];
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
      || !['runId', 'project', 'workspace', 'phase', 'group', 'nextAction'].every(field => typeof result[field] === 'string')
      || !['knownRed', 'unexecuted', 'unknown'].every(field => Array.isArray(result[field])) || !result.selection || !result.cleanup || typeof result.cleanup.complete !== 'boolean'
      || !Array.isArray(result.cleanup.remainingPids) || typeof result.timedOut !== 'boolean') throw new SandboxCallerRefusal('Incomplete TestRunResult');
    validateStateRecoveryResult(result);
  } catch { return escalation('missing, malformed or truncated TestRunResult JSON'); }
  const validPass = result.groupSnapshot === 'loaded' && result.outcome === 'passed' && evidence.reply.code === 0 && result.cleanup.complete && !result.cleanup.remainingPids.length && !result.timedOut && !result.knownRed.length && !result.unexecuted.length && !result.unknown.length;
  return `${context}\nCLI code: ${evidence.reply.code}; child exitCode: ${result.exitCode}\nrunId: ${result.runId}\nproject: ${result.project}; phase: ${result.phase}; group: ${result.group}\nselection: ${JSON.stringify(result.selection)}\noutcome: ${result.outcome}; verified pass: ${validPass}\ntimedOut: ${result.timedOut}; cleanup: ${JSON.stringify(result.cleanup)}\nknownRed: ${JSON.stringify(result.knownRed)}\nunexecuted: ${JSON.stringify(result.unexecuted)}\nunknown: ${JSON.stringify(result.unknown)}\nstateAccess: ${JSON.stringify(result.stateAccess)}; groupSnapshot: ${result.groupSnapshot}\ntimeoutCount: ${result.timeoutCount}; groupState: ${result.groupState}; nextAction: ${result.nextAction}\nstderr: ${evidence.reply.stderr}${result.outcome === 'passed' && !validPass ? '\nUnverified result; use agent message to main; no green claim.' : ''}`;
}
