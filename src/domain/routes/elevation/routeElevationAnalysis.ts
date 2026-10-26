import type { FeatureCollection, LineString } from 'geojson';
import type { GpxRoute, GpxRouteSegment, RouteCoordinate } from '../gpx/GpxRoute';

const WGS84_SEMI_MAJOR_AXIS_METERS = 6_378_137;
const WGS84_FLATTENING = 1 / 298.257223563;
const WGS84_SEMI_MINOR_AXIS_METERS =
  WGS84_SEMI_MAJOR_AXIS_METERS * (1 - WGS84_FLATTENING);
const MEAN_EARTH_RADIUS_METERS = 6_371_008.8;

export interface RouteSample {
  coordinate: RouteCoordinate;
  distanceMeters: number;
  elevationMeters: number | null;
  gradePercent: number | null;
  segmentIndex?: number;
}

export interface ClimbSegment {
  id: number;
  startDistanceMeters: number;
  endDistanceMeters: number;
  distanceMeters: number;
  elevationGainMeters: number;
  netRiseMeters?: number;
  ascentMeters?: number;
  descentMeters?: number;
  averageGradePercent: number;
  maxGradePercent: number;
  startElevationMeters: number | null;
  endElevationMeters: number | null;
  startCoordinate: RouteCoordinate;
  endCoordinate: RouteCoordinate;
}

export const ROUTE_ELEVATION_PROFILE_ALGORITHM_VERSION = 'cyclecomp-route-elevation-v2';

export interface RouteElevationAnalysis {
  samples: RouteSample[];
  climbs: ClimbSegment[];
  totalDistanceMeters: number;
  totalAscentMeters: number;
  totalDescentMeters: number;
  minElevationMeters: number | null;
  maxElevationMeters: number | null;
  maxGradePercent: number | null;
  gradientFeatureCollection: FeatureCollection<LineString>;
}

export type ClimbAlertState =
  | {
      type: 'active';
      climb: ClimbSegment;
      climbIndex: number; // 1-based (misal 1 dari 3)
      totalClimbs: number;
      distanceRemainingMeters: number;
      gainRemainingMeters: number | null;
      progressPercent: number; // 0 - 100
      currentGradePercent: number | null;
      currentElevationMeters: number | null;
    }
  | {
      type: 'upcoming';
      climb: ClimbSegment;
      climbIndex: number;
      totalClimbs: number;
      distanceToStartMeters: number;
      currentGradePercent: number | null;
      currentElevationMeters: number | null;
    }
  | {
      type: 'none';
      currentGradePercent: number | null;
      currentElevationMeters: number | null;
      nextClimbDistanceMeters: number | null;
      totalClimbs: number;
    };

/**
 * Palet warna gradien disesuaikan dengan standar Kontur dan Garmin/COROS:
 * - Turunan (< -1.5%): Biru Cerah (#0284C7)
 * - Datar/Landai (-1.5% s.d. 3%): Hijau Emerald (#10B981)
 * - Tanjakan Ringan (3% s.d. 6%): Kuning Amber (#F59E0B)
 * - Tanjakan Sedang (6% s.d. 9%): Oranye (#F97316)
 * - Tanjakan Curam (9% s.d. 13%): Merah (#DC2626)
 * - Tanjakan Ekstrem (≥ 13%): Merah Terang / Vivid Electric Red (#FF1E42)
 */
export function getGradeColor(grade: number | null): string {
  if (grade === null) return '#8E8E93';
  if (grade < -1.5) return '#0284C7';
  if (grade < 3) return '#10B981';
  if (grade < 6) return '#F59E0B';
  if (grade < 9) return '#F97316';
  if (grade < 13) return '#DC2626';
  return '#FF1E42';
}

export function getGradeLabel(grade: number | null): string {
  if (grade === null) return '—';
  if (grade < -8) return 'Turunan curam';
  if (grade < -1.5) return 'Turunan';
  if (grade < 3) return 'Datar / Landai';
  if (grade < 6) return 'Tanjakan ringan (3–6%)';
  if (grade < 9) return 'Tanjakan sedang (6–9%)';
  if (grade < 13) return 'Tanjakan curam (9–13%)';
  return 'Tanjakan ekstrem (≥13%)';
}

export function getShortGradeLabel(grade: number | null): string {
  if (grade === null) return 'Gradien';
  if (grade < -8) return 'Turun curam';
  if (grade < -1.5) return 'Turunan';
  if (grade < 3) return 'Landai';
  if (grade < 6) return 'Tanjakan ringan';
  if (grade < 9) return 'Tanjakan sedang';
  if (grade < 13) return 'Tanjakan curam';
  return 'Tanjakan ekstrem';
}

