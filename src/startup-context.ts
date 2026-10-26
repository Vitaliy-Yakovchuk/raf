import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export interface ContextMeasurement<T> {
  readonly value: T | null;
  readonly reason: string | null;
}

export interface StartupContextSource {
  readonly name: string;
  readonly path?: string;
  readonly tokens: ContextMeasurement<number>;
}

export interface StartupContextAssessment {
  readonly unnecessary: readonly { readonly source: string; readonly reason: string }[];
  readonly missing: readonly { readonly description: string; readonly foundAt: string }[];
}

export interface StartupContextTrace {
  readonly runId: string;
  readonly agentType: string;
  readonly runner: 'claude' | 'codex';
  readonly phase: string;
  readonly autoloaded: {
    readonly systemPrompt: ContextMeasurement<number>;
    readonly instructions: ContextMeasurement<readonly StartupContextSource[]>;
    readonly skills: ContextMeasurement<readonly StartupContextSource[]>;
    readonly mcpServers: ContextMeasurement<readonly StartupContextSource[]>;
    readonly memory: ContextMeasurement<readonly StartupContextSource[]>;
  };
  readonly reads: readonly {
    readonly tool: string;
    readonly target: string;
    readonly resultBytes: ContextMeasurement<number>;
  }[];
  readonly brief: {
    readonly tokens: number;
    readonly parts: readonly { readonly source: string; readonly tokens: number }[];
  };
  readonly tokens: {
    readonly startupInput: ContextMeasurement<number>;
    readonly totalInput: ContextMeasurement<number>;
    readonly cacheReadInput: ContextMeasurement<number>;
    readonly cacheWriteInput: ContextMeasurement<number>;
  };
  readonly boundary: {
    readonly kind: 'file-write' | 'raf-side-effect' | 'response' | 'run-ended';
    readonly eventIndex: number;
  };
  readonly context: StartupContextAssessment | null;
}

export interface StartupContextCapture {
  readonly runId: string;
  readonly agentType: string;
  readonly runner: 'claude' | 'codex';
  readonly phase: string;
  readonly events: readonly Readonly<Record<string, unknown>>[];
  readonly briefParts: readonly { readonly source: string; readonly text: string }[];
  readonly report?: { readonly context?: StartupContextAssessment };
}

export interface StartupContextCapturePorts {
  estimateTokens(text: string): number;
}

export interface StartupContextDueEvent {
  readonly id: string;
  readonly event: 'context-review.due';
  readonly to: string;
  readonly runIds: readonly string[];
  readonly createdAt: string;
  readonly mainDelivery?: {
    readonly state: 'uncertain' | 'delivered';
    readonly attemptId?: string;
    readonly attemptedAt?: string;
    readonly deliveredAt?: string;
    readonly reason?: string;
  };
}

export interface StartupContextCompletion {
  readonly runId: string;
  readonly phase: string;
  readonly trace: StartupContextTrace | null;
  readonly finishedAt: string;
  readonly flowPath: string;
  readonly mainAddress: string;
}

const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const measured = <T>(value: T): ContextMeasurement<T> => ({ value, reason: null });
const unavailable = <T>(field: string): ContextMeasurement<T> => ({ value: null, reason: `Runner did not report ${field}` });
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export const startupContextAssessmentSchema = {
  type: 'object', required: ['unnecessary', 'missing'], additionalProperties: false,
  properties: {
    unnecessary: { type: 'array', items: { type: 'object', required: ['source', 'reason'], additionalProperties: false, properties: { source: { type: 'string', minLength: 1 }, reason: { type: 'string', minLength: 1 } } } },
    missing: { type: 'array', items: { type: 'object', required: ['description', 'foundAt'], additionalProperties: false, properties: { description: { type: 'string', minLength: 1 }, foundAt: { type: 'string', minLength: 1 } } } },
  },
} as const;

export function validStartupContextAssessment(value: unknown): value is StartupContextAssessment {
  const assessment = object(value);
  return Object.keys(assessment).every(key => key === 'unnecessary' || key === 'missing') &&
    [['unnecessary', ['source', 'reason']], ['missing', ['description', 'foundAt']]].every(([key, fields]) => {
      const rows = assessment[key as string];
      return Array.isArray(rows) && rows.every(row => {
        const entry = object(row);
        return Object.keys(entry).length === fields.length && (fields as string[]).every(field => typeof entry[field] === 'string' && entry[field].length > 0);
      });
    });
}

