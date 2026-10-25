export function configureDeliveryStand(raf, original) {
  raf.costProfile = original.costProfile;
  raf.commandTiming = original.commandTiming;
  raf.runnerProtocols[0].timeouts = original.runnerProtocols.find(row => row.runner === 'codex').timeouts;
  raf.runnerProtocols[0].baseArgs = ['--sandbox', 'workspace-write'];
  return raf;
}

export function parsePublicDeliveryEvidence(message) {
  return JSON.parse(message.split('deliveryEvidence=')[1].split('\n')[0]);
}
import assert from 'node:assert/strict';


export function assertPublicArtifact(value, markers) {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  for (const marker of markers) assert.ok(!text.includes(marker), 'Control secret reached a public artifact');
}
