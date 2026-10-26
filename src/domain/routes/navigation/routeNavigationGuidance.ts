import type { RouteCoordinate } from '../gpx/GpxRoute';
import { distanceBetweenCoords } from '../elevation/routeElevationAnalysis';

export type ManeuverType =
  | 'straight'
  | 'slight_right'
  | 'right'
  | 'sharp_right'
  | 'slight_left'
  | 'left'
  | 'sharp_left'
  | 'u_turn'
  | 'finish';

export type TurnInstruction = {
  type: ManeuverType;
  title: string;
  description: string;
  distanceMeters: number;
  coordinate: RouteCoordinate;
  thenManeuver?: {
    type: ManeuverType;
    label: string;
  } | null;
};

export function calculateBearing(
  coord1: RouteCoordinate,
  coord2: RouteCoordinate,
): number {
  const [lon1, lat1] = coord1;
  const [lon2, lat2] = coord2;
  const lat1Rad = (lat1 * Math.PI) / 180;
  const lat2Rad = (lat2 * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const y = Math.sin(dLon) * Math.cos(lat2Rad);
  const x =
    Math.cos(lat1Rad) * Math.sin(lat2Rad) -
    Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);

  const brng = (Math.atan2(y, x) * 180) / Math.PI;
  return (brng + 360) % 360;
}

export function calculateTurnAngle(
  incomingBearing: number,
  outgoingBearing: number,
): number {
  let diff = outgoingBearing - incomingBearing;
  while (diff > 180) diff -= 360;
  while (diff < -180) diff += 360;
  return diff;
}

export function classifyManeuver(angle: number): {
  type: ManeuverType;
  title: string;
} {
  if (angle > 135 || angle < -135) {
    return { type: 'u_turn', title: 'Putar balik' };
  }
  if (angle > 100) {
    return { type: 'sharp_right', title: 'Belok tajam kanan' };
  }
  if (angle > 45) {
    return { type: 'right', title: 'Belok kanan' };
  }
  if (angle >= 20) {
    return { type: 'slight_right', title: 'Serong kanan' };
  }
  if (angle < -100) {
    return { type: 'sharp_left', title: 'Belok tajam kiri' };
  }
  if (angle < -45) {
    return { type: 'left', title: 'Belok kiri' };
  }
  if (angle <= -20) {
    return { type: 'slight_left', title: 'Serong kiri' };
  }
  return { type: 'straight', title: 'Lurus terus' };
}

export function formatNavigationDistance(distanceMeters: number): string {
  if (distanceMeters < 30) {
    return 'Sekarang';
  }
  if (distanceMeters < 1000) {
    const rounded = Math.round(distanceMeters / 10) * 10;
    return `${rounded} m`;
  }
  const km = distanceMeters / 1000;
  return `${km.toFixed(1).replace('.', ',')} km`;
}

/**
 * Menghitung instruksi navigasi Turn-by-Turn berdasarkan rute GPX dan posisi pengendara.
 */
