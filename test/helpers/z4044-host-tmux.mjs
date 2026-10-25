import assert from 'node:assert/strict';

export function prepareHostTmuxEndpoint(endpoint, execute) {
  const session = 'z4044-host-control';
  const created = execute(['-S', endpoint, 'new-session', '-d', '-s', session]);
  assert.equal(created.cliExitCode, 0, created.stderr || created.error);
  const result = execute(['-S', endpoint, 'list-sessions']);
  assert.equal(result.cliExitCode, 0, result.stderr || result.error);
  return { endpoint, session };
}
