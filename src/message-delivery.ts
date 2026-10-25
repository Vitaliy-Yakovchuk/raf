import { readNativeComposer, matchPendingBrief, observeRunnerScreen, isNativeWorking, isNativeFinished, type ProtocolSettings } from './runner-protocols.ts';

export type MessageDeliveryPorts = {
  settings: ProtocolSettings;
  verify(): Promise<boolean>;
  capture(): Promise<string>;
  paste(message: string): Promise<void>;
  enter(): Promise<void>;
  now(): number;
  delay(ms: number): Promise<void>;
};

export async function deliverCheckedMessage(ports: MessageDeliveryPorts, message: string): Promise<{ accepted: boolean; reason?: string }> {
  const refuse = (reason: string) => ({ accepted: false, reason });
  const settings = ports.settings;
  if (!settings.native) return refuse('Recipient has no supported native delivery protocol');
  const recognized = (screen: string) => {
    const state = observeRunnerScreen(settings, { text: screen, version: settings.version, requestedCommand: null }).state;
    return state === 'ready' || state === 'unknown_screen' && (isNativeWorking(settings, screen) || isNativeFinished(settings, screen));
  };
  if (!await ports.verify()) return refuse('Recipient identity is no longer verified');
  const before = await ports.capture();
  if (!recognized(before) || readNativeComposer(settings, before)?.input !== '') return refuse('Recipient has no recognized empty agent composer');
  if (!await ports.verify()) return refuse('Recipient identity changed before insertion');
  await ports.paste(message);
  const deadline = ports.now() + settings.timeouts.transitionMs;
  let retried = false;
  let pendingFrame: string | undefined;
  while (ports.now() < deadline) {
    if (!await ports.verify()) return refuse('Recipient identity changed during delivery');
    const screen = await ports.capture();
    const composer = readNativeComposer(settings, screen);
    if (!recognized(screen) || !composer) return refuse('Recipient screen cannot confirm agent acceptance');
    if (composer.input === '' && screen !== before) return await ports.verify() ? { accepted: true } : refuse('Recipient identity changed before receipt');
    const pending = matchPendingBrief(settings, composer.input, message) === 'pending' || composer.input === message;
    if (composer.input !== '' && !pending) return refuse('Recipient composer contains unrelated input');
    if (pending && !retried && pendingFrame === screen) {
      if (!await ports.verify()) return refuse('Recipient identity changed before Enter retry');
      if (await ports.capture() !== screen) return refuse('Recipient composer changed before Enter retry');
      await ports.enter();
      retried = true;
    }
    pendingFrame = pending ? screen : undefined;
    await ports.delay(settings.timeouts.pollMs);
  }
  return refuse('Agent acceptance is unconfirmed after bounded delivery verification');
}
