import React from 'react';
import { Alert, AppState } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';

import { TerrainPackManager } from '../src/features/elevation/TerrainPackManager';
import * as terrainService from '../src/features/elevation/terrainGridPackService';
import * as areaTransferService from '../src/features/elevation/terrainAreaTransfer';

jest.mock('../src/features/elevation/terrainAreaTransfer', () => ({
  getTerrainAreaReceipts: jest.fn(() => []),
  terrainAreaReceiptInstalled: jest.fn(() => false),
  restoreTerrainAreaTransfer: jest.fn(),
  startTerrainAreaTransfer: jest.fn().mockResolvedValue(undefined),
  pauseTerrainAreaTransfer: jest.fn(),
  subscribeToTerrainAreaTransfer: jest.fn(listener => {
    listener(null);
    return jest.fn();
  }),
}));

jest.mock('react-native/Libraries/Settings/Settings', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn() },
}));

jest.mock('../src/features/elevation/terrainGridPackService', () => {
  const original = jest.requireActual('../src/features/elevation/terrainGridPackService');
  return {
    ...original,
    getTerrainGridPackInventory: jest.fn(),
    fetchRemoteTerrainCatalog: jest.fn(),
    prepareTerrainForOfflineAreas: jest.fn(),
    downloadAndInstallTerrainPack: jest.fn(),
    cancelTerrainPackDownload: jest.fn(),
    getTerrainPackDownloadStates: jest.fn(),
    subscribeToTerrainPackDownloadStates: jest.fn(),
    pickAndInstallTerrainGridPack: jest.fn(),
    removeTerrainGridPack: jest.fn(),
  };
});

