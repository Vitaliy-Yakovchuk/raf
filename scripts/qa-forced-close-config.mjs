export function configureForcedCloseStand(raf, originalRaf) {
  raf.costProfile = originalRaf.costProfile;
  raf.commandTiming = originalRaf.commandTiming;
  raf.runnerProtocols[0].timeouts = originalRaf.runnerProtocols.find(row => row.runner === 'codex').timeouts;
  return raf;
}
