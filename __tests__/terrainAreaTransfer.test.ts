import type { TerrainAreaTransfer } from '../src/features/elevation/terrainAreaTransfer';
import type {
  TerrainCatalog,
  TerrainGridPackSummary,
} from '../src/features/elevation/terrainGridPackService';

const mockPrepare = jest.fn();
const mockDownload = jest.fn();
const mockInventory = jest.fn();
const mockDownloadStates = jest.fn();
const mockCancel = jest.fn();
let mockStoredSettings: Record<string, unknown> = {};
let mockPlatform = 'ios';
let mockAndroidTerrainStore: {
  areaSettings: Record<string, string>;
  setAreaSetting: jest.Mock;
};

jest.mock('react-native', () => ({
  Platform: { get OS() { return mockPlatform; } },
  NativeModules: { get TerrainGridPackStore() { return mockAndroidTerrainStore; } },
  Settings: {
    get: (key: string) => mockStoredSettings[key],
    set: (settings: Record<string, unknown>) =>
      Object.assign(mockStoredSettings, settings),
  },
}));
jest.mock('../src/features/elevation/terrainGridPackService', () => ({
  prepareTerrainForOfflineAreas: (...args: unknown[]) => mockPrepare(...args),
  downloadAndInstallTerrainPack: (...args: unknown[]) => mockDownload(...args),
  getTerrainGridPackInventory: () => mockInventory(),
  getTerrainPackDownloadStates: () => mockDownloadStates(),
  cancelTerrainPackDownload: (chunkID: string) => mockCancel(chunkID),
}));

const bounds: [number, number, number, number] = [115, -9, 116, -8];
const catalog: TerrainCatalog = {
  schemaVersion: 1,
  releaseId: 'bali-v1',
  generatedAt: '',
  signatureKeyId: 'release-key',
  chunks: ['west', 'east'].map((name, index) => ({
    chunkId: name,
    packId: name,
    manifestSha256: 'a'.repeat(64),
    databaseSha256: (index === 0 ? 'b' : 'c').repeat(64),
    databaseSizeBytes: index === 0 ? 100 : 300,
    elevationCoverage: 'complete',
    hasElevationGrid: true,
    hasRoadGraph: false,
    hasRoadProfiles: false,
    requestedBoundsWgs84: bounds,
    verticalDatum: 'EGM2008',
  })),
};

let queue: typeof import('../src/features/elevation/terrainAreaTransfer');
let states: TerrainAreaTransfer[];
let installedPacks: TerrainGridPackSummary[];

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockStoredSettings = {};
  mockPlatform = 'ios';
  mockAndroidTerrainStore = {
    areaSettings: {},
    setAreaSetting: jest.fn(),
  };
  installedPacks = [];
  states = [];
  mockPrepare.mockResolvedValue(catalog);
  mockInventory.mockImplementation(async () => ({ packs: installedPacks }));
  mockDownloadStates.mockResolvedValue([]);
  mockDownload.mockResolvedValue(undefined);
  mockCancel.mockResolvedValue(undefined);
  queue = require('../src/features/elevation/terrainAreaTransfer');
  queue.subscribeToTerrainAreaTransfer(transfer => {
    if (transfer) {
      states.push(transfer);
    }
  });
});

test('Android restores an interrupted area from native settings after a restart', async () => {
  mockPlatform = 'android';
  mockAndroidTerrainStore.areaSettings = {
    CycleCompPendingTerrainArea: JSON.stringify({ bounds, areaName: 'Bali', autoResume: true }),
  };
  jest.resetModules();
  queue = require('../src/features/elevation/terrainAreaTransfer');
  await queue.restoreTerrainAreaTransfer();
  expect(mockPrepare).toHaveBeenCalledWith([bounds], expect.any(Function));
  expect(mockAndroidTerrainStore.setAreaSetting).toHaveBeenCalledWith('CycleCompPendingTerrainArea', '');
  expect(mockStoredSettings.CycleCompPendingTerrainArea).toBeUndefined();
});

function installedWestPack(): TerrainGridPackSummary {
  return {
    packID: 'west',
    schemaVersion: 1,
    requestedBoundsWgs84: bounds,
    verticalDatum: 'EGM2008',
    signatureStatus: 'signed',
    signatureKeyID: 'release-key',
    databaseSha256: catalog.chunks[0].databaseSha256,
  };
}

