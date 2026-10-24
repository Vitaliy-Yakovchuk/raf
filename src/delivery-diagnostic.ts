import { redactDiagnostic } from './cli-contract.ts';
import { matchPendingBrief, observeRunnerScreen, readNativeComposer, type ProtocolSettings } from './runner-protocols.ts';

export type DeliveryFrame = { screen: string; brief: string; phase: 'before_submission' | 'submitting' | 'awaiting_acceptance'; retried: boolean };

function redactBrief(screen: string, brief: string): string {
  const compact = (value: string) => value.replace(/\s/gu, '');
  const prompt = compact(brief);
  let result = screen.split('\n').map(line => {
    const content = compact(line.replace(/^\s*›\s*/u, ''));
    return content.length >= 8 && prompt.includes(content) ? '[redacted-brief]' : line;
  }).join('\n');
  for (const line of brief.split('\n')) {
    const content = compact(line);
    if (content.length < 8) continue;
    const positions: number[] = [];
    let normalized = '';
    for (let index = 0; index < result.length; index++) {
      if (/\s/u.test(result[index])) continue;
      normalized += result[index];
      positions.push(index);
    }
    for (let offset = normalized.lastIndexOf(content); offset >= 0; offset = normalized.lastIndexOf(content, offset - content.length)) {
      result = result.slice(0, positions[offset]) + '[redacted-brief]' + result.slice(positions[offset + content.length - 1] + 1);
      if (offset < content.length) break;
    }
  }
  return result;
}

export function deliveryDiagnostic(settings: ProtocolSettings, frame: DeliveryFrame) {
  const composer = readNativeComposer(settings, frame.screen);
  const input = composer?.input;
  const paste = input !== undefined && new RegExp(settings.native!.pendingPaste.pattern, 'u').test(input);
  const kind = input === undefined ? 'missing' : input === '' || settings.markers.ready?.includes(input) ? 'empty' : paste ? 'paste' : 'other';
  let screen = frame.screen;
  if (composer && kind === 'other') {
    const lines = screen.split('\n');
    lines[composer.line] = lines[composer.line].match(new RegExp(settings.native!.composer, 'u'))![0] + '[redacted-input]';
    screen = lines.join('\n');
  }
  screen = redactBrief(screen, frame.brief)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '')
    .replace(/\bBearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/\b(?:Account|User|Login|Organization|Email)\s*:\s*[^\n]*/giu, '[redacted-account]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[\p{L}]{2,}\b/giu, '[redacted-email]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, '[redacted-id]')
    .replace(/https?:\/\/[^\s]+/giu, '[redacted-url]')
    .replace(/(?:~?\/)[\w.@%+:-]+(?:\/[\w.@%+:-]+)*/gu, '[redacted-path]')
    .replace(/\bsk-[\w-]+/gu, '[redacted]');
  screen = String(redactDiagnostic(screen));
  const truncated = JSON.stringify(screen).length > 2048;
  while (JSON.stringify(screen).length > 2048) screen = screen.slice(Math.max(1, Math.ceil((JSON.stringify(screen).length - 2048) / 6)));
  return {
    runner: settings.runner, phase: frame.phase,
    observation: observeRunnerScreen(settings, { text: frame.screen, version: settings.version, requestedCommand: settings.native!.identity.source === 'session_start' ? null : settings.native!.identity.command }).state,
    composer: kind, pending: input === undefined ? 'none' : matchPendingBrief(settings, input, frame.brief),
    retried: frame.retried, truncated, screen,
  };
}
