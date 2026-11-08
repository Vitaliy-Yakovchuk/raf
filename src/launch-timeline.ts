import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

export function recordLaunchStage(
  launch: { tmpRoot: string; runId: string },
  stage: string,
  details: { runner?: string; runnerPid?: number; runnerStartedAt?: string } = {},
  atMs = Date.now(),
): boolean {
  try {
    appendFileSync(join(launch.tmpRoot, launch.runId, 'launch-timeline.jsonl'),
      JSON.stringify({ runId: launch.runId, stage, atMs, at: new Date(atMs).toISOString(), pid: process.pid, ...details }) + '\n',
      { mode: 0o600 });
    return true;
  } catch { return false; }
}
