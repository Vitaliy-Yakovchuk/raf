import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';

class IncompleteSQLiteRead extends Error {}

export function inspectStateSchema(path: string): { version: number; objects: boolean } {
  let deadline: number | undefined;
  let retryDelayMs = 0;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try { return inspectStateSchemaOnce(path); }
    catch (error) {
      if (!(error instanceof IncompleteSQLiteRead)) throw error;
      if (deadline === undefined) {
        const { state: { contention } } = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
        deadline = Date.now() + contention.timeoutMs;
        retryDelayMs = contention.retryDelayMs;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw error;
      Atomics.wait(sleeper, 0, 0, Math.min(retryDelayMs, remaining));
    }
  }
}

function inspectStateSchemaOnce(path: string): { version: number; objects: boolean } {
  const read = (fd: number, size: number, offset: number) => {
    const bytes = Buffer.alloc(size);
    if (readSync(fd, bytes, 0, size, offset) !== size) throw new IncompleteSQLiteRead(`Incomplete SQLite header at ${path}`);
    return bytes;
  };
  const database = openSync(path, 'r');
  let page: Buffer;
  let pageSize: number;
  try {
    if (fstatSync(database).size === 0) return { version: 0, objects: false };
    const header = read(database, 100, 0);
    if (header.toString('ascii', 0, 16) !== 'SQLite format 3\0') throw new Error(`Invalid SQLite header at ${path}`);
    pageSize = header.readUInt16BE(16);
    if (pageSize === 1) pageSize = 65536;
    if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) throw new Error(`Invalid SQLite page size at ${path}`);
    page = read(database, pageSize, 0);
  } finally { closeSync(database); }

  let wal: number;
  try { wal = openSync(`${path}-wal`, 'r'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return schema(page); }
  try {
    const size = fstatSync(wal).size;
    if (size === 0) return schema(page);
    if (size < 32) throw new Error(`Incomplete SQLite WAL at ${path}`);
    const header = read(wal, 32, 0);
    const magic = header.readUInt32BE(0);
    if ((magic !== 0x377f0682 && magic !== 0x377f0683) || header.readUInt32BE(8) !== pageSize) {
      throw new Error(`Invalid SQLite WAL header at ${path}`);
    }
    let first = 0, second = 0;
    const checksum = (bytes: Buffer) => {
      for (let index = 0; index < bytes.length; index += 8) {
        const a = magic === 0x377f0682 ? bytes.readUInt32LE(index) : bytes.readUInt32BE(index);
        const b = magic === 0x377f0682 ? bytes.readUInt32LE(index + 4) : bytes.readUInt32BE(index + 4);
        first = (first + a + second) >>> 0;
        second = (second + b + first) >>> 0;
      }
    };
    checksum(header.subarray(0, 24));
    if (first !== header.readUInt32BE(24) || second !== header.readUInt32BE(28)) throw new Error(`Invalid SQLite WAL checksum at ${path}`);
    let pending = page;
    for (let offset = 32; offset + 24 + pageSize <= size; offset += 24 + pageSize) {
      const frame = read(wal, 24 + pageSize, offset);
      if (!frame.subarray(8, 16).equals(header.subarray(16, 24))) break;
      checksum(frame.subarray(0, 8));
      checksum(frame.subarray(24));
      if (first !== frame.readUInt32BE(16) || second !== frame.readUInt32BE(20)) break;
      const pageNumber = frame.readUInt32BE(0);
      if (pageNumber === 0) break;
      if (pageNumber === 1) pending = frame.subarray(24);
      if (frame.readUInt32BE(4) !== 0) page = pending;
    }
    return schema(page);
  } finally { closeSync(wal); }
}

function schema(page: Buffer): { version: number; objects: boolean } {
  if (page[100] !== 5 && page[100] !== 13) throw new Error('Invalid sqlite_schema root page');
  return { version: page.readUInt32BE(60), objects: page[100] === 5 || page.readUInt16BE(103) !== 0 };
}
