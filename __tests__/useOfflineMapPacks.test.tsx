import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import {
  OfflineManager,
  type OfflinePack,
  type OfflinePackStatus,
} from '@maplibre/maplibre-react-native';
import type { RouteBounds } from '../src/domain/routes/gpx/GpxRoute';
import { useOfflineMapPacks } from '../src/features/maps/useOfflineMapPacks';
import { INDONESIA_MAP_SOURCE_ID } from '../src/features/maps/offlineMapSource';

jest.mock('@maplibre/maplibre-react-native', () => ({
  OfflineManager: {
    addListener: jest.fn(),
    createPack: jest.fn(),
    deletePack: jest.fn(),
    getPacks: jest.fn(),
    removeListener: jest.fn(),
  },
}));

const offlineManagerMock = OfflineManager as unknown as {
  createPack: jest.Mock;
  deletePack: jest.Mock;
  getPacks: jest.Mock;
  removeListener: jest.Mock;
};

type ProgressListener = Parameters<typeof OfflineManager.createPack>[1];
type ErrorListener = Parameters<typeof OfflineManager.createPack>[2];

const originalBounds: RouteBounds = [115.1, -8.7, 115.2, -8.5];
const replacementBounds: RouteBounds = [114.9, -8.6, 115.05, -8.4];
let reportProgress: ProgressListener | undefined;
let reportError: ErrorListener | undefined;
let hookState: ReturnType<typeof useOfflineMapPacks> | undefined;
let originalPack: OfflinePack;
let replacementPack: OfflinePack;

function makePack(
  id: string,
  bounds: RouteBounds,
  status: OfflinePackStatus,
): OfflinePack {
  return {
    bounds,
    id,
    metadata: { sourceId: INDONESIA_MAP_SOURCE_ID },
    pause: jest.fn().mockResolvedValue(undefined),
    resume: jest.fn().mockResolvedValue(undefined),
    status: jest.fn().mockResolvedValue(status),
  } as unknown as OfflinePack;
}

function packStatus(id: string, state: OfflinePackStatus['state']): OfflinePackStatus {
  return {
    completedResourceCount: 1,
    completedResourceSize: 1024,
    completedTileCount: 1,
    completedTileSize: 1024,
    id,
    percentage: state === 'complete' ? 100 : 25,
    requiredResourceCount: 1,
    state,
  };
}

function OfflineMapPacksProbe() {
  hookState = useOfflineMapPacks();
  return null;
}

async function renderOfflineMapPacks() {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(<OfflineMapPacksProbe />);
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  return renderer!;
}

beforeEach(() => {
  reportProgress = undefined;
  reportError = undefined;
  hookState = undefined;
  originalPack = makePack(
    'original-area',
    originalBounds,
    packStatus('original-area', 'complete'),
  );
  replacementPack = makePack(
    'replacement-area',
    replacementBounds,
    packStatus('replacement-area', 'complete'),
  );

  offlineManagerMock.getPacks.mockReset().mockResolvedValue([originalPack]);
  offlineManagerMock.createPack.mockReset().mockImplementation(
    async (
      _options: unknown,
      progressListener: ProgressListener,
      errorListener: ErrorListener,
    ) => {
      reportProgress = progressListener;
      reportError = errorListener;
      return replacementPack;
    },
  );
  offlineManagerMock.deletePack.mockReset().mockResolvedValue(undefined);
  offlineManagerMock.removeListener.mockReset();
});

afterEach(() => {
  hookState = undefined;
});

test('keeps the current offline area until its replacement is complete', async () => {
  const renderer = await renderOfflineMapPacks();
  (replacementPack.status as jest.Mock).mockResolvedValue(
    packStatus('replacement-area', 'active'),
  );
  let updateTask: Promise<void> | undefined;

  await ReactTestRenderer.act(async () => {
    updateTask = hookState!.updateArea('original-area', replacementBounds);
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  expect(offlineManagerMock.deletePack).not.toHaveBeenCalled();
  expect(hookState!.savedMapAreas.map(area => area.id)).toEqual(['original-area']);
  expect(hookState!.areaUpdateProgress['original-area']).toEqual({
    percentage: 0,
    downloadedBytes: 0,
  });

  await ReactTestRenderer.act(async () => {
    (replacementPack.status as jest.Mock).mockResolvedValue(
      packStatus('replacement-area', 'complete'),
    );
    reportProgress!(replacementPack, packStatus('replacement-area', 'complete'));
    await updateTask;
  });

  expect(offlineManagerMock.deletePack).toHaveBeenCalledWith('original-area');
  expect(hookState!.savedMapAreas).toEqual([
    expect.objectContaining({
      bounds: replacementBounds,
      id: 'replacement-area',
      status: 'ready',
    }),
  ]);
  expect(hookState!.areaUpdateProgress).toEqual({});

  await ReactTestRenderer.act(() => renderer.unmount());
});

test('keeps the current offline area when replacement download fails', async () => {
  replacementPack = makePack(
    'replacement-area',
    replacementBounds,
    packStatus('replacement-area', 'active'),
  );
  const renderer = await renderOfflineMapPacks();
  let updateTask: Promise<void> | undefined;

  await ReactTestRenderer.act(async () => {
    updateTask = hookState!.updateArea('original-area', replacementBounds);
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  await ReactTestRenderer.act(async () => {
    reportError!(replacementPack, {
      id: 'replacement-area',
      message: 'network unavailable',
    });
    await updateTask;
  });

  expect(offlineManagerMock.deletePack).toHaveBeenCalledWith('replacement-area');
  expect(offlineManagerMock.deletePack).not.toHaveBeenCalledWith('original-area');
  expect(hookState!.savedMapAreas.map(area => area.id)).toEqual(['original-area']);
  expect(hookState!.mapPackError).toBe('network unavailable');

  await ReactTestRenderer.act(() => renderer.unmount());
});
