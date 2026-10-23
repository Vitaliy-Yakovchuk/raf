import { captureStartupContext, type StartupContextCapture, type StartupContextTrace } from './startup-context.ts';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export type StartupContextRunner = 'claude' | 'codex';

export interface StartupContextJournal {
  readonly events: StartupContextCapture['events'];
  readonly unavailableReason: string | null;
}

export interface StartupContextJournalRequest {
  readonly runner: StartupContextRunner;
  readonly runnerSessionId: string;
  readonly homeDirectory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export interface StartupContextJournalFilePorts {
  findFiles(pattern: string): Promise<readonly string[]>;
  readText(path: string): Promise<string>;
}

export function normalizeStartupContextJournal(input: {
  readonly runner: StartupContextRunner;
  readonly version: string;
  readonly lines: readonly string[];
}): StartupContextJournal {
  if (!['claude', 'codex'].includes(input.runner) || input.version !== (input.runner === 'claude' ? '2.1.308' : '0.163.0')) return { events: [], unavailableReason: 'Unsupported native journal dialect' };
  const events: Record<string, unknown>[] = [];
  const metadata: Record<string, unknown> = {};
  const record = (value: any): Record<string, any> => value && typeof value === 'object' ? value : {};
  const append = (key: string, values: unknown) => {
    if (Array.isArray(values)) metadata[key] = [...(metadata[key] as unknown[] ?? []), ...values];
  };
  for (const line of input.lines) {
    let row: Record<string, any>;
    try { row = record(JSON.parse(line)); } catch { continue; }
    if (row.isSidechain === true) continue;
    if (input.runner === 'claude') {
      if (row.type === 'attachment') {
        const attachment = record(row.attachment);
        if (attachment.type === 'instructions') append('instructions', attachment.files);
        if (attachment.type === 'skill_listing') append('skills', attachment.names);
        if (attachment.type === 'mcp_instructions_delta') append('mcp_servers', attachment.addedNames);
        if (attachment.type === 'prompt_snapshot' && typeof attachment.systemPrompt === 'string') metadata.system_prompt = attachment.systemPrompt;
      } else if (row.type === 'assistant' || row.type === 'user') events.push(row);
    } else {
      const payload = record(row.payload);
      if (row.type === 'session_meta' && typeof payload.base_instructions?.text === 'string') metadata.system_prompt = payload.base_instructions.text;
      if (row.type === 'response_item' && payload.type === 'message' && ['developer', 'user'].includes(payload.role)) {
        for (const block of Array.isArray(payload.content) ? payload.content : []) {
          const content = typeof block.text === 'string' ? block.text : '';
          for (const match of content.matchAll(/^- ([^:\n]+):[^\n]*\(file: ([^)]+)\)/gm)) append('skills', [{ name: match[1], path: match[2] }]);
          for (const match of content.matchAll(/# (?:AGENTS\.md instructions for|Instructions for) ([^\n]+)/g)) append('instructions', [{ name: 'AGENTS.md', path: match[1].trim().replace(/\/$/, '') + '/AGENTS.md' }]);
          for (const match of content.matchAll(/<instructions(?:\s+[^>]*)?>([\s\S]*?)<\/instructions>/g)) {
            if (!metadata.instructions) append('instructions', [{ name: 'AGENTS.md', description: match[1] }]);
          }
        }
      }
      if (row.type === 'event_msg' && payload.type === 'item_completed') {
        const item = record(payload.item);
        const types: Record<string, string> = { CommandExecution: 'command_execution', FileChange: 'file_change', AgentMessage: 'agent_message', Extension: 'mcp_tool_call' };
        if (types[item.type]) events.push({ type: 'item.completed', item: { ...item, type: types[item.type] } });
      }
      if (row.type === 'event_msg' && payload.type === 'token_count') events.push(row);
    }
  }
  if (Object.keys(metadata).length) events.unshift({ type: 'session.configured', autoloaded: metadata });
  return { events, unavailableReason: null };
}

export async function collectStartupContextJournal(
  input: StartupContextJournalRequest,
  ports?: StartupContextJournalFilePorts,
): Promise<StartupContextJournal> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(input.runnerSessionId)) return { events: [], unavailableReason: 'Native runner session identity is missing or invalid' };
  const root = input.runner === 'claude' ? join(input.environment.CLAUDE_CONFIG_DIR || join(input.homeDirectory, '.claude'), 'projects') : join(input.environment.CODEX_HOME || join(input.homeDirectory, '.codex'), 'sessions');
  const pattern = input.runner === 'claude' ? join(root, '*', `${input.runnerSessionId}.jsonl`) : join(root, '*', '*', '*', `rollout-*-${input.runnerSessionId}.jsonl`);
  const files = ports ?? {
    findFiles: async (glob: string) => { const matches: string[] = []; for await (const path of fs.glob(glob)) matches.push(path); return matches; },
    readText: (path: string) => fs.readFile(path, 'utf8'),
  };
  let matches: readonly string[];
  try { matches = await files.findFiles(pattern); } catch { return { events: [], unavailableReason: 'Native session journal lookup failed' }; }
  if (matches.length !== 1) return { events: [], unavailableReason: matches.length ? 'Multiple native session journals match runnerSessionId' : 'Native session journal not found for runnerSessionId' };
  let content: string;
  try { content = await files.readText(matches[0]); } catch { return { events: [], unavailableReason: 'Native session journal could not be read' }; }
  return normalizeStartupContextJournal({ runner: input.runner, version: input.runner === 'claude' ? '2.1.308' : '0.163.0', lines: content.split(/\r?\n/) });
}

export function captureStartupContextJournal(
  input: Omit<StartupContextCapture, 'events'> & { readonly journal: StartupContextJournal },
  ports: { estimateTokens(text: string): number },
): StartupContextTrace {
  const trace = captureStartupContext({ ...input, events: input.journal.events }, ports);
  if (!input.journal.unavailableReason) return trace;
  const unavailable = { value: null, reason: input.journal.unavailableReason };
  return { ...trace, reads: [], autoloaded: { systemPrompt: unavailable, instructions: unavailable, skills: unavailable, mcpServers: unavailable, memory: unavailable }, tokens: { startupInput: unavailable, totalInput: unavailable, cacheReadInput: unavailable, cacheWriteInput: unavailable } };
}

export function startupContextRunnerEnvironment(
  runner: string,
  inherited: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return { ...inherited, ...(runner === 'claude' ? { CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' } : {}) };
}
