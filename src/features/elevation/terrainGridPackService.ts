import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

import type { RouteBounds, RouteCoordinate } from '../../domain/routes/gpx/GpxRoute';
import { CYCLECOMP_VPS_BASE_URL } from '../maps/offlineMapSource';

const MAX_COORDINATES_PER_NATIVE_BATCH = 2_000;
const CATALOG_REQUEST_TIMEOUT_MS = 8_000;
const TERRAIN_AREA_REQUEST_TIMEOUT_MS = 15_000;
const TERRAIN_AREA_POLL_INTERVAL_MS = 1_500;
const TERRAIN_AREA_JOB_TIMEOUT_MS = 15 * 60_000;

export type TerrainGridPackSummary = {
  packID: string;
  schemaVersion: number;
  requestedBoundsWgs84: [number, number, number, number];
  verticalDatum: string;
  signatureStatus: string;
  signatureKeyID: string | null;
  databaseSha256?: string | null;
};

export type TerrainGridPackInventory = {
  packs: TerrainGridPackSummary[];
  unavailablePackageCount: number;
  trustedSigningKeyCount: number;
  allowUnsignedPilot: boolean;
};

export type OfflineTerrainSample = {
  elevationMeters: number | null;
  packID: string | null;
  verticalDatum: string | null;
};

export type TerrainElevationCoverage =
  | string
  | {
      status: string;
      coverageFraction: number;
      validCellCount?: number;
      requestedCellCount?: number;
      unknownReasonCounts?: Record<string, number>;
    };

export type TerrainCatalogChunk = {
  chunkId: string;
  releaseId?: string;
  packId: string;
  manifestSha256: string;
  databaseSha256: string;
  databaseSizeBytes: number;
  elevationCoverage: TerrainElevationCoverage;
  hasElevationGrid: boolean;
  hasRoadGraph: boolean;
  hasRoadProfiles: boolean;
  requestedBoundsWgs84: [number, number, number, number];
  verticalDatum: string;
};

export type TerrainCatalog = {
  schemaVersion: number;
  releaseId: string;
  generatedAt: string;
  signatureKeyId: string;
  chunks: TerrainCatalogChunk[];
};

export type TerrainAreaBuildProgress = {
  status: 'queued' | 'building';
  completedChunks: number;
  totalChunks: number;
};

export type TerrainDownloadProgress = {
  chunkID: string;
  progress: number;
  bytesWritten: number;
  totalBytes: number;
};

export type TerrainDownloadState = TerrainDownloadProgress & {
  operationID: string;
  releaseID: string;
  databaseSha256: string;
  state: 'preparing' | 'downloading' | 'installing' | 'cancelling' | 'failed' | 'completed';
  error: string | null;
};

type NativeTerrainGridPackStore = {
  addListener(eventName: string): void;
  removeListeners(count: number): void;
  getInventory(): Promise<TerrainGridPackInventory>;
  installPack(directoryURI: string): Promise<TerrainGridPackSummary>;
  downloadAndInstallPack(
    baseURL: string,
    releaseID: string,
    chunkID: string,
    databaseSha256: string,
  ): Promise<TerrainGridPackSummary>;
  cancelDownload(chunkID: string): Promise<void>;
  getDownloadStates(): Promise<TerrainDownloadState[]>;
  removePack(packID: string): Promise<void>;
  sampleElevations(flatCoordinates: number[]): Promise<OfflineTerrainSample[]>;
};

export class TerrainGridPackServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerrainGridPackServiceError';
  }
}

export async function getTerrainGridPackInventory(): Promise<TerrainGridPackInventory> {
  return requireNativeTerrainStore().getInventory();
}

