type RideTimingSnapshot = {
  status: string;
  durationSeconds?: number;
  elapsedSeconds?: number;
  durationUpdatedAt?: string;
  finishedAt?: string | null;
  startedAt?: string;
};

export function rideDurationSeconds(ride: RideTimingSnapshot, now = Date.now()): number {
  const recordedSeconds = Number.isFinite(ride.durationSeconds)
    ? Math.max(0, ride.durationSeconds ?? 0) : 0;
  if (ride.status !== 'active') { return recordedSeconds; }
  if (ride.durationUpdatedAt) {
    const recordedAt = Date.parse(ride.durationUpdatedAt);
    return Number.isFinite(recordedAt)
      ? recordedSeconds + Math.max(0, (now - recordedAt) / 1000)
      : recordedSeconds;
  }
  if (ride.durationSeconds == null && ride.startedAt) {
    const startedAt = Date.parse(ride.startedAt);
    return Number.isFinite(startedAt) ? Math.max(0, (now - startedAt) / 1000) : 0;
  }
  return recordedSeconds;
}

export function rideElapsedSeconds(ride: RideTimingSnapshot, now = Date.now()): number {
  const startedAt = ride.startedAt ? Date.parse(ride.startedAt) : NaN;
  if (Number.isFinite(startedAt)) {
    const finishedAt = ride.finishedAt ? Date.parse(ride.finishedAt) : NaN;
    const endTime = Number.isFinite(finishedAt)
      ? finishedAt
      : ride.status === 'active' || ride.status === 'paused' ? now : NaN;
    if (Number.isFinite(endTime)) return Math.max(0, (endTime - startedAt) / 1000);
  }

  return Number.isFinite(ride.elapsedSeconds)
    ? Math.max(0, ride.elapsedSeconds ?? 0)
    : rideDurationSeconds(ride, now);
}
