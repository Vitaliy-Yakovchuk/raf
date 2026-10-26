import { parseCommandArguments, validateCommandConstraints } from './cli-arguments.ts';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { accessSync, constants, statSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import type { CompiledCatalog } from './catalog.ts';

export interface CommandFailureContext {
  code: string;
  message: string;
  stage: string;
  source: string;
  sourceCode: string | number | null;
  reason: string | null;
  received: unknown;
  expected: unknown;
  found: unknown;
  completed: readonly string[];
  pending: readonly string[];
  retrySafe: boolean | null;
  remediation: readonly string[];
  cleanup?: import('./agent-run-queue.ts').AgentQueueCleanup;
  secrets?: readonly string[];
  admission?: import('./admission-snapshot.ts').AdmissionSnapshot | null;
}

const failures = new WeakMap<Error, CommandFailureContext>();

export function commandFailure(context: CommandFailureContext): Error {
  const error = new Error(context.message);
  failures.set(error, structuredClone(context));
  return error;
}

export function failureContext(error: unknown): CommandFailureContext | undefined {
  return error instanceof Error ? failures.get(error) : undefined;
}

export function redactDiagnostic(value: unknown, secrets: readonly string[] = []): unknown {
  const scrub = (text: string): string => secrets.filter(Boolean).sort((a, b) => b.length - a.length).reduce((result, secret) => result.split(secret).join('[redacted]'), text)
    .replace(/((?:password|passwd|secret|token|authorization|api[_-]?key|credential)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1[redacted]')
    .replace(/(Bearer\s+)\S+/gi, '$1[redacted]');
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') return scrub(item);
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, entry]) => [scrub(key), /password|passwd|secret|token|authorization|api[_-]?key|credential/i.test(key) ? '[redacted]' : visit(entry)]));
    return item;
  };
  return visit(value);
}

export type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>;

