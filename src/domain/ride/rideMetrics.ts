export function calculateAverageSpeedKmh(
  distanceMeters: number | null | undefined,
  movingSeconds: number | null | undefined,
): number | null {
  if (
    distanceMeters == null || !Number.isFinite(distanceMeters) || distanceMeters <= 0 ||
    movingSeconds == null || !Number.isFinite(movingSeconds) || movingSeconds <= 0
  ) {
    return null;
  }

  const averageSpeedKmh = distanceMeters / movingSeconds * 3.6;
  return Number.isFinite(averageSpeedKmh) ? averageSpeedKmh : null;
}
