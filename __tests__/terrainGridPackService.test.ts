import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import {
  cancelTerrainPackDownload,
  downloadAndInstallTerrainPack,
  fetchRemoteTerrainCatalog,
  getTerrainPackDownloadStates,
  getTerrainGridPackInventory,
  lookupInstalledTerrainElevations,
  prepareTerrainForOfflineAreas,
  sampleInstalledTerrainPacks,
  subscribeToTerrainPackDownloadStates,
  type TerrainDownloadProgress,
} from '../src/features/elevation/terrainGridPackService';

jest.mock('@react-native-documents/picker', () => ({
  errorCodes: { OPERATION_CANCELED: 'OPERATION_CANCELED' },
  isErrorWithCode: (error: unknown) =>
    typeof error === 'object' && error !== null && 'code' in error,
  pickDirectory: jest.fn(),
}));

const mockNativeTerrainStore = {
  getInventory: jest.fn(),
  installPack: jest.fn(),
  downloadAndInstallPack: jest.fn(),
  cancelDownload: jest.fn(),
  getDownloadStates: jest.fn(),
  removePack: jest.fn(),
  sampleElevations: jest.fn(),
  addListener: jest.fn(),
  removeListeners: jest.fn(),
};

describe('terrainGridPackService', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(NativeModules, 'TerrainGridPackStore', {
      configurable: true,
      value: mockNativeTerrainStore,
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it('uses the native terrain store on Android', async () => {
    const originalPlatform = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    mockNativeTerrainStore.getInventory.mockResolvedValue({
      packs: [], unavailablePackageCount: 0, trustedSigningKeyCount: 2, allowUnsignedPilot: false,
    });
    try {
      const inventory = await getTerrainGridPackInventory();
      expect(inventory.trustedSigningKeyCount).toBe(2);
      expect(mockNativeTerrainStore.getInventory).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
    }
  });

  it('preserves negative, zero, unknown and pack provenance samples', async () => {
    mockNativeTerrainStore.sampleElevations.mockResolvedValue([
      { elevationMeters: -5, packID: 'bali-1', verticalDatum: 'EGM2008' },
      { elevationMeters: 0, packID: 'bali-1', verticalDatum: 'EGM2008' },
      { elevationMeters: null, packID: null, verticalDatum: null },
    ]);

    const terrainSamples = await sampleInstalledTerrainPacks([
      [115.1, -8.1],
      [115.2, -8.2],
      [115.3, -8.3],
    ]);

    expect(terrainSamples.map(sample => sample.elevationMeters)).toEqual([-5, 0, null]);
    expect(terrainSamples[0]).toMatchObject({ packID: 'bali-1', verticalDatum: 'EGM2008' });
  });

  it('uses bounded batches for routes with many coordinates', async () => {
    const routeCoordinates = Array.from({ length: 2_001 }, (_, coordinateIndex) => [
      115 + coordinateIndex / 1_000,
      -8,
    ] as [number, number]);
    mockNativeTerrainStore.sampleElevations
      .mockResolvedValueOnce(Array.from({ length: 2_000 }, () => ({
        elevationMeters: null,
        packID: null,
        verticalDatum: null,
      })))
      .mockResolvedValueOnce([{
        elevationMeters: 1,
        packID: 'bali-1',
        verticalDatum: 'EGM2008',
      }]);

    const elevations = await lookupInstalledTerrainElevations(routeCoordinates);

    expect(mockNativeTerrainStore.sampleElevations).toHaveBeenCalledTimes(2);
    expect(mockNativeTerrainStore.sampleElevations.mock.calls[0]?.[0]).toHaveLength(4_000);
    expect(mockNativeTerrainStore.sampleElevations.mock.calls[1]?.[0]).toHaveLength(2);
    expect(elevations).toHaveLength(routeCoordinates.length);
    expect(elevations[0]).toBeNull();
    expect(elevations[2_000]).toBe(1);
  });

  it('rejects invalid coordinates and malformed native responses', async () => {
    await expect(sampleInstalledTerrainPacks([[181, -8]]))
      .rejects.toThrow('Koordinat lookup medan tidak valid.');

    mockNativeTerrainStore.sampleElevations.mockResolvedValue([
      { elevationMeters: Number.NaN, packID: 'bali-1', verticalDatum: 'EGM2008' },
    ]);
    await expect(sampleInstalledTerrainPacks([[115, -8]]))
      .rejects.toThrow('Respons sampel medan dari perangkat tidak valid.');
  });

  describe('fetchRemoteTerrainCatalog', () => {
    it.each(['headers', 'body'])('aborts stalled catalog %s at the request deadline', async phase => {
      jest.useFakeTimers();
      global.fetch = jest.fn().mockImplementation(() => phase === 'headers'
        ? new Promise(() => {})
        : Promise.resolve({
            ok: true,
            status: 200,
            json: () => new Promise(() => {}),
          }));

      const catalogError = fetchRemoteTerrainCatalog().catch(error => error);
      await jest.advanceTimersByTimeAsync(7_999);
      expect((global.fetch as jest.Mock).mock.calls[0][1].signal.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1);

      expect(await catalogError).toMatchObject({
        message: 'Koneksi ke katalog medan VPS timeout setelah 8 detik.',
      });
      expect((global.fetch as jest.Mock).mock.calls[0][1].signal.aborted).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('shares one deadline between headers and parsing the catalog body', async () => {
      jest.useFakeTimers();
      global.fetch = jest.fn().mockImplementation(() => new Promise(resolve => {
        setTimeout(() => resolve({
          ok: true,
          status: 200,
          json: () => new Promise(() => {}),
        }), 7_000);
      }));

      const catalogError = fetchRemoteTerrainCatalog().catch(error => error);
      await jest.advanceTimersByTimeAsync(8_000);

      expect(await catalogError).toMatchObject({
        message: 'Koneksi ke katalog medan VPS timeout setelah 8 detik.',
      });
      expect(jest.getTimerCount()).toBe(0);
    });

    it.each([200, 404, 500])('clears the deadline after HTTP %s settles', async status => {
      jest.useFakeTimers();
      global.fetch = jest.fn().mockResolvedValue({
        ok: status === 200,
        status,
        json: async () => ({ schemaVersion: 1, releaseId: 'test', chunks: [] }),
      });

      await fetchRemoteTerrainCatalog().catch(() => undefined);

      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(8_000);
      expect((global.fetch as jest.Mock).mock.calls[0][1].signal.aborted).toBe(false);
    });

    it('clears the deadline after a network failure', async () => {
      jest.useFakeTimers();
      global.fetch = jest.fn().mockRejectedValue(new Error('Connection lost'));

      await expect(fetchRemoteTerrainCatalog()).rejects.toThrow('Connection lost');

      expect(jest.getTimerCount()).toBe(0);
    });

    it('fetches and validates remote catalog when available', async () => {
      const mockCatalogData = {
        schemaVersion: 1,
        releaseId: 'bali-pilot-2026-10',
        generatedAt: '2026-10-17T12:00:00Z',
        signatureKeyId: 'terrain-release-2026',
        chunks: [
          {
            chunkId: 'bali-pilot-1',
            packId: 'bali-pilot-1',
            manifestSha256: 'a'.repeat(64),
            databaseSha256: 'b'.repeat(64),
            databaseSizeBytes: 24_500_000,
            elevationCoverage: 'partial',
            hasElevationGrid: true,
            hasRoadGraph: true,
            hasRoadProfiles: true,
            requestedBoundsWgs84: [114.9, -8.9, 115.9, -7.9],
            verticalDatum: 'EGM2008',
          },
        ],
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockCatalogData,
      });

      const catalog = await fetchRemoteTerrainCatalog('https://168.110.215.60:9443');
      expect(catalog).not.toBeNull();
      expect(catalog?.releaseId).toBe('bali-pilot-2026-10');
      expect(catalog?.chunks).toHaveLength(1);
      expect(catalog?.chunks[0].chunkId).toBe('bali-pilot-1');
      expect(catalog?.chunks[0].hasRoadProfiles).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://168.110.215.60:9443/v1/terrain/catalog.json',
        expect.objectContaining({ headers: { Accept: 'application/json' } }),
      );
    });

    it('returns null gracefully when catalog responds 404 (not yet deployed)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });

      const catalog = await fetchRemoteTerrainCatalog();
      expect(catalog).toBeNull();
    });

    it('returns null gracefully when catalog responds 503', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
      });

      const catalog = await fetchRemoteTerrainCatalog();
      expect(catalog).toBeNull();
    });

    it('throws error when server responds with 500 error', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      await expect(fetchRemoteTerrainCatalog()).rejects.toThrow(
        'Katalog medan server merespons error (HTTP 500).',
      );
    });

    it('throws error when catalog schemaVersion is unsupported', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ schemaVersion: 99, releaseId: 'test', chunks: [] }),
      });

      await expect(fetchRemoteTerrainCatalog()).rejects.toThrow(
        'Versi skema katalog medan tidak didukung.',
      );
    });

    it('throws error when chunk database SHA-256 is invalid', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          schemaVersion: 1,
          releaseId: 'test',
          chunks: [
            {
              chunkId: 'c1',
              packId: 'p1',
              databaseSha256: 'invalid-hash',
              databaseSizeBytes: 100,
              requestedBoundsWgs84: [0, 0, 1, 1],
            },
          ],
        }),
      });

      await expect(fetchRemoteTerrainCatalog()).rejects.toThrow(
        'Hash database chunk medan tidak valid.',
      );
    });
  });

  it('requests a signed terrain catalog for only the saved offline map areas', async () => {
    const areaCatalog = {
      schemaVersion: 1,
      releaseId: 'area-jatiluwih-release',
      generatedAt: '2026-10-19T12:00:00Z',
      signatureKeyId: 'terrain-release-2026',
      chunks: [
        {
          chunkId: 'jatiluwih-grid',
          packId: 'jatiluwih-grid-v1',
          manifestSha256: 'a'.repeat(64),
          databaseSha256: 'b'.repeat(64),
          databaseSizeBytes: 900_000,
          elevationCoverage: { status: 'complete', coverageFraction: 1 },
          hasElevationGrid: true,
          hasRoadGraph: false,
          hasRoadProfiles: false,
          requestedBoundsWgs84: [115.1, -8.9, 115.2, -8.8],
          verticalDatum: 'EGM2008',
        },
      ],
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        jobId: 'area-0123456789abcdef0123456789abcdef',
        status: 'completed',
        completedChunks: 1,
        totalChunks: 1,
        releaseId: 'area-jatiluwih-release',
        error: null,
        catalog: areaCatalog,
        catalogSignatureBase64: `${'A'.repeat(86)}==`,
      }),
    });
    const savedMapBounds: [number, number, number, number][] = [[115.12, -8.85, 115.18, -8.82]];

    const result = await prepareTerrainForOfflineAreas(
      savedMapBounds,
      undefined,
      'https://168.110.215.60:9443',
    );

    expect(result.releaseId).toBe('area-jatiluwih-release');
    expect(result.chunks[0].releaseId).toBe('area-jatiluwih-release');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://168.110.215.60:9443/v1/terrain/areas',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ areas: [{ west: 115.12, south: -8.85, east: 115.18, north: -8.82 }] }),
      }),
    );
  });

  describe('downloadAndInstallTerrainPack', () => {
    it('reads persisted transfer state and forwards native changes until unsubscribe', async () => {
      const recoveredDownloads = [{
        operationID: 'transfer-1', chunkID: 'bali-1', releaseID: 'release-1',
        databaseSha256: 'b'.repeat(64), state: 'downloading' as const,
        progress: 0.5, bytesWritten: 50, totalBytes: 100, error: null,
      }];
      mockNativeTerrainStore.getDownloadStates.mockResolvedValue(recoveredDownloads);
      await expect(getTerrainPackDownloadStates()).resolves.toEqual(recoveredDownloads);
      const onDownloadChange = jest.fn();
      const onDownloadError = jest.fn();
      const unsubscribe = subscribeToTerrainPackDownloadStates(onDownloadChange, onDownloadError);
      const nativeEmitter = new NativeEventEmitter(mockNativeTerrainStore);

      nativeEmitter.emit('onTerrainDownloadStateChanged', { downloads: recoveredDownloads });
      expect(onDownloadChange).toHaveBeenCalledWith(recoveredDownloads);
      nativeEmitter.emit('onTerrainDownloadStateChanged', { downloads: [], error: 'Cannot read checkpoints' });
      expect(onDownloadError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Cannot read checkpoints' }));
      expect(onDownloadChange).toHaveBeenCalledTimes(1);
      unsubscribe();
      nativeEmitter.emit('onTerrainDownloadStateChanged', { downloads: [] });
      expect(onDownloadChange).toHaveBeenCalledTimes(1);
    });

    it('calls native store with correct parameters', async () => {
      const mockSummary = {
        packID: 'bali-pilot-1',
        schemaVersion: 1,
        requestedBoundsWgs84: [114.9, -8.9, 115.9, -7.9] as [number, number, number, number],
        verticalDatum: 'EGM2008',
        signatureStatus: 'signed',
        signatureKeyID: 'terrain-release-2026',
      };
      mockNativeTerrainStore.downloadAndInstallPack.mockResolvedValue(mockSummary);

      const progressEvents: TerrainDownloadProgress[] = [];
      const summary = await downloadAndInstallTerrainPack(
        {
          baseURL: 'https://168.110.215.60:9443',
          releaseID: 'bali-pilot-2026-10',
          chunkID: 'bali-pilot-1',
          databaseSha256: 'b'.repeat(64),
        },
        progress => progressEvents.push(progress),
      );

      expect(summary).toEqual(mockSummary);
      expect(mockNativeTerrainStore.downloadAndInstallPack).toHaveBeenCalledWith(
        'https://168.110.215.60:9443',
        'bali-pilot-2026-10',
        'bali-pilot-1',
        'b'.repeat(64),
      );
    });

    it('cancels active download', async () => {
      mockNativeTerrainStore.cancelDownload.mockResolvedValue(undefined);
      await cancelTerrainPackDownload('bali-pilot-1');
      expect(mockNativeTerrainStore.cancelDownload).toHaveBeenCalledWith('bali-pilot-1');
    });
  });
});
