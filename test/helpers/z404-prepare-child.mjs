import * as fs from 'node:fs/promises';
import { prepareCodexSandbox } from '../../src/codex-sandbox.ts';

const [inputFile, outputFile] = process.argv.slice(2);
const input = JSON.parse(await fs.readFile(inputFile, 'utf8'));
let prepared;
const record = { accepted: false, workerStarted: false, cleaned: false };
try {
  prepared = await prepareCodexSandbox(input);
  record.accepted = true;
  record.policyPaths = prepared.policyPaths;
} catch (error) {
  record.error = { message: error.message, code: error.code };
} finally {
  try { await prepared?.cleanup(); await prepared?.cleanup(); record.cleaned = true; }
  catch (error) { record.cleanupError = error.message; }
  await fs.writeFile(outputFile, JSON.stringify(record, null, 2) + '\n');
}
