import { Settings } from 'react-native';

import type { RouteBounds } from '../../domain/routes/gpx/GpxRoute';
import { boundsOverlap } from './terrainMapAreaCoverage';
import {
  cancelTerrainPackDownload,
  downloadAndInstallTerrainPack,
  getTerrainGridPackInventory,
  getTerrainPackDownloadStates,
  prepareTerrainForOfflineAreas,
  type TerrainAreaBuildProgress,
  type TerrainCatalog,
  type TerrainCatalogChunk,
  type TerrainGridPackSummary,
} from './terrainGridPackService';

const PENDING_AREA_KEY = 'CycleCompPendingTerrainArea';
const COMPLETED_AREAS_KEY = 'CycleCompCompletedTerrainAreas';

export type TerrainAreaReceipt = {
  bounds: RouteBounds;
  areaName: string;
  totalBytes: number;
  packages: { packID: string; databaseSha256: string }[];
};

export type TerrainAreaTransfer = {
  bounds: RouteBounds;
  areaName: string;
  phase:
    | 'preparing'
    | 'downloading'
    | 'pausing'
    | 'paused'
    | 'failed'
    | 'completed';
  buildProgress: TerrainAreaBuildProgress | null;
  completedBytes: number;
  totalBytes: number;
  progress: number;
  error: string | null;
  catalog: TerrainCatalog | null;
};

let currentTransfer: TerrainAreaTransfer | null = null;
let runningTransfer: Promise<void> | null = null;
let activeChunkID: string | null = null;
let pauseRequested = false;
const listeners = new Set<(transfer: TerrainAreaTransfer | null) => void>();

export function subscribeToTerrainAreaTransfer(
  listener: (transfer: TerrainAreaTransfer | null) => void,
): () => void {
  listeners.add(listener);
  listener(currentTransfer);
  return () => {
    listeners.delete(listener);
  };
}

function publishTransfer(changes: Partial<TerrainAreaTransfer>) {
  if (!currentTransfer) {
    return;
  }
  currentTransfer = { ...currentTransfer, ...changes };
  for (const listener of listeners) {
    listener(currentTransfer);
  }
}

function rememberTransfer(autoResume: boolean) {
  if (!currentTransfer) {
    return;
  }
  Settings.set({
    [PENDING_AREA_KEY]: JSON.stringify({
      bounds: currentTransfer.bounds,
      areaName: currentTransfer.areaName,
      autoResume,
    }),
  });
}

export function startTerrainAreaTransfer(
  bounds: RouteBounds,
  areaName: string,
): Promise<void> {
  if (runningTransfer) {
    return runningTransfer;
  }
  if (!validBounds(bounds)) {
    return Promise.reject(new Error('Cakupan area elevasi tidak valid.'));
  }
  pauseRequested = false;
  currentTransfer = {
    bounds: [...bounds],
    areaName,
    phase: 'preparing',
    buildProgress: null,
    completedBytes: 0,
    totalBytes: 0,
    progress: 0,
    error: null,
    catalog: null,
  };
  rememberTransfer(true);
  publishTransfer({});
  runningTransfer = downloadArea(bounds).finally(() => {
    activeChunkID = null;
    runningTransfer = null;
  });
  return runningTransfer;
}

async function downloadArea(bounds: RouteBounds) {
  try {
    const catalog = await prepareTerrainForOfflineAreas(
      [bounds],
      buildProgress => {
        publishTransfer({ buildProgress });
      },
    );
    publishTransfer({ catalog });
    const chunks = catalog.chunks.filter(
      chunk =>
        chunk.hasElevationGrid &&
        boundsOverlap(bounds, chunk.requestedBoundsWgs84),
    );
    if (chunks.length === 0) {
      throw new Error('Server belum menyediakan elevasi untuk area ini.');
    }
    const inventory = await getTerrainGridPackInventory();
    const installedPacks = new Map(
      inventory.packs.map(pack => [pack.packID, pack]),
    );
    const totalBytes = chunks.reduce(
      (bytes, chunk) => bytes + chunk.databaseSizeBytes,
      0,
    );
    const pendingChunks = chunks.filter(
      chunk =>
        installedPacks.get(chunk.packId)?.databaseSha256?.toLowerCase() !==
        chunk.databaseSha256.toLowerCase(),
    );
    let completedBytes =
      totalBytes -
      pendingChunks.reduce(
        (bytes, chunk) => bytes + chunk.databaseSizeBytes,
        0,
      );
    publishTransfer({
      phase: 'downloading',
      totalBytes,
      completedBytes,
      progress: totalBytes > 0 ? completedBytes / totalBytes : 0,
    });

    for (const chunk of pendingChunks) {
      if (pauseRequested) {
        break;
      }
      const activeDownloads = (await getTerrainPackDownloadStates()).filter(
        download =>
          download.state !== 'completed' && download.state !== 'failed',
      );
      if (
        activeDownloads.some(download => download.chunkID !== chunk.chunkId)
      ) {
        throw new Error(
          'Tunggu unduhan paket lain selesai, lalu tekan Lanjutkan.',
        );
      }
      if (pauseRequested) {
        break;
      }
      activeChunkID = chunk.chunkId;
      await downloadAndInstallTerrainPack(
        {
          releaseID: chunk.releaseId ?? catalog.releaseId,
          chunkID: chunk.chunkId,
          databaseSha256: chunk.databaseSha256,
        },
        downloadProgress => {
          const fraction = Math.max(0, Math.min(1, downloadProgress.progress));
          const downloadedBytes =
            completedBytes + fraction * chunk.databaseSizeBytes;
          publishTransfer({
            completedBytes: downloadedBytes,
            progress: totalBytes > 0 ? downloadedBytes / totalBytes : 0,
          });
        },
      );
      activeChunkID = null;
      completedBytes += chunk.databaseSizeBytes;
      publishTransfer({
        completedBytes,
        progress: totalBytes > 0 ? completedBytes / totalBytes : 0,
      });
    }
    if (pauseRequested) {
      publishTransfer({ phase: 'paused' });
      rememberTransfer(false);
    } else {
      rememberCompletedArea(chunks, totalBytes);
      publishTransfer({
        phase: 'completed',
        progress: 1,
        completedBytes: totalBytes,
        error: null,
      });
      Settings.set({ [PENDING_AREA_KEY]: '' });
    }
  } catch (error) {
    const cancelled =
      pauseRequested ||
      (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'download_cancelled');
    publishTransfer({
      phase: cancelled ? 'paused' : 'failed',
      error: cancelled
        ? null
        : error instanceof Error
        ? error.message
        : 'Unduhan elevasi gagal.',
    });
    rememberTransfer(false);
  }
}