export function formatGradePercent(grade: number | null): string {
  if (grade === null) return '—';
  const prefix = grade > 0 ? '+' : '';
  return `${prefix}${grade.toFixed(1)}%`;
}

export function distanceBetweenCoords(
  coord1: RouteCoordinate,
  coord2: RouteCoordinate,
): number {
  const [lon1, lat1] = coord1;
  const [lon2, lat2] = coord2;
  const latitudeOne = (lat1 * Math.PI) / 180;
  const latitudeTwo = (lat2 * Math.PI) / 180;
  const longitudeDifferenceDegrees = ((lon2 - lon1 + 540) % 360) - 180;
  const longitudeDifference = (longitudeDifferenceDegrees * Math.PI) / 180;
  const reducedLatitudeOne = Math.atan(
    (1 - WGS84_FLATTENING) * Math.tan(latitudeOne),
  );
  const reducedLatitudeTwo = Math.atan(
    (1 - WGS84_FLATTENING) * Math.tan(latitudeTwo),
  );
  const sinReducedLatitudeOne = Math.sin(reducedLatitudeOne);
  const cosReducedLatitudeOne = Math.cos(reducedLatitudeOne);
  const sinReducedLatitudeTwo = Math.sin(reducedLatitudeTwo);
  const cosReducedLatitudeTwo = Math.cos(reducedLatitudeTwo);
  let longitudeIteration = longitudeDifference;
  let sinSigma = 0;
  let cosSigma = 1;
  let sigma = 0;
  let sinAlpha = 0;
  let cosSquaredAlpha = 0;
  let cosDoubleSigmaMidpoint = 0;
  let converged = false;

  for (let iteration = 0; iteration < 100; iteration += 1) {
    const sinLongitudeIteration = Math.sin(longitudeIteration);
    const cosLongitudeIteration = Math.cos(longitudeIteration);
    const firstSigmaComponent =
      cosReducedLatitudeTwo * sinLongitudeIteration;
    const secondSigmaComponent =
      cosReducedLatitudeOne * sinReducedLatitudeTwo -
      sinReducedLatitudeOne * cosReducedLatitudeTwo * cosLongitudeIteration;
    sinSigma = Math.hypot(firstSigmaComponent, secondSigmaComponent);
    if (sinSigma === 0) return 0;

    cosSigma =
      sinReducedLatitudeOne * sinReducedLatitudeTwo +
      cosReducedLatitudeOne * cosReducedLatitudeTwo * cosLongitudeIteration;
    sigma = Math.atan2(sinSigma, cosSigma);
    sinAlpha =
      (cosReducedLatitudeOne * cosReducedLatitudeTwo * sinLongitudeIteration) /
      sinSigma;
    cosSquaredAlpha = 1 - sinAlpha ** 2;
    cosDoubleSigmaMidpoint = cosSquaredAlpha === 0
      ? 0
      : cosSigma -
        (2 * sinReducedLatitudeOne * sinReducedLatitudeTwo) / cosSquaredAlpha;

    const correction =
      (WGS84_FLATTENING / 16) *
      cosSquaredAlpha *
      (4 + WGS84_FLATTENING * (4 - 3 * cosSquaredAlpha));
    const nextLongitudeIteration =
      longitudeDifference +
      (1 - correction) *
        WGS84_FLATTENING *
        sinAlpha *
        (sigma +
          correction *
            sinSigma *
            (cosDoubleSigmaMidpoint +
              correction *
                cosSigma *
                (-1 + 2 * cosDoubleSigmaMidpoint ** 2)));

    if (Math.abs(nextLongitudeIteration - longitudeIteration) < 1e-12) {
      longitudeIteration = nextLongitudeIteration;
      converged = true;
      break;
    }
    longitudeIteration = nextLongitudeIteration;
  }

  if (!converged) {
    return haversineDistanceMeters(latitudeOne, latitudeTwo, longitudeDifference);
  }

  const squaredEllipsoidRatio =
    (cosSquaredAlpha *
      (WGS84_SEMI_MAJOR_AXIS_METERS ** 2 - WGS84_SEMI_MINOR_AXIS_METERS ** 2)) /
    WGS84_SEMI_MINOR_AXIS_METERS ** 2;
  const distanceScaleA =
    1 +
    (squaredEllipsoidRatio / 16_384) *
      (4_096 +
        squaredEllipsoidRatio *
          (-768 + squaredEllipsoidRatio * (320 - 175 * squaredEllipsoidRatio)));
  const distanceScaleB =
    (squaredEllipsoidRatio / 1_024) *
    (256 +
      squaredEllipsoidRatio *
        (-128 + squaredEllipsoidRatio * (74 - 47 * squaredEllipsoidRatio)));
  const sigmaCorrection =
    distanceScaleB *
    sinSigma *
    (cosDoubleSigmaMidpoint +
      (distanceScaleB / 4) *
        (cosSigma * (-1 + 2 * cosDoubleSigmaMidpoint ** 2) -
          (distanceScaleB / 6) *
            cosDoubleSigmaMidpoint *
            (-3 + 4 * sinSigma ** 2) *
            (-3 + 4 * cosDoubleSigmaMidpoint ** 2)));
  return WGS84_SEMI_MINOR_AXIS_METERS * distanceScaleA * (sigma - sigmaCorrection);
}

