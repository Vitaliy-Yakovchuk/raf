import { runStateMigration } from '../src/state-migration.ts';

process.exitCode = await runStateMigration(process.argv.slice(2));
