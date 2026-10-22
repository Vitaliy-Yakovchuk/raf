export const nativeSecret = 'DO_NOT_STORE_NATIVE_RESULT_ї';

export const claudeNativeLines = [
  { type: 'attachment', attachment: { type: 'prompt_snapshot', systemPrompt: 'system prompt' } },
  { type: 'attachment', attachment: { type: 'instructions', files: ['/workspace/CLAUDE.md'] } },
  { type: 'attachment', attachment: { type: 'skill_listing', names: ['plan', 'review'], skillCount: 2 } },
  { type: 'attachment', attachment: { type: 'mcp_instructions_delta', addedNames: ['docs'] } },
  { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 120, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 }, content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/workspace/requirements.md' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: nativeSecret }] } },
  { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 120, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 }, content: [] } },
  { type: 'assistant', isSidechain: true, message: { id: 'side', content: [{ type: 'tool_use', id: 'side-read', name: 'Read', input: { file_path: '/sidechain-only' } }] } },
  { type: 'user', isSidechain: true, message: { content: [{ type: 'tool_result', tool_use_id: 'side-read', content: nativeSecret }] } },
  { type: 'assistant', message: { id: 'm2', usage: { input_tokens: 30, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 }, content: [{ type: 'tool_use', id: 'write', name: 'Write', input: { file_path: '/workspace/output.ts', content: nativeSecret } }] } },
  { type: 'assistant', message: { id: 'late', content: [{ type: 'tool_use', id: 'late-read', name: 'Read', input: { file_path: '/after-boundary' } }] } },
  { type: 'unrecognized_native_metadata', content: nativeSecret },
].map(row => JSON.stringify(row));

export const codexNativeLines = [
  { type: 'session_meta', payload: { base_instructions: { text: 'system prompt' } } },
  { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<skills_instructions>\n## Skills\n### Available skills\n- plan: Planning (file: /skills/plan/SKILL.md)\n- review: Reviewing (file: /skills/review/SKILL.md)\n</skills_instructions>' }] } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /workspace\n\n<INSTRUCTIONS>\nRead requirements before editing.\n</INSTRUCTIONS>' }] } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>/workspace</cwd>\n</environment_context>' }] } },
  { type: 'event_msg', payload: { type: 'item_completed', item: { id: 'read', type: 'CommandExecution', command: 'cat /workspace/requirements.md', aggregated_output: nativeSecret } } },
  { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 140, cached_input_tokens: 40 }, last_token_usage: { input_tokens: 140, cached_input_tokens: 40 } } } },
  { type: 'event_msg', payload: { type: 'item_completed', item: { id: 'write', type: 'FileChange', changes: [{ path: '/workspace/output.ts' }] } } },
  { type: 'event_msg', payload: { type: 'item_completed', item: { id: 'late', type: 'CommandExecution', command: 'cat /after-boundary', aggregated_output: nativeSecret } } },
  { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 220, cached_input_tokens: 60 }, last_token_usage: { input_tokens: 80, cached_input_tokens: 20 } } } },
  { type: 'unrecognized_native_metadata', content: nativeSecret },
].map(row => JSON.stringify(row));
