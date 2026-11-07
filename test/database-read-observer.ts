import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export interface DatabaseReadExecution {
  readonly rowsRead: number;
  readonly fullscanSteps: number;
  readonly returnedRows: number;
}

const observers = new AsyncLocalStorage<(execution: DatabaseReadExecution) => void>();
const prepare = DatabaseSync.prototype.prepare;

function recordRead(statement: StatementSync, returnedRows: number): void {
  const fullscanSteps = statement.stat('fullscanStep');
  observers.getStore()?.({ rowsRead: Math.max(returnedRows, fullscanSteps + 1), fullscanSteps, returnedRows });
}

DatabaseSync.prototype.prepare = function (...args) {
  const statement = prepare.apply(this, args);
  const all = statement.all.bind(statement);
  const get = statement.get.bind(statement);
  const run = statement.run.bind(statement);
  statement.all = (...bindings) => {
    if (!observers.getStore()) return all(...bindings);
    statement.resetStats();
    const rows = all(...bindings);
    recordRead(statement, rows.length);
    return rows;
  };
  statement.get = (...bindings) => {
    if (!observers.getStore()) return get(...bindings);
    statement.resetStats();
    const row = get(...bindings);
    recordRead(statement, row === undefined ? 0 : 1);
    return row;
  };
  statement.run = (...bindings) => {
    if (!observers.getStore()) return run(...bindings);
    statement.resetStats();
    const result = run(...bindings);
    recordRead(statement, 0);
    return result;
  };
  return statement;
};

export function observeDatabaseReads<T>(action: () => T, observer: (execution: DatabaseReadExecution) => void): T {
  return observers.run(observer, action);
}
