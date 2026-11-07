import type { DatabaseSync } from 'node:sqlite';

export function* iterateDatabaseTable(database: DatabaseSync, table: string, after?: number | bigint): Generator<Record<string, any>> {
  const identifier = table.replaceAll('"', '""');
  for (;;) {
    const statement = database.prepare(`SELECT rowid AS __raf_page_rowid, * FROM "${identifier}" ${after === undefined ? '' : 'WHERE rowid > ?'} ORDER BY rowid LIMIT 50`);
    let page;
    try {
      page = after === undefined ? statement.all() : statement.all(after);
    } finally {
      statement.close();
    }
    for (const row of page) {
      after = row.__raf_page_rowid as number | bigint;
      const { __raf_page_rowid, ...value } = row;
      yield value;
    }
    if (page.length < 50) return;
  }
}

export function readDatabaseTable(database: DatabaseSync, table: string): Record<string, any>[] {
  return [...iterateDatabaseTable(database, table)];
}
