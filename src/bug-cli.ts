import { commandFailure, failureContext, type CommandFailureContext } from './cli-contract.ts';
import type { Handler } from './cli.ts';
import { BugStoreError, type BugRepository, type BugView } from './bug-store.ts';
import { AttachmentCacheError, type AttachmentCache } from './bug-attachment-cache.ts';
import { BugSyncConfigError, ClaimsError, type BugSyncConfig, type BugWriter, type ClaimsIssuer } from './bug-sync.ts';

export type BugCommand = 'bug list' | 'bug show' | 'bug comment add' | 'bug status set' | 'bug attachment get';

export const bugCommands: readonly BugCommand[] = ['bug list', 'bug show', 'bug comment add', 'bug status set', 'bug attachment get'];

export interface BugCommandPorts {
  loadConfig(): BugSyncConfig;
  openRepository(config: BugSyncConfig): BugRepository;
  claims(config: BugSyncConfig): Promise<ClaimsIssuer>;
  openCache(repository: BugRepository, config: BugSyncConfig, claims: ClaimsIssuer): AttachmentCache;
  writer(repository: BugRepository, config: BugSyncConfig, claims: ClaimsIssuer): BugWriter;
  readText(file: string): Promise<Uint8Array>;
  now(): Date;
}

type Facts = Partial<Omit<CommandFailureContext, 'code' | 'message'>>;

const storeCodes: Readonly<Record<string, string>> = {
  'invalid-bug-key': 'INVALID_BUG_KEY', 'bug-not-found': 'BUG_NOT_FOUND', 'ambiguous-bug': 'AMBIGUOUS_BUG', 'invalid-comment': 'INVALID_COMMENT',
  'unknown-section': 'BUG_SECTION_UNKNOWN', 'unsupported-version': 'BUG_STORE_UNSUPPORTED_VERSION', 'unsafe-path': 'BUG_STORE_UNSAFE_PATH',
  'operation-not-found': 'OPERATION_NOT_FOUND',
};

const storeRemedies: Readonly<Record<string, readonly string[]>> = {
  'invalid-bug-key': ['Передайте повний канонічний ключ у формі projects/<проєкт>/bug#<номер>, наприклад projects/etchly/bug#344.'],
  'bug-not-found': ['Перевірте ключ у raf bug list; якщо жук щойно створено на сервері, дочекайтеся синхронізації службою raf.'],
  'ambiguous-bug': ['Ключ відповідає кільком жукам різних розділів; уточніть проєкт у ключі або перегляньте кандидатів у details.found.'],
  'invalid-comment': ['Перевірте текст коментаря: непорожній UTF-8 у межах обмежень bugs-api.'],
  'unknown-section': ['Розділ жука відсутній у conf/raf.json#/bugs/sections; зверніться до main щодо конфігурації розділів.'],
  'unsupported-version': ['База жуків створена новішою версією raf; оновіть raf-develop і повторіть команду.'],
  'unsafe-path': ['Виправте conf/raf.json#/bugs/fileName: лише назва файла всередині ~/.raf.'],
  'operation-not-found': ['Перевірте ідентифікатор операції в raf bug show.'],
};

const cacheRemedies: Readonly<Record<string, readonly string[]>> = {
  ATTACHMENT_NOT_FOUND: ['Перевірте ID вкладення в raf bug show --bug <ключ>; видалене або відсутнє на сервері вкладення не видається.'],
  ATTACHMENT_ACCESS_DENIED: ['Сервер відмовив у доступі; перевірте права розділу та секрет у ~/.raf/secrets.json, потім повторіть.'],
  ATTACHMENT_SECTION_UNAVAILABLE: ['Перевірте розділ жука в conf/raf.json#/bugs/sections і наявність його секрету в ~/.raf/secrets.json.'],
  ATTACHMENT_INTEGRITY_FAILED: ['Отримані байти не збіглися з розміром чи SHA-256 метаданих; повторіть пізніше або дочекайтеся нової синхронізації метаданих.'],
  ATTACHMENT_FETCH_FAILED: ['Сервер чи мережа тимчасово недоступні; повторіть команду пізніше.'],
  ATTACHMENT_TOO_LARGE: ['Вкладення не вміщується в бюджет conf/raf.json#/bugs/attachmentCacheMaxBytes; збільшення бюджету — рішення main.'],
};