function haversineDistanceMeters(
  latitudeOne: number,
  latitudeTwo: number,
  longitudeDifference: number,
): number {
  const latitudeDifference = latitudeTwo - latitudeOne;
  const haversineTerm =
    Math.sin(latitudeDifference / 2) ** 2 +
    Math.cos(latitudeOne) *
      Math.cos(latitudeTwo) *
      Math.sin(longitudeDifference / 2) ** 2;
  return (
    2 *
    MEAN_EARTH_RADIUS_METERS *
    Math.atan2(Math.sqrt(haversineTerm), Math.sqrt(Math.max(0, 1 - haversineTerm)))
  );
}

/**
 * Menganalisis rute GPX:
 * 1. Menghitung jarak kumulatif dan melakukan resample titik.
 * 2. Menghaluskan profil elevasi dengan filter median & moving linear regression.
 * 3. Mendeteksi segmen tanjakan (Climbs) seperti Garmin ClimbPro & Kontur.
 * 4. Membangun GeoJSON FeatureCollection berwarna berdasarkan gradien elevasi.
 */
export function analyzeRouteElevation(
  route: GpxRoute,
  segmentPointDistancesMeters?: readonly (readonly number[])[],
): RouteElevationAnalysis {
  if (route.segments.every(segment => segment.points.length === 0)) {
    return {
      samples: [],
      climbs: [],
      totalDistanceMeters: 0,
      totalAscentMeters: 0,
      totalDescentMeters: 0,
      minElevationMeters: null,
      maxElevationMeters: null,
      maxGradePercent: null,
      gradientFeatureCollection: { type: 'FeatureCollection', features: [] },
    };
  }

  // 1. Resample track ke interval reguler ~15-20 meter
  const samples = resamplePoints(route.segments, segmentPointDistancesMeters);
  const totalDistanceMeters = samples.at(-1)?.distanceMeters ?? 0;

  // 2. Haluskan elevasi jika ada
  const hasElevation = samples.some(s => s.elevationMeters !== null);
  if (hasElevation) {
    smoothElevations(samples);
    calculateGrades(samples);
  }

  // 3. Hitung ringkasan naik/turun dan gradien maksimum
  let totalAscentMeters = 0;
  let totalDescentMeters = 0;
  let minElevationMeters: number | null = null;
  let maxElevationMeters: number | null = null;
  let maxGradePercent: number | null = null;
  let elevationGainPivot: { elevationMeters: number; segmentIndex?: number } | null = null;

  for (let i = 0; i < samples.length; i++) {
    const curr = samples[i];
    if (curr.elevationMeters === null) {
      elevationGainPivot = null;
      continue;
    }

    minElevationMeters = Math.min(minElevationMeters ?? Infinity, curr.elevationMeters);
    maxElevationMeters = Math.max(maxElevationMeters ?? -Infinity, curr.elevationMeters);
    if (!elevationGainPivot || elevationGainPivot.segmentIndex !== curr.segmentIndex) {
      elevationGainPivot = {
        elevationMeters: curr.elevationMeters,
        segmentIndex: curr.segmentIndex,
      };
    } else {
      const elevationChangeMeters = curr.elevationMeters - elevationGainPivot.elevationMeters;
      if (elevationChangeMeters >= 2) {
        totalAscentMeters += elevationChangeMeters;
        elevationGainPivot.elevationMeters = curr.elevationMeters;
      } else if (elevationChangeMeters <= -2) {
        totalDescentMeters += Math.abs(elevationChangeMeters);
        elevationGainPivot.elevationMeters = curr.elevationMeters;
      }
    }

    if (curr.gradePercent !== null) {
      maxGradePercent = Math.max(maxGradePercent ?? -Infinity, curr.gradePercent);
    }
  }

  // 4. Deteksi segmen tanjakan (Climbs)
  const climbs = hasElevation ? detectClimbs(samples) : [];

  // 5. Bangun GeoJSON FeatureCollection dengan segmentasi warna gradien
  const gradientFeatureCollection = buildGradientFeatures(samples, route.name);

  return {
    samples,
    climbs,
    totalDistanceMeters,
    totalAscentMeters: Math.round(totalAscentMeters),
    totalDescentMeters: Math.round(totalDescentMeters),
    minElevationMeters: minElevationMeters !== null ? Math.round(minElevationMeters) : null,
    maxElevationMeters: maxElevationMeters !== null ? Math.round(maxElevationMeters) : null,
    maxGradePercent: maxGradePercent !== null ? Math.round(maxGradePercent * 10) / 10 : null,
    gradientFeatureCollection,
  };
}