export interface ExecutionResult {
  afterDelivery?: () => Promise<void>;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function execute(
  argv: readonly string[],
  catalog: CompiledCatalog,
  handlers: Record<string, Handler>,
): Promise<ExecutionResult> {
  const ok = (value: unknown): ExecutionResult => ({ exitCode: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value ?? null), stderr: '' });
  const fail = (code: string, message: string, details: Record<string, unknown> = {}, remediation: readonly string[] = [], secrets: readonly string[] = []): ExecutionResult => {
    const definitions = catalog.errorCodes;
    const definition = definitions?.find(entry => entry.id === code);
    if (definitions && !definition) {
      details = { ...details, sourceCode: code, reason: null, completed: details.completed ?? null, pending: details.pending ?? null, retrySafe: details.retrySafe ?? null };
      code = 'HANDLER_FAILED';
      message = definitions.find(entry => entry.id === code)?.description ?? 'Unregistered command failure';
    }
    const fallback = definitions?.find(entry => entry.id === code);
    return {
      exitCode: definition?.exitCode ?? fallback?.exitCode ?? 1, stdout: '', stderr: JSON.stringify(redactDiagnostic({ code, message: message || definition?.description, details: {
        command: null, stage: 'arguments', source: 'cli', sourceCode: null,
        reason: message, received: null, expected: null, found: null,
        completed: [], pending: [], retrySafe: true, ...(details.command === 'agent run' ? { admission: null } : {}), ...details,
      }, remediation: [...(remediation.length ? remediation : [typeof details.example === 'string' ? `Виправте виклик: ${details.example}` : details.stage === 'handler' ? 'Перевірте фактичний стан операції перед повторним викликом.' : 'Перевірте параметри та доступність команди за довідкою.']), `raf help${typeof details.command === 'string' && details.command ? ` ${details.command}` : ''}`] }, secrets)),
    };
  };
  const unknown = (tokens: readonly string[], message: string): ExecutionResult => {
    let prefix: string[] = [];
    for (const token of tokens) {
      if (!catalog.commands.some(command => [...prefix, token].every((part, index) => command.path[index] === part))) break;
      prefix = [...prefix, token];
    }
    const alternatives = catalog.commands.filter(command => prefix.every((part, index) => command.path[index] === part));
    const expected = [...new Set(alternatives.map(command => command.path[prefix.length]).filter(Boolean))];
    return fail('UNKNOWN_COMMAND', message, { command: prefix.join(' ') || null, received: tokens[prefix.length] ?? null, expected, found: prefix }, [`Перевірте шлях команди: raf help${prefix.length ? ` ${prefix.join(' ')}` : ''}`]);
  };
  const helpRequested = argv[0] === 'help' || argv.includes('--help') || argv.length === 0;
  const tokens = argv[0] === 'help'
    ? (argv.length === 2 && argv[1] === '--help' ? ['help'] : argv.slice(1).filter(t => t !== '--help'))
    : argv.filter(t => t !== '--help');
  if (helpRequested) {
    const matches = catalog.commands.filter(c => tokens.every((t, i) => c.path[i] === t));
    if (!matches.length) return unknown(tokens, 'Невідомий шлях довідки.');
    return ok(JSON.stringify({ program: 'raf', commands: matches.map(c => ({ ...c.metadata, ...c, usage: commandUsage(c), errorCodes: (c.metadata.errorCodes as string[] | undefined)?.map(id => catalog.errorCodes?.find(entry => entry.id === id)), parameters: c.parameters.map(p => ({ ...p, required: p.required ?? false, multiple: p.multiple ?? false, requirement: p.required ? 'required' : 'optional' })) })), reportStatuses: catalog.reportStatuses }, null, 2));
  }
  const command = [...catalog.commands].sort((a, b) => b.path.length - a.path.length).find(c => c.path.every((t, i) => argv[i] === t));
  if (!command) return unknown(tokens, 'Невідома команда.');
  const context = { command: command.path.join(' ') };
  const parsed = parseCommandArguments(argv.slice(command.path.length), command);
  if ('error' in parsed) {
    const { code, message, details, remediation } = parsed.error;
    return fail(code, message, details, remediation);
  }
  const { params } = parsed;
  const constraint = validateCommandConstraints(params, command);
  if (constraint) return fail(constraint.code, constraint.message, constraint.details, constraint.remediation);
  if (command.handlerName === 'agent close' && typeof params.reason === 'string') params.reason = params.reason.trim();
  const handler = handlers[command.handlerName];
  if (typeof handler !== 'function') return fail('HANDLER_UNAVAILABLE', 'Обробник команди недоступний.', { ...context, stage: 'dispatch' });
  try {
    return ok(await handler({ ...params }));
  } catch (error) {
    const supplied = failureContext(error);
    if (supplied) {
      const { code, message, remediation, secrets, ...facts } = supplied;
      return fail(code, message, { ...facts, ...context }, remediation, secrets);
    }
    if (error instanceof UnavailableCommandError) return fail('COMMAND_UNAVAILABLE', 'Команда ще не реалізована в цьому інкременті raf.', { ...context, stage: 'dispatch', sideEffects: [] });
    const sourceCode = error && typeof error === 'object' && 'code' in error && (typeof error.code === 'string' || typeof error.code === 'number') ? error.code : null;
    return fail('HANDLER_FAILED', catalog.errorCodes?.find(entry => entry.id === 'HANDLER_FAILED')?.description ?? 'Обробник завершився помилкою; причина невідома.', { ...context, stage: 'handler', source: null, sourceCode, reason: null, found: error instanceof Error ? error.message : null, completed: null, pending: null, retrySafe: null });
  }
}

export function commandUsage(command: CompiledCatalog['commands'][number]): string {
  return ['raf', ...command.path, ...command.parameters.map(parameter => {
    const value = parameter.type === 'boolean' ? '' : ` <${parameter.name}>${parameter.multiple ? ` [<${parameter.name}> ...]` : ''}`;
    const syntax = `${parameter.option}${value}`;
    return parameter.required ? syntax : `[${syntax}]`;
  })].join(' ');
}

export class UnavailableCommandError extends Error {}

const diagnostic = (code: string, error: unknown): ExecutionResult => ({ exitCode: 1, stdout: '', stderr: JSON.stringify({ code, message: error instanceof Error ? error.message : String(error) }) });

