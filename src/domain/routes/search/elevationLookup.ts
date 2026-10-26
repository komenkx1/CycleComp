import type { RouteCoordinate } from '../gpx/GpxRoute';
import {
  sampleElevationGrid,
  type ElevationGridWindow,
} from '../../terrain/elevationGrid';
import { CYCLECOMP_VPS_BASE_URL } from '../../../features/maps/offlineMapSource';

export class ElevationLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ElevationLookupError';
  }
}

export const OPEN_METEO_ELEVATION_URL = 'https://api.open-meteo.com/v1/elevation';
export const DEFAULT_SELF_HOSTED_ELEVATION_URL = `${CYCLECOMP_VPS_BASE_URL}/v1/elevation/batch`;

const MAX_SELF_HOSTED_BATCH_COORDS = 2_000;
const MAX_OPEN_METEO_COORDS = 100;

export interface ElevationLookupOptions {
  /** Decoded local grid windows from a verified terrain pack. */
  offlineGridWindows?: readonly ElevationGridWindow[];
  /** Leave uncovered points unknown when the caller is preparing offline. */
  allowOnlineFallback?: boolean;
  /** Primary self-hosted elevation API endpoint url. Set to null to skip self-hosted lookup. */
  primaryElevationUrl?: string | null;
}

interface SelfHostedElevationSample {
  index: number;
  elevationMeters: number | null;
  reason?: string | null;
}

interface SelfHostedElevationResponse {
  requestId?: string;
  datasetVersion?: string;
  verticalDatum?: string;
  samples: SelfHostedElevationSample[];
}

interface OpenMeteoElevationResponse {
  elevation: unknown[];
}

/**
 * Look up elevation for a list of coordinates.
 *
 * @param coordinates Array of [longitude, latitude] pairs.
 * @returns Array of elevation values in metres (same length as input).
 */
export async function lookupElevations(
  coordinates: RouteCoordinate[],
  options: ElevationLookupOptions = {},
): Promise<(number | null)[]> {
  if (coordinates.length === 0) {
    return [];
  }

  if (coordinates.some(([longitude, latitude]) =>
    !Number.isFinite(longitude) || !Number.isFinite(latitude) ||
    longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90,
  )) {
    throw new ElevationLookupError('Daftar koordinat rute berisi titik yang tidak valid.');
  }

  const offlineGridWindows = options.offlineGridWindows ?? [];
  const elevationsByCoordinate = coordinates.map(coordinate =>
    findOfflineElevation(coordinate, offlineGridWindows),
  );
  const coordinatesNeedingOnlineLookup = coordinates
    .map((coordinate, index) => ({ coordinate, index }))
    .filter(({ index }) => elevationsByCoordinate[index] === null);

  if (options.allowOnlineFallback === false || coordinatesNeedingOnlineLookup.length === 0) {
    return elevationsByCoordinate;
  }

  const primaryUrl = options.primaryElevationUrl !== undefined
    ? options.primaryElevationUrl
    : DEFAULT_SELF_HOSTED_ELEVATION_URL;

  const onlineElevations = await lookupOnlineElevations(
    coordinatesNeedingOnlineLookup.map(({ coordinate }) => coordinate),
    primaryUrl,
  );

  for (let index = 0; index < coordinatesNeedingOnlineLookup.length; index++) {
    const originalIndex = coordinatesNeedingOnlineLookup[index]!.index;
    elevationsByCoordinate[originalIndex] = onlineElevations[index] ?? null;
  }

  return elevationsByCoordinate;
}

function findOfflineElevation(
  coordinate: RouteCoordinate,
  offlineGridWindows: readonly ElevationGridWindow[],
): number | null {
  for (const gridWindow of offlineGridWindows) {
    const elevationMeters = sampleElevationGrid(gridWindow, coordinate);
    if (elevationMeters !== null) {
      return elevationMeters;
    }
  }

  return null;
}

async function lookupOnlineElevations(
  coordinates: RouteCoordinate[],
  primaryUrl: string | null,
): Promise<(number | null)[]> {
  const results: (number | null)[] = new Array(coordinates.length).fill(null);
  const fallbackIndices: number[] = [];

  if (primaryUrl) {
    for (let start = 0; start < coordinates.length; start += MAX_SELF_HOSTED_BATCH_COORDS) {
      const batchCoords = coordinates.slice(start, start + MAX_SELF_HOSTED_BATCH_COORDS);
      try {
        const batchResults = await fetchSelfHostedElevationBatch(batchCoords, primaryUrl);
        for (let i = 0; i < batchCoords.length; i++) {
          const sampleElevation = batchResults[i];
          if (sampleElevation !== null && sampleElevation !== undefined) {
            results[start + i] = sampleElevation;
          } else {
            fallbackIndices.push(start + i);
          }
        }
      } catch {
        // Primary endpoint unavailable or errored; mark entire batch for fallback
        for (let i = 0; i < batchCoords.length; i++) {
          fallbackIndices.push(start + i);
        }
      }
    }
  } else {
    for (let i = 0; i < coordinates.length; i++) {
      fallbackIndices.push(i);
    }
  }

  if (fallbackIndices.length > 0) {
    const fallbackCoords = fallbackIndices.map(idx => coordinates[idx]!);
    try {
      const openMeteoResults = await lookupOpenMeteoElevations(fallbackCoords);
      for (let i = 0; i < fallbackIndices.length; i++) {
        const targetIndex = fallbackIndices[i]!;
        results[targetIndex] = openMeteoResults[i] ?? null;
      }
    } catch (fallbackError) {
      // If we have no resolved elevations at all, throw the error
      const anySuccess = results.some(val => val !== null);
      if (!anySuccess && fallbackIndices.length === coordinates.length) {
        throw fallbackError;
      }
    }
  }

  return results;
}

