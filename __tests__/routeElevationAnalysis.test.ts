import type { GpxRoute } from '../src/domain/routes/gpx/GpxRoute';
import type { ClimbSegment, RouteElevationAnalysis } from '../src/domain/routes/elevation/routeElevationAnalysis';
import {
  analyzeRouteElevation,
  distanceBetweenCoords,
  findClimbStateForRider,
  formatGradePercent,
  getGradeColor,
  getGradeLabel,
  getShortGradeLabel,
} from '../src/domain/routes/elevation/routeElevationAnalysis';

describe('routeElevationAnalysis', () => {
  test('measures route distance on the WGS84 ellipsoid', () => {
    expect(distanceBetweenCoords([0, 0], [1, 0])).toBeCloseTo(111319.490793, 6);
    expect(distanceBetweenCoords([1, 0], [0, 0])).toBeCloseTo(111319.490793, 6);
    expect(distanceBetweenCoords([115.2, -8.65], [115.2, -8.65])).toBe(0);
  });

  test('keeps resampled profile distances strictly increasing at exact 20 meter points', () => {
    const longitudeStepForTwentyMeters = 20 / 111319.49079327357;
    const routePoints = [0, 1, 2, 3].map(pointIndex => ({
      coordinate: [pointIndex * longitudeStepForTwentyMeters, 0] as [number, number],
      elevationMeters: pointIndex,
    }));
    const route: GpxRoute = {
      name: 'Twenty meter sample spacing',
      sourceFileName: 'twenty-meter-spacing.gpx',
      segments: [{ points: routePoints }],
      bounds: [0, 0, 3 * longitudeStepForTwentyMeters, 0],
      distanceMeters: 60,
      pointCount: routePoints.length,
      elevationPointCount: routePoints.length,
      minimumElevationMeters: 0,
      maximumElevationMeters: 3,
    };

    const sampleDistances = analyzeRouteElevation(route).samples.map(sample => sample.distanceMeters);

    expect(sampleDistances[0]).toBe(0);
    expect(sampleDistances.every((distance, index) => index === 0 || distance > sampleDistances[index - 1]!)).toBe(true);
  });

  test.each([0.02, 0.3, 0.49])('preserves both endpoints of a %s meter road', lengthMeters => {
    const endLongitude = lengthMeters / 111319.49079327357;
    const route: GpxRoute = {
      name: 'Short road segment', sourceFileName: 'short-road.gpx',
      segments: [{ points: [
        { coordinate: [0, 0], elevationMeters: -2 },
        { coordinate: [endLongitude, 0], elevationMeters: 0 },
      ] }],
      bounds: [0, 0, endLongitude, 0], distanceMeters: lengthMeters,
      pointCount: 2, elevationPointCount: 2, minimumElevationMeters: -2, maximumElevationMeters: 0,
    };
    const profile = analyzeRouteElevation(route);
    expect(profile.samples).toHaveLength(2);
    expect(profile.samples[1]?.coordinate).toEqual([endLongitude, 0]);
    expect(profile.totalDistanceMeters).toBeCloseTo(lengthMeters, 4);
    expect(profile.samples.every(sample => sample.gradePercent === null)).toBe(true);
    expect(profile.climbs).toHaveLength(0);
  });

  test('returns appropriate grade colors following Kontur/Garmin scheme', () => {
    expect(getGradeColor(null)).toBe('#8E8E93');
    expect(getGradeColor(-3.5)).toBe('#0284C7'); // Turunan
    expect(getGradeColor(1.2)).toBe('#10B981');  // Datar / Landai
    expect(getGradeColor(4.5)).toBe('#F59E0B');  // 3-6%
    expect(getGradeColor(7.8)).toBe('#F97316');  // 6-9%
    expect(getGradeColor(11.2)).toBe('#DC2626'); // 9-13%
    expect(getGradeColor(15.0)).toBe('#FF1E42'); // >=13%
  });

  test('keeps prepared road arc distances aligned with unknown surface intervals', () => {
    const elevations = [0, 10, null, null, 40, 50];
    const route: GpxRoute = {
      name: 'Prepared curved road', sourceFileName: 'prepared-road',
      segments: [{ points: elevations.map((elevationMeters, index) => ({
        coordinate: [index * 20 / 111319.49079327357, 0] as [number, number], elevationMeters,
      })) }],
      bounds: [0, 0, 0.001, 0], distanceMeters: 500,
      pointCount: 6, elevationPointCount: 4, minimumElevationMeters: 0, maximumElevationMeters: 50,
    };
    const analysis = analyzeRouteElevation(route, [[0, 100, 200, 300, 400, 500]]);
    expect(analysis.totalDistanceMeters).toBe(500);
    const unknownSamples = analysis.samples.filter(sample => sample.distanceMeters > 100 && sample.distanceMeters < 400);
    expect(unknownSamples.length).toBeGreaterThan(0);
    expect(unknownSamples.every(sample => sample.elevationMeters === null && sample.gradePercent === null)).toBe(true);
    expect(analysis.samples.find(sample => sample.distanceMeters === 400)?.elevationMeters).toBe(40);
    expect(() => analyzeRouteElevation(route, [[0, 100, 200, 199, 400, 500]])).toThrow('increase');
  });

  test('formats grade label and percent correctly', () => {
    expect(getGradeLabel(null)).toBe('—');
    expect(getGradeLabel(-4.0)).toBe('Turunan');
    expect(getGradeLabel(1.0)).toBe('Datar / Landai');
    expect(getGradeLabel(5.0)).toBe('Tanjakan ringan (3–6%)');
    expect(getGradeLabel(8.0)).toBe('Tanjakan sedang (6–9%)');
    expect(getGradeLabel(10.5)).toBe('Tanjakan curam (9–13%)');
    expect(getGradeLabel(14.0)).toBe('Tanjakan ekstrem (≥13%)');

    expect(getShortGradeLabel(null)).toBe('Gradien');
    expect(getShortGradeLabel(-4.0)).toBe('Turunan');
    expect(getShortGradeLabel(1.0)).toBe('Landai');
    expect(getShortGradeLabel(5.0)).toBe('Tanjakan ringan');
    expect(getShortGradeLabel(8.0)).toBe('Tanjakan sedang');
    expect(getShortGradeLabel(10.5)).toBe('Tanjakan curam');
    expect(getShortGradeLabel(14.0)).toBe('Tanjakan ekstrem');

    expect(formatGradePercent(null)).toBe('—');
    expect(formatGradePercent(6.5)).toBe('+6.5%');
    expect(formatGradePercent(-3.2)).toBe('-3.2%');
  });

  test('detects climbs and builds gradient colored GeoJSON features for route with elevation', () => {
    // Buat rute sintetis:
    // 0-400m datar (10m ele)
    // 400m-1000m tanjakan 60m naik (10m -> 70m) ~10% gradien
    // 1000m-1400m turunan (70m -> 20m)
    const points: { coordinate: [number, number]; elevationMeters: number }[] = [];
    const baseLat = -8.65;
    const baseLon = 115.2;

    // ~111m per 0.001 deg latitude
    // Titik 1-5: datar (jarak ~400m)
    for (let i = 0; i <= 4; i++) {
      points.push({
        coordinate: [baseLon, baseLat + i * 0.0009],
        elevationMeters: 10,
      });
    }

    // Titik 6-12: tanjakan (jarak ~600m, naik dari 10m ke 70m)
    for (let i = 5; i <= 11; i++) {
      const frac = (i - 4) / 7;
      points.push({
        coordinate: [baseLon, baseLat + i * 0.0009],
        elevationMeters: 10 + frac * 60,
      });
    }

    // Titik 13-16: turunan (jarak ~400m, turun dari 70m ke 20m)
    for (let i = 12; i <= 15; i++) {
      const frac = (i - 11) / 4;
      points.push({
        coordinate: [baseLon, baseLat + i * 0.0009],
        elevationMeters: 70 - frac * 50,
      });
    }

    const testRoute: GpxRoute = {
      name: 'Rute Uji Tanjakan',
      sourceFileName: 'test.gpx',
      segments: [{ points }],
      bounds: [baseLon, baseLat, baseLon, baseLat + 0.015],
      distanceMeters: 1500,
      pointCount: points.length,
      elevationPointCount: points.length,
      minimumElevationMeters: 10,
      maximumElevationMeters: 70,
    };

    const analysis = analyzeRouteElevation(testRoute);

    expect(analysis.samples.length).toBeGreaterThan(10);
    expect(analysis.totalDistanceMeters).toBeGreaterThan(1000);
    expect(analysis.totalAscentMeters).toBeGreaterThanOrEqual(50);
    expect(analysis.maxGradePercent).toBeGreaterThanOrEqual(7);

    // Harus terdeteksi minimal 1 tanjakan
    expect(analysis.climbs.length).toBeGreaterThanOrEqual(1);
    const climb = analysis.climbs[0];
    expect(climb.averageGradePercent).toBeGreaterThanOrEqual(3.0);
    expect(climb.elevationGainMeters).toBeGreaterThanOrEqual(20);
    expect(climb.netRiseMeters).toBeGreaterThanOrEqual(15);
    expect(climb.ascentMeters).toBe(climb.elevationGainMeters);
    expect(climb.descentMeters).toBeGreaterThanOrEqual(0);

    // Feature collection harus memiliki segmen berwarna
    expect(analysis.gradientFeatureCollection.features.length).toBeGreaterThan(0);
    const colors = analysis.gradientFeatureCollection.features.map(f => f.properties?.color);
    // Harus ada warna hijau (datar) dan oranye/merah (tanjakan) dan biru (turunan)
    expect(colors.some(c => c === '#10B981' || c === '#F97316' || c === '#DC2626' || c === '#0284C7')).toBe(true);
  });

  test('tracks active and upcoming climb alerts for rider position', () => {
    const baseLat = -8.65;
    const baseLon = 115.2;

    const points: { coordinate: [number, number]; elevationMeters: number }[] = [];
    // 0 - 500m datar
    for (let i = 0; i <= 5; i++) {
      points.push({ coordinate: [baseLon, baseLat + i * 0.0009], elevationMeters: 10 });
    }
    // 500m - 1200m tanjakan
    for (let i = 6; i <= 13; i++) {
      points.push({ coordinate: [baseLon, baseLat + i * 0.0009], elevationMeters: 10 + (i - 5) * 10 });
    }

    const testRoute: GpxRoute = {
      name: 'Rute Uji Tanjakan 2',
      sourceFileName: 'test2.gpx',
      segments: [{ points }],
      bounds: [baseLon, baseLat, baseLon, baseLat + 0.015],
      distanceMeters: 1400,
      pointCount: points.length,
      elevationPointCount: points.length,
      minimumElevationMeters: 10,
      maximumElevationMeters: 90,
    };

    const analysis = analyzeRouteElevation(testRoute);
    expect(analysis.climbs.length).toBeGreaterThanOrEqual(1);
    const climb = analysis.climbs[0];

    // Posisi rider di awal rute (sebelum tanjakan) -> upcoming alert
    const riderAtStart = points[1].coordinate;
    const alertUpcoming = findClimbStateForRider(riderAtStart, analysis);
    expect(alertUpcoming.type).toBe('upcoming');
    if (alertUpcoming.type === 'upcoming') {
      expect(alertUpcoming.distanceToStartMeters).toBeGreaterThan(0);
      expect(alertUpcoming.climb.id).toBe(climb.id);
    }

    // Posisi rider di tengah tanjakan -> active alert
    const riderInClimb = points[9].coordinate;
    const alertActive = findClimbStateForRider(riderInClimb, analysis);
    expect(alertActive.type).toBe('active');
    if (alertActive.type === 'active') {
      expect(alertActive.progressPercent).toBeGreaterThan(0);
      expect(alertActive.progressPercent).toBeLessThanOrEqual(100);
      expect(alertActive.distanceRemainingMeters).toBeGreaterThan(0);
    }
  });

  test('keeps signed elevations and does not count distance or gain across GPX segments', () => {
    const route: GpxRoute = {
      name: 'Separated negative elevations',
      sourceFileName: 'signed-segments.gpx',
      segments: [
        {
          points: [
            { coordinate: [106, -6], elevationMeters: -20 },
            { coordinate: [106, -5.999], elevationMeters: -10 },
          ],
        },
        {
          points: [
            { coordinate: [106, -5], elevationMeters: -100 },
            { coordinate: [106, -5.001], elevationMeters: -110 },
          ],
        },
      ],
      bounds: [106, -6, 106, -5],
      distanceMeters: 222,
      pointCount: 4,
      elevationPointCount: 4,
      minimumElevationMeters: -110,
      maximumElevationMeters: -10,
    };

    const analysis = analyzeRouteElevation(route);

    expect(analysis.totalDistanceMeters).toBeCloseTo(221.2, 0);
    expect(analysis.totalAscentMeters).toBe(10);
    expect(analysis.totalDescentMeters).toBe(10);
    expect(analysis.minElevationMeters).toBe(-110);
    expect(analysis.maxElevationMeters).toBe(-10);
    expect(analysis.samples.some(sample => sample.gradePercent !== null && sample.gradePercent > 0)).toBe(true);
    expect(analysis.samples.some(sample => sample.gradePercent !== null && sample.gradePercent < 0)).toBe(true);
    expect(analysis.gradientFeatureCollection.features.length).toBeGreaterThanOrEqual(2);
    expect(analysis.gradientFeatureCollection.features.every(feature => {
      const latitudes = feature.geometry.coordinates.map(([, latitude]) => latitude);
      return latitudes.every(latitude => latitude < -5.5) || latitudes.every(latitude => latitude > -5.5);
    })).toBe(true);
  });

  test('keeps unknown elevation gaps from joining separate climbs', () => {
    const baseLongitude = 115.2;
    const baseLatitude = -8.65;
    const points = [
      ...Array.from({ length: 21 }, (_, index) => ({
        coordinate: [baseLongitude, baseLatitude + (index * 20) / 111_195] as [number, number],
        elevationMeters: index * 2,
      })),
      { coordinate: [baseLongitude, baseLatitude + 420 / 111_195] as [number, number], elevationMeters: null },
      { coordinate: [baseLongitude, baseLatitude + 520 / 111_195] as [number, number], elevationMeters: null },
      ...Array.from({ length: 21 }, (_, index) => ({
        coordinate: [baseLongitude, baseLatitude + (540 + index * 20) / 111_195] as [number, number],
        elevationMeters: index * 2,
      })),
    ];
    const route: GpxRoute = {
      name: 'Rute dengan gap elevasi',
      sourceFileName: 'elevation-gap.gpx',
      segments: [{ points }],
      bounds: [baseLongitude, baseLatitude, baseLongitude, baseLatitude + 940 / 111_195],
      distanceMeters: 940,
      pointCount: points.length,
      elevationPointCount: points.filter(point => point.elevationMeters !== null).length,
      minimumElevationMeters: 0,
      maximumElevationMeters: 40,
    };

    const analysis = analyzeRouteElevation(route);

    expect(analysis.samples.some(sample => sample.elevationMeters === null)).toBe(true);
    expect(analysis.climbs).toHaveLength(2);
    expect(analysis.climbs.every(climb => climb.distanceMeters < 450)).toBe(true);
    expect(analysis.totalAscentMeters).toBe(77);
  });

  test('projects the rider onto the route and counts future rises through a rolling climb', () => {
    const coordinateAtDistance = (distanceMeters: number): [number, number] => [
      115.2,
      -8.65 + distanceMeters / 111_195,
    ];
    const climb: ClimbSegment = {
      id: 1,
      startDistanceMeters: 0,
      endDistanceMeters: 400,
      distanceMeters: 400,
      elevationGainMeters: 35,
      averageGradePercent: 6.3,
      maxGradePercent: 10,
      startElevationMeters: 0,
      endElevationMeters: 25,
      startCoordinate: coordinateAtDistance(0),
      endCoordinate: coordinateAtDistance(400),
    };
    const analysis: RouteElevationAnalysis = {
      samples: [0, 100, 200, 300, 400].map((distanceMeters, index) => ({
        coordinate: coordinateAtDistance(distanceMeters),
        distanceMeters,
        elevationMeters: [0, 10, 20, 15, 25][index] ?? null,
        gradePercent: 6,
        segmentIndex: 0,
      })),
      climbs: [climb],
      totalDistanceMeters: 400,
      totalAscentMeters: 35,
      totalDescentMeters: 5,
      minElevationMeters: 0,
      maxElevationMeters: 25,
      maxGradePercent: 10,
      gradientFeatureCollection: { type: 'FeatureCollection', features: [] },
    };

    const alert = findClimbStateForRider(coordinateAtDistance(150), analysis);

    expect(alert.type).toBe('active');
    if (alert.type === 'active') {
      expect(alert.distanceRemainingMeters).toBe(250);
      expect(alert.progressPercent).toBe(38);
      expect(alert.currentElevationMeters).toBeCloseTo(15, 1);
      expect(alert.gainRemainingMeters).toBe(15);
    }
  });

  test('does not attach a climb alert to a rider far away from the GPX track', () => {
    const baseLatitude = -8.65;
    const baseLongitude = 115.2;
    const route = analyzeRouteElevation({
      name: 'Short climb',
      sourceFileName: 'short-climb.gpx',
      segments: [{
        points: Array.from({ length: 20 }, (_, index) => ({
          coordinate: [baseLongitude, baseLatitude + index * 0.0002] as [number, number],
          elevationMeters: index * 3,
        })),
      }],
      bounds: [baseLongitude, baseLatitude, baseLongitude, baseLatitude + 0.0038],
      distanceMeters: 422,
      pointCount: 20,
      elevationPointCount: 20,
      minimumElevationMeters: 0,
      maximumElevationMeters: 57,
    });

    const alert = findClimbStateForRider([baseLongitude + 0.01, baseLatitude + 0.001], route);

    expect(alert).toMatchObject({
      type: 'none',
      currentGradePercent: null,
      currentElevationMeters: null,
      nextClimbDistanceMeters: null,
    });
  });
});
