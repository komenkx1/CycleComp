import { SaxesParser, type SaxesTagNS } from 'saxes';

import type {
  GpxRoute,
  GpxRoutePoint,
  GpxRouteSegment,
  RouteBounds,
} from './GpxRoute';

const EARTH_RADIUS_METERS = 6_371_008.8;
const MAXIMUM_ROUTE_POINT_COUNT = 250_000;
const XML_PARSE_CHUNK_SIZE = 64 * 1024;

export class GpxValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GpxValidationError';
  }
}

interface GpxParserState {
  elementPath: string[];
  elementText: string;
  metadataName: string | null;
  trackName: string | null;
  trackSegments: GpxRouteSegment[];
  currentTrackSegment: GpxRouteSegment | null;
  routePoints: GpxRoutePoint[];
  currentRoutePoint: GpxRoutePoint | null;
  totalPointCount: number;
  rootFound: boolean;
  parserError: Error | null;
}

export function parseGpxRoute(
  gpxXml: string,
  sourceFileName: string,
): GpxRoute {
  if (/<!DOCTYPE/i.test(gpxXml)) {
    throw new GpxValidationError('GPX dengan deklarasi DOCTYPE tidak didukung.');
  }

  const parserState: GpxParserState = {
    elementPath: [],
    elementText: '',
    metadataName: null,
    trackName: null,
    trackSegments: [],
    currentTrackSegment: null,
    routePoints: [],
    currentRoutePoint: null,
    totalPointCount: 0,
    rootFound: false,
    parserError: null,
  };

  const xmlParser = new SaxesParser({ xmlns: true });

  xmlParser.on('error', parserError => {
    parserState.parserError = parserError;
  });

  xmlParser.on('opentag', tag => {
    openGpxElement(parserState, tag);
  });

  xmlParser.on('text', text => {
    parserState.elementText += text;
  });

  xmlParser.on('cdata', text => {
    parserState.elementText += text;
  });

  xmlParser.on('closetag', tag => {
    closeGpxElement(parserState, tag.local);
  });

  try {
    for (
      let chunkStart = 0;
      chunkStart < gpxXml.length;
      chunkStart += XML_PARSE_CHUNK_SIZE
    ) {
      xmlParser.write(
        gpxXml.slice(chunkStart, chunkStart + XML_PARSE_CHUNK_SIZE),
      );
    }
    xmlParser.close();
  } catch (error) {
    throw normalizeParserError(error);
  }

  if (parserState.parserError) {
    throw normalizeParserError(parserState.parserError);
  }

  if (!parserState.rootFound) {
    throw new GpxValidationError('File tidak memiliki elemen GPX.');
  }

  const routeSegments = selectRouteSegments(parserState);

  if (routeSegments.length === 0) {
    throw new GpxValidationError('GPX tidak memiliki track atau route point.');
  }

  return buildGpxRoute(routeSegments, parserState, sourceFileName);
}

function openGpxElement(parserState: GpxParserState, tag: SaxesTagNS) {
  parserState.elementPath.push(tag.local);
  parserState.elementText = '';

  if (tag.local === 'gpx') {
    parserState.rootFound = true;
    return;
  }

  if (tag.local === 'trkseg') {
    parserState.currentTrackSegment = { points: [] };
    return;
  }

  if (tag.local === 'trkpt' || tag.local === 'rtept') {
    parserState.currentRoutePoint = parseRoutePointCoordinates(tag);
    parserState.totalPointCount += 1;

    if (parserState.totalPointCount > MAXIMUM_ROUTE_POINT_COUNT) {
      throw new GpxValidationError(
        `GPX melebihi batas ${MAXIMUM_ROUTE_POINT_COUNT.toLocaleString('id-ID')} titik.`,
      );
    }
  }
}