export async function fetchRemoteTerrainCatalog(
  baseURL: string = CYCLECOMP_VPS_BASE_URL,
): Promise<TerrainCatalog | null> {
  const normalizedBase = baseURL.replace(/\/+$/, '');
  const catalogUrl = `${normalizedBase}/v1/terrain/catalog.json`;
  const controller = new AbortController();
  let timeoutID: ReturnType<typeof setTimeout> | undefined;

  try {
    const requestDeadline = new Promise<never>((_, reject) => {
      timeoutID = setTimeout(() => {
        controller.abort();
        reject(new TerrainGridPackServiceError(
          'Koneksi ke katalog medan VPS timeout setelah 8 detik.',
        ));
      }, CATALOG_REQUEST_TIMEOUT_MS);
    });
    const catalogRequest = (async () => {
      const response = await fetch(catalogUrl, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });

      if (response.status === 404 || response.status === 503) {
        return null;
      }

      if (!response.ok) {
        throw new TerrainGridPackServiceError(
          `Katalog medan server merespons error (HTTP ${response.status}).`,
        );
      }

      const catalogContents: unknown = await response.json();
      return validateCatalogPayload(catalogContents);
    })();
    return await Promise.race([catalogRequest, requestDeadline]);
  } catch (error) {
    if (error instanceof TerrainGridPackServiceError) {
      throw error;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new TerrainGridPackServiceError(
        'Koneksi ke katalog medan VPS timeout setelah 8 detik.',
      );
    }
    throw new TerrainGridPackServiceError(
      `Gagal memeriksa katalog medan VPS: ${error instanceof Error ? error.message : 'Koneksi gagal'}`,
    );
  } finally {
    clearTimeout(timeoutID);
  }
}

export async function prepareTerrainForOfflineAreas(
  mapAreaBounds: RouteBounds[],
  onProgress?: (progress: TerrainAreaBuildProgress) => void,
  baseURL: string = CYCLECOMP_VPS_BASE_URL,
): Promise<TerrainCatalog> {
  if (mapAreaBounds.length === 0) {
    throw new TerrainGridPackServiceError('Belum ada area peta offline yang dapat disiapkan.');
  }

  const normalizedBase = baseURL.replace(/\/+$/, '');
  const requestResponse = await fetchTerrainAreaJSON(
    `${normalizedBase}/v1/terrain/areas`,
    {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        areas: mapAreaBounds.map(([west, south, east, north]) => ({ west, south, east, north })),
      }),
    },
  );
  let job = validateTerrainAreaJob(requestResponse);
  const jobStartedAt = Date.now();
  onProgress?.(toTerrainAreaBuildProgress(job));

  while (job.status !== 'completed' && job.status !== 'failed') {
    if (Date.now() - jobStartedAt >= TERRAIN_AREA_JOB_TIMEOUT_MS) {
      throw new TerrainGridPackServiceError(
        'Penyiapan elevasi masih berjalan. Coba buka menu ini lagi beberapa saat nanti.',
      );
    }
    await new Promise(resolve => setTimeout(resolve, TERRAIN_AREA_POLL_INTERVAL_MS));
    const statusResponse = await fetchTerrainAreaJSON(
      `${normalizedBase}/v1/terrain/areas/${encodeURIComponent(job.jobId)}`,
      { headers: { Accept: 'application/json' } },
    );
    job = validateTerrainAreaJob(statusResponse);
    onProgress?.(toTerrainAreaBuildProgress(job));
  }

  if (job.status === 'failed') {
    throw new TerrainGridPackServiceError(
      job.error ?? 'Data elevasi untuk area peta belum dapat disiapkan.',
    );
  }
  if (!job.catalog || !job.catalogSignatureBase64 || job.releaseId === null) {
    throw new TerrainGridPackServiceError('Katalog elevasi area belum lengkap.');
  }
  const areaCatalog = validateCatalogPayload(job.catalog);
  if (areaCatalog.releaseId !== job.releaseId) {
    throw new TerrainGridPackServiceError('Katalog elevasi tidak cocok dengan rilis area.');
  }
  if (!/^[A-Za-z0-9+/]{86}==$/.test(job.catalogSignatureBase64)) {
    throw new TerrainGridPackServiceError('Tanda tangan katalog elevasi area tidak valid.');
  }
  return areaCatalog;
}

