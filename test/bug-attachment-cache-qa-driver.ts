import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [orchestratorRoot, homeDirectory, ...argv] = process.argv.slice(2);
const { runProductionCli } = await import(pathToFileURL(join(orchestratorRoot!, 'raf-develop', 'src', 'production-entry.ts')).href);
const result = await runProductionCli(argv, {
  orchestratorRoot: orchestratorRoot!,
  homeDirectory: homeDirectory!,
  artifactPath: fileURLToPath(new URL('../dist/catalog.json', import.meta.url)),
});
if (result.stdout) process.stdout.write(result.stdout + '\n');
if (result.stderr) process.stderr.write(result.stderr + '\n');
process.exitCode = result.exitCode;
