import { readNativeComposer, matchPendingBrief, observeRunnerScreen, isNativeWorking, isNativeFinished, type ProtocolSettings } from './runner-protocols.ts';

export type MessageDeliveryPorts = {
  settings: ProtocolSettings;
  waitForComposer?: boolean;
  acquire?(): Promise<{ release(): Promise<void> } | null>;
  verify(): Promise<boolean>;
  capture(): Promise<string>;
  paste(message: string): Promise<void>;
  enter(): Promise<void>;
  now(): number;
  delay(ms: number): Promise<void>;
};

export async function deliverCheckedMessage(ports: MessageDeliveryPorts, message: string): Promise<{ accepted: boolean; reason?: string }> {
  if (!ports.acquire) return deliverInComposer(ports, message);
  if (!await ports.verify()) return { accepted: false, reason: 'Recipient identity is no longer verified' };
  let lease = await ports.acquire();
  while (!lease) {
    if (!ports.waitForComposer) return { accepted: false, reason: 'Another delivery owns the recipient composer' };
    if (!await ports.verify()) return { accepted: false, reason: 'Recipient identity changed while waiting for delivery' };
    await ports.delay(ports.settings.timeouts.transitionMs);
    lease = await ports.acquire();
  }
  try { return await deliverInComposer(ports, message); }
  finally { await lease.release(); }
}

async function deliverInComposer(ports: MessageDeliveryPorts, message: string): Promise<{ accepted: boolean; reason?: string }> {
  const refuse = (reason: string) => ({ accepted: false, reason });
  const settings = ports.settings;
  if (!settings.native) return refuse('Recipient has no supported native delivery protocol');
  const recognized = (screen: string) => {
    const state = observeRunnerScreen(settings, { text: screen, version: settings.version, requestedCommand: null }).state;
    return state === 'ready' || state === 'unknown_screen' && (isNativeWorking(settings, screen) || isNativeFinished(settings, screen));
  };
  const empty = (input: string | undefined) => input === '' || input !== undefined && (settings.markers.ready ?? []).includes(input);
  if (!await ports.verify()) return refuse('Recipient identity is no longer verified');
  let before = await ports.capture();
  for (;;) {
    const composer = readNativeComposer(settings, before);
    if (!recognized(before) || !composer) return refuse('Recipient has no recognized empty agent composer');
    if (empty(composer.input)) break;
    if (!ports.waitForComposer) return refuse('Recipient has no recognized empty agent composer');
    await ports.delay(settings.timeouts.transitionMs);
    if (!await ports.verify()) return refuse('Recipient identity changed while waiting for composer');
    before = await ports.capture();
  }
  if (!await ports.verify()) return refuse('Recipient identity changed before insertion');
  await ports.paste(message);
  const deadline = ports.now() + settings.timeouts.transitionMs;
  let retried = false;
  let pendingFrame: string | undefined;
  while (ports.now() < deadline) {
    if (!await ports.verify()) return refuse('Recipient identity changed during delivery');
    const screen = await ports.capture();
    const composer = readNativeComposer(settings, screen);
    if (!composer) return refuse('Recipient screen cannot confirm agent acceptance');
    const pending = matchPendingBrief(settings, composer.input, message) === 'pending' || pendingWrappedMessage(settings, before, screen, message);
    const observation = observeRunnerScreen(settings, { text: screen, version: settings.version, requestedCommand: null });
    const pendingHint = observation.state === 'unknown_screen' && pending && settings.native.modeHints?.some(hint => screen.split('\n').some(line => line.trim() === hint));
    if (!recognized(screen) && !pendingHint) return refuse('Recipient screen cannot confirm agent acceptance');
    if (empty(composer.input) && screen !== before) return await ports.verify() ? { accepted: true } : refuse('Recipient identity changed before receipt');
    if (!empty(composer.input) && !pending) return refuse('Recipient composer contains unrelated input');
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

function pendingWrappedMessage(settings: ProtocolSettings, before: string, screen: string, message: string): boolean {
  const baseline = readNativeComposer(settings, before)!;
  const composer = readNativeComposer(settings, screen)!;
  const footer = before.split('\n').slice(baseline.line + 1).map(line => line.trim()).filter(Boolean);
  const following = screen.split('\n').slice(composer.line + 1).map(line => line.trim()).filter(Boolean);
  if (footer.length > following.length || !footer.every((line, index) => line === following[following.length - footer.length + index])) return false;
  const body = following.slice(0, following.length - footer.length);
  const compact = (text: string) => text.replace(/\s+/gu, '');
  return compact([composer.input, ...body].join('\n')) === compact(message);
}