function resamplePoints(
  routeSegments: GpxRouteSegment[],
  segmentPointDistancesMeters?: readonly (readonly number[])[],
): RouteSample[] {
  const profileSamples: RouteSample[] = [];
  let cumulativeDistance = 0;
  const targetStepMeters = 20;
  if (segmentPointDistancesMeters && segmentPointDistancesMeters.length !== routeSegments.length) {
    throw new Error('Prepared profile distances must cover every route segment');
  }

  for (let segmentIndex = 0; segmentIndex < routeSegments.length; segmentIndex += 1) {
    const rawPoints = routeSegments[segmentIndex]?.points ?? [];
    const firstPoint = rawPoints[0];
    if (!firstPoint) continue;
    const pointDistances = segmentPointDistancesMeters?.[segmentIndex];
    if (pointDistances && (
      pointDistances.length !== rawPoints.length || pointDistances[0] !== 0 ||
      pointDistances.some((distance, index) => !Number.isFinite(distance) || distance < 0 ||
        (index > 0 && distance <= pointDistances[index - 1]!))
    )) {
      throw new Error('Prepared profile distances must start at zero and increase along the segment');
    }

    let segmentDistanceMeters = 0;
    profileSamples.push({
      coordinate: firstPoint.coordinate,
      distanceMeters: cumulativeDistance,
      elevationMeters: firstPoint.elevationMeters,
      gradePercent: null,
      segmentIndex,
    });

    for (let pointIndex = 1; pointIndex < rawPoints.length; pointIndex += 1) {
      const previousPoint = rawPoints[pointIndex - 1];
      const currentPoint = rawPoints[pointIndex];
      if (!previousPoint || !currentPoint) continue;

      const edgeDistanceMeters = pointDistances
        ? pointDistances[pointIndex]! - pointDistances[pointIndex - 1]!
        : distanceBetweenCoords(previousPoint.coordinate, currentPoint.coordinate);
      if (edgeDistanceMeters <= 1e-6) continue;

      const edgeStartDistance = cumulativeDistance + segmentDistanceMeters;
      const edgeEndDistance = edgeStartDistance + edgeDistanceMeters;

      if (previousPoint.elevationMeters !== null && currentPoint.elevationMeters === null) {
        appendElevationBoundarySample(
          profileSamples,
          previousPoint,
          edgeStartDistance,
          segmentIndex,
        );
      }

      let nextGridDistance = (Math.floor(edgeStartDistance / targetStepMeters) + 1) * targetStepMeters;

      while (nextGridDistance <= edgeEndDistance + 0.01) {
        if (nextGridDistance > edgeStartDistance + 0.01) {
          const sampleDistanceMeters = Math.min(nextGridDistance, edgeEndDistance);
          const fraction = (sampleDistanceMeters - edgeStartDistance) / edgeDistanceMeters;
          profileSamples.push({
            coordinate: interpolateCoordinate(previousPoint.coordinate, currentPoint.coordinate, fraction),
            distanceMeters: sampleDistanceMeters,
            elevationMeters: interpolateElevation(previousPoint.elevationMeters, currentPoint.elevationMeters, fraction),
            gradePercent: null,
            segmentIndex,
          });
        }
        nextGridDistance += targetStepMeters;
      }

      if (previousPoint.elevationMeters === null && currentPoint.elevationMeters !== null) {
        appendElevationBoundarySample(
          profileSamples,
          currentPoint,
          edgeEndDistance,
          segmentIndex,
        );
      }

      segmentDistanceMeters += edgeDistanceMeters;
    }

    const lastPoint = rawPoints[rawPoints.length - 1];
    const segmentEndDistance = cumulativeDistance + segmentDistanceMeters;
    if (lastPoint && segmentDistanceMeters > 0 &&
        (profileSamples.at(-1)?.distanceMeters ?? -Infinity) < segmentEndDistance) {
      profileSamples.push({
        coordinate: lastPoint.coordinate,
        distanceMeters: segmentEndDistance,
        elevationMeters: lastPoint.elevationMeters,
        gradePercent: null,
        segmentIndex,
      });
    }
    cumulativeDistance += segmentDistanceMeters;
  }

  return profileSamples;
}