function closeGpxElement(parserState: GpxParserState, elementName: string) {
  const trimmedElementText = parserState.elementText.trim();

  if (elementName === 'name') {
    saveRouteName(parserState, trimmedElementText);
  } else if (elementName === 'ele' && parserState.currentRoutePoint) {
    const elevationMeters = parseElevation(trimmedElementText);
    parserState.currentRoutePoint.elevationMeters = elevationMeters;
    if (elevationMeters !== null) {
      parserState.currentRoutePoint.elevationSource = 'gpx_file';
    }
  } else if (elementName === 'trkpt') {
    saveTrackPoint(parserState);
  } else if (elementName === 'rtept') {
    saveFallbackRoutePoint(parserState);
  } else if (elementName === 'trkseg') {
    saveTrackSegment(parserState);
  }

  parserState.elementPath.pop();
  parserState.elementText = '';
}

function parseRoutePointCoordinates(tag: SaxesTagNS): GpxRoutePoint {
  const latitude = parseCoordinateAttribute(tag, 'lat');
  const longitude = parseCoordinateAttribute(tag, 'lon');

  if (latitude < -90 || latitude > 90) {
    throw new GpxValidationError(`Latitude di luar rentang: ${latitude}.`);
  }

  if (longitude < -180 || longitude > 180) {
    throw new GpxValidationError(`Longitude di luar rentang: ${longitude}.`);
  }

  return {
    coordinate: [longitude, latitude],
    elevationMeters: null,
  };
}

function parseCoordinateAttribute(tag: SaxesTagNS, attributeName: string) {
  const attributeValue = tag.attributes[attributeName]?.value;
  const coordinate = Number(attributeValue);

  if (attributeValue === undefined || !Number.isFinite(coordinate)) {
    throw new GpxValidationError(
      `Track point memiliki ${attributeName} yang tidak valid.`,
    );
  }

  return coordinate;
}

function parseElevation(elementText: string) {
  if (elementText.length === 0) {
    return null;
  }

  const elevationMeters = Number(elementText);
  return Number.isFinite(elevationMeters) ? elevationMeters : null;
}

function saveRouteName(parserState: GpxParserState, routeName: string) {
  if (routeName.length === 0) {
    return;
  }

  const parentPath = parserState.elementPath.slice(0, -1).join('/');

  if (parentPath === 'gpx/metadata') {
    parserState.metadataName = routeName;
  } else if (parentPath === 'gpx/trk' && parserState.trackName === null) {
    parserState.trackName = routeName;
  }
}

function saveTrackPoint(parserState: GpxParserState) {
  if (!parserState.currentRoutePoint || !parserState.currentTrackSegment) {
    throw new GpxValidationError('Track point berada di luar track segment.');
  }

  parserState.currentTrackSegment.points.push(parserState.currentRoutePoint);
  parserState.currentRoutePoint = null;
}

function saveFallbackRoutePoint(parserState: GpxParserState) {
  if (!parserState.currentRoutePoint) {
    throw new GpxValidationError('Route point tidak dapat dibaca.');
  }

  parserState.routePoints.push(parserState.currentRoutePoint);
  parserState.currentRoutePoint = null;
}

function saveTrackSegment(parserState: GpxParserState) {
  const currentTrackSegment = parserState.currentTrackSegment;

  if (currentTrackSegment && currentTrackSegment.points.length > 0) {
    parserState.trackSegments.push(currentTrackSegment);
  }

  parserState.currentTrackSegment = null;
}

function selectRouteSegments(parserState: GpxParserState) {
  if (parserState.trackSegments.length > 0) {
    return parserState.trackSegments;
  }

  if (parserState.routePoints.length > 0) {
    return [{ points: parserState.routePoints }];
  }

  return [];
}

function buildGpxRoute(
  routeSegments: GpxRouteSegment[],
  parserState: GpxParserState,
  sourceFileName: string,
): GpxRoute {
  const routePoints = routeSegments.flatMap(segment => segment.points);
  const elevationsMeters = routePoints.flatMap(routePoint =>
    routePoint.elevationMeters === null
      ? []
      : [routePoint.elevationMeters],
  );
  const elevationRange = calculateElevationRange(elevationsMeters);

  return {
    name:
      parserState.trackName ??
      parserState.metadataName ??
      removeGpxFileExtension(sourceFileName),
    sourceFileName,
    segments: routeSegments,
    bounds: calculateRouteBounds(routePoints),
    distanceMeters: calculateRouteDistance(routeSegments),
    pointCount: routePoints.length,
    elevationPointCount: elevationsMeters.length,
    minimumElevationMeters: elevationRange.minimumElevationMeters,
    maximumElevationMeters: elevationRange.maximumElevationMeters,
  };
}