test('one area action automatically downloads its parts sequentially with byte weighted progress', async () => {
  installedPacks = [installedWestPack()];
  mockDownload.mockImplementation(async (_identity, onProgress) => {
    onProgress({ progress: 0.5 });
  });
  await queue.startTerrainAreaTransfer(bounds, 'Bali');
  expect(mockPrepare).toHaveBeenCalledWith([bounds], expect.any(Function));
  expect(mockDownload).toHaveBeenCalledTimes(1);
  expect(mockDownload.mock.calls[0][0].chunkID).toBe('east');
  expect(states.some(state => state.progress === 0.625)).toBe(true);
  expect(states.at(-1)?.phase).toBe('completed');
  expect(mockStoredSettings.CycleCompPendingTerrainArea).toBe('');
  const receipt = queue.getTerrainAreaReceipts()[0];
  expect(receipt.bounds).toEqual(bounds);
  expect(receipt.totalBytes).toBe(400);
  expect(
    queue.terrainAreaReceiptInstalled(receipt, [installedWestPack()]),
  ).toBe(false);
  expect(
    queue.terrainAreaReceiptInstalled(receipt, [
      installedWestPack(),
      {
        ...installedWestPack(),
        packID: 'east',
        databaseSha256: catalog.chunks[1].databaseSha256,
      },
    ]),
  ).toBe(true);
});

test('a failed part stops the queue and retry skips the already verified part', async () => {
  mockDownload.mockImplementation(async ({ chunkID }) => {
    if (chunkID === 'west') {
      installedPacks = [installedWestPack()];
    } else {
      throw new Error('Jaringan terputus');
    }
  });
  await queue.startTerrainAreaTransfer(bounds, 'Bali');
  expect(states.at(-1)?.phase).toBe('failed');
  expect(states.at(-1)?.error).toBe('Jaringan terputus');
  expect(
    JSON.parse(String(mockStoredSettings.CycleCompPendingTerrainArea))
      .autoResume,
  ).toBe(false);

  mockDownload.mockClear().mockResolvedValue(undefined);
  await queue.startTerrainAreaTransfer(bounds, 'Bali');
  expect(mockDownload).toHaveBeenCalledTimes(1);
  expect(mockDownload.mock.calls[0][0].chunkID).toBe('east');
  expect(states.at(-1)?.phase).toBe('completed');
});

test('pause waits for cancellation and does not start the next part', async () => {
  let rejectDownload!: (error: unknown) => void;
  const started = new Promise<void>(resolve => {
    mockDownload.mockImplementation(() => {
      resolve();
      return new Promise((_resolve, reject) => {
        rejectDownload = reject;
      });
    });
  });
  mockCancel.mockImplementation(async () => {
    rejectDownload({ code: 'download_cancelled' });
  });
  const transfer = queue.startTerrainAreaTransfer(bounds, 'Bali');
  await started;
  await queue.pauseTerrainAreaTransfer();
  await transfer;
  expect(mockCancel).toHaveBeenCalledWith('west');
  expect(mockDownload).toHaveBeenCalledTimes(1);
  expect(states.at(-1)?.phase).toBe('paused');
});

test('restores an interrupted area intent and reattaches the matching native transfer', async () => {
  mockStoredSettings.CycleCompPendingTerrainArea = JSON.stringify({
    bounds,
    areaName: 'Bali',
    autoResume: true,
  });
  mockDownloadStates.mockResolvedValue([
    { chunkID: 'west', state: 'downloading' },
  ]);
  mockDownload.mockImplementation(async ({ chunkID }) => {
    if (chunkID === 'west') {
      mockDownloadStates.mockResolvedValue([]);
    }
  });
  await queue.restoreTerrainAreaTransfer();
  expect(mockDownload.mock.calls.map(([identity]) => identity.chunkID)).toEqual(
    ['west', 'east'],
  );
  expect(states.at(-1)?.phase).toBe('completed');
});

test('does not start over an unrelated active native download or reuse an outdated installed hash', async () => {
  installedPacks = [{ ...installedWestPack(), databaseSha256: 'outdated' }];
  mockDownloadStates.mockResolvedValue([
    { chunkID: 'other-area', state: 'downloading' },
  ]);
  await queue.startTerrainAreaTransfer(bounds, 'Bali');
  expect(mockDownload).not.toHaveBeenCalled();
  expect(states.at(-1)?.phase).toBe('failed');
  mockDownloadStates.mockResolvedValue([]);
  await queue.startTerrainAreaTransfer(bounds, 'Bali');
  expect(mockDownload.mock.calls.map(([identity]) => identity.chunkID)).toEqual(
    ['west', 'east'],
  );
});

test('a user paused intent stays paused after relaunch', async () => {
  mockStoredSettings.CycleCompPendingTerrainArea = JSON.stringify({
    bounds,
    areaName: 'Bali',
    autoResume: false,
  });
  await queue.restoreTerrainAreaTransfer();
  expect(mockPrepare).not.toHaveBeenCalled();
  expect(states.at(-1)?.phase).toBe('paused');
});