function appendElevationBoundarySample(
  samples: RouteSample[],
  routePoint: GpxRouteSegment['points'][number],
  distanceMeters: number,
  segmentIndex: number,
) {
  const boundarySample: RouteSample = {
    coordinate: routePoint.coordinate,
    distanceMeters,
    elevationMeters: routePoint.elevationMeters,
    gradePercent: null,
    segmentIndex,
  };
  const lastSample = samples.at(-1);

  if (lastSample?.segmentIndex === segmentIndex &&
      lastSample.distanceMeters === distanceMeters) {
    samples[samples.length - 1] = boundarySample;
    return;
  }

  samples.push(boundarySample);
}

function interpolateCoordinate(
  startCoordinate: RouteCoordinate,
  endCoordinate: RouteCoordinate,
  fraction: number,
): RouteCoordinate {
  return [
    startCoordinate[0] + (endCoordinate[0] - startCoordinate[0]) * fraction,
    startCoordinate[1] + (endCoordinate[1] - startCoordinate[1]) * fraction,
  ];
}

function interpolateElevation(
  startElevationMeters: number | null,
  endElevationMeters: number | null,
  fraction: number,
): number | null {
  if (fraction <= 0) return startElevationMeters;
  if (fraction >= 1) return endElevationMeters;
  if (startElevationMeters === null || endElevationMeters === null) return null;
  return startElevationMeters + (endElevationMeters - startElevationMeters) * fraction;
}

function smoothElevations(samples: RouteSample[]) {
  const n = samples.length;
  if (n < 3) return;

  const raw = samples.map(s => s.elevationMeters);
  for (let i = 1; i < n - 1; i++) {
    const prev = raw[i - 1];
    const curr = raw[i];
    const next = raw[i + 1];
    if (samples[i - 1]?.segmentIndex === samples[i]?.segmentIndex &&
        samples[i]?.segmentIndex === samples[i + 1]?.segmentIndex &&
        prev !== null && curr !== null && next !== null) {
      // Median filter jendela 3
      const sorted = [prev, curr, next].sort((a, b) => a - b);
      samples[i].elevationMeters = sorted[1];
    }
  }
}

function calculateGrades(samples: RouteSample[]) {
  for (let centerIndex = 0; centerIndex < samples.length; centerIndex += 1) {
    const centerSample = samples[centerIndex];
    if (!centerSample) continue;

    let firstNeighborIndex = centerIndex;
    while (firstNeighborIndex > 0) {
      const previousSample = samples[firstNeighborIndex - 1];
      if (!previousSample || previousSample.segmentIndex !== centerSample.segmentIndex ||
          centerSample.distanceMeters - previousSample.distanceMeters > 30) break;
      firstNeighborIndex -= 1;
    }

    let lastNeighborIndex = centerIndex;
    while (lastNeighborIndex + 1 < samples.length) {
      const nextSample = samples[lastNeighborIndex + 1];
      if (!nextSample || nextSample.segmentIndex !== centerSample.segmentIndex ||
          nextSample.distanceMeters - centerSample.distanceMeters > 30) break;
      lastNeighborIndex += 1;
    }

    const neighboringSamples = samples.slice(firstNeighborIndex, lastNeighborIndex + 1);
    if (neighboringSamples.length < 3 ||
        neighboringSamples.some(sample => sample.elevationMeters === null) ||
        (neighboringSamples.at(-1)?.distanceMeters ?? 0) -
          (neighboringSamples[0]?.distanceMeters ?? 0) < 20) {
      centerSample.gradePercent = null;
      continue;
    }

    const meanDistance = neighboringSamples.reduce((sum, sample) => sum + sample.distanceMeters, 0) /
      neighboringSamples.length;
    const meanElevation = neighboringSamples.reduce(
      (sum, sample) => sum + (sample.elevationMeters ?? 0),
      0,
    ) / neighboringSamples.length;
    const covariance = neighboringSamples.reduce(
      (sum, sample) => sum + (sample.distanceMeters - meanDistance) *
        ((sample.elevationMeters ?? 0) - meanElevation),
      0,
    );
    const distanceVariance = neighboringSamples.reduce(
      (sum, sample) => sum + (sample.distanceMeters - meanDistance) ** 2,
      0,
    );

    centerSample.gradePercent = distanceVariance > 0
      ? Math.round((covariance / distanceVariance) * 1000) / 10
      : null;
  }
}

