import { createInterface } from 'node:readline';
import { Writable, type Readable } from 'node:stream';
import { commandFailure } from './cli-contract.ts';
import type { Handler } from './cli.ts';
import { openSecretsStore, SecretsStoreError, type SecretsStoreOptions } from './secrets-store.ts';

type SecretInput = Readable & { isTTY?: boolean };

export async function readSecretValue(input: SecretInput = process.stdin, output: Writable = process.stderr): Promise<string> {
  if (!input.isTTY) {
    input.setEncoding('utf8');
    let value = '';
    for await (const chunk of input) value += chunk;
    return value.replace(/\r?\n$/, '');
  }
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const reader = createInterface({ input, output: muted, terminal: true, historySize: 0 });
  try {
    return await new Promise<string>((resolve, reject) => {
      reader.once('close', () => reject(new Error('Secret input cancelled.')));
      reader.once('SIGINT', () => reader.close());
      reader.question('', resolve);
    });
  } finally {
    reader.close();
    muted.destroy();
  }
}

export function createSecretHandlers(options: SecretsStoreOptions & { input?: SecretInput } = {}): Record<'secret set' | 'secret list', Handler> {
  const safe = (action: Handler): Handler => async params => {
    try { return await action(params); }
    catch (error) {
      const known = error instanceof SecretsStoreError;
      throw commandFailure({ code: 'HANDLER_FAILED', message: known ? error.message : 'Secret command failed.',
        stage: 'handler', source: 'secrets-store', sourceCode: known ? error.code : 'io-error', reason: null,
        received: null, expected: null, found: null, completed: [], pending: [], retrySafe: null,
        remediation: [known ? error.remediation : 'Перевірте доступність сховища та повторіть ввід.'] });
    }
  };
  return {
    'secret set': safe(async params => {
      const value = await readSecretValue(options.input);
      const store = await openSecretsStore(options);
      return store.set({ name: params.name as string, kind: 'env', value, source: (params.source as string | undefined) ?? 'owner', updatedAt: options.now?.() ?? new Date().toISOString() }, params.replace === true);
    }),
    'secret list': safe(async () => (await (await openSecretsStore(options)).list()).map(({ name, kind, source, updatedAt }) => ({ name, kind, source, updatedAt }))),
  };
}
