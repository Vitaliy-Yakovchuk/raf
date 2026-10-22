import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openSecretsStore } from './secrets-store.ts';
import { openBugStore, resolveBugStorePath } from './bug-store.ts';
import { createAttachmentCache, loadAttachmentCacheSettings, type AttachmentDownloader } from './bug-attachment-cache.ts';
import { BugSyncConfigError, createBugWriter, createClaimsIssuer, createHttpBugMcp, loadBugSyncConfig } from './bug-sync.ts';
import type { BugCommandPorts } from './bug-cli.ts';

export interface BugProductionOptions {
  readonly orchestratorRoot: string;
  readonly homeDirectory: string;
  readonly fetch?: typeof fetch;
  readonly stdin?: AsyncIterable<Uint8Array>;
}

function retryAfterMs(header: string | null, now: number): number | null {
  if (header === null) return null;
  if (/^[0-9]+$/.test(header.trim())) return Number(header.trim()) * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export function createHttpAttachmentDownloader(fetcher: typeof fetch = globalThis.fetch): AttachmentDownloader {
  return async request => {
    const id = JSON.stringify([request.key.source, request.key.owner, request.key.rawId]);
    const query = new URLSearchParams({ project: request.auth.project, env: request.auth.env });
    const url = `${request.auth.origin.replace(/\/$/, '')}/api/bugs/${encodeURIComponent(id)}/attachments/${encodeURIComponent(request.serverId)}?${query}`;
    const response = await fetcher(url, {
      headers: { authorization: `Bearer ${request.auth.token}`, 'x-bugs-contract-version': '2' },
      signal: request.signal, redirect: 'error', cache: 'no-store', credentials: 'omit',
    });
    if (!response.ok) {
      let code = `http-${response.status}`;
      try {
        const data: unknown = await response.json();
        const error = data && typeof data === 'object' ? (data as Record<string, unknown>).error : undefined;
        if (typeof error === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(error)) code = error;
      } catch { }
      return { ok: false, status: response.status, code, retryAfterMs: retryAfterMs(response.headers.get('retry-after'), Date.now()) };
    }
    if (!response.body) return { ok: false, status: 502, code: 'empty-body', retryAfterMs: null };
    return { ok: true, body: response.body as unknown as AsyncIterable<Uint8Array> };
  };
}

async function readAll(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export function createProductionBugPorts(options: BugProductionOptions): BugCommandPorts {
  const confRoot = join(options.orchestratorRoot, 'conf');
  const rafHome = join(options.homeDirectory, '.raf');
  const configPath = join(confRoot, 'raf.json');
  return {
    loadConfig() {
      let raw: unknown;
      try { raw = JSON.parse(readFileSync(configPath, 'utf8')); }
      catch { throw new BugSyncConfigError('raf.json', `Не вдалося прочитати валідний ${configPath}.`); }
      return loadBugSyncConfig(raw && typeof raw === 'object' ? (raw as Record<string, unknown>).bugs : undefined);
    },
    openRepository: config => openBugStore(resolveBugStorePath(rafHome, config.fileName)),
    claims: async config => createClaimsIssuer({
      secrets: { select: async names => (await openSecretsStore({ home: options.homeDirectory, configPath })).select(names) },
      config, clock: { now: () => new Date() },
    }),
    openCache: (repository, config, claims) => createAttachmentCache({
      database: repository.database, settings: loadAttachmentCacheSettings(confRoot, rafHome), config, claims,
      download: createHttpAttachmentDownloader(options.fetch), now: () => new Date(),
      sleep: ms => new Promise(done => setTimeout(done, ms)),
    }),
    writer: (repository, config, claims) => createBugWriter({
      repository, mcp: createHttpBugMcp({ ...(options.fetch ? { fetch: options.fetch } : {}) }), claims, config, clock: { now: () => new Date() },
    }),
    readText: file => file === '-' ? readAll(options.stdin ?? process.stdin) : readFile(resolve(file)),
    now: () => new Date(),
  };
}