function detectClimbs(samples: RouteSample[]): ClimbSegment[] {
  const climbs: ClimbSegment[] = [];
  let climbStartIndex = -1;
  let lastRisingIndex = -1;

  const closeClimb = () => {
    if (climbStartIndex < 0 || lastRisingIndex <= climbStartIndex) {
      climbStartIndex = -1;
      lastRisingIndex = -1;
      return;
    }

    const first = samples[climbStartIndex];
    const last = samples[lastRisingIndex];
    const distanceMeters = last.distanceMeters - first.distanceMeters;
    const riseMeters =
      first.elevationMeters !== null && last.elevationMeters !== null
        ? last.elevationMeters - first.elevationMeters
        : 0;

    const averageGradePercent =
      distanceMeters > 0 ? (riseMeters / distanceMeters) * 100 : 0;

    // Kriteria tanjakan (panjang >= 250m, naik >= 15m, rata-rata gradien >= 3%)
    if (distanceMeters >= 250 && riseMeters >= 15 && averageGradePercent >= 3) {
      let ascentMeters = 0;
      let descentMeters = 0;
      let elevationPivotMeters = first.elevationMeters ?? 0;
      let maxGrade = 0;

      for (let i = climbStartIndex + 1; i <= lastRisingIndex; i++) {
        const curr = samples[i];
        if (curr.elevationMeters !== null) {
          const elevationChangeMeters = curr.elevationMeters - elevationPivotMeters;
          if (elevationChangeMeters >= 2) {
            ascentMeters += elevationChangeMeters;
            elevationPivotMeters = curr.elevationMeters;
          } else if (elevationChangeMeters <= -2) {
            descentMeters += Math.abs(elevationChangeMeters);
            elevationPivotMeters = curr.elevationMeters;
          }
        }
        if (curr.gradePercent !== null) {
          maxGrade = Math.max(maxGrade, curr.gradePercent);
        }
      }

      climbs.push({
        id: climbs.length + 1,
        startDistanceMeters: Math.round(first.distanceMeters),
        endDistanceMeters: Math.round(last.distanceMeters),
        distanceMeters: Math.round(distanceMeters),
        elevationGainMeters: Math.round(ascentMeters),
        netRiseMeters: Math.round(riseMeters),
        ascentMeters: Math.round(ascentMeters),
        descentMeters: Math.round(descentMeters),
        averageGradePercent: Math.round(averageGradePercent * 10) / 10,
        maxGradePercent: Math.round(maxGrade * 10) / 10,
        startElevationMeters: first.elevationMeters !== null ? Math.round(first.elevationMeters) : null,
        endElevationMeters: last.elevationMeters !== null ? Math.round(last.elevationMeters) : null,
        startCoordinate: first.coordinate,
        endCoordinate: last.coordinate,
      });
    }

    climbStartIndex = -1;
    lastRisingIndex = -1;
  };

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    const grade = sample.gradePercent;

    if (grade === null || grade < -2.0) {
      closeClimb();
      continue;
    }

    if (grade >= 3.0) {
      if (climbStartIndex < 0) climbStartIndex = i;
      lastRisingIndex = i;
    } else if (
      lastRisingIndex >= 0 &&
      sample.distanceMeters - samples[lastRisingIndex].distanceMeters > 150
    ) {
      closeClimb();
    }
  }

  closeClimb();
  return climbs;
}

function buildGradientFeatures(
  samples: RouteSample[],
  routeName: string,
): FeatureCollection<LineString> {
  if (samples.length < 2) {
    return { type: 'FeatureCollection', features: [] };
  }

  const features: FeatureCollection<LineString>['features'] = [];
  let currentColor = getGradeColor(samples[0].gradePercent);
  let currentCoords: RouteCoordinate[] = [samples[0].coordinate];

  for (let i = 1; i < samples.length; i++) {
    const sample = samples[i];
    const previousSample = samples[i - 1];
    if (sample.segmentIndex !== previousSample.segmentIndex) {
      if (currentCoords.length >= 2) {
        features.push({
          type: 'Feature',
          properties: { color: currentColor, name: routeName },
          geometry: { type: 'LineString', coordinates: currentCoords },
        });
      }
      currentColor = getGradeColor(sample.gradePercent);
      currentCoords = [sample.coordinate];
      continue;
    }
    const color = getGradeColor(sample.gradePercent);

    if (color === currentColor) {
      currentCoords.push(sample.coordinate);
    } else {
      // Tutup garis warna sebelumnya dengan menyertakan titik awal segmen berikutnya
      currentCoords.push(sample.coordinate);
      features.push({
        type: 'Feature',
        properties: {
          color: currentColor,
          name: routeName,
        },
        geometry: {
          type: 'LineString',
          coordinates: currentCoords,
        },
      });

      // Mulai segmen warna baru dari titik terakhir
      currentColor = color;
      currentCoords = [sample.coordinate];
    }
  }

  if (currentCoords.length >= 2) {
    features.push({
      type: 'Feature',
      properties: {
        color: currentColor,
        name: routeName,
      },
      geometry: {
        type: 'LineString',
        coordinates: currentCoords,
      },
    });
  }

  return {
    type: 'FeatureCollection',
    features,
  };
}