export async function runPublicCli(entryUrl: string, argv: readonly string[], costStartedAt?: import('./raf-cost-runtime.ts').RafCostBoundary): Promise<ExecutionResult> {
  const codeRoot = fileURLToPath(new URL('../', entryUrl)).replace(/\/$/, '');
  const artifactPath = join(codeRoot, 'dist/catalog.json');
  const bootstrapIdentity = statSync(codeRoot, { bigint: true });
  const verifyBootstrap = () => {
    const current = statSync(codeRoot, { bigint: true });
    if (current.dev !== bootstrapIdentity.dev || current.ino !== bootstrapIdentity.ino || current.ctimeNs !== bootstrapIdentity.ctimeNs) throw new Error('Bootstrap directory changed before reader pinning');
  };
  let catalog: CompiledCatalog;
  try {
    catalog = JSON.parse(readFileSync(artifactPath, 'utf8'));
    if (!Array.isArray(catalog?.commands) || !Array.isArray(catalog?.reportStatuses)) throw new Error('Compiled CLI catalog unavailable; run npm run build');
    let runtime = false;
    const result = await execute(argv, catalog, new Proxy(Object.create(null), { get: () => async () => { runtime = true; } }));
    if (!runtime) return result;
  } catch (error) { return diagnostic('CATALOG_UNAVAILABLE', error); }

  let lease: { generationRoot: string; release(): Promise<void> } | undefined;
  let result: ExecutionResult | undefined;
  const fail = async (code: string, error: unknown): Promise<ExecutionResult> => argv[0] === 'test' && argv[1] === 'run'
    ? (await import('./test-run-bootstrap.ts')).testRunBootstrapFailure(argv.slice(2), diagnostic(code, error).stderr)
    : diagnostic(code, error);
  try {
    let owner: any;
    try { owner = JSON.parse(readFileSync(fileURLToPath(new URL('../../ownership.json', entryUrl)), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const orchestratorRoot = process.env.RAF_ORCHESTRATOR_ROOT ?? owner?.orchestratorRoot ?? fileURLToPath(new URL('../../', entryUrl));
    let configuration: any;
    try { configuration = JSON.parse(readFileSync(join(orchestratorRoot, 'conf/projects.json'), 'utf8')); }
    catch (error) { return await fail('CONFIGURATION_INVALID', error); }
    const main = configuration.projects?.raf?.branchPaths?.main;
    if (typeof main !== 'string' || !main.trim()) return await fail('STATE_CONTEXT_REFUSED', new Error('Registered raf main route required'));
    const logicalMain = resolve(orchestratorRoot, main);
    const copies = configuration.projects.raf.mainCopies;
    const physicalSlot = Array.isArray(copies) && copies.some(copy => typeof copy === 'string' && resolve(orchestratorRoot, copy) === codeRoot);
    if (logicalMain === codeRoot || physicalSlot || owner?.root === codeRoot) {
      if (owner?.root !== codeRoot) {
        if (realpathSync(logicalMain) !== codeRoot) throw new Error('Inactive main slot cannot bootstrap the production runtime');
        if (physicalSlot) {
          const { productionStateContext } = await import(pathToFileURL(join(codeRoot, 'src/state-migration-guard.ts')).href);
          productionStateContext(orchestratorRoot, fileURLToPath(entryUrl), homedir(), 'cli');
        }
        if (execFileSync('git', ['-C', codeRoot, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== 'main') throw new Error('Registered raf main Git branch required');
      }
      if (owner?.root === codeRoot && codeRoot.includes('/raf-hotfix/generations/')) accessSync(resolve(codeRoot, '../../..'), constants.W_OK);
      verifyBootstrap();
      const { acquireHotfixReader, retainHotfixGeneration } = await import(pathToFileURL(join(codeRoot, 'src/hotfix-activation.ts')).href);
      verifyBootstrap();
      const host = { orchestratorRoot, qaHome: homedir(), environment: {}, sandboxExecutable: 'codex' };
      if (owner?.root === codeRoot) {
        const retained = await retainHotfixGeneration(host, codeRoot);
        if (!retained) throw new Error('Production generation reader registration missing');
        lease = { generationRoot: codeRoot, release: () => retained.release() };
      } else lease = await acquireHotfixReader(host, 'cli');
    }
    const root = lease?.generationRoot ?? codeRoot;
    const { runProductionCli } = await import(pathToFileURL(join(root, 'src/production-entry.ts')).href);
    result = await runProductionCli(argv, { orchestratorRoot, homeDirectory: homedir(), artifactPath: join(root, 'dist/catalog.json'), costStartedAt });
    if (argv[0] === 'test' && argv[1] === 'run' && result.exitCode !== 0 && !result.stdout.trim()) {
      result = { ...(await fail('PRODUCTION_ENTRY_FAILED', new Error('Production entry returned no TestRunResult'))), stderr: result.stderr, afterDelivery: result.afterDelivery };
    }
  } catch (error) { result = await fail(failureContext(error)?.code ?? 'PRODUCTION_ENTRY_FAILED', error); }
  finally {
    try { await lease?.release(); }
    catch (error) { if (!result || result.exitCode === 0) result = diagnostic('PRODUCTION_ENTRY_FAILED', error); }
  }
  return result!;
}
