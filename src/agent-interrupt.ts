import { commandFailure } from './cli-contract.ts';
import type { AdapterCommandExecutor } from './agent-adapters.ts';
import { isNativeWorking, observeRunnerScreen, readNativeComposer, type ProtocolSettings } from './runner-protocols.ts';

function refuse(code: string, reason: string): never {
  throw Object.assign(commandFailure({ code, message: reason, reason, stage: 'interrupt', source: 'production-runtime', sourceCode: null, received: null, expected: null, found: null, completed: [], pending: [], retrySafe: false, remediation: ['Перевірте поточний стан і належність панелі виконавця перед наступною дією.'] }), { code });
}

export async function interruptAgentAction(input: {
  pane: string;
  settings: ProtocolSettings;
  execute: AdapterCommandExecutor;
  verify: () => Promise<boolean>;
}): Promise<void> {
  const { pane, settings, execute, verify } = input;
  const owned = async () => {
    if (!await verify()) refuse('PROCESS_IDENTITY_UNAVAILABLE', 'Interrupt requires the same live process in its recorded tmux pane');
  };
  const capture = async () => {
    const result = await execute({ executable: 'tmux', args: ['capture-pane', '-p', '-t', pane] });
    if (result.exitCode !== 0) refuse('INTERRUPT_UNCONFIRMED', 'Cannot read the owned runner pane');
    return result.stdout;
  };
  await owned();
  const before = await capture();
  if (!settings.native || !isNativeWorking(settings, before)) refuse('INTERRUPT_UNAVAILABLE', 'Runner has no verified busy action to interrupt');
  const state = observeRunnerScreen(settings, { text: before, version: settings.version, requestedCommand: null }).state;
  if (state !== 'ready' && state !== 'unknown_screen') refuse('INTERRUPT_UNAVAILABLE', 'Runner is showing a modal or navigation screen');
  await owned();
  const sent = await execute({ executable: 'tmux', args: ['send-keys', '-t', pane, 'Escape'] });
  if (sent.exitCode !== 0) refuse('INTERRUPT_UNCONFIRMED', 'Interrupt key delivery was not confirmed');
  const deadline = performance.now() + settings.timeouts.transitionMs;
  do {
    await owned();
    const screen = await capture();
    const composer = readNativeComposer(settings, screen);
    if (!isNativeWorking(settings, screen) && composer && (composer.input === '' || settings.markers.ready?.includes(composer.input)) && observeRunnerScreen(settings, { text: screen, version: settings.version, requestedCommand: null }).state === 'ready') {
      await owned();
      return;
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(settings.timeouts.pollMs, Math.max(0, deadline - performance.now()))));
  } while (performance.now() < deadline);
  refuse('INTERRUPT_UNCONFIRMED', 'Runner did not confirm an idle composer after interrupt; the session is preserved');
}
