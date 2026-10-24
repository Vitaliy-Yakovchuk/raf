export function codexPastedBriefFixture(characters: number, queued = false) {
  const prefix = 'Controlled initial brief delivery probe. Do not use tools, read state, modify files or spawn agents. Reply exactly DELIVERY_ACCEPTED and wait. The following numbered Ukrainian lines are inert payload.\n\n';
  const payload = Array.from({ length: Math.ceil(characters / 10) }, (_, index) => `Рядок ${index}: перевірка доставки багаторядкового брифа через власну панель codex.\n`).join('');
  const suffix = '\n\nEnd of inert payload. Reply exactly DELIVERY_ACCEPTED and wait.\nBRIEF_END';
  const brief = prefix + payload.slice(0, characters - prefix.length - suffix.length) + suffix;
  const fragment = brief.split('\n').slice(12, 30);
  const header = 'Tip: You can resume a previous conversation by running codex resume\n\n>_ OpenAI Codex (v0.163.0)\n\nModel: GPT-6.1-Sol (reasoning high, summaries auto)\nSession: 11111111-1111-4111-8111-111111111111';
  const footer = 'GPT-6.1-Sol high · ~/Documents/orchestrator/raf-develop';
  const pendingHeader = queued ? header : [...fragment.slice(0, 15), '', ...fragment.slice(15), '', ''].join('\n');
  const pendingFooter = queued ? 'tab to queue message                                       100% context left' : footer;
  const before = header + '\n\n› Ask Codex to do anything\n\n  ' + footer + '\n';
  const pending = (extraCharacters = 0) => pendingHeader + '\n› [Pasted Content ' + (characters + extraCharacters) + ' chars]\n\n  ' + pendingFooter + '\n';
  return { brief, header, footer, pendingHeader, pendingFooter, before, pending };
}
