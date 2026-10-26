import { NativeModules } from 'react-native';
import type { StravaStorageData, StravaUploadResult } from './stravaTypes';

interface RideTrackingNativeStrava {
  getStravaStorage(): Promise<Record<string, unknown>>;
  setStravaStorage(data: Record<string, unknown>): Promise<boolean>;
  uploadGpxToStrava(fileUrl: string, accessToken: string, activityName: string): Promise<StravaUploadResult>;
  checkStravaUploadStatus(uploadId: string, accessToken: string): Promise<StravaUploadResult>;
}

function getRideTracking(): RideTrackingNativeStrava | undefined {
  return NativeModules.RideTracking as RideTrackingNativeStrava | undefined;
}

export async function loadStravaStorage(): Promise<StravaStorageData> {
  const tracking = getRideTracking();
  if (!tracking?.getStravaStorage) {
    return {};
  }
  try {
    const raw = await tracking.getStravaStorage();
    return (raw as unknown as StravaStorageData) || {};
  } catch (error) {
    console.warn('Gagal memuat penyimpanan Strava:', error);
    return {};
  }
}

export async function saveStravaStorage(data: StravaStorageData): Promise<boolean> {
  const tracking = getRideTracking();
  if (!tracking?.setStravaStorage) {
    return false;
  }
  try {
    await tracking.setStravaStorage(data as unknown as Record<string, unknown>);
    return true;
  } catch (error) {
    console.warn('Gagal menyimpan penyimpanan Strava:', error);
    return false;
  }
}

export async function uploadGpxToStravaNative(
  fileUrl: string,
  accessToken: string,
  activityName: string,
): Promise<StravaUploadResult> {
  const tracking = getRideTracking();
  if (!tracking?.uploadGpxToStrava) {
    throw new Error('Modul upload native Strava tidak tersedia.');
  }
  return tracking.uploadGpxToStrava(fileUrl, accessToken, activityName);
}

export async function checkStravaUploadStatusNative(
  uploadId: string | number,
  accessToken: string,
): Promise<StravaUploadResult> {
  const tracking = getRideTracking();
  if (!tracking?.checkStravaUploadStatus) {
    throw new Error('Modul pengecekan status Strava tidak tersedia.');
  }
  return tracking.checkStravaUploadStatus(String(uploadId), accessToken);
}