export const DEFAULT_ELEVATION_TIMEOUT_MS = 10_000;

async function fetchWithDeadline(
  url: string,
  options: RequestInit,
  timeoutMs: number = DEFAULT_ELEVATION_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  let timerId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => {
      controller.abort();
      reject(new ElevationLookupError(`Batas waktu permintaan elevasi terlampaui (${timeoutMs}ms).`));
    }, timeoutMs);
  });

  try {
    const fetchPromise = fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return await Promise.race([fetchPromise, timeoutPromise]);
  } finally {
    clearTimeout(timerId);
  }
}

async function readJsonWithDeadline<T>(
  response: Response,
  timeoutMs: number = DEFAULT_ELEVATION_TIMEOUT_MS,
): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => {
      reject(new ElevationLookupError(`Batas waktu pembacaan respons elevasi terlampaui (${timeoutMs}ms).`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([response.json() as Promise<T>, timeoutPromise]);
  } finally {
    clearTimeout(timerId);
  }
}

async function fetchSelfHostedElevationBatch(
  coords: RouteCoordinate[],
  url: string,
): Promise<(number | null)[]> {
  let response: Response;
  try {
    response = await fetchWithDeadline(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        coordinates: coords.map(([longitude, latitude]) => ({
          longitude,
          latitude,
        })),
      }),
    });
  } catch (error) {
    throw new ElevationLookupError(
      `Gagal terhubung ke endpoint elevasi: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    throw new ElevationLookupError(
      `Endpoint elevasi merespons status ${response.status}`,
    );
  }

  let body: unknown;
  try {
    body = await readJsonWithDeadline(response);
  } catch (error) {
    if (error instanceof ElevationLookupError) {
      throw error;
    }
    throw new ElevationLookupError('Respons endpoint elevasi bukan JSON yang valid.');
  }

  // Support self-hosted response format { samples: [{ index, elevationMeters, ... }] }
  const selfHosted = body as Partial<SelfHostedElevationResponse> | null;
  if (Array.isArray(selfHosted?.samples)) {
    if (selfHosted.samples.length !== coords.length) {
      throw new ElevationLookupError('Jumlah sampel elevasi tidak cocok dengan koordinat.');
    }
    const alignedResults: (number | null)[] = new Array(coords.length).fill(null);
    const seenIndices = new Set<number>();
    for (const sample of selfHosted.samples) {
      if (
        typeof sample.index !== 'number' ||
        sample.index < 0 ||
        sample.index >= coords.length ||
        seenIndices.has(sample.index)
      ) {
        throw new ElevationLookupError('Index sampel elevasi tidak valid atau terduplikasi.');
      }
      seenIndices.add(sample.index);
      alignedResults[sample.index] =
        typeof sample.elevationMeters === 'number' && Number.isFinite(sample.elevationMeters)
          ? sample.elevationMeters
          : null;
    }
    return alignedResults;
  }

  // Also support Open-Meteo style mock if passed as primary url
  const openMeteo = body as Partial<OpenMeteoElevationResponse> | null;
  if (Array.isArray(openMeteo?.elevation)) {
    if (openMeteo.elevation.length !== coords.length) {
      throw new ElevationLookupError('Jumlah sampel elevasi tidak cocok dengan koordinat.');
    }
    return openMeteo.elevation.map(sample =>
      typeof sample === 'number' && Number.isFinite(sample) ? sample : null,
    );
  }

  throw new ElevationLookupError('Format respons elevasi tidak dikenali.');
}

async function lookupOpenMeteoElevations(
  coordinates: RouteCoordinate[],
): Promise<(number | null)[]> {
  const onlineElevations: (number | null)[] = [];

  for (let startIndex = 0; startIndex < coordinates.length; startIndex += MAX_OPEN_METEO_COORDS) {
    const coordinateBatch = coordinates.slice(startIndex, startIndex + MAX_OPEN_METEO_COORDS);
    onlineElevations.push(...await fetchOpenMeteoChunk(coordinateBatch));
  }

  return onlineElevations;
}

async function fetchOpenMeteoChunk(
  coords: RouteCoordinate[],
): Promise<(number | null)[]> {
  const latitudes = coords.map(([_lng, lat]) => lat.toFixed(6)).join(',');
  const longitudes = coords.map(([lng, _lat]) => lng.toFixed(6)).join(',');

  const url = `${OPEN_METEO_ELEVATION_URL}?latitude=${latitudes}&longitude=${longitudes}`;

  let response: Response;
  try {
    response = await fetchWithDeadline(url, {
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new ElevationLookupError(
      'Gagal mengambil data elevasi. Periksa koneksi internet Anda.',
    );
  }

  if (!response.ok) {
    throw new ElevationLookupError(
      `Server elevasi merespons dengan kode ${response.status}. Coba lagi nanti.`,
    );
  }

  let responseBody: unknown;
  try {
    responseBody = await readJsonWithDeadline(response);
  } catch {
    throw new ElevationLookupError('Format respons elevasi tidak dikenali.');
  }

  const elevations = (responseBody as Partial<OpenMeteoElevationResponse> | null)?.elevation;

  if (!Array.isArray(elevations) || elevations.length !== coords.length) {
    throw new ElevationLookupError('Format respons elevasi tidak dikenali.');
  }

  return elevations.map(elevationMeters =>
    typeof elevationMeters === 'number' && Number.isFinite(elevationMeters)
      ? elevationMeters
      : null,
  );
}
