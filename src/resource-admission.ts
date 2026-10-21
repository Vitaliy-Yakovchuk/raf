export interface FileSystemMeasurement {
  id: string;
  totalBytes: number;
  availableBytes: number;
}

export interface ResourceMeasurement {
  machineId: string;
  loadAverage1m: number;
  availableCores: number;
  totalRamBytes: number;
  availableRamBytes: number;
  memoryPressure: 'normal' | 'critical' | 'unknown';
  fileSystems: FileSystemMeasurement[];
}

export interface ResourceReservation {
  ramBytes: number;
  diskBytes: Record<string, number>;
}

export interface ResourceAdmissionInput {
  measurement: ResourceMeasurement;
  requested: ResourceReservation;
  unusedReservations: ResourceReservation[];
  requiredFileSystemIds: string[];
}

export interface ResourceAdmission {
  level: 'ANY_RUN' | 'HOTFIX_ONLY' | 'NO_RESOURCES' | 'UNKNOWN';
  allowed: { normal: boolean; hotfix: boolean };
  reasons: string[];
  measurement: ResourceMeasurement;
  remaining: { ramBytes: number; diskBytes: Record<string, number>; normalizedLoad: number } | null;
}

export function evaluateResourceAdmission(input: ResourceAdmissionInput): ResourceAdmission {
  const { measurement, requested, unusedReservations, requiredFileSystemIds } = input;
  const reasons: string[] = [];
  const validNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const unknown = (): ResourceAdmission => ({ level: 'UNKNOWN', allowed: { normal: false, hotfix: false }, reasons, measurement, remaining: null });
  if (!measurement || typeof measurement.machineId !== 'string' || !measurement.machineId.trim()) reasons.push('Missing machine identity');
  if (!validNumber(measurement?.loadAverage1m)) reasons.push('Invalid load average');
  if (!validNumber(measurement?.availableCores) || measurement.availableCores <= 0) reasons.push('Invalid available cores');
  if (!validNumber(measurement?.totalRamBytes) || measurement.totalRamBytes <= 0
    || !validNumber(measurement?.availableRamBytes) || measurement.availableRamBytes > measurement.totalRamBytes) reasons.push('Invalid RAM measurement');
  if (!['normal', 'critical'].includes(measurement?.memoryPressure)) reasons.push('Unknown memory pressure');
  if (!Array.isArray(requiredFileSystemIds) || requiredFileSystemIds.length === 0
    || requiredFileSystemIds.some(id => typeof id !== 'string' || !id.trim())) reasons.push('Missing required filesystem identifiers');
  if (!Array.isArray(unusedReservations)) reasons.push('Invalid unused reservations');
  if (!Array.isArray(measurement?.fileSystems)) reasons.push('Missing filesystem measurements');
  const reservations = [requested, ...(Array.isArray(unusedReservations) ? unusedReservations : [])];
  for (const reservation of reservations) {
    if (!reservation || !validNumber(reservation.ramBytes) || !reservation.diskBytes
      || typeof reservation.diskBytes !== 'object' || Array.isArray(reservation.diskBytes)
      || Object.entries(reservation.diskBytes).some(([id, bytes]) => !id.trim() || !validNumber(bytes))) reasons.push('Invalid resource reservation');
  }
  if (reasons.length) return unknown();
  const ids = [...new Set([...requiredFileSystemIds, ...Object.keys(requested.diskBytes)])];
  const disks = new Map<string, FileSystemMeasurement>();
  for (const fs of measurement.fileSystems) {
    if (!fs || typeof fs.id !== 'string' || !fs.id.trim() || !validNumber(fs.totalBytes) || fs.totalBytes <= 0
      || !validNumber(fs.availableBytes) || fs.availableBytes > fs.totalBytes) {
      reasons.push('Invalid filesystem measurement');
      continue;
    }
    const existing = disks.get(fs.id);
    if (existing && (existing.totalBytes !== fs.totalBytes || existing.availableBytes !== fs.availableBytes)) reasons.push(`Conflicting filesystem measurements: ${fs.id}`);
    disks.set(fs.id, fs);
  }
  for (const id of ids) {
    if (!disks.has(id)) reasons.push(`Missing filesystem measurement: ${id}`);
    if (!Object.hasOwn(requested.diskBytes, id)) reasons.push(`Missing disk reservation estimate: ${id}`);
  }
  if (reasons.length) return unknown();
  const ramBytes = measurement.availableRamBytes - reservations.reduce((sum, reservation) => sum + reservation.ramBytes, 0);
  const diskBytes: Record<string, number> = {};
  for (const id of ids) diskBytes[id] = disks.get(id)!.availableBytes - reservations.reduce((sum, reservation) => sum + (reservation.diskBytes[id] ?? 0), 0);
  const normalizedLoad = measurement.loadAverage1m / measurement.availableCores;
  if (![ramBytes, normalizedLoad, ...Object.values(diskBytes)].every(Number.isFinite)) {
    reasons.push('Invalid resource arithmetic');
    return unknown();
  }
  const remaining = { ramBytes, diskBytes, normalizedLoad };
  if (measurement.memoryPressure === 'critical') {
    return { level: 'NO_RESOURCES', allowed: { normal: false, hotfix: false }, reasons: ['Critical memory pressure'], measurement, remaining };
  }
  const gib = 1024 ** 3;
  const failures = (label: string, load: number, ramFraction: number, ramMinimum: number, diskFraction: number, diskMinimum: number) => {
    const result: string[] = [];
    if (normalizedLoad > load) result.push(`${label}: normalized load exceeds ${load}`);
    if (ramBytes < Math.max(measurement.totalRamBytes * ramFraction, ramMinimum * gib)) result.push(`${label}: insufficient RAM after reservations`);
    for (const id of ids) {
      if (diskBytes[id] < Math.max(disks.get(id)!.totalBytes * diskFraction, diskMinimum * gib)) result.push(`${label}: insufficient disk on ${id} after reservations`);
    }
    return result;
  };
  const normal = failures('normal', 1.2, 0.2, 2, 0.1, 10);
  const hotfix = failures('hotfix', 1.5, 0.1, 1, 0.05, 5);
  return {
    level: normal.length === 0 ? 'ANY_RUN' : hotfix.length === 0 ? 'HOTFIX_ONLY' : 'NO_RESOURCES',
    allowed: { normal: normal.length === 0, hotfix: hotfix.length === 0 },
    reasons: normal.length === 0 ? ['All normal resource thresholds satisfied after reservations'] : [...normal, ...hotfix],
    measurement, remaining,
  };
}
