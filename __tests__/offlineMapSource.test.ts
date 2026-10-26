import { parseGpxRoute } from '../src/domain/routes/gpx/parseGpxRoute';
import {
  boundsContain,
  CYCLECOMP_VPS_BASE_URL,
  INDONESIA_MAP_STYLE_URL,
  routeFitsJatiluwihMap,
  selectedAreaFromFrameCorners,
} from '../src/features/maps/offlineMapSource';

test('loads map resources from the public VPS IP over HTTPS', () => {
  expect(CYCLECOMP_VPS_BASE_URL).toBe('https://168.110.215.60:9443');
  expect(INDONESIA_MAP_STYLE_URL).toBe(
    `${CYCLECOMP_VPS_BASE_URL}/style-v4.json`,
  );
});

test('offers the local map for a route inside the Jatiluwih bounds', () => {
  const route = parseGpxRoute(
    '<gpx><trk><trkseg><trkpt lat="-8.5" lon="115.18" /></trkseg></trk></gpx>',
    'inside-map.gpx',
  );

  expect(routeFitsJatiluwihMap(route)).toBe(true);
});

test('does not offer the local map for a route outside its bounds', () => {
  const route = parseGpxRoute(
    '<gpx><trk><trkseg><trkpt lat="-7.0" lon="110.0" /></trkseg></trk></gpx>',
    'outside.gpx',
  );

  expect(routeFitsJatiluwihMap(route)).toBe(false);
});

test('offers Indonesia map for routes anywhere in Indonesia and rejects routes outside', () => {
  const javaRoute = parseGpxRoute(
    '<gpx><trk><trkseg><trkpt lat="-6.2" lon="106.8" /></trkseg></trk></gpx>',
    'jakarta.gpx',
  );
  const papuaRoute = parseGpxRoute(
    '<gpx><trk><trkseg><trkpt lat="-2.5" lon="140.7" /></trkseg></trk></gpx>',
    'jayapura.gpx',
  );
  const foreignRoute = parseGpxRoute(
    '<gpx><trk><trkseg><trkpt lat="48.85" lon="2.35" /></trkseg></trk></gpx>',
    'paris.gpx',
  );

  expect(boundsContain([94.5, -11.5, 141.5, 6.5], javaRoute.bounds)).toBe(true);
  expect(boundsContain([94.5, -11.5, 141.5, 6.5], papuaRoute.bounds)).toBe(true);
  expect(boundsContain([94.5, -11.5, 141.5, 6.5], foreignRoute.bounds)).toBe(false);
});

test('uses the projected blue frame corners as the downloaded area bounds', () => {
  expect(selectedAreaFromFrameCorners([
    [115.2, -8.5],
    [115.4, -8.52],
    [115.19, -8.3],
    [115.39, -8.32],
  ])).toEqual([115.19, -8.52, 115.4, -8.3]);
  expect(selectedAreaFromFrameCorners([
    [115.2, -8.5],
    [Number.NaN, -8.52],
    [115.19, -8.3],
    [115.39, -8.32],
  ])).toBeNull();
});
