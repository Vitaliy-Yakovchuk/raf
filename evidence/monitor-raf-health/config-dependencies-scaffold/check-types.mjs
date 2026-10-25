import ts from '../../../node_modules/typescript/lib/typescript.js';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const options = {
  noEmit: true, strict: true, allowImportingTsExtensions: true,
  target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
  typeRoots: ['/usr/share/nodejs/@types'], types: ['node'], skipLibCheck: true,
};
const diagnostics = files => ts.getPreEmitDiagnostics(ts.createProgram(files.map(file => resolve(root, file)), options)).map(diagnostic => ({
  file: diagnostic.file ? relative(root, diagnostic.file.fileName) : null,
  code: diagnostic.code,
  message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
}));
const baseline = diagnostics(['test/helpers/test-run-reservations-fixture.ts']);
const current = diagnostics(['src/test-run-config-dependencies.ts', 'src/test-run-reservations.ts', 'test/test-run-config-dependencies.test.ts']);
const introduced = current.filter(diagnostic => !baseline.some(previous => JSON.stringify(previous) === JSON.stringify(diagnostic)));
const own = current.filter(diagnostic => ['src/test-run-config-dependencies.ts', 'test/test-run-config-dependencies.test.ts'].includes(diagnostic.file));
const status = introduced.length === 0 && own.length === 0 ? 'passed' : 'failed';
console.log(JSON.stringify({ status, mode: 'strict semantic diagnostics compared with existing fixture dependency graph', baseline, current, introduced, own }, null, 2));
process.exitCode = status === 'passed' ? 0 : 1;
