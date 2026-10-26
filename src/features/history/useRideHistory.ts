import { useCallback, useEffect, useState } from 'react';
import { NativeModules } from 'react-native';

import type { GpxRoute } from '../../domain/routes/gpx/GpxRoute';
import { parseGpxRoute } from '../../domain/routes/gpx/parseGpxRoute';
import type { SavedRideFile } from '../ride/useRideTracking';

interface RideTrackingNativeMethods {
  listSavedRides(): Promise<SavedRideFile[]>;
  readSavedRideGpx(fileUrl: string): Promise<string>;
  deleteSavedRide(fileUrl: string): Promise<boolean>;
  shareGpx(fileUrl: string): Promise<void>;
  shareSensorTrace(fileUrl: string): Promise<void>;
}

function getRideTracking(): RideTrackingNativeMethods | undefined {
  return NativeModules.RideTracking as RideTrackingNativeMethods | undefined;
}

export interface SelectedRideDetail {
  file: SavedRideFile;
  route: GpxRoute;
  rawGpxXml: string;
}

export function useRideHistory() {
  const [rides, setRides] = useState<SavedRideFile[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedRide, setSelectedRide] = useState<SelectedRideDetail | null>(null);
  const [loadingSelected, setLoadingSelected] = useState<boolean>(false);

  const loadRides = useCallback(async () => {
    const tracking = getRideTracking();
    if (!tracking?.listSavedRides) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const items = await tracking.listSavedRides();
      setRides(items);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal memuat riwayat gowes.';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  const selectRide = useCallback(async (file: SavedRideFile): Promise<SelectedRideDetail | null> => {
    const tracking = getRideTracking();
    if (!tracking?.readSavedRideGpx) {
      setError('Modul pembaca GPX belum tersedia.');
      return null;
    }
    setLoadingSelected(true);
    setError(null);
    try {
      const rawGpxXml = await tracking.readSavedRideGpx(file.fileUrl);
      const route = parseGpxRoute(rawGpxXml, file.fileName);
      const detail: SelectedRideDetail = {
        file,
        route,
        rawGpxXml,
      };
      setSelectedRide(detail);
      return detail;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal membaca file GPX ini.';
      setError(message);
      return null;
    } finally {
      setLoadingSelected(false);
    }
  }, []);

  const clearSelectedRide = useCallback(() => {
    setSelectedRide(null);
  }, []);

  const deleteRide = useCallback(async (file: SavedRideFile): Promise<boolean> => {
    const tracking = getRideTracking();
    if (!tracking?.deleteSavedRide) {
      return false;
    }
    try {
      await tracking.deleteSavedRide(file.fileUrl);
      if (selectedRide?.file.id === file.id) {
        setSelectedRide(null);
      }
      await loadRides();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal menghapus file rekaman.';
      setError(message);
      return false;
    }
  }, [loadRides, selectedRide?.file.id]);

  const shareRide = useCallback(async (fileUrl: string) => {
    const tracking = getRideTracking();
    if (!tracking?.shareGpx) return;
    try {
      await tracking.shareGpx(fileUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal membuka menu berbagi.';
      setError(message);
    }
  }, []);

  const shareSensorTrace = useCallback(async (fileUrl: string) => {
    const tracking = getRideTracking();
    if (!tracking?.shareSensorTrace) return;
    try {
      await tracking.shareSensorTrace(fileUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal membuka menu berbagi sensor trace.';
      setError(message);
    }
  }, []);

  useEffect(() => {
    void loadRides();
  }, [loadRides]);

  return {
    rides,
    loading,
    error,
    selectedRide,
    loadingSelected,
    loadRides,
    selectRide,
    clearSelectedRide,
    deleteRide,
    shareRide,
    shareSensorTrace,
  };
}