export function getTerrainAreaReceipts(): TerrainAreaReceipt[] {
  const storedReceipts = Settings.get(COMPLETED_AREAS_KEY);
  if (typeof storedReceipts !== 'string' || !storedReceipts) {
    return [];
  }
  try {
    const receipts: unknown = JSON.parse(storedReceipts);
    if (!Array.isArray(receipts)) {
      return [];
    }
    return receipts.filter(
      (receipt): receipt is TerrainAreaReceipt =>
        typeof receipt === 'object' &&
        receipt !== null &&
        validBounds(receipt.bounds) &&
        typeof receipt.areaName === 'string' &&
        typeof receipt.totalBytes === 'number' &&
        Number.isFinite(receipt.totalBytes) &&
        receipt.totalBytes >= 0 &&
        Array.isArray(receipt.packages) &&
        receipt.packages.length > 0 &&
        receipt.packages.every(
          (pack: unknown) =>
            typeof pack === 'object' &&
            pack !== null &&
            'packID' in pack &&
            typeof pack.packID === 'string' &&
            'databaseSha256' in pack &&
            typeof pack.databaseSha256 === 'string' &&
            /^[a-f0-9]{64}$/i.test(pack.databaseSha256),
        ),
    );
  } catch {
    return [];
  }
}

export function terrainAreaReceiptInstalled(
  receipt: TerrainAreaReceipt,
  installedPacks: TerrainGridPackSummary[],
): boolean {
  const installedHashes = new Map(
    installedPacks.map(pack => [
      pack.packID,
      pack.databaseSha256?.toLowerCase(),
    ]),
  );
  return receipt.packages.every(
    pack =>
      installedHashes.get(pack.packID) === pack.databaseSha256.toLowerCase(),
  );
}

function rememberCompletedArea(
  chunks: TerrainCatalogChunk[],
  totalBytes: number,
) {
  if (!currentTransfer) {
    return;
  }
  const { bounds, areaName } = currentTransfer;
  const otherAreas = getTerrainAreaReceipts().filter(
    receipt =>
      !receipt.bounds.every(
        (coordinate, index) => coordinate === bounds[index],
      ),
  );
  Settings.set({
    [COMPLETED_AREAS_KEY]: JSON.stringify([
      ...otherAreas,
      {
        bounds,
        areaName,
        totalBytes,
        packages: chunks.map(chunk => ({
          packID: chunk.packId,
          databaseSha256: chunk.databaseSha256,
        })),
      },
    ]),
  });
}

export async function pauseTerrainAreaTransfer(): Promise<void> {
  if (
    !runningTransfer ||
    !currentTransfer ||
    currentTransfer.phase !== 'downloading'
  ) {
    return;
  }
  pauseRequested = true;
  publishTransfer({ phase: 'pausing' });
  rememberTransfer(false);
  try {
    if (activeChunkID) {
      await cancelTerrainPackDownload(activeChunkID);
    }
  } catch (error) {
    pauseRequested = false;
    publishTransfer({
      phase: 'downloading',
      error:
        error instanceof Error ? error.message : 'Unduhan belum dapat dijeda.',
    });
    rememberTransfer(true);
  }
}

export function restoreTerrainAreaTransfer() {
  if (currentTransfer || runningTransfer) {
    return;
  }
  try {
    const storedTransfer = Settings.get(PENDING_AREA_KEY);
    if (typeof storedTransfer !== 'string' || !storedTransfer) {
      return;
    }
    const pending: unknown = JSON.parse(storedTransfer);
    if (
      typeof pending !== 'object' ||
      pending === null ||
      !('bounds' in pending) ||
      !validBounds(pending.bounds) ||
      !('areaName' in pending) ||
      typeof pending.areaName !== 'string'
    ) {
      return;
    }
    if ('autoResume' in pending && pending.autoResume === true) {
      return startTerrainAreaTransfer(pending.bounds, pending.areaName);
    } else {
      currentTransfer = {
        bounds: pending.bounds,
        areaName: pending.areaName,
        phase: 'paused',
        buildProgress: null,
        completedBytes: 0,
        totalBytes: 0,
        progress: 0,
        error: null,
        catalog: null,
      };
      publishTransfer({});
    }
  } catch {
    Settings.set({ [PENDING_AREA_KEY]: '' });
  }
}

function validBounds(bounds: unknown): bounds is RouteBounds {
  return (
    Array.isArray(bounds) &&
    bounds.length === 4 &&
    bounds.every(
      coordinate =>
        typeof coordinate === 'number' && Number.isFinite(coordinate),
    ) &&
    bounds[0] >= -180 &&
    bounds[2] <= 180 &&
    bounds[1] >= -90 &&
    bounds[3] <= 90 &&
    bounds[0] < bounds[2] &&
    bounds[1] < bounds[3]
  );
}