/**
 * Mencari status tanjakan aktif / yang akan datang (upcoming) untuk posisi pengendara saat ini:
 * - Jika sedang berada di dalam tanjakan: mengembalikan type 'active'.
 * - Jika berada dalam radius peringatan (misal 1500m sebelum tanjakan): mengembalikan type 'upcoming'.
 * - Jika tidak ada tanjakan dekat: mengembalikan type 'none' dengan gradien rute saat ini.
 */
export function findClimbStateForRider(
  riderCoordinate: RouteCoordinate | null | undefined,
  analysis: RouteElevationAnalysis,
): ClimbAlertState {
  if (!riderCoordinate || analysis.samples.length === 0 ||
      !Number.isFinite(riderCoordinate[0]) || !Number.isFinite(riderCoordinate[1])) {
    return {
      type: 'none',
      currentGradePercent: null,
      currentElevationMeters: null,
      nextClimbDistanceMeters: null,
      totalClimbs: analysis.climbs.length,
    };
  }

  const routePosition = findClosestRoutePosition(riderCoordinate, analysis.samples);
  if (!routePosition || routePosition.distanceFromRouteMeters > 100) {
    return {
      type: 'none',
      currentGradePercent: null,
      currentElevationMeters: null,
      nextClimbDistanceMeters: null,
      totalClimbs: analysis.climbs.length,
    };
  }

  const riderDistance = routePosition.distanceMeters;
  const currentGradePercent = routePosition.gradePercent;
  const currentElevationMeters = routePosition.elevationMeters;

  // Periksa apakah sedang di dalam tanjakan
  for (let i = 0; i < analysis.climbs.length; i++) {
    const climb = analysis.climbs[i];
    if (riderDistance >= climb.startDistanceMeters && riderDistance <= climb.endDistanceMeters) {
      const distanceRemainingMeters = Math.max(0, climb.endDistanceMeters - riderDistance);
      const progressPercent =
        climb.distanceMeters > 0
          ? Math.min(100, Math.max(0, ((riderDistance - climb.startDistanceMeters) / climb.distanceMeters) * 100))
          : 100;
      const gainRemainingMeters = calculateRemainingAscentMeters(
        analysis.samples,
        routePosition,
        riderDistance,
        climb.endDistanceMeters,
      );

      return {
        type: 'active',
        climb,
        climbIndex: i + 1,
        totalClimbs: analysis.climbs.length,
        distanceRemainingMeters: Math.round(distanceRemainingMeters),
        gainRemainingMeters: gainRemainingMeters === null ? null : Math.round(gainRemainingMeters),
        progressPercent: Math.round(progressPercent),
        currentGradePercent,
        currentElevationMeters,
      };
    }
  }

  // Periksa apakah ada tanjakan di depan dalam jarak 1500 meter
  for (let i = 0; i < analysis.climbs.length; i++) {
    const climb = analysis.climbs[i];
    if (climb.startDistanceMeters > riderDistance) {
      const distanceToStartMeters = climb.startDistanceMeters - riderDistance;
      if (distanceToStartMeters <= 1500) {
        return {
          type: 'upcoming',
          climb,
          climbIndex: i + 1,
          totalClimbs: analysis.climbs.length,
          distanceToStartMeters: Math.round(distanceToStartMeters),
          currentGradePercent,
          currentElevationMeters,
        };
      } else {
        // Tanjakan terdekat lebih dari 1.5 km
        return {
          type: 'none',
          currentGradePercent,
          currentElevationMeters,
          nextClimbDistanceMeters: Math.round(distanceToStartMeters),
          totalClimbs: analysis.climbs.length,
        };
      }
    }
  }

  return {
    type: 'none',
    currentGradePercent,
    currentElevationMeters,
    nextClimbDistanceMeters: null,
    totalClimbs: analysis.climbs.length,
  };
}

interface RoutePosition {
  distanceMeters: number;
  distanceFromRouteMeters: number;
  elevationMeters: number | null;
  gradePercent: number | null;
  segmentIndex?: number;
}