describe('TerrainPackManager', () => {
  const mockGetInventory = terrainService.getTerrainGridPackInventory as jest.Mock;
  const mockFetchCatalog = terrainService.fetchRemoteTerrainCatalog as jest.Mock;
  const mockDownload = terrainService.downloadAndInstallTerrainPack as jest.Mock;
  const mockCancelDownload = terrainService.cancelTerrainPackDownload as jest.Mock;
  const mockDownloadStates = terrainService.getTerrainPackDownloadStates as jest.Mock;
  const mockSubscribeDownloadStates = terrainService.subscribeToTerrainPackDownloadStates as jest.Mock;
  const mockRemove = terrainService.removeTerrainGridPack as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    (areaTransferService.getTerrainAreaReceipts as jest.Mock).mockReturnValue([]);
    (areaTransferService.terrainAreaReceiptInstalled as jest.Mock).mockReturnValue(false);
    jest.spyOn(Alert, 'alert');

    mockGetInventory.mockResolvedValue({
      packs: [],
      unavailablePackageCount: 0,
      trustedSigningKeyCount: 1,
      allowUnsignedPilot: false,
    });
    mockFetchCatalog.mockResolvedValue(null);
    mockCancelDownload.mockResolvedValue(undefined);
    mockDownloadStates.mockResolvedValue([]);
    mockSubscribeDownloadStates.mockReturnValue(jest.fn());
  });

  it('renders collapsed state and displays inventory summary', async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<TerrainPackManager />);
    });

    const root = renderer!.root;
    expect(root.findByProps({ children: 'Elevasi offline' })).toBeTruthy();
    expect(root.findByProps({ children: '0 paket tersimpan' })).toBeTruthy();
  });

  it('expands on tap and fetches remote catalog', async () => {
    mockFetchCatalog.mockResolvedValue({
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
          databaseSizeBytes: 25_000_000,
          elevationCoverage: 'partial',
          hasElevationGrid: true,
          hasRoadGraph: true,
          hasRoadProfiles: true,
          requestedBoundsWgs84: [114.9, -8.9, 115.9, -7.9],
          verticalDatum: 'EGM2008',
        },
      ],
    });

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<TerrainPackManager />);
    });

    // Tap to expand
    const expandButton = renderer!.root.findByProps({ accessibilityRole: 'button' });
    await act(async () => {
      expandButton.props.onPress();
    });

    expect(mockFetchCatalog).toHaveBeenCalledTimes(1);
    expect(renderer!.root.findByProps({ children: 'bali-pilot-1' })).toBeTruthy();
    expect(renderer!.root.findByProps({ children: 'Unduh' })).toBeTruthy();
  });

  it('offers only terrain packs overlapping downloaded map areas', async () => {
    mockFetchCatalog.mockResolvedValue({
      schemaVersion: 1,
      releaseId: 'bali-pilot-2026-10',
      generatedAt: '2026-10-17T12:00:00Z',
      signatureKeyId: 'terrain-release-2026',
      chunks: [
        {
          chunkId: 'bedugul-grid',
          packId: 'bedugul-grid',
          manifestSha256: 'a'.repeat(64),
          databaseSha256: 'b'.repeat(64),
          databaseSizeBytes: 25_000_000,
          elevationCoverage: { status: 'complete', coverageFraction: 1 },
          hasElevationGrid: true,
          hasRoadGraph: false,
          hasRoadProfiles: false,
          requestedBoundsWgs84: [115.15, -8.69, 115.23, -8.25],
          verticalDatum: 'EGM2008',
        },
        {
          chunkId: 'lombok-grid',
          packId: 'lombok-grid',
          manifestSha256: 'c'.repeat(64),
          databaseSha256: 'd'.repeat(64),
          databaseSizeBytes: 25_000_000,
          elevationCoverage: { status: 'complete', coverageFraction: 1 },
          hasElevationGrid: true,
          hasRoadGraph: false,
          hasRoadProfiles: false,
          requestedBoundsWgs84: [116.0, -8.9, 117.0, -8.0],
          verticalDatum: 'EGM2008',
        },
      ],
    });

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <TerrainPackManager mapAreaBounds={[[115.17, -8.6, 115.21, -8.4]]} />,
      );
    });
    await act(async () => {
      renderer!.root.findByProps({ accessibilityRole: 'button' }).props.onPress();
    });

    expect(renderer!.root.findAllByProps({ children: 'bedugul-grid' })).toHaveLength(0);
    await act(async () => {
      renderer!.root.findByProps({ accessibilityLabel: 'Detail paket elevasi' }).props.onPress();
    });
    expect(renderer!.root.findByProps({ children: 'bedugul-grid' })).toBeTruthy();
    expect(renderer!.root.findAllByProps({ children: 'lombok-grid' })).toHaveLength(0);
    expect(renderer!.root.findByProps({ children: 'Medan tersedia' })).toBeTruthy();
    await act(async () => { renderer!.unmount(); });
  });

  it('does not offer server terrain when no offline map area has been downloaded', async () => {
    mockFetchCatalog.mockResolvedValue(downloadCatalog);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<TerrainPackManager mapAreaBounds={[]} />);
    });
    await act(async () => {
      renderer!.root.findByProps({ accessibilityRole: 'button' }).props.onPress();
    });

    expect(renderer!.root.findByProps({
      children: 'Unduh area peta terlebih dahulu. Paket elevasi akan ditampilkan sesuai area yang tersimpan.',
    })).toBeTruthy();
    expect(renderer!.root.findAllByProps({ children: 'bali-pilot-1' })).toHaveLength(0);
    await act(async () => { renderer!.unmount(); });
  });

  it('reports when a downloaded map area is outside published terrain coverage', async () => {
    mockFetchCatalog.mockResolvedValue(downloadCatalog);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<TerrainPackManager mapAreaBounds={[[116.1, -8.8, 116.2, -8.7]]} />);
    });
    await act(async () => {
      renderer!.root.findByProps({ accessibilityRole: 'button' }).props.onPress();
    });

    expect(renderer!.root.findByProps({ children: 'Belum tersedia di server' })).toBeTruthy();
    expect(renderer!.root.findByProps({
      children: 'Paket elevasi untuk area ini belum tersedia. Siapkan dari data medan nasional di server.',
    })).toBeTruthy();
    expect(renderer!.root.findAllByProps({ children: 'bali-pilot-1' })).toHaveLength(0);
    await act(async () => { renderer!.unmount(); });
  });

  it('starts one transfer for the selected saved area without listing individual chunks', async () => {
    mockFetchCatalog.mockResolvedValue(downloadCatalog);
    const savedAreaBounds: [number, number, number, number][] = [[115.12, -8.85, 115.18, -8.82]];

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<TerrainPackManager mapAreaBounds={savedAreaBounds} />);
    });
    await act(async () => {
      renderer!.root.findByProps({ accessibilityRole: 'button' }).props.onPress();
    });
    const prepareAreaButton = renderer!.root.findAllByProps({ accessibilityRole: 'button' })
      .find(button => button.findAllByProps({
        children: 'Siapkan & unduh elevasi',
      }).length > 0);
    expect(prepareAreaButton).toBeTruthy();
    await act(async () => {
      prepareAreaButton!.props.onPress();
    });

    expect(areaTransferService.startTerrainAreaTransfer).toHaveBeenCalledWith(savedAreaBounds[0], 'Area peta 1');
    expect(renderer!.root.findAllByProps({ children: 'bali-pilot-1' })).toHaveLength(0);
    await act(async () => { renderer!.unmount(); });
  });

  it('keeps a completed area grouped after restart while exposing partial source coverage', async () => {
    const savedBounds: [number, number, number, number] = [115, -9, 116, -8];
    (areaTransferService.getTerrainAreaReceipts as jest.Mock).mockReturnValue([{
      bounds: savedBounds, areaName: 'Area peta 1', totalBytes: 1_048_576,
      packages: [{ packID: 'bali-grid', databaseSha256: 'b'.repeat(64) }],
    }]);
    (areaTransferService.terrainAreaReceiptInstalled as jest.Mock).mockReturnValue(true);
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<TerrainPackManager mapAreaBounds={[savedBounds]} />); });
    await act(async () => {
      renderer.root.findByProps({ accessibilityRole: 'button' }).props.onPress();
    });
    expect(renderer.root.findByProps({ children: '1 dari 1 area terunduh' })).toBeTruthy();
    expect(renderer.root.findByProps({ children: 'Terunduh · cakupan sebagian' })).toBeTruthy();
    expect(renderer.root.findByProps({ children: '1.0 MB tersimpan di iPhone' })).toBeTruthy();
    expect(renderer.root.findByProps({ children: 'Periksa pembaruan elevasi' })).toBeTruthy();
    await act(async () => { renderer.unmount(); });
  });

  it('downloads pack when Unduh is tapped', async () => {
    mockFetchCatalog.mockResolvedValue({
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
          databaseSizeBytes: 25_000_000,
          elevationCoverage: 'partial',
          hasElevationGrid: true,
          hasRoadGraph: true,
          hasRoadProfiles: true,
          requestedBoundsWgs84: [114.9, -8.9, 115.9, -7.9],
          verticalDatum: 'EGM2008',
        },
      ],
    });

    mockDownload.mockResolvedValue({
      packID: 'bali-pilot-1',
      schemaVersion: 1,
      requestedBoundsWgs84: [114.9, -8.9, 115.9, -7.9],
      verticalDatum: 'EGM2008',
      signatureStatus: 'signed',
      signatureKeyID: 'terrain-release-2026',
    });

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<TerrainPackManager />);
    });

    // Expand
    const expandButton = renderer!.root.findByProps({ accessibilityRole: 'button' });
    await act(async () => {
      expandButton.props.onPress();
    });

    const downloadButton = renderer!.root.findByProps({
      accessibilityLabel: 'Unduh paket bali-pilot-1',
    });

    await act(async () => {
      downloadButton.props.onPress();
    });

    expect(mockDownload).toHaveBeenCalledWith(
      {
        releaseID: 'bali-pilot-2026-10',
        chunkID: 'bali-pilot-1',
        databaseSha256: 'b'.repeat(64),
      },
      expect.any(Function),
    );
  });

  it('keeps cancel and retry locked until the original download settles', async () => {
    mockFetchCatalog.mockResolvedValue(downloadCatalog);
    const pendingDownload = deferredDownload();
    mockDownload.mockReturnValue(pendingDownload.promise);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => { renderer = create(<TerrainPackManager />); });
    await act(async () => {
      renderer!.root.findByProps({ accessibilityRole: 'button' }).props.onPress();
    });
    const startDownload = renderer!.root.findByProps({
      accessibilityLabel: 'Unduh paket bali-pilot-1',
    }).props.onPress;
    await act(async () => { startDownload(); });
    await act(async () => {
      await renderer!.root.findByProps({ accessibilityLabel: 'Batalkan unduhan' }).props.onPress();
    });

    expect(renderer!.root.findByProps({ accessibilityLabel: 'Batalkan unduhan' }).props.disabled)
      .toBe(true);
    expect(renderer!.root.findByProps({ accessibilityLabel: 'Unduh paket bali-pilot-2' }).props.disabled)
      .toBe(true);
    await act(async () => { startDownload(); });
    expect(mockDownload).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingDownload.reject(Object.assign(new Error('Download cancelled'), { code: 'download_cancelled' }));
    });
    expect(renderer!.root.findByProps({ accessibilityLabel: 'Unduh paket bali-pilot-1' }).props.disabled)
      .toBe(false);
    expect(renderer!.root.findAllByProps({ accessibilityRole: 'alert' })).toHaveLength(0);
    await act(async () => { renderer!.unmount(); });
  });

  it('shows cancellation failures and keeps the original transfer locked', async () => {
    mockFetchCatalog.mockResolvedValue(downloadCatalog);
    const pendingDownload = deferredDownload();
    mockDownload.mockReturnValue(pendingDownload.promise);
    mockCancelDownload.mockRejectedValue(new Error('Cancellation failed'));
    let renderer: ReactTestRenderer | undefined;
    await act(async () => { renderer = create(<TerrainPackManager />); });
    await act(async () => {
      renderer!.root.findByProps({ accessibilityRole: 'button' }).props.onPress();
    });
    await act(async () => {
      renderer!.root.findByProps({ accessibilityLabel: 'Unduh paket bali-pilot-1' }).props.onPress();
    });
    await act(async () => {
      await renderer!.root.findByProps({ accessibilityLabel: 'Batalkan unduhan' }).props.onPress();
    });

    expect(renderer!.root.findByProps({ accessibilityRole: 'alert' }).props.children)
      .toBe('Cancellation failed');
    expect(renderer!.root.findByProps({ accessibilityLabel: 'Batalkan unduhan' }).props.disabled)
      .toBe(false);
    expect(renderer!.root.findByProps({ accessibilityLabel: 'Unduh paket bali-pilot-2' }).props.disabled)
      .toBe(true);
    await act(async () => { pendingDownload.reject(new Error('Database write failed')); });
    expect(renderer!.root.findByProps({ accessibilityRole: 'alert' }).props.children)
      .toBe('Database write failed');
    await act(async () => { renderer!.unmount(); });
  });

  it('keeps a newer transfer visible if an earlier cancel response arrives late', async () => {
    mockFetchCatalog.mockResolvedValue(downloadCatalog);
    const firstDownload = deferredDownload();
    const secondDownload = deferredDownload();
    const pendingCancellation = deferredDownload();
    mockDownload.mockReturnValueOnce(firstDownload.promise).mockReturnValueOnce(secondDownload.promise);
    mockCancelDownload.mockReturnValue(pendingCancellation.promise);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => { renderer = create(<TerrainPackManager />); });
    await act(async () => {
      renderer!.root.findByProps({ accessibilityRole: 'button' }).props.onPress();
    });
    await act(async () => {
      renderer!.root.findByProps({ accessibilityLabel: 'Unduh paket bali-pilot-1' }).props.onPress();
    });
    await act(async () => {
      renderer!.root.findByProps({ accessibilityLabel: 'Batalkan unduhan' }).props.onPress();
    });
    await act(async () => {
      firstDownload.reject(Object.assign(new Error('Download cancelled'), { code: 'download_cancelled' }));
    });
    await act(async () => {
      renderer!.root.findByProps({ accessibilityLabel: 'Unduh paket bali-pilot-2' }).props.onPress();
    });
    await act(async () => { pendingCancellation.resolve(); });

    expect(renderer!.root.findByProps({ accessibilityLabel: 'Batalkan unduhan' })).toBeTruthy();
    expect(renderer!.root.findByProps({ accessibilityLabel: 'Unduh paket bali-pilot-1' }).props.disabled)
      .toBe(true);
    expect(mockDownload).toHaveBeenCalledTimes(2);
    await act(async () => { secondDownload.reject(new Error('Test cleanup')); });
    await act(async () => { renderer!.unmount(); });
  });

  it('reattaches background progress and refreshes inventory when installation completes', async () => {
    mockFetchCatalog.mockResolvedValue(downloadCatalog);
    mockDownloadStates.mockResolvedValue([recoveredDownload]);
    const unsubscribe = jest.fn();
    mockSubscribeDownloadStates.mockReturnValue(unsubscribe);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => { renderer = create(<TerrainPackManager />); });
    await act(async () => {
      renderer!.root.findByProps({ accessibilityRole: 'button' }).props.onPress();
    });

    expect(renderer!.root.findByProps({ children: '45%' })).toBeTruthy();
    expect(renderer!.root.findByProps({ accessibilityLabel: 'Unduh paket bali-pilot-2' }).props.disabled)
      .toBe(true);
    expect(mockDownload).not.toHaveBeenCalled();

    const onDownloadChange = mockSubscribeDownloadStates.mock.calls[0][0];
    await act(async () => { onDownloadChange([{ ...recoveredDownload, state: 'completed' }]); });
    expect(mockGetInventory).toHaveBeenCalledTimes(2);
    expect(renderer!.root.findByProps({ accessibilityLabel: 'Unduh paket bali-pilot-2' }).props.disabled)
      .toBe(false);
    await act(async () => { onDownloadChange([{ ...recoveredDownload, state: 'completed' }]); });
    expect(mockGetInventory).toHaveBeenCalledTimes(2);
    await act(async () => { renderer!.unmount(); });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('keeps a newer native event when the initial recovery query resolves late', async () => {
    mockFetchCatalog.mockResolvedValue(downloadCatalog);
    let resolveInitialQuery: (downloads: terrainService.TerrainDownloadState[]) => void = () => {};
    mockDownloadStates.mockReturnValue(new Promise(resolve => { resolveInitialQuery = resolve; }));
    let renderer: ReactTestRenderer | undefined;
    await act(async () => { renderer = create(<TerrainPackManager />); });
    await act(async () => {
      renderer!.root.findByProps({ accessibilityRole: 'button' }).props.onPress();
    });
    await act(async () => {
      mockSubscribeDownloadStates.mock.calls[0][0]([recoveredDownload]);
      resolveInitialQuery([]);
    });

    expect(renderer!.root.findByProps({ children: '45%' })).toBeTruthy();
    expect(renderer!.root.findByProps({ accessibilityLabel: 'Unduh paket bali-pilot-2' }).props.disabled)
      .toBe(true);
    await act(async () => { renderer!.unmount(); });
  });

  it('shows recovered progress even when the server catalog cannot be loaded', async () => {
    mockDownloadStates.mockResolvedValue([recoveredDownload]);
    mockFetchCatalog.mockRejectedValue(new Error('Catalog offline'));
    let renderer: ReactTestRenderer | undefined;
    await act(async () => { renderer = create(<TerrainPackManager />); });
    await act(async () => {
      renderer!.root.findByProps({ accessibilityRole: 'button' }).props.onPress();
    });

    expect(renderer!.root.findByProps({ children: '45%' })).toBeTruthy();
    expect(renderer!.root.findByProps({ children: 'Unduhan berlangsung' })).toBeTruthy();
    expect(renderer!.root.findByProps({ accessibilityLabel: 'Batalkan unduhan' }).props.disabled)
      .toBe(false);
    await act(async () => { renderer!.unmount(); });
  });

  it('keeps cancelling a recovered transfer until native cancellation finishes', async () => {
    mockDownloadStates.mockResolvedValueOnce([recoveredDownload]).mockResolvedValue([]);
    mockFetchCatalog.mockResolvedValue(downloadCatalog);
    const pendingCancellation = deferredDownload();
    mockCancelDownload.mockReturnValue(pendingCancellation.promise);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => { renderer = create(<TerrainPackManager />); });
    await act(async () => {
      renderer!.root.findByProps({ accessibilityRole: 'button' }).props.onPress();
    });
    await act(async () => {
      renderer!.root.findByProps({ accessibilityLabel: 'Batalkan unduhan' }).props.onPress();
    });

    expect(renderer!.root.findByProps({ children: 'Membatalkan…' })).toBeTruthy();
    expect(renderer!.root.findByProps({ accessibilityLabel: 'Unduh paket bali-pilot-2' }).props.disabled)
      .toBe(true);
    await act(async () => { pendingCancellation.resolve(); });
    expect(renderer!.root.findByProps({ accessibilityLabel: 'Unduh paket bali-pilot-1' }).props.disabled)
      .toBe(false);
    await act(async () => { renderer!.unmount(); });
  });

  it('keeps a newer native event when a recovered cancellation query resolves late', async () => {
    mockFetchCatalog.mockResolvedValue(downloadCatalog);
    let resolveCancellationQuery: (downloads: terrainService.TerrainDownloadState[]) => void = () => {};
    mockDownloadStates
      .mockResolvedValueOnce([recoveredDownload])
      .mockReturnValueOnce(new Promise(resolve => { resolveCancellationQuery = resolve; }));
    let renderer: ReactTestRenderer | undefined;
    await act(async () => { renderer = create(<TerrainPackManager />); });
    await act(async () => {
      renderer!.root.findByProps({ accessibilityRole: 'button' }).props.onPress();
    });
    await act(async () => {
      renderer!.root.findByProps({ accessibilityLabel: 'Batalkan unduhan' }).props.onPress();
    });
    await act(async () => {
      mockSubscribeDownloadStates.mock.calls[0][0]([{
        ...recoveredDownload, operationID: 'new-recovered-operation', progress: 0.8,
      }]);
    });
    await act(async () => { resolveCancellationQuery([]); });

    expect(renderer!.root.findByProps({ children: '80%' })).toBeTruthy();
    expect(renderer!.root.findByProps({ accessibilityLabel: 'Unduh paket bali-pilot-2' }).props.disabled)
      .toBe(true);
    await act(async () => { renderer!.unmount(); });
  });

  it('restores current transfer state after returning to the foreground', async () => {
    mockFetchCatalog.mockResolvedValue(downloadCatalog);
    const appStateObserver = jest.mocked(AppState.addEventListener);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => { renderer = create(<TerrainPackManager />); });
    await act(async () => {
      renderer!.root.findByProps({ accessibilityRole: 'button' }).props.onPress();
    });
    mockDownloadStates.mockResolvedValue([recoveredDownload]);
    await act(async () => { appStateObserver.mock.calls[0][1]('active'); });

    expect(mockDownloadStates).toHaveBeenCalledTimes(2);
    expect(renderer!.root.findByProps({ children: '45%' })).toBeTruthy();
    await act(async () => { renderer!.unmount(); });
  });

  it('ignores an old recovery query after a newer foreground query completes', async () => {
    mockFetchCatalog.mockResolvedValue(downloadCatalog);
    let resolveInitialQuery: (downloads: terrainService.TerrainDownloadState[]) => void = () => {};
    mockDownloadStates
      .mockReturnValueOnce(new Promise(resolve => { resolveInitialQuery = resolve; }))
      .mockResolvedValue([]);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => { renderer = create(<TerrainPackManager />); });
    await act(async () => {
      renderer!.root.findByProps({ accessibilityRole: 'button' }).props.onPress();
    });
    await act(async () => { jest.mocked(AppState.addEventListener).mock.calls[0][1]('active'); });
    await act(async () => { resolveInitialQuery([recoveredDownload]); });

    expect(renderer!.root.findByProps({ accessibilityLabel: 'Unduh paket bali-pilot-1' }).props.disabled)
      .toBe(false);
    expect(renderer!.root.findAllByProps({ accessibilityLabel: 'Batalkan unduhan' })).toHaveLength(0);
    await act(async () => { renderer!.unmount(); });
  });

  it('shows a failed recovered transfer and offers retry', async () => {
    mockFetchCatalog.mockResolvedValue(downloadCatalog);
    mockDownloadStates.mockResolvedValue([{
      ...recoveredDownload, state: 'failed', error: 'Download interrupted',
    }]);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => { renderer = create(<TerrainPackManager />); });
    await act(async () => {
      renderer!.root.findByProps({ accessibilityRole: 'button' }).props.onPress();
    });

    expect(renderer!.root.findByProps({ accessibilityRole: 'alert' }).props.children)
      .toBe('Download interrupted');
    expect(renderer!.root.findByProps({ accessibilityLabel: 'Unduh paket bali-pilot-1' }).props.disabled)
      .toBe(false);
    await act(async () => { renderer!.unmount(); });
  });

  it('shows Terpasang badge when chunk is already installed', async () => {
    mockGetInventory.mockResolvedValue({
      packs: [
        {
          packID: 'bali-pilot-1',
          schemaVersion: 1,
          requestedBoundsWgs84: [114.9, -8.9, 115.9, -7.9],
          verticalDatum: 'EGM2008',
          signatureStatus: 'signed',
          signatureKeyID: 'terrain-release-2026',
        },
      ],
      unavailablePackageCount: 0,
      trustedSigningKeyCount: 1,
      allowUnsignedPilot: false,
    });

    mockFetchCatalog.mockResolvedValue({
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
          databaseSizeBytes: 25_000_000,
          elevationCoverage: 'partial',
          hasElevationGrid: true,
          hasRoadGraph: true,
          hasRoadProfiles: true,
          requestedBoundsWgs84: [114.9, -8.9, 115.9, -7.9],
          verticalDatum: 'EGM2008',
        },
      ],
    });

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<TerrainPackManager />);
    });

    // Expand
    const expandButton = renderer!.root.findByProps({ accessibilityRole: 'button' });
    await act(async () => {
      expandButton.props.onPress();
    });

    expect(renderer!.root.findByProps({ children: 'Terpasang' })).toBeTruthy();
  });

  it('displays message when online catalog is not yet deployed', async () => {
    mockFetchCatalog.mockResolvedValue(null);

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<TerrainPackManager />);
    });

    // Expand
    const expandButton = renderer!.root.findByProps({ accessibilityRole: 'button' });
    await act(async () => {
      expandButton.props.onPress();
    });

    expect(
      renderer!.root.findByProps({
        children: 'Katalog medan online belum dipublikasikan di server.',
      }),
    ).toBeTruthy();
  });

  it('prompts confirmation when removing an installed pack', async () => {
    mockGetInventory.mockResolvedValue({
      packs: [
        {
          packID: 'bali-pilot-1',
          schemaVersion: 1,
          requestedBoundsWgs84: [114.9, -8.9, 115.9, -7.9],
          verticalDatum: 'EGM2008',
          signatureStatus: 'signed',
          signatureKeyID: 'terrain-release-2026',
        },
      ],
      unavailablePackageCount: 0,
      trustedSigningKeyCount: 1,
      allowUnsignedPilot: false,
    });

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<TerrainPackManager />);
    });

    // Expand
    const expandButton = renderer!.root.findByProps({ accessibilityRole: 'button' });
    await act(async () => {
      expandButton.props.onPress();
    });

    const removeButton = renderer!.root.findByProps({
      accessibilityLabel: 'Hapus paket bali-pilot-1',
    });

    await act(async () => {
      removeButton.props.onPress();
    });

    expect(Alert.alert).toHaveBeenCalledWith(
      'Hapus paket medan?',
      'Data bali-pilot-1 akan dihapus dari penyimpanan iPhone.',
      expect.any(Array),
    );

    // Call the destructive action callback
    const alertCalls = (Alert.alert as jest.Mock).mock.calls;
    const buttons = alertCalls[0][2];
    const deleteButton = buttons.find((b: { text: string }) => b.text === 'Hapus');

    await act(async () => {
      deleteButton.onPress();
    });

    expect(mockRemove).toHaveBeenCalledWith('bali-pilot-1');
  });
});

const downloadCatalog: terrainService.TerrainCatalog = {
  schemaVersion: 1,
  releaseId: 'bali-pilot-2026-10',
  generatedAt: '2026-10-17T12:00:00Z',
  signatureKeyId: 'terrain-release-2026',
  chunks: ['bali-pilot-1', 'bali-pilot-2'].map(chunkID => ({
    chunkId: chunkID,
    packId: chunkID,
    manifestSha256: 'a'.repeat(64),
    databaseSha256: 'b'.repeat(64),
    databaseSizeBytes: 25_000_000,
    elevationCoverage: 'complete',
    hasElevationGrid: true,
    hasRoadGraph: true,
    hasRoadProfiles: true,
    requestedBoundsWgs84: [114.9, -8.9, 115.9, -7.9],
    verticalDatum: 'EGM2008',
  })),
};

function deferredDownload() {
  let resolve: () => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const recoveredDownload: terrainService.TerrainDownloadState = {
  operationID: 'recovered-operation',
  chunkID: 'bali-pilot-1',
  releaseID: downloadCatalog.releaseId,
  databaseSha256: 'b'.repeat(64),
  state: 'downloading',
  progress: 0.45,
  bytesWritten: 45,
  totalBytes: 100,
  error: null,
};
