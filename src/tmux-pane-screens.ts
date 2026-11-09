import { randomUUID } from 'node:crypto';
import type { AdapterCommandExecutor } from './agent-adapters.ts';

export async function capturePaneScreens(execute: AdapterCommandExecutor, panes: readonly string[]): Promise<Map<string, string>> {
  if (!panes.length) return new Map();
  const marker = `raf-screen-${randomUUID()}-`;
  const args = panes.flatMap((pane, index) => [
    ...(index ? [';'] : []), 'display-message', '-p', `${marker}${index}`,
    ';', 'capture-pane', '-p', '-t', pane,
  ]);
  const captured = await execute({ executable: 'tmux', args });
  if (captured.exitCode !== 0) return new Map();
  const screens = captured.stdout.split(new RegExp(`^${marker}\\d+\\n`, 'm'));
  const markers = captured.stdout.match(new RegExp(`^${marker}\\d+\\n`, 'gm')) ?? [];
  if (screens[0] !== '' || markers.length !== panes.length || markers.some((value, index) => value !== `${marker}${index}\n`)) return new Map();
  return new Map(panes.map((pane, index) => [pane, screens[index + 1]]));
}
