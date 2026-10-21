import { runServiceEntry } from '../src/service-entry.ts';

try {
  const host = await runServiceEntry();
  await host.closed;
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
}