function findClosestRoutePosition(
  riderCoordinate: RouteCoordinate,
  samples: RouteSample[],
): RoutePosition | null {
  const [riderLongitude, riderLatitude] = riderCoordinate;
  const riderLatitudeRadians = (riderLatitude * Math.PI) / 180;
  const eccentricitySquared =
    WGS84_FLATTENING * (2 - WGS84_FLATTENING);
  const latitudeDenominator = Math.sqrt(
    1 - eccentricitySquared * Math.sin(riderLatitudeRadians) ** 2,
  );
  const primeVerticalRadiusMeters =
    WGS84_SEMI_MAJOR_AXIS_METERS / latitudeDenominator;
  const meridionalRadiusMeters =
    (WGS84_SEMI_MAJOR_AXIS_METERS * (1 - eccentricitySquared)) /
    latitudeDenominator ** 3;
  const latitudeScale = (Math.PI / 180) * meridionalRadiusMeters;
  const longitudeScale =
    (Math.PI / 180) *
    primeVerticalRadiusMeters *
    Math.cos(riderLatitudeRadians);
  let closestPosition: RoutePosition | null = null;

  const considerPosition = (routeSample: RouteSample, endSample: RouteSample | null) => {
    const startX = shortestLongitudeDelta(riderLongitude, routeSample.coordinate[0]) * longitudeScale;
    const startY = (routeSample.coordinate[1] - riderLatitude) * latitudeScale;
    const endX = endSample
      ? shortestLongitudeDelta(riderLongitude, endSample.coordinate[0]) * longitudeScale
      : startX;
    const endY = endSample
      ? (endSample.coordinate[1] - riderLatitude) * latitudeScale
      : startY;
    const segmentX = endX - startX;
    const segmentY = endY - startY;
    const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;
    const fraction = segmentLengthSquared > 0
      ? Math.max(0, Math.min(1, -(startX * segmentX + startY * segmentY) / segmentLengthSquared))
      : 0;
    const distanceFromRouteMeters = Math.hypot(
      startX + segmentX * fraction,
      startY + segmentY * fraction,
    );
    if (closestPosition && distanceFromRouteMeters >= closestPosition.distanceFromRouteMeters) return;

    closestPosition = {
      distanceMeters: endSample
        ? routeSample.distanceMeters + (endSample.distanceMeters - routeSample.distanceMeters) * fraction
        : routeSample.distanceMeters,
      distanceFromRouteMeters,
      elevationMeters: endSample
        ? interpolateNullable(routeSample.elevationMeters, endSample.elevationMeters, fraction)
        : routeSample.elevationMeters,
      gradePercent: endSample
        ? interpolateNullable(routeSample.gradePercent, endSample.gradePercent, fraction)
        : routeSample.gradePercent,
      segmentIndex: routeSample.segmentIndex,
    };
  };

  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    const routeSample = samples[sampleIndex];
    if (!routeSample) continue;
    const nextSample = samples[sampleIndex + 1];
    if (nextSample && nextSample.segmentIndex === routeSample.segmentIndex) {
      considerPosition(routeSample, nextSample);
      continue;
    }

    const previousSample = samples[sampleIndex - 1];
    if (!previousSample || previousSample.segmentIndex !== routeSample.segmentIndex) {
      considerPosition(routeSample, null);
    }
  }

  return closestPosition;
}

function calculateRemainingAscentMeters(
  samples: RouteSample[],
  routePosition: RoutePosition,
  currentDistanceMeters: number,
  climbEndDistanceMeters: number,
): number | null {
  if (routePosition.elevationMeters === null) return null;
  let lastRiseReferenceMeters = routePosition.elevationMeters;
  let remainingAscentMeters = 0;

  for (const sample of samples) {
    if (sample.segmentIndex !== routePosition.segmentIndex ||
        sample.distanceMeters <= currentDistanceMeters ||
        sample.distanceMeters > climbEndDistanceMeters) continue;
    if (sample.elevationMeters === null) return null;

    const elevationChangeMeters = sample.elevationMeters - lastRiseReferenceMeters;
    if (elevationChangeMeters >= 2) {
      remainingAscentMeters += elevationChangeMeters;
      lastRiseReferenceMeters = sample.elevationMeters;
    } else if (elevationChangeMeters <= -2) {
      lastRiseReferenceMeters = sample.elevationMeters;
    }
  }

  return remainingAscentMeters;
}

function interpolateNullable(
  startValue: number | null,
  endValue: number | null,
  fraction: number,
): number | null {
  if (startValue === null || endValue === null) return null;
  return startValue + (endValue - startValue) * fraction;
}

function shortestLongitudeDelta(fromLongitude: number, toLongitude: number): number {
  let longitudeDelta = toLongitude - fromLongitude;
  if (longitudeDelta > 180) longitudeDelta -= 360;
  if (longitudeDelta < -180) longitudeDelta += 360;
  return longitudeDelta;
}
