import {
  GpxValidationError,
  parseGpxRoute,
} from '../src/domain/routes/gpx/parseGpxRoute';

test('parses a synthetic route without joining unrelated segments', () => {
  const gpxXml = `<?xml version="1.0"?>
    <gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
      <metadata><name>Test route</name></metadata>
      <trk><trkseg>
        <trkpt lat="-8.5" lon="115.1"><ele>15</ele></trkpt>
        <trkpt lat="-8.501" lon="115.101"><ele>20</ele></trkpt>
      </trkseg></trk>
    </gpx>`;
  const route = parseGpxRoute(gpxXml, 'test-route.gpx');

  expect(route.name).toBe('Test route');
  expect(route.segments).toHaveLength(1);
  expect(route.pointCount).toBe(2);
  expect(route.elevationPointCount).toBe(2);
  expect(route.distanceMeters).toBeGreaterThan(0);
  expect(route.minimumElevationMeters).toBe(15);
  expect(route.maximumElevationMeters).toBe(20);
});

test('uses route points when a GPX does not contain a track', () => {
  const route = parseGpxRoute(
    `<?xml version="1.0"?>
      <gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
        <metadata><name>Fallback route</name></metadata>
        <rte>
          <rtept lat="-8.5" lon="115.1"><ele>100</ele></rtept>
          <rtept lat="-8.6" lon="115.2"><ele>120</ele></rtept>
        </rte>
      </gpx>`,
    'fallback.gpx',
  );

  expect(route.name).toBe('Fallback route');
  expect(route.segments).toHaveLength(1);
  expect(route.pointCount).toBe(2);
  expect(route.bounds).toEqual([115.1, -8.6, 115.2, -8.5]);
});

test('rejects invalid coordinates', () => {
  const invalidGpx = `<?xml version="1.0"?>
    <gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
      <trk><trkseg><trkpt lat="-95" lon="115" /></trkseg></trk>
    </gpx>`;

  expect(() => parseGpxRoute(invalidGpx, 'invalid.gpx')).toThrow(
    GpxValidationError,
  );
});

test('preserves elevations below sea level', () => {
  const route = parseGpxRoute(
    `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
      <trk><trkseg>
        <trkpt lat="-6.0" lon="106.0"><ele>-12.5</ele></trkpt>
        <trkpt lat="-6.001" lon="106.0"><ele>-8</ele></trkpt>
      </trkseg></trk>
    </gpx>`,
    'below-sea-level.gpx',
  );

  expect(route.minimumElevationMeters).toBe(-12.5);
  expect(route.maximumElevationMeters).toBe(-8);
  expect(route.segments[0]?.points[0]?.elevationMeters).toBe(-12.5);
  expect(route.segments[0]?.points[0]?.elevationSource).toBe('gpx_file');
});

test('rejects a document type declaration', () => {
  const gpxWithDoctype = `<?xml version="1.0"?>
    <!DOCTYPE gpx [<!ENTITY unsafe SYSTEM "file:///etc/passwd">]>
    <gpx version="1.1"><trk /></gpx>`;

  expect(() => parseGpxRoute(gpxWithDoctype, 'unsafe.gpx')).toThrow(
    'DOCTYPE',
  );
});
