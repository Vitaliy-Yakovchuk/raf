// Extracted existing QA reader; regression tests precede the repair.
export function nativeUserInputs(events) {
  return events.filter(event => event.type === 'event_msg' && event.payload?.type === 'user_message').map(event => event.payload.message);
}

// Reproduce the actor's observed over-escaped apostrophe before repairing it.
export function agentMessageCommand(prefix, to, text) {
  const q = value => "'" + value.replaceAll("'", "'" + String.fromCharCode(92, 92) + "''") + "'";
  return prefix + ' agent message --to ' + q(to) + ' --text ' + q(text);
}