export function getNavigationGuidance(
  routePoints: RouteCoordinate[],
  riderPosition: RouteCoordinate | null | undefined,
): TurnInstruction | null {
  if (!routePoints || routePoints.length < 2) {
    return null;
  }

  const destination = routePoints[routePoints.length - 1];

  // Jika posisi rider belum ada, arahkan ke titik start rute
  if (!riderPosition) {
    const startPoint = routePoints[0];
    const initialManeuver = classifyManeuver(0);

    return {
      type: initialManeuver.type,
      title: 'Mulai rute',
      description: 'Menuju titik awal perjalanan',
      distanceMeters: 0,
      coordinate: startPoint,
    };
  }

  // 1. Temukan titik terdekat pada rute
  let closestIndex = 0;
  let minDistance = Infinity;

  for (let i = 0; i < routePoints.length; i++) {
    const d = distanceBetweenCoords(riderPosition, routePoints[i]);
    if (d < minDistance) {
      minDistance = d;
      closestIndex = i;
    }
  }

  // Jarak dari titik saat ini ke finish
  let distanceToEnd = 0;
  for (let i = closestIndex; i < routePoints.length - 1; i++) {
    distanceToEnd += distanceBetweenCoords(routePoints[i], routePoints[i + 1]);
  }

  // Jika hampir sampai di titik finish (< 35m)
  if (closestIndex >= routePoints.length - 2 || distanceToEnd < 35) {
    return {
      type: 'finish',
      title: 'Tiba di tujuan',
      description: 'Anda telah mencapai akhir rute GPX',
      distanceMeters: Math.max(0, Math.round(distanceToEnd)),
      coordinate: destination,
    };
  }

  // 2. Scan titik-titik ke depan untuk menemukan belokan signifikan berikutnya
  let distanceToTurn = 0;
  let foundTurnIndex: number | null = null;
  let turnAngle = 0;

  // Baseline bearing dari posisi rider ke titik beberapa meter ke depan
  const lookAheadBaseIndex = Math.min(routePoints.length - 1, closestIndex + 2);
  let currentBearing = calculateBearing(
    routePoints[closestIndex],
    routePoints[lookAheadBaseIndex],
  );

  for (let i = closestIndex; i < routePoints.length - 2; i++) {
    const stepDist = distanceBetweenCoords(routePoints[i], routePoints[i + 1]);
    distanceToTurn += stepDist;

    // Evaluasi perubahan arah dengan membandingkan bearing segmen berikutnya
    const nextBearingIndex = Math.min(routePoints.length - 1, i + 3);
    const forwardBearing = calculateBearing(routePoints[i + 1], routePoints[nextBearingIndex]);
    const angleDiff = calculateTurnAngle(currentBearing, forwardBearing);

    if (Math.abs(angleDiff) >= 22) {
      foundTurnIndex = i + 1;
      turnAngle = angleDiff;
      break;
    }

    // Perbarui baseline bearing perlahan
    currentBearing = forwardBearing;
  }

  // 3. Jika ditemukan belokan
  if (foundTurnIndex !== null) {
    const maneuver = classifyManeuver(turnAngle);
    const turnCoordinate = routePoints[foundTurnIndex];

    // Cari belokan kedua setelah belokan ini (untuk badge "Lalu / Then")
    let thenManeuver: TurnInstruction['thenManeuver'] = null;
    let postTurnBearing = calculateBearing(
      routePoints[foundTurnIndex],
      routePoints[Math.min(routePoints.length - 1, foundTurnIndex + 2)],
    );

    for (let j = foundTurnIndex; j < Math.min(routePoints.length - 2, foundTurnIndex + 15); j++) {
      const nextNextIndex = Math.min(routePoints.length - 1, j + 3);
      const nextForwardBearing = calculateBearing(routePoints[j + 1], routePoints[nextNextIndex]);
      const nextAngle = calculateTurnAngle(postTurnBearing, nextForwardBearing);

      if (Math.abs(nextAngle) >= 25) {
        const nextClass = classifyManeuver(nextAngle);
        thenManeuver = {
          type: nextClass.type,
          label: nextClass.title,
        };
        break;
      }
      postTurnBearing = nextForwardBearing;
    }

    return {
      type: maneuver.type,
      title: maneuver.title,
      description: distanceToTurn < 30 ? 'Sekarang berbelok' : `Ikuti rute ke depan`,
      distanceMeters: Math.round(distanceToTurn),
      coordinate: turnCoordinate,
      thenManeuver,
    };
  }

  // Jika tidak ada belokan tajam dalam jarak dekat, instruksikan lurus terus
  return {
    type: 'straight',
    title: 'Lurus terus',
    description: 'Ikuti jalur rute saat ini',
    distanceMeters: Math.round(distanceToEnd),
    coordinate: destination,
  };
}
