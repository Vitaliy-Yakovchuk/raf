import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

export interface DatabaseReadQuery {
  readonly queryId: string;
  readonly callsite: string;
  readonly rowsReadLimit?: number;
  readonly justification?: string;
}

export interface DatabaseReadExecution {
  readonly queryId: string;
  readonly callsite: string;
  readonly rowsRead: number;
  readonly limit: number;
  readonly metric: 'SQLITE_STMTSTATUS_FULLSCAN_STEP_AND_RESULT_ROWS';
  readonly fullscanSteps: number;
  readonly returnedRows: number;
}

export interface DatabaseReadLimitError extends Error {
  readonly code: 'DB_ROWS_READ_LIMIT_EXCEEDED';
  readonly queryId: string;
  readonly callsite: string;
  readonly rowsRead: number;
  readonly limit: number;
}

export const DEFAULT_ROWS_READ_LIMIT = 50;
const contexts = new AsyncLocalStorage<ReadonlyMap<DatabaseSync, DatabaseReadQuery>>();
const observers = new AsyncLocalStorage<readonly ((execution: DatabaseReadExecution) => void)[]>();
const guarded = new WeakSet<DatabaseSync>();

export function assertRowsRead(query: DatabaseReadQuery, actual: number): void {
  const limit = query.rowsReadLimit ?? DEFAULT_ROWS_READ_LIMIT;
  if (limit !== DEFAULT_ROWS_READ_LIMIT && !query.justification?.trim()) throw new Error(`Missing rows read justification: ${query.queryId}`);
  if (actual > limit) throw Object.assign(new Error(`DB_ROWS_READ_LIMIT_EXCEEDED: ${query.queryId} at ${query.callsite}: ${actual} > ${limit}`), {
    code: 'DB_ROWS_READ_LIMIT_EXCEEDED', queryId: query.queryId, callsite: query.callsite, rowsRead: actual, limit,
  });
}

function describe(sql: string): DatabaseReadQuery {
  const callsite = new Error().stack?.split('\n').find(line => !line.includes('database-read-limit.ts') && !line.includes('Error'))?.trim() ?? 'raf:sqlite';
  return { queryId: `sqlite:${createHash('sha256').update(sql).digest('hex').slice(0, 16)}`, callsite };
}

export function guardDatabase(database: DatabaseSync): DatabaseSync {
  if (guarded.has(database)) return database;
  const prepare = database.prepare.bind(database);
  const probe = prepare('SELECT 1');
  if (typeof probe.stat !== 'function' || typeof probe.resetStats !== 'function') throw new Error('SQLite read guard requires StatementSync.stat/resetStats (Node >=26.8)');
  probe.close();
  const wrap = (statement: StatementSync, query: DatabaseReadQuery): StatementSync => {
    const all = statement.all.bind(statement);
    const get = statement.get.bind(statement);
    const run = statement.run.bind(statement);
    const check = (returnedRows: number, description: DatabaseReadQuery) => {
      const fullscanSteps = statement.stat('fullscanStep');
      const rowsRead = Math.max(returnedRows, fullscanSteps + 1);
      const execution: DatabaseReadExecution = { ...description, rowsRead, limit: description.rowsReadLimit ?? DEFAULT_ROWS_READ_LIMIT,
        metric: 'SQLITE_STMTSTATUS_FULLSCAN_STEP_AND_RESULT_ROWS', fullscanSteps, returnedRows };
      for (const observer of observers.getStore() ?? []) observer(execution);
      assertRowsRead(description, rowsRead);
    };
    const description = () => contexts.getStore()?.get(database) ?? query;
    statement.all = (...args) => {
      const query = description();
      statement.resetStats();
      const result = all(...args);
      check(result.length, query);
      return result;
    };
    statement.get = (...args) => {
      const query = description();
      statement.resetStats();
      const result = get(...args);
      check(result === undefined ? 0 : 1, query);
      return result;
    };
    statement.run = (...args) => {
      const query = description();
      statement.resetStats();
      const result = run(...args);
      check(0, query);
      return result;
    };
    statement.iterate = (...args) => statement.all(...args).values();
    return statement;
  };
  database.prepare = (sql, ...options) => wrap(prepare(sql, ...options), describe(sql));
  database.exec = (sql: string) => {
    let remaining = sql;
    for (;;) {
      remaining = remaining.replace(/^(?:\s|;|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, '');
      if (!remaining) break;
      const statement = database.prepare(remaining);
      const consumed = statement.sourceSQL.length;
      try { statement.setReadBigInts(true); statement.all(); } finally { statement.close(); }
      remaining = remaining.slice(consumed);
    }
  };
  database.createTagStore = (maxSize = 1000) => {
    const cache = new Map<string, StatementSync>();
    const invoke = (method: 'all' | 'get' | 'run' | 'iterate', strings: TemplateStringsArray, args: unknown[]) => {
      const sql = strings.join('?');
      let statement = cache.get(sql);
      if (!statement) {
        statement = database.prepare(sql);
        if (cache.size >= maxSize) { const first = cache.keys().next().value; if (first !== undefined) { cache.get(first)!.close(); cache.delete(first); } }
        cache.set(sql, statement);
      }
      return statement[method](...args as never[]);
    };
    return { get db() { return database; }, get size() { return cache.size; }, capacity: maxSize,
      clear() { for (const statement of cache.values()) statement.close(); cache.clear(); },
      all: (strings, ...args) => invoke('all', strings, args), get: (strings, ...args) => invoke('get', strings, args),
      run: (strings, ...args) => invoke('run', strings, args), iterate: (strings, ...args) => invoke('iterate', strings, args),
    } as ReturnType<DatabaseSync['createTagStore']>;
  };
  guarded.add(database);
  return database;
}

export function withDatabaseReadQuery<T>(database: DatabaseSync, query: DatabaseReadQuery, action: () => T): T {
  guardDatabase(database);
  const next = new Map(contexts.getStore());
  next.set(database, query);
  return contexts.run(next, action);
}

export function observeDatabaseReads<T>(action: () => T, observer: (execution: DatabaseReadExecution) => void): T {
  return observers.run([...(observers.getStore() ?? []), observer], action);
}

export function* iterateDatabaseTable(database: DatabaseSync, table: string, after?: number | bigint): Generator<Record<string, any>> {
  guardDatabase(database);
  const identifier = table.replaceAll('"', '""');
  for (;;) {
    const statement = database.prepare(`SELECT rowid AS __raf_page_rowid, * FROM "${identifier}" ${after === undefined ? '' : 'WHERE rowid > ?'} ORDER BY rowid LIMIT 50`);
    let page;
    try { page = after === undefined ? statement.all() : statement.all(after); } finally { statement.close(); }
    for (const row of page) { after = row.__raf_page_rowid as number | bigint; const { __raf_page_rowid, ...value } = row; yield value; }
    if (page.length < 50) return;
  }
}

export function readDatabaseTable(database: DatabaseSync, table: string): Record<string, any>[] {
  return [...iterateDatabaseTable(database, table)];
}