export async function downloadAndInstallTerrainPack(
  params: {
    baseURL?: string;
    releaseID: string;
    chunkID: string;
    databaseSha256: string;
  },
  onProgress?: (progress: TerrainDownloadProgress) => void,
): Promise<TerrainGridPackSummary> {
  const nativeTerrainStore = requireNativeTerrainStore();
  const baseURL = (params.baseURL ?? CYCLECOMP_VPS_BASE_URL).replace(/\/+$/, '');

  let subscription: { remove: () => void } | null = null;
  if (onProgress) {
    try {
      const emitter = new NativeEventEmitter(NativeModules.TerrainGridPackStore);
      subscription = emitter.addListener('onTerrainDownloadProgress', (rawEvent: unknown) => {
        const event = rawEvent as TerrainDownloadProgress | undefined;
        if (event && event.chunkID === params.chunkID) {
          onProgress(event);
        }
      });
    } catch {
      // Emitter fallback if listener unsupported in test environment
    }
  }

  try {
    return await nativeTerrainStore.downloadAndInstallPack(
      baseURL,
      params.releaseID,
      params.chunkID,
      params.databaseSha256,
    );
  } finally {
    subscription?.remove();
  }
}

export async function cancelTerrainPackDownload(chunkID: string): Promise<void> {
  await requireNativeTerrainStore().cancelDownload(chunkID);
}

export async function getTerrainPackDownloadStates(): Promise<TerrainDownloadState[]> {
  return requireNativeTerrainStore().getDownloadStates();
}

export function subscribeToTerrainPackDownloadStates(
  onChange: (downloads: TerrainDownloadState[]) => void,
  onError?: (error: Error) => void,
): () => void {
  const emitter = new NativeEventEmitter(requireNativeTerrainStore());
  const subscription = emitter.addListener(
    'onTerrainDownloadStateChanged',
    (rawEvent: unknown) => {
      const event = rawEvent as { downloads?: TerrainDownloadState[]; error?: string } | undefined;
      if (typeof event?.error === 'string') {
        onError?.(new TerrainGridPackServiceError(event.error));
        return;
      }
      if (Array.isArray(event?.downloads)) {
        onChange(event.downloads);
      }
    },
  );
  return () => subscription.remove();
}

export async function pickAndInstallTerrainGridPack(): Promise<TerrainGridPackSummary | null> {
  const nativeTerrainStore = requireNativeTerrainStore();
  const { errorCodes, isErrorWithCode, pickDirectory } = await import(
    '@react-native-documents/picker'
  );
  try {
    const selectedDirectory = await pickDirectory({ requestLongTermAccess: false });
    return await nativeTerrainStore.installPack(selectedDirectory.uri);
  } catch (error) {
    if (isErrorWithCode(error) && error.code === errorCodes.OPERATION_CANCELED) {
      return null;
    }
    throw error;
  }
}

export async function removeTerrainGridPack(packID: string): Promise<void> {
  await requireNativeTerrainStore().removePack(packID);
}

type TerrainAreaBuildJob = {
  jobId: string;
  status: 'queued' | 'building' | 'completed' | 'failed';
  completedChunks: number;
  totalChunks: number;
  releaseId: string | null;
  error: string | null;
  catalog?: unknown;
  catalogSignatureBase64?: string | null;
};

async function fetchTerrainAreaJSON(url: string, requestInit: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timeoutID = setTimeout(() => controller.abort(), TERRAIN_AREA_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...requestInit, signal: controller.signal });
    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      throw new TerrainGridPackServiceError('Respons penyiapan elevasi dari server tidak valid.');
    }
    if (!response.ok) {
      const responseDetail = typeof responseBody === 'object' && responseBody !== null &&
        'detail' in responseBody && typeof responseBody.detail === 'string'
        ? responseBody.detail
        : `HTTP ${response.status}`;
      throw new TerrainGridPackServiceError(`Penyiapan elevasi gagal: ${responseDetail}`);
    }
    return responseBody;
  } catch (error) {
    if (error instanceof TerrainGridPackServiceError) {
      throw error;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new TerrainGridPackServiceError('Permintaan penyiapan elevasi timeout.');
    }
    throw new TerrainGridPackServiceError(
      `Tidak dapat menghubungi layanan penyiapan elevasi: ${error instanceof Error ? error.message : 'Koneksi gagal'}`,
    );
  } finally {
    clearTimeout(timeoutID);
  }
}