function calculateElevationRange(elevationsMeters: number[]) {
  if (elevationsMeters.length === 0) {
    return {
      minimumElevationMeters: null,
      maximumElevationMeters: null,
    };
  }

  let minimumElevationMeters = elevationsMeters[0] ?? 0;
  let maximumElevationMeters = minimumElevationMeters;

  for (const elevationMeters of elevationsMeters.slice(1)) {
    minimumElevationMeters = Math.min(minimumElevationMeters, elevationMeters);
    maximumElevationMeters = Math.max(maximumElevationMeters, elevationMeters);
  }

  return { minimumElevationMeters, maximumElevationMeters };
}

function calculateRouteBounds(routePoints: GpxRoutePoint[]): RouteBounds {
  const firstRoutePoint = routePoints[0];

  if (!firstRoutePoint) {
    throw new GpxValidationError('GPX tidak memiliki titik yang dapat dipetakan.');
  }

  let west = firstRoutePoint.coordinate[0];
  let south = firstRoutePoint.coordinate[1];
  let east = west;
  let north = south;

  for (const routePoint of routePoints.slice(1)) {
    const [longitude, latitude] = routePoint.coordinate;
    west = Math.min(west, longitude);
    south = Math.min(south, latitude);
    east = Math.max(east, longitude);
    north = Math.max(north, latitude);
  }

  return [west, south, east, north];
}

function calculateRouteDistance(routeSegments: GpxRouteSegment[]) {
  return routeSegments.reduce((totalRouteDistance, routeSegment) => {
    let segmentDistance = 0;

    for (
      let pointIndex = 1;
      pointIndex < routeSegment.points.length;
      pointIndex += 1
    ) {
      const previousRoutePoint = routeSegment.points[pointIndex - 1];
      const currentRoutePoint = routeSegment.points[pointIndex];

      if (previousRoutePoint && currentRoutePoint) {
        segmentDistance += calculateDistanceBetweenPoints(
          previousRoutePoint,
          currentRoutePoint,
        );
      }
    }

    return totalRouteDistance + segmentDistance;
  }, 0);
}

function calculateDistanceBetweenPoints(
  firstRoutePoint: GpxRoutePoint,
  secondRoutePoint: GpxRoutePoint,
) {
  const [firstLongitude, firstLatitude] = firstRoutePoint.coordinate;
  const [secondLongitude, secondLatitude] = secondRoutePoint.coordinate;
  const latitudeDifference = degreesToRadians(secondLatitude - firstLatitude);
  const longitudeDifference = degreesToRadians(
    secondLongitude - firstLongitude,
  );
  const firstLatitudeRadians = degreesToRadians(firstLatitude);
  const secondLatitudeRadians = degreesToRadians(secondLatitude);
  const haversine =
    Math.sin(latitudeDifference / 2) ** 2 +
    Math.cos(firstLatitudeRadians) *
      Math.cos(secondLatitudeRadians) *
      Math.sin(longitudeDifference / 2) ** 2;

  return (
    2 *
    EARTH_RADIUS_METERS *
    Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
  );
}

function degreesToRadians(degrees: number) {
  return (degrees * Math.PI) / 180;
}

function removeGpxFileExtension(fileName: string) {
  return fileName.replace(/\.gpx$/i, '');
}

function normalizeParserError(error: unknown) {
  if (error instanceof GpxValidationError) {
    return error;
  }

  if (error instanceof Error) {
    return new GpxValidationError(`XML GPX tidak valid: ${error.message}`);
  }

  return new GpxValidationError('XML GPX tidak valid.');
}