function failure(code: string, message: string, facts: Facts = {}): Error {
  return commandFailure({
    code, message, stage: 'bug', source: 'bug-cli', sourceCode: null, reason: message,
    received: null, expected: null, found: null, completed: [], pending: [], retrySafe: true,
    remediation: ['Виправте причину та повторіть команду.'], ...facts,
  });
}

function translate(error: unknown, stage: string, completed: readonly string[]): Error {
  if (failureContext(error)) return error as Error;
  if (error instanceof BugStoreError) {
    return failure(storeCodes[error.code] ?? 'BUG_STORE_FAILED', error.message, {
      stage, source: 'bug-store', sourceCode: error.code, found: error.details, completed, retrySafe: true,
      remediation: storeRemedies[error.code] ?? ['Перевірте стан бази жуків і повторіть команду.'],
    });
  }
  if (error instanceof AttachmentCacheError) {
    return failure(error.code, error.message, {
      stage, source: 'bug-attachment-cache', sourceCode: error.code, completed, retrySafe: true,
      remediation: cacheRemedies[error.code] ?? ['Повторіть команду пізніше.'],
    });
  }
  if (error instanceof BugSyncConfigError) {
    return failure('BUG_CONFIG_INVALID', error.message, {
      stage: 'config', source: 'conf/raf.json', sourceCode: error.field, received: error.field, completed, retrySafe: false,
      remediation: [`Виправте conf/raf.json#/bugs (${error.field}) і повторіть команду.`],
    });
  }
  if (error instanceof ClaimsError) {
    return failure('BUG_SECTION_UNAVAILABLE', error.message, {
      stage, source: 'bug-sync', sourceCode: error.code, received: error.sectionId, completed, retrySafe: true,
      remediation: ['Перевірте секрет розділу в ~/.raf/secrets.json (raf secrets import-conductor).'],
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return failure('BUG_COMMAND_FAILED', `Команда bug завершилась помилкою: ${message}`, {
    stage, source: 'bug-cli', reason: message, completed, retrySafe: null,
    remediation: ['Перевірте фактичний стан у raf bug show перед повторним викликом.'],
  });
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined;
}

function pageLimit(value: unknown, config: BugSyncConfig): number {
  if (value === undefined) return config.pageLimit;
  const raw = String(value);
  const parsed = /^[1-9][0-9]*$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed > config.pageLimit) {
    throw failure('INVALID_VALUE', `--limit має бути цілим числом від 1 до ${config.pageLimit} (conf/raf.json#/bugs/pageLimit).`, {
      stage: 'arguments', received: raw, expected: `1..${config.pageLimit}`, retrySafe: true,
      remediation: [`Передайте --limit від 1 до ${config.pageLimit} або пропустіть параметр.`],
    });
  }
  return parsed;
}

function decodeComment(bytes: Uint8Array, file: string): string {
  let decoded: string;
  try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); }
  catch {
    throw failure('COMMENT_TEXT_INVALID', 'Текст коментаря не є коректним UTF-8.', {
      stage: 'arguments', received: file, expected: 'UTF-8', retrySafe: true,
      remediation: ['Збережіть текст коментаря в кодуванні UTF-8 і повторіть команду.'],
    });
  }
  if (!decoded.trim()) {
    throw failure('COMMENT_TEXT_EMPTY', 'Текст коментаря порожній.', {
      stage: 'arguments', received: file, expected: 'непорожній текст', retrySafe: true,
      remediation: ['Передайте у --text-file файл із текстом коментаря або - для stdin.'],
    });
  }
  return decoded;
}