function validateTerrainAreaJob(value: unknown): TerrainAreaBuildJob {
  if (typeof value !== 'object' || value === null) {
    throw new TerrainGridPackServiceError('Status penyiapan elevasi tidak valid.');
  }
  const job = value as Record<string, unknown>;
  if (
    typeof job.jobId !== 'string' ||
    !['queued', 'building', 'completed', 'failed'].includes(String(job.status)) ||
    typeof job.completedChunks !== 'number' ||
    !Number.isInteger(job.completedChunks) ||
    typeof job.totalChunks !== 'number' ||
    !Number.isInteger(job.totalChunks) ||
    job.completedChunks < 0 || job.totalChunks < 1 || job.completedChunks > job.totalChunks ||
    !(typeof job.releaseId === 'string' || job.releaseId === null) ||
    !(typeof job.error === 'string' || job.error === null)
  ) {
    throw new TerrainGridPackServiceError('Status penyiapan elevasi tidak lengkap.');
  }
  if (
    job.catalogSignatureBase64 !== undefined &&
    !(typeof job.catalogSignatureBase64 === 'string' || job.catalogSignatureBase64 === null)
  ) {
    throw new TerrainGridPackServiceError('Tanda tangan katalog area tidak valid.');
  }
  return {
    jobId: job.jobId,
    status: job.status as TerrainAreaBuildJob['status'],
    completedChunks: job.completedChunks,
    totalChunks: job.totalChunks,
    releaseId: job.releaseId as string | null,
    error: job.error as string | null,
    catalog: job.catalog,
    catalogSignatureBase64: job.catalogSignatureBase64 as string | null | undefined,
  };
}

function toTerrainAreaBuildProgress(job: TerrainAreaBuildJob): TerrainAreaBuildProgress {
  return {
    status: job.status === 'building' ? 'building' : 'queued',
    completedChunks: job.completedChunks,
    totalChunks: job.totalChunks,
  };
}

export async function sampleInstalledTerrainPacks(
  coordinates: RouteCoordinate[],
): Promise<OfflineTerrainSample[]> {
  if (coordinates.length === 0) {
    return [];
  }
  validateCoordinates(coordinates);

  const nativeTerrainStore = requireNativeTerrainStore();
  const sampledElevations: OfflineTerrainSample[] = [];
  for (
    let batchStart = 0;
    batchStart < coordinates.length;
    batchStart += MAX_COORDINATES_PER_NATIVE_BATCH
  ) {
    const coordinateBatch = coordinates.slice(
      batchStart,
      batchStart + MAX_COORDINATES_PER_NATIVE_BATCH,
    );
    const flatCoordinates = coordinateBatch.flatMap(
      ([longitude, latitude]) => [longitude, latitude],
    );
    const batchSamples = await nativeTerrainStore.sampleElevations(flatCoordinates);
    if (batchSamples.length !== coordinateBatch.length) {
      throw new TerrainGridPackServiceError(
        'Jumlah sampel dari penyimpanan medan tidak cocok dengan jumlah koordinat.',
      );
    }
    sampledElevations.push(...batchSamples.map(validateNativeSample));
  }

  return sampledElevations;
}

export async function lookupInstalledTerrainElevations(
  coordinates: RouteCoordinate[],
): Promise<(number | null)[]> {
  const terrainSamples = await sampleInstalledTerrainPacks(coordinates);
  return terrainSamples.map(sample => sample.elevationMeters);
}

function validateCoordinates(coordinates: RouteCoordinate[]) {
  if (coordinates.some(([longitude, latitude]) =>
    !Number.isFinite(longitude) || !Number.isFinite(latitude) ||
    longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90,
  )) {
    throw new TerrainGridPackServiceError('Koordinat lookup medan tidak valid.');
  }
}

function validateNativeSample(sample: OfflineTerrainSample): OfflineTerrainSample {
  const elevationMeters = sample.elevationMeters;
  if (elevationMeters === null) {
    if (sample.packID !== null || sample.verticalDatum !== null) {
      throw new TerrainGridPackServiceError(
        'Sampel tanpa elevasi tidak boleh membawa sumber paket.',
      );
    }
    return sample;
  }

  if (
    !Number.isFinite(elevationMeters) ||
    typeof sample.packID !== 'string' || sample.packID.length === 0 ||
    typeof sample.verticalDatum !== 'string' || sample.verticalDatum.length === 0
  ) {
    throw new TerrainGridPackServiceError('Respons sampel medan dari perangkat tidak valid.');
  }
  return sample;
}

