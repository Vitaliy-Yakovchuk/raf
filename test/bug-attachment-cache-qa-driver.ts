import { fileURLToPath } from 'node:url';
import { runProductionCli } from '../src/production-entry.ts';

const [orchestratorRoot, homeDirectory, ...argv] = process.argv.slice(2);
const result = await runProductionCli(argv, {
  orchestratorRoot: orchestratorRoot!,
  homeDirectory: homeDirectory!,
  artifactPath: fileURLToPath(new URL('../dist/catalog.json', import.meta.url)),
});
if (result.stdout) process.stdout.write(result.stdout + '\n');
if (result.stderr) process.stderr.write(result.stderr + '\n');
process.exitCode = result.exitCode;