function bugPk(repository: BugRepository, bug: BugView): number {
  const key = bug.serverKey;
  const row = repository.database.prepare('SELECT bug_pk FROM bugs WHERE project = ? AND env = ? AND source = ? AND owner = ? AND raw_id = ?')
    .get(key.project, key.env, key.source, key.owner, key.rawId) as { bug_pk: number | bigint } | undefined;
  if (!row) throw new BugStoreError('bug-not-found', `Жук ${bug.key} зник із локальної бази під час команди.`);
  return Number(row.bug_pk);
}

export function createBugHandlers(ports: BugCommandPorts): Record<BugCommand, Handler> {
  const session = async <T>(stage: string, action: (repository: BugRepository, config: BugSyncConfig, completed: string[]) => Promise<T> | T): Promise<T> => {
    const completed: string[] = [];
    let repository: BugRepository | undefined;
    try {
      const config = ports.loadConfig();
      repository = ports.openRepository(config);
      return await action(repository, config, completed);
    } catch (error) {
      throw translate(error, stage, completed);
    } finally {
      repository?.close();
    }
  };
  return {
    'bug list': params => session('list', (repository, config) => {
      const limit = pageLimit(params.limit, config);
      const page = repository.listBugs({
        ...(text(params.project) ? { canonicalProject: text(params.project) } : {}),
        ...(text(params.status) ? { status: text(params.status) } : {}),
        cursor: text(params.cursor) ?? null,
        limit,
      });
      return { source: 'local', bugs: page.bugs, nextCursor: page.nextCursor, sync: page.sync };
    }),
    'bug show': params => session('show', repository => ({ source: 'local', bug: repository.findBug(String(params.bug)) })),
    'bug comment add': params => session('comment', async (repository, config, completed) => {
      const file = String(params['text-file']);
      let bytes: Uint8Array;
      try { bytes = await ports.readText(file); }
      catch (error) {
        throw failure('COMMENT_TEXT_UNREADABLE', `Не вдалося прочитати текст коментаря з ${file === '-' ? 'stdin' : file}.`, {
          stage: 'arguments', received: file, reason: error instanceof Error ? error.message : String(error), retrySafe: true,
          remediation: ['Перевірте шлях і права читання файла або передайте текст через stdin із --text-file -.'],
        });
      }
      const body = decodeComment(bytes, file);
      const bug = repository.findBug(String(params.bug));
      const section = repository.sections().find(item => item.sectionId === bug.sectionId);
      if (!section) throw new BugStoreError('unknown-section', `Розділ ${bug.sectionId} жука ${bug.key} відсутній у локальній базі жуків.`, { sectionId: bug.sectionId });
      const claims = await ports.claims(config);
      const receipt = repository.addLocalComment({
        bugKey: bug.key, text: body, authorId: config.actor, authorKind: 'agent',
        claimsFingerprint: claims.fingerprint(section, 'write'), at: ports.now().toISOString(),
      });
      completed.push('local-comment');
      return {
        source: 'local', accepted: true, ...receipt, delivered: false, delivery: 'pending',
        notice: 'Коментар і операцію відправлення збережено локально; доставку на сервер виконає служба raf асинхронно. Стан доставки — raf bug show.',
      };
    }),
    'bug status set': async _params => {
      throw new Error('NotImplemented: bug status set');
    },
    'bug attachment get': params => session('attachment', async (repository, config) => {
      const bug = repository.findBug(String(params.bug));
      const claims = await ports.claims(config);
      const cache = ports.openCache(repository, config, claims);
      await cache.reconcile();
      const access = await cache.get({ bugPk: bugPk(repository, bug), serverId: String(params.attachment) });
      return { bug: bug.key, attachment: String(params.attachment), ...access };
    }),
  };
}
