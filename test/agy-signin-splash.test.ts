import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { selectNativeLaunchProtocol } from '../src/agy-session-start.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';
import { nextRunnerAction, observeRunnerScreen } from '../src/runner-protocols.ts';

const configuration = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8'));

const CAPTURED_5F301F9C_LAST_SCREEN =
  '\n     ▄▀▀▄\n    ▀▀▀▀▀▀\n   ▀▀▀▀▀▀▀▀\n  ▄▀▀    ▀▀▄\n ▄▀▀      ▀▀▄\n\n Welcome to the Antigravity CLI. You are currently not signed in.\n\n ⣯  Signing in...\n\n\n\n\n\n\n\n\n\n\n\n\n\n';

const AGY_READY_SCREEN = [
  ' ▄▀▀▄        Antigravity CLI 1.4.7',
  ' ▀▀▀▀▀▀▀▀    gemini-4-argon-high (high)',
  '▄▀▀    ▀▀▄   /srv/dev/work/orchestrator/raf-hotfix',
  '',
  '────────────────────────────────────────────────────────────────────────────────',
  '> ',
  '────────────────────────────────────────────────────────────────────────────────',
  '  ? for shortcuts                                         Context Left: 92%',
].join('\n');

const getConfiguredAgySettings = (): ProtocolSettings => {
  const settings = configuration.runnerProtocols.find((row: ProtocolSettings) => row.runner === 'agy');
  assert.ok(settings, 'conf/raf.json must define runnerProtocols entry for agy');
  return settings;
};

test('agy sign-in splash from last-screen 5f301f9c is starting (not unknown_screen) and reaches ready on ? for shortcuts', () => {
  const settings = getConfiguredAgySettings();
  const protocol = selectNativeLaunchProtocol(settings);

  const splashObservation = observeRunnerScreen(settings, {
    text: CAPTURED_5F301F9C_LAST_SCREEN,
    version: settings.version,
    requestedCommand: null,
  });
  assert.equal(splashObservation.state, 'starting');
  assert.deepEqual(nextRunnerAction(settings, splashObservation), { kind: 'wait' });
  assert.deepEqual(protocol.observe(CAPTURED_5F301F9C_LAST_SCREEN), { status: 'starting' });

  for (const spinner of ['⣯', '⣷', '⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⠋', '*']) {
    const frame = CAPTURED_5F301F9C_LAST_SCREEN.replace('⣯  Signing in...', `${spinner}  Signing in...`);
    const observation = observeRunnerScreen(settings, { text: frame, version: settings.version, requestedCommand: null });
    assert.equal(observation.state, 'starting', `expected starting for spinner "${spinner}"`);
    assert.deepEqual(protocol.observe(frame), { status: 'starting' });
  }

  const readyObservation = observeRunnerScreen(settings, {
    text: AGY_READY_SCREEN,
    version: settings.version,
    requestedCommand: null,
  });
  assert.equal(readyObservation.state, 'ready');
  assert.equal(protocol.observe(AGY_READY_SCREEN).status, 'ready');

  const unexpectedObservation = observeRunnerScreen(settings, {
    text: `${CAPTURED_5F301F9C_LAST_SCREEN}\nUnexpected startup prompt`,
    version: settings.version,
    requestedCommand: null,
  });
  assert.equal(unexpectedObservation.state, 'unknown_screen');
});