function requireNativeTerrainStore(): NativeTerrainGridPackStore {
  if (Platform.OS !== 'ios') {
    throw new TerrainGridPackServiceError(
      'Pengelolaan paket medan offline belum tersedia pada Android.',
    );
  }

  const nativeTerrainStore = NativeModules.TerrainGridPackStore as
    | NativeTerrainGridPackStore
    | undefined;
  if (!nativeTerrainStore) {
    throw new TerrainGridPackServiceError(
      'Penyimpanan paket medan belum tersedia pada build aplikasi ini.',
    );
  }
  return nativeTerrainStore;
}

function validateCatalogPayload(payload: unknown): TerrainCatalog {
  if (typeof payload !== 'object' || payload === null) {
    throw new TerrainGridPackServiceError('Katalog medan tidak berformat JSON objek.');
  }

  const catalog = payload as Record<string, unknown>;
  if (catalog.schemaVersion !== 1) {
    throw new TerrainGridPackServiceError('Versi skema katalog medan tidak didukung.');
  }
  if (typeof catalog.releaseId !== 'string' || catalog.releaseId.length === 0) {
    throw new TerrainGridPackServiceError('Release ID pada katalog medan tidak valid.');
  }
  if (!Array.isArray(catalog.chunks)) {
    throw new TerrainGridPackServiceError('Daftar chunk pada katalog medan tidak valid.');
  }
  const catalogReleaseId = catalog.releaseId;

  const validatedChunks: TerrainCatalogChunk[] = catalog.chunks.map(chunk => {
    if (typeof chunk !== 'object' || chunk === null) {
      throw new TerrainGridPackServiceError('Data chunk pada katalog medan tidak valid.');
    }
    const c = chunk as Record<string, unknown>;
    if (typeof c.chunkId !== 'string' || typeof c.packId !== 'string') {
      throw new TerrainGridPackServiceError('Identitas chunk medan tidak valid.');
    }
    if (typeof c.databaseSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(c.databaseSha256)) {
      throw new TerrainGridPackServiceError('Hash database chunk medan tidak valid.');
    }
    if (typeof c.databaseSizeBytes !== 'number' || c.databaseSizeBytes <= 0) {
      throw new TerrainGridPackServiceError('Ukuran database chunk medan tidak valid.');
    }
    if (
      !Array.isArray(c.requestedBoundsWgs84) ||
      c.requestedBoundsWgs84.length !== 4 ||
      !c.requestedBoundsWgs84.every(val => typeof val === 'number' && Number.isFinite(val))
    ) {
      throw new TerrainGridPackServiceError('Batas koordinat chunk medan tidak valid.');
    }

    let elevationCoverage: TerrainElevationCoverage = 'partial';
    if (typeof c.elevationCoverage === 'string') {
      elevationCoverage = c.elevationCoverage;
    } else if (typeof c.elevationCoverage === 'object' && c.elevationCoverage !== null) {
      elevationCoverage = c.elevationCoverage as TerrainElevationCoverage;
    }

    return {
      chunkId: c.chunkId,
      releaseId: typeof c.releaseId === 'string' ? c.releaseId : catalogReleaseId,
      packId: c.packId,
      manifestSha256: typeof c.manifestSha256 === 'string' ? c.manifestSha256 : '',
      databaseSha256: c.databaseSha256,
      databaseSizeBytes: c.databaseSizeBytes,
      elevationCoverage,
      hasElevationGrid: Boolean(c.hasElevationGrid),
      hasRoadGraph: Boolean(c.hasRoadGraph),
      hasRoadProfiles: Boolean(c.hasRoadProfiles),
      requestedBoundsWgs84: c.requestedBoundsWgs84 as [number, number, number, number],
      verticalDatum: typeof c.verticalDatum === 'string' ? c.verticalDatum : 'EGM2008',
    };
  });

  return {
    schemaVersion: 1,
    releaseId: catalog.releaseId,
    generatedAt: typeof catalog.generatedAt === 'string' ? catalog.generatedAt : '',
    signatureKeyId: typeof catalog.signatureKeyId === 'string' ? catalog.signatureKeyId : '',
    chunks: validatedChunks,
  };
}