function safeTarget(value: unknown): string {
  if (typeof value !== 'string') return 'unreported';
  if (/^[a-z]+:\/\//i.test(value)) {
    try { const url = new URL(value); return `${url.protocol}//${url.host}${url.pathname}`; } catch { return 'unreported'; }
  }
  if (/[\r\n\0]/.test(value) || /(?:token|password|secret|api[_-]?key)\s*[=:]/i.test(value)) return 'redacted';
  return value;
}

function contentBytes(content: unknown): number {
  if (typeof content === 'string') return Buffer.byteLength(content);
  if (Array.isArray(content)) return content.reduce((total, block) => total + contentBytes(object(block).text ?? block), 0);
  return Buffer.byteLength(JSON.stringify(content) ?? '');
}

function commandAction(command: string): StartupContextTrace['boundary']['kind'] | null {
  command = command.replace(/\d*>\s*\/dev\/null\b|\d*>&\d+/g, '');
  const raf = command.match(/(?:\braf(?:\.ts)?|\/raf\.ts)\s+(agent|reminder|runner|service|secrets|deployment|resource|openspec)\s+([\w-]+)/);
  if (raf && !['ps', 'help', 'stats', 'list', 'show', 'status'].includes(raf[2])) return 'raf-side-effect';
  if (/(?:^|[;&|]\s*|\s)(?:touch|mkdir|rm|mv|cp|tee|truncate|install|apply_patch)\b|(?:^|\s)(?:sed|perl)\s+[^;&|]*-[^\s]*i\b|(?:^|[^<])>{1,2}(?!&)|\bgit\s+(?:add|commit|checkout|switch|reset|merge|rebase|cherry-pick)\b/.test(command)) return 'file-write';
  return null;
}

