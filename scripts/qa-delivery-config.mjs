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
