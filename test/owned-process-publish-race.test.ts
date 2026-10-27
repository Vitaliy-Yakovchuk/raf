import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/production-runtime.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('production-runtime.ts', source, ts.ScriptTarget.Latest, true);
let publication = '';
function visit(node: ts.Node): void {
  if (ts.isBlock(node)) {
    const statements = [...node.statements];
    const named = (statement: ts.Statement, name: string) => ts.isVariableStatement(statement)
      && statement.declarationList.declarations.some(declaration => declaration.name.getText(tree) === name);
    const start = statements.findIndex(statement => named(statement, 'ownedProcessPath'));
    const end = statements.findIndex(statement => named(statement, 'emptyComposer'));
    if (start >= 0 && end > start) publication = statements.slice(start, end).map(statement => statement.getText(tree)).join('\n');
  }
  ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(publication, 'Production worker publication entry exists');
const program = ts.transpileModule(`${publication}\nglobalThis.publish = publishOwnedProcess;`, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
}).outputText;

const workerFixture = `
const files = new Map();
const diagnostics = [];
let writes = 0, renames = 0;
const fs = {
  writeFile: async (path, contents, options) => {
    if (options.mode !== 0o600) throw new Error('Publication must remain private');
    if (++writes === 1) await new Promise(resolve => queueMicrotask(() => queueMicrotask(resolve)));
    files.set(path, contents);
  },
  rename: async (from, to) => {
    if (++renames === 1 && globalThis.failFirstRename) throw Object.assign(new Error('injected publication failure'), { code: 'EIO' });
    if (!files.has(from)) throw Object.assign(new Error('ENOENT: rename ' + from), { code: 'ENOENT' });
    files.set(to, files.get(from));
    files.delete(from);
  },
};
const context = vm.createContext({
  fs, deferred: true, process: { pid: 123, stderr: { write: value => diagnostics.push(value) } },
  session: { launchContext: { reportPath: '/unit/run/report.json' } }, request: { runId: 'unit-run' },
  join: (...parts) => parts.join('/'), dirname: path => path.slice(0, path.lastIndexOf('/')),
});
vm.runInContext(${JSON.stringify(program)}, context);
const pending = { pid: 456, runner: 'agy', runnerSessionId: null, nativeIdentity: { state: 'pending', id: null } };
const latest = { ...pending, runnerSessionId: 'conversation-id', nativeIdentity: { state: 'confirmed', id: 'conversation-id' } };
`;

test('owned process publication: parallel calls publish the latest identity without ENOENT', async () => {
  const context = vm.createContext({ vm, queueMicrotask });
  vm.runInContext(`${workerFixture}\nglobalThis.result = (async () => {
    const results = await Promise.allSettled([context.publish(pending), context.publish(latest)]);
    return { errors: results.filter(row => row.status === 'rejected').map(row => String(row.reason)),
      identity: JSON.parse(files.get('/unit/run/owned-process.json')), latest, diagnostics };
  })();`, context);
  const result = JSON.parse(JSON.stringify(await context.result));
  assert.deepEqual(result.errors, [], 'Concurrent publication must not reject');
  assert.deepEqual(result.identity, result.latest, 'An older write must not replace the latest identity');
  assert.deepEqual(result.diagnostics, []);
});

for (const failFirstRename of [false, true]) {
  test(`owned process publication: fire-and-forget calls keep the worker alive (write failure=${failFirstRename})`, () => {
    const script = `import vm from 'node:vm';
globalThis.failFirstRename = ${failFirstRename};
${workerFixture}
void context.publish(pending);
${failFirstRename ? 'await new Promise(resolve => setImmediate(resolve));' : ''}
void context.publish(latest);
await new Promise(resolve => setImmediate(resolve));
console.log(JSON.stringify({ alive: true, identity: JSON.parse(files.get('/unit/run/owned-process.json')), latest, diagnostics }));`;
    const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(child.status, 0, `Worker must survive publication: ${child.stderr}`);
    assert.equal(child.signal, null);
    const result = JSON.parse(child.stdout);
    assert.equal(result.alive, true);
    assert.deepEqual(result.identity, result.latest);
    if (failFirstRename) assert.match(result.diagnostics.join('\n'), /unit-run.*injected publication failure/);
    else assert.deepEqual(result.diagnostics, []);
  });
}
