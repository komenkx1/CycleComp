import {
  OfflineManager,
  type OfflinePack,
  type OfflinePackStatus,
} from '@maplibre/maplibre-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { RouteBounds } from '../../domain/routes/gpx/GpxRoute';
import {
  INDONESIA_MAP_SOURCE_ID,
  INDONESIA_MAP_STYLE_URL,
  JATILUWIH_MAP_SOURCE_ID,
} from './offlineMapSource';

export type SavedMapArea = {
  id: string;
  bounds: RouteBounds;
  status: 'downloading' | 'paused' | 'ready' | 'failed';
  percentage: number;
  downloadedBytes: number;
};

export type MapAreaUpdateProgress = Pick<
  SavedMapArea,
  'percentage' | 'downloadedBytes'
>;

export function useOfflineMapPacks() {
  const [savedMapAreas, setSavedMapAreas] = useState<SavedMapArea[]>([]);
  const [mapPackCheck, setMapPackCheck] = useState<'checking' | 'done' | 'failed'>(
    'checking',
  );
  const [mapPackError, setMapPackError] = useState<string | null>(null);
  const [areaUpdateProgress, setAreaUpdateProgress] = useState<
    Record<string, MapAreaUpdateProgress>
  >({});
  const offlinePacks = useRef(new Map<string, OfflinePack>());

  const updatePack = useCallback((pack: OfflinePack, packStatus: OfflinePackStatus) => {
    const savedArea = summaryFromPack(pack, packStatus);
    setSavedMapAreas(previousAreas => {
      const otherAreas = previousAreas.filter(area => area.id !== pack.id);
      return [...otherAreas, savedArea];
    });
  }, []);

  const observePack = useCallback((pack: OfflinePack) => {
    OfflineManager.addListener(
      pack.id,
      (_, status) => updatePack(pack, status),
      (_, error) => setMapPackError(error.message),
    ).catch(error => setMapPackError(mapPackErrorMessage(error)));
  }, [updatePack]);

  useEffect(() => {
    let isMounted = true;
    const packRegistry = offlinePacks.current;

    async function restorePacks() {
      try {
        const storedPacks = (await OfflineManager.getPacks()).filter(
          pack =>
            pack.metadata.sourceId === INDONESIA_MAP_SOURCE_ID ||
            pack.metadata.sourceId === JATILUWIH_MAP_SOURCE_ID,
        );
        const storedStatuses = await Promise.all(
          storedPacks.map(async pack => ({ pack, status: await pack.status() })),
        );
        if (!isMounted) {
          return;
        }

        for (const { pack, status } of storedStatuses) {
          packRegistry.set(pack.id, pack);
          if (status.state !== 'complete') {
            observePack(pack);
          }
        }
        setSavedMapAreas(
          storedStatuses.map(({ pack, status }) => summaryFromPack(pack, status)),
        );
        setMapPackCheck('done');
      } catch (error) {
        if (isMounted) {
          setMapPackError(mapPackErrorMessage(error));
          setMapPackCheck('failed');
        }
      }
    }

    restorePacks();
    return () => {
      isMounted = false;
      for (const packId of packRegistry.keys()) {
        OfflineManager.removeListener(packId);
      }
    };
  }, [observePack]);

  async function downloadArea(bounds: RouteBounds) {
    setMapPackError(null);
    try {
      const pack = await OfflineManager.createPack(
        {
          mapStyle: INDONESIA_MAP_STYLE_URL,
          bounds,
          minZoom: 0,
          maxZoom: 15,
          metadata: { sourceId: INDONESIA_MAP_SOURCE_ID },
        },
        (updatedPack, status) => updatePack(updatedPack, status),
        (_, error) => setMapPackError(error.message),
      );
      offlinePacks.current.set(pack.id, pack);
      updatePack(pack, await pack.status());
      await pack.resume();
    } catch (error) {
      setMapPackError(mapPackErrorMessage(error));
    }
  }

  async function pauseArea(packId: string) {
    const pack = offlinePacks.current.get(packId);
    if (!pack) {
      return;
    }
    try {
      await pack.pause();
      updatePack(pack, await pack.status());
    } catch (error) {
      setMapPackError(mapPackErrorMessage(error));
    }
  }

  async function resumeArea(packId: string) {
    const pack = offlinePacks.current.get(packId);
    if (!pack) {
      return;
    }
    try {
      setMapPackError(null);
      observePack(pack);
      await pack.resume();
    } catch (error) {
      setMapPackError(mapPackErrorMessage(error));
    }
  }

  async function updateArea(packId: string, bounds: RouteBounds) {
    const existingPack = offlinePacks.current.get(packId);
    if (!existingPack) {
      return;
    }

    let replacementPack: OfflinePack | null = null;
    let resolveReplacement!: (pack: OfflinePack) => void;
    let rejectReplacement!: (error: Error) => void;
    const replacementComplete = new Promise<OfflinePack>((resolve, reject) => {
      resolveReplacement = resolve;
      rejectReplacement = reject;
    });
    // The pack's native error callback can fire before the completion promise is awaited.
    void replacementComplete.catch(() => undefined);

    try {
      setMapPackError(null);
      setAreaUpdateProgress(previousProgress => ({
        ...previousProgress,
        [packId]: { percentage: 0, downloadedBytes: 0 },
      }));
      replacementPack = await OfflineManager.createPack(
        {
          mapStyle: INDONESIA_MAP_STYLE_URL,
          bounds,
          minZoom: 0,
          maxZoom: 15,
          metadata: { sourceId: INDONESIA_MAP_SOURCE_ID },
        },
        (updatedPack, status) => {
          setAreaUpdateProgress(previousProgress => ({
            ...previousProgress,
            [packId]: {
              percentage: status.percentage,
              downloadedBytes: status.completedResourceSize,
            },
          }));
          if (status.state === 'complete') {
            resolveReplacement(updatedPack);
          }
        },
        (_, error) => rejectReplacement(new Error(error.message)),
      );
      offlinePacks.current.set(replacementPack.id, replacementPack);
      await replacementPack.resume();
      const replacementStatusAfterResume = await replacementPack.status();
      if (replacementStatusAfterResume.state === 'complete') {
        resolveReplacement(replacementPack);
      }
      const completedReplacementPack = await replacementComplete;
      const completedReplacementStatus =
        await completedReplacementPack.status();

      // Keep the old coverage until the replacement has completed successfully.
      await OfflineManager.deletePack(existingPack.id);
      OfflineManager.removeListener(existingPack.id);
      OfflineManager.removeListener(completedReplacementPack.id);
      offlinePacks.current.delete(existingPack.id);
      offlinePacks.current.set(
        completedReplacementPack.id,
        completedReplacementPack,
      );
      setSavedMapAreas(previousAreas => [
        ...previousAreas.filter(
          area =>
            area.id !== existingPack.id &&
            area.id !== completedReplacementPack.id,
        ),
        summaryFromPack(completedReplacementPack, completedReplacementStatus),
      ]);
    } catch (error) {
      let errorMessage = mapPackErrorMessage(error);
      if (replacementPack) {
        const failedReplacementPack = replacementPack;
        OfflineManager.removeListener(failedReplacementPack.id);
        try {
          await OfflineManager.deletePack(failedReplacementPack.id);
          offlinePacks.current.delete(failedReplacementPack.id);
        } catch {
          const replacementStatus = await failedReplacementPack
            .status()
            .catch(() => null);
          if (replacementStatus) {
            const failedReplacementArea = summaryFromPack(
              failedReplacementPack,
              replacementStatus,
            );
            offlinePacks.current.set(
              failedReplacementPack.id,
              failedReplacementPack,
            );
            setSavedMapAreas(previousAreas => [
              ...previousAreas.filter(
                area => area.id !== failedReplacementPack.id,
              ),
              failedReplacementArea,
            ]);
          }
          errorMessage = `${errorMessage} Paket pembaruan sementara masih tersimpan.`;
        }
      }
      setMapPackError(errorMessage);
    } finally {
      setAreaUpdateProgress(previousProgress => {
        const remainingProgress = { ...previousProgress };
        delete remainingProgress[packId];
        return remainingProgress;
      });
    }
  }

  async function deleteArea(packId: string) {
    try {
      setMapPackError(null);
      OfflineManager.removeListener(packId);
      await OfflineManager.deletePack(packId);
      offlinePacks.current.delete(packId);
      setSavedMapAreas(previousAreas =>
        previousAreas.filter(area => area.id !== packId),
      );
    } catch (error) {
      setMapPackError(mapPackErrorMessage(error));
    }
  }

  return {
    savedMapAreas,
    mapPackCheck,
    mapPackError,
    areaUpdateProgress,
    downloadArea,
    pauseArea,
    resumeArea,
    updateArea,
    deleteArea,
  };
}

function summaryFromPack(pack: OfflinePack, status: OfflinePackStatus): SavedMapArea {
  return {
    id: pack.id,
    bounds: pack.bounds,
    status:
      status.state === 'complete'
        ? 'ready'
        : status.state === 'active'
          ? 'downloading'
          : 'paused',
    percentage: status.percentage,
    downloadedBytes: status.completedResourceSize,
  };
}

function mapPackErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Peta tidak dapat diunduh.';
}
