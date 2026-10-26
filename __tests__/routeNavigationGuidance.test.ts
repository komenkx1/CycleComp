import {
  calculateBearing,
  calculateTurnAngle,
  classifyManeuver,
  formatNavigationDistance,
  getNavigationGuidance,
} from '../src/domain/routes/navigation/routeNavigationGuidance';
import type { RouteCoordinate } from '../src/domain/routes/gpx/GpxRoute';

describe('routeNavigationGuidance', () => {
  describe('calculateBearing', () => {
    test('calculates cardinal bearings correctly', () => {
      // Due north (latitude increases)
      const north = calculateBearing([115.0, -8.5], [115.0, -8.4]);
      expect(Math.round(north)).toBe(0);

      // Due east (longitude increases)
      const east = calculateBearing([115.0, -8.5], [115.1, -8.5]);
      expect(Math.round(east)).toBe(90);

      // Due south (latitude decreases)
      const south = calculateBearing([115.0, -8.4], [115.0, -8.5]);
      expect(Math.round(south)).toBe(180);

      // Due west (longitude decreases)
      const west = calculateBearing([115.1, -8.5], [115.0, -8.5]);
      expect(Math.round(west)).toBe(270);
    });
  });

  describe('calculateTurnAngle & classifyManeuver', () => {
    test('identifies straight maneuvers', () => {
      const angle = calculateTurnAngle(90, 95);
      const maneuver = classifyManeuver(angle);
      expect(maneuver.type).toBe('straight');
    });

    test('identifies right turns', () => {
      const angle = calculateTurnAngle(0, 85);
      const maneuver = classifyManeuver(angle);
      expect(maneuver.type).toBe('right');
    });

    test('identifies sharp right turns', () => {
      const angle = calculateTurnAngle(0, 115);
      const maneuver = classifyManeuver(angle);
      expect(maneuver.type).toBe('sharp_right');
    });

    test('identifies left turns', () => {
      const angle = calculateTurnAngle(90, 10);
      const maneuver = classifyManeuver(angle);
      expect(maneuver.type).toBe('left');
    });

    test('identifies u-turns', () => {
      const angle = calculateTurnAngle(0, 175);
      const maneuver = classifyManeuver(angle);
      expect(maneuver.type).toBe('u_turn');
    });
  });

  describe('formatNavigationDistance', () => {
    test('formats immediate turns (<30m)', () => {
      expect(formatNavigationDistance(15)).toBe('Sekarang');
    });

    test('formats meter distances rounded to tens', () => {
      expect(formatNavigationDistance(148)).toBe('150 m');
      expect(formatNavigationDistance(452)).toBe('450 m');
    });

    test('formats kilometer distances with comma decimal', () => {
      expect(formatNavigationDistance(1250)).toBe('1,3 km');
      expect(formatNavigationDistance(3500)).toBe('3,5 km');
    });
  });

  describe('getNavigationGuidance', () => {
    const testRoute: RouteCoordinate[] = [
      [115.2000, -8.6500], // Start: heading north
      [115.2000, -8.6480], // 220m north
      [115.2000, -8.6460], // 440m north
      [115.2020, -8.6460], // Turn east (90 deg turn)
      [115.2040, -8.6460], // 220m east
      [115.2040, -8.6440], // Turn north again
      [115.2040, -8.6420], // Finish
    ];

    test('returns start guidance when rider position is not yet known', () => {
      const guidance = getNavigationGuidance(testRoute, null);
      expect(guidance).not.toBeNull();
      expect(guidance!.title).toBe('Mulai rute');
    });

    test('detects upcoming right turn and secondary "then" turn ahead', () => {
      const riderPos: RouteCoordinate = [115.2000, -8.6490];
      const guidance = getNavigationGuidance(testRoute, riderPos);

      expect(guidance).not.toBeNull();
      expect(guidance!.type).toBe('right');
      expect(guidance!.title).toBe('Belok kanan');
      expect(guidance!.distanceMeters).toBeGreaterThan(0);
      expect(guidance!.thenManeuver).toBeDefined();
    });

    test('detects finish when rider is near destination', () => {
      const riderNearEnd: RouteCoordinate = [115.2040, -8.6425];
      const guidance = getNavigationGuidance(testRoute, riderNearEnd);

      expect(guidance).not.toBeNull();
      expect(guidance!.type).toBe('finish');
      expect(guidance!.title).toBe('Tiba di tujuan');
    });
  });
});
