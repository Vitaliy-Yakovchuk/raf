export function nativeUserInputs(events) {
  return events.flatMap(event => {
    const payload = event.payload;
    if (event.type === 'event_msg' && payload?.type === 'user_message' && typeof payload.message === 'string') return [payload.message];
    if (event.type !== 'response_item' || payload?.type !== 'message' || payload.role !== 'user' || !Array.isArray(payload.content) || !payload.content.length) return [];
    if (!payload.content.every(part => part?.type === 'input_text' && typeof part.text === 'string')) return [];
    return [payload.content.map(part => part.text).join('')];
  });
}

export function agentMessageCommand(prefix, to, text) {
  const q = value => "'" + value.replaceAll("'", "'" + String.fromCharCode(92) + "''") + "'";
  return prefix + ' agent message --to ' + q(to) + ' --text ' + q(text);
}