function commandTarget(command: string): string {
  const raf = command.match(/(?:\braf(?:\.ts)?|\/raf\.ts)\s+(agent|reminder|runner|service|secrets|deployment|resource|openspec)\s+([\w-]+)/);
  if (raf) return `raf ${raf[1]} ${raf[2]}`;
  const paths = [...command.matchAll(/(?:^|[\s'"=])((?:\/|\.\.?\/|(?:src|test|conf|openspec|skills|docs)\/)[^\s'";|&<>]*)/g)].map(match => safeTarget(match[1])).filter(path => !/^\/(?:usr\/)?bin\/(?:ba|z|fi)?sh$/.test(path));
  if (paths.length) return [...new Set(paths)].join(' ');
  return command.match(/\b(?:cat|rg|grep|sed|head|tail|ls|pwd|find|git|stat|wc|readlink)\b/)?.[0] ?? 'command';
}

export function captureStartupContext(input: StartupContextCapture, ports: StartupContextCapturePorts): StartupContextTrace {
  const autoloaded: StartupContextTrace['autoloaded'] = {
    systemPrompt: unavailable('system prompt tokens'), instructions: unavailable('instruction files'), skills: unavailable('skills'), mcpServers: unavailable('MCP servers'), memory: unavailable('memory'),
  };
  let loaded = { ...autoloaded };
  const reads: { tool: string; target: string; resultBytes: ContextMeasurement<number> }[] = [];
  const calls = new Map<string, number>();
  let boundary: StartupContextTrace['boundary'] | undefined;
  let startupInput: ContextMeasurement<number> = unavailable('startup input tokens');
  let totalInput: ContextMeasurement<number> = unavailable('total input tokens');
  let cacheReadInput: ContextMeasurement<number> = unavailable('cache read input tokens');
  let cacheWriteInput: ContextMeasurement<number> = unavailable('cache write input tokens');
  const seenUsage = new Set<string>();
  const sourceList = (raw: unknown, label: string): ContextMeasurement<readonly StartupContextSource[]> => {
    if (!Array.isArray(raw)) return unavailable(label);
    return measured(raw.map(entry => {
      const item = typeof entry === 'string' ? { name: entry } : object(entry);
      const tokens = item.tokens ?? item.token_count;
      return { name: safeTarget(item.name ?? item.path ?? 'unreported'), ...(typeof item.path === 'string' ? { path: safeTarget(item.path) } : {}), tokens: numeric(tokens) ? measured(tokens) : typeof item.description === 'string' ? measured(ports.estimateTokens(item.description)) : unavailable<number>(`${label} tokens`) };
    }));
  };
  const usage = (raw: unknown, cumulative: boolean, key?: string, startup = false) => {
    const row = object(raw);
    if (key && seenUsage.has(key)) return;
    if (key) seenUsage.add(key);
    const update = (current: ContextMeasurement<number>, value: unknown) => numeric(value) ? measured(cumulative ? value : (current.value ?? 0) + value) : current;
    const count = row.input_tokens ?? row.inputTokens;
    if (startup && startupInput.value === null && numeric(count)) startupInput = measured(count);
    totalInput = update(totalInput, count);
    cacheReadInput = update(cacheReadInput, row.cache_read_input_tokens ?? row.cached_input_tokens);
    cacheWriteInput = update(cacheWriteInput, row.cache_creation_input_tokens ?? row.cache_write_input_tokens);
  };
  const invoke = (tool: string, args: unknown, id: string, index: number) => {
    if (boundary) return;
    const row = object(args);
    const command = row.command ?? row.cmd;
    const kind = /(?:^|[._/])(?:Write|Edit|MultiEdit|write_file|edit_file|apply_patch|file_change)$/i.test(tool) ? 'file-write' : typeof command === 'string' ? commandAction(command) : null;
    if (kind) { boundary = { kind, eventIndex: index }; return; }
    const target = typeof command === 'string' ? commandTarget(command) : [row.file_path ?? row.path ?? row.url ?? row.target, row.query ?? row.pattern].filter(value => typeof value === 'string').map(safeTarget).join(' ') || 'unreported';
    calls.set(id, reads.length);
    reads.push({ tool, target, resultBytes: unavailable('tool result size') });
  };
  const result = (id: string, content: unknown) => {
    const index = calls.get(id);
    if (index === undefined || content === undefined) return;
    reads[index].resultBytes = measured(contentBytes(content));
    calls.delete(id);
  };
  for (let index = 0; index < input.events.length; index++) {
    const event = object(input.events[index]);
    const message = object(event.message);
    if (event.type === 'system' && event.subtype === 'init' || event.type === 'session.configured' || event.type === 'session.started') {
      const metadata = object(event.autoloaded ?? event.context ?? event);
      const prompt = metadata.system_prompt_tokens ?? metadata.systemPromptTokens ?? (typeof metadata.system_prompt === 'string' ? ports.estimateTokens(metadata.system_prompt) : undefined);
      loaded = { systemPrompt: numeric(prompt) ? measured(prompt) : loaded.systemPrompt,
        instructions: sourceList(metadata.instructions ?? metadata.instruction_files, 'instruction files'), skills: sourceList(metadata.skills, 'skills'),
        mcpServers: sourceList(metadata.mcp_servers ?? metadata.mcpServers, 'MCP servers'), memory: sourceList(metadata.memory, 'memory') };
    }
    if (input.runner === 'claude') {
      if (event.type === 'assistant') {
        usage(message.usage, false, typeof message.id === 'string' ? message.id : undefined, !boundary);
        const blocks = Array.isArray(message.content) ? message.content : [];
        for (const block of blocks) if (block.type === 'tool_use') invoke(block.name, block.input, block.id, index);
        if (!boundary && blocks.length && !blocks.some(block => block.type === 'tool_use') && blocks.some(block => block.type === 'text' && block.text)) boundary = { kind: 'response', eventIndex: index };
      }
      if (event.type === 'user') for (const block of Array.isArray(message.content) ? message.content : []) if (block.type === 'tool_result') result(block.tool_use_id, block.content);
      if (event.type === 'result') usage(event.usage, true);
    } else {
      const item = object(event.item);
      if (event.type === 'item.started' || event.type === 'item.completed') {
        const id = item.id ?? `event-${index}`;
        if (item.type === 'file_change') { if (!boundary) boundary = { kind: 'file-write', eventIndex: index }; }
        else if (item.type === 'command_execution') {
          if (!calls.has(id) && !(event.type === 'item.completed' && boundary)) invoke('command_execution', item, id, index);
          if (event.type === 'item.completed') result(id, item.aggregated_output);
        } else if (item.type === 'mcp_tool_call') {
          if (!calls.has(id)) invoke(`${item.server}.${item.tool}`, item.arguments, id, index);
          if (event.type === 'item.completed') result(id, item.result);
        } else if (item.type === 'agent_message' && !boundary) boundary = { kind: 'response', eventIndex: index };
      }
      if (event.type === 'turn.completed') usage(event.usage, false);
      const payload = object(event.payload);
      if (event.type === 'event_msg' && payload.type === 'token_count') {
        const info = object(payload.info);
        usage(info.total_token_usage, true);
        if (startupInput.value === null) {
          const first = object(info.last_token_usage).input_tokens;
          if (numeric(first)) startupInput = measured(first);
        }
      }
    }
  }
  return { runId: input.runId, agentType: input.agentType, runner: input.runner, phase: input.phase, autoloaded: loaded, reads,
    brief: { tokens: ports.estimateTokens(input.briefParts.map(part => part.text).join('\n')), parts: input.briefParts.map(part => ({ source: part.source, tokens: ports.estimateTokens(part.text) })) },
    tokens: { startupInput, totalInput, cacheReadInput, cacheWriteInput }, boundary: boundary ?? { kind: 'run-ended', eventIndex: input.events.length },
    context: input.report?.context && validStartupContextAssessment(input.report.context) ? structuredClone(input.report.context) : null };
}

function schema(database: DatabaseSync): void {
  database.exec(`CREATE TABLE IF NOT EXISTS startup_context_traces (run_id TEXT PRIMARY KEY, payload TEXT NOT NULL, finished_at TEXT) STRICT;
    CREATE TABLE IF NOT EXISTS startup_context_completions (sequence INTEGER PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, event_id TEXT) STRICT;
    CREATE TABLE IF NOT EXISTS startup_context_reviews (id TEXT PRIMARY KEY, payload TEXT NOT NULL, review_run_id TEXT, closed_at TEXT) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS startup_context_review_run ON startup_context_reviews(review_run_id) WHERE review_run_id IS NOT NULL;`);
}

function atomic<T>(database: DatabaseSync, action: () => T): T {
  database.exec('SAVEPOINT startup_context');
  try { const value = action(); database.exec('RELEASE startup_context'); return value; }
  catch (error) { database.exec('ROLLBACK TO startup_context; RELEASE startup_context'); throw error; }
}

function policyNumber(path: string, section: string, field: string): number {
  let policy: Record<string, any>;
  try { policy = object(JSON.parse(readFileSync(path, 'utf8'))); }
  catch (cause) { throw new Error(`Cannot load flow policy ${path}`, { cause }); }
  const value = object(policy[section])[field];
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid flow policy: ${section}.${field}`);
  return value;
}

export function saveStartupContextTrace(database: DatabaseSync, trace: StartupContextTrace): void {
  schema(database);
  database.prepare('INSERT INTO startup_context_traces(run_id, payload) VALUES (?, ?) ON CONFLICT(run_id) DO UPDATE SET payload=excluded.payload').run(trace.runId, JSON.stringify(trace));
}

export function readStartupContextTrace(database: DatabaseSync, runId: string): StartupContextTrace | null {
  schema(database);
  const row = database.prepare('SELECT payload FROM startup_context_traces WHERE run_id=?').get(runId);
  return row ? JSON.parse(row.payload as string) : null;
}

export function recordStartupContextCompletion(database: DatabaseSync, input: StartupContextCompletion): StartupContextDueEvent | null {
  const threshold = policyNumber(input.flowPath, 'startupContextReview', 'runsPerReview');
  schema(database);
  return atomic(database, () => {
    if (input.trace === null) return null;
    if (input.trace.runId !== input.runId || input.trace.phase !== input.phase) throw new Error('Startup context completion identity mismatch');
    if (!Number.isFinite(Date.parse(input.finishedAt))) throw new Error('Invalid startup context completion time');
    if (database.prepare('SELECT 1 FROM startup_context_traces WHERE run_id=? AND finished_at IS NOT NULL').get(input.runId)) return null;
    saveStartupContextTrace(database, input.trace);
    database.prepare('UPDATE startup_context_traces SET finished_at=? WHERE run_id=?').run(input.finishedAt, input.runId);
    if (input.phase === 'context-review') return null;
    database.prepare('INSERT OR IGNORE INTO startup_context_completions(run_id) VALUES (?)').run(input.runId);
    const runIds = pendingStartupContextRunIds(database);
    if (runIds.length < threshold) return null;
    const event: StartupContextDueEvent = { id: randomUUID(), event: 'context-review.due', to: input.mainAddress, runIds, createdAt: input.finishedAt };
    database.prepare('INSERT INTO startup_context_reviews(id, payload) VALUES (?, ?)').run(event.id, JSON.stringify(event));
    database.prepare('UPDATE startup_context_completions SET event_id=? WHERE event_id IS NULL').run(event.id);
    return event;
  });
}

export function pendingStartupContextRunIds(database: DatabaseSync): readonly string[] {
  schema(database);
  return database.prepare('SELECT run_id FROM startup_context_completions WHERE event_id IS NULL ORDER BY sequence').all().map(row => row.run_id as string);
}

export function listStartupContextReviewEvents(database: DatabaseSync): readonly StartupContextDueEvent[] {
  schema(database);
  return database.prepare('SELECT payload FROM startup_context_reviews ORDER BY rowid').all().map(row => JSON.parse(row.payload as string));
}

export function bindStartupContextReview(database: DatabaseSync, input: { readonly eventId: string; readonly reviewRunId: string; readonly phase: 'context-review' }): void {
  schema(database);
  atomic(database, () => {
    if (input.phase !== 'context-review' || !input.reviewRunId.trim()) throw new Error('A context-review run is required');
    const row = database.prepare('SELECT review_run_id, closed_at FROM startup_context_reviews WHERE id=?').get(input.eventId);
    if (!row || row.closed_at !== null || row.review_run_id !== null && row.review_run_id !== input.reviewRunId) throw new Error('Unknown, closed or already bound startup context review');
    database.prepare('UPDATE startup_context_reviews SET review_run_id=? WHERE id=?').run(input.reviewRunId, input.eventId);
  });
}

export function closeStartupContextReview(database: DatabaseSync, input: { readonly reviewRunId: string; readonly closedAt: string }): void {
  schema(database);
  if (!Number.isFinite(Date.parse(input.closedAt))) throw new Error('Invalid startup context review close time');
  database.prepare('UPDATE startup_context_reviews SET closed_at=COALESCE(closed_at, ?) WHERE review_run_id=?').run(input.closedAt, input.reviewRunId);
}

export function settleStartupContextReview(database: DatabaseSync, input: { readonly reviewRunId: string; readonly status: string; readonly finishedAt: string }): void {
  schema(database);
  if (input.status === 'succeeded') closeStartupContextReview(database, { reviewRunId: input.reviewRunId, closedAt: input.finishedAt });
  else database.prepare('UPDATE startup_context_reviews SET review_run_id=NULL WHERE review_run_id=? AND closed_at IS NULL').run(input.reviewRunId);
}

export function pruneStartupContextTraces(database: DatabaseSync, input: { readonly now: string; readonly flowPath: string }): readonly string[] {
  schema(database);
  if (!database.prepare('SELECT 1 FROM startup_context_traces LIMIT 1').get()) return [];
  const retention = policyNumber(input.flowPath, 'retention', 'finishedSessionsMs');
  if (!Number.isFinite(Date.parse(input.now))) throw new Error('Invalid startup context retention time');
  const cutoff = Date.parse(input.now) - retention;
  schema(database);
  return atomic(database, () => {
    const protectedIds = new Set(database.prepare('SELECT c.run_id FROM startup_context_completions c LEFT JOIN startup_context_reviews r ON r.id=c.event_id WHERE c.event_id IS NULL OR r.closed_at IS NULL').all().map(row => row.run_id));
    const expired = database.prepare('SELECT run_id, finished_at FROM startup_context_traces WHERE finished_at IS NOT NULL ORDER BY rowid').all().filter(row => !protectedIds.has(row.run_id) && Date.parse(row.finished_at as string) <= cutoff).map(row => row.run_id as string);
    for (const id of expired) database.prepare('DELETE FROM startup_context_traces WHERE run_id=?').run(id);
    return expired;
  });
}
