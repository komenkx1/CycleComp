import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Linking } from 'react-native';

import type { SavedRideFile } from '../ride/useRideTracking';
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  parseCallbackCode,
  refreshAccessToken,
} from './stravaAuthService';
import {
  checkStravaUploadStatusNative,
  loadStravaStorage,
  saveStravaStorage,
  uploadGpxToStravaNative,
} from './stravaNativeStorage';
import { DEFAULT_STRAVA_CONFIG } from './stravaConstants';
import type {
  StravaAthlete,
  StravaAuthToken,
  StravaConfig,
  StravaStorageData,
} from './stravaTypes';

const POLLING_INTERVAL_MS = 2000;
const MAX_POLLING_ATTEMPTS = 15;

export function useStrava() {
  const [storage, setStorage] = useState<StravaStorageData>({});
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [uploadingFileId, setUploadingFileId] = useState<string | null>(null);
  const [uploadProgressMessage, setUploadProgressMessage] = useState<string | null>(null);

  // Keep a ref to storage to avoid stale closures in listeners
  const storageRef = useRef<StravaStorageData>(storage);
  storageRef.current = storage;

  // Initial load
  useEffect(() => {
    let isMounted = true;
    loadStravaStorage()
      .then(data => {
        if (isMounted) {
          setStorage(data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  // Handle incoming OAuth deep links: cyclecomp://...
  const handleDeepLink = useCallback(async (url: string | null | undefined) => {
    if (!url || !url.startsWith('cyclecomp://')) {
      return;
    }

    const { code, error: authError } = parseCallbackCode(url);
    if (authError) {
      setError(`Otorisasi dibatalkan: ${authError}`);
      return;
    }

    if (!code) {
      return;
    }

    const currentConfig: StravaConfig = {
      clientId: storageRef.current.config?.clientId || DEFAULT_STRAVA_CONFIG.clientId,
      clientSecret: storageRef.current.config?.clientSecret || DEFAULT_STRAVA_CONFIG.clientSecret,
    };

    setLoading(true);
    setError(null);
    try {
      const auth = await exchangeAuthorizationCode(code, currentConfig);
      const updatedStorage: StravaStorageData = {
        ...storageRef.current,
        auth,
      };
      await saveStravaStorage(updatedStorage);
      setStorage(updatedStorage);

      const athleteName = auth.athlete
        ? `${auth.athlete.firstname} ${auth.athlete.lastname}`.trim()
        : 'Atlet';
      Alert.alert(
        'Strava Terhubung!',
        `Selamat datang, ${athleteName}! Akun Strava Anda kini siap untuk sinkronisasi rekaman gowes dari CycleComp.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gagal menukar token otorisasi Strava.';
      setError(msg);
      Alert.alert('Koneksi Gagal', msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Check initial launch URL
    Linking.getInitialURL().then(handleDeepLink);

    // Listen for URLs while app is open/backgrounded
    const subscription = Linking.addEventListener('url', event => {
      handleDeepLink(event.url);
    });

    return () => {
      subscription.remove();
    };
  }, [handleDeepLink]);

  const config: StravaConfig = {
    clientId: storage.config?.clientId || DEFAULT_STRAVA_CONFIG.clientId,
    clientSecret: storage.config?.clientSecret || DEFAULT_STRAVA_CONFIG.clientSecret,
  };
  const auth: StravaAuthToken | null = storage.auth ?? null;
  const athlete: StravaAthlete | null = auth?.athlete ?? null;
  const isConnected = Boolean(auth?.accessToken);
  const uploadedRides: Record<string, number> = storage.uploadedRides ?? {};

  // Save/update API credentials (optional override)
  const saveCredentials = useCallback(
    async (clientId: string, clientSecret: string) => {
      const newConfig: StravaConfig = {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      };
      const updated: StravaStorageData = {
        ...storageRef.current,
        config: newConfig,
      };
      await saveStravaStorage(updated);
      setStorage(updated);
      setError(null);
      return true;
    },
    [],
  );

  // Trigger login/authorization
  const connect = useCallback(async () => {
    const currentConfig: StravaConfig = {
      clientId: storageRef.current.config?.clientId || DEFAULT_STRAVA_CONFIG.clientId,
      clientSecret: storageRef.current.config?.clientSecret || DEFAULT_STRAVA_CONFIG.clientSecret,
    };

    const authUrl = buildAuthorizeUrl(currentConfig.clientId);
    const canOpen = await Linking.canOpenURL(authUrl);
    if (!canOpen) {
      Alert.alert('Gagal Membuka Browser', 'Tidak dapat membuka URL otorisasi Strava.');
      return;
    }

    await Linking.openURL(authUrl);
  }, []);

  // Disconnect / logout
  const disconnect = useCallback(async () => {
    const updated: StravaStorageData = {
      ...storageRef.current,
      auth: undefined,
    };
    await saveStravaStorage(updated);
    setStorage(updated);
  }, []);

  // Ensure valid token (auto-refresh if within 5 mins of expiry)
  const getValidToken = useCallback(async (): Promise<string> => {
    const currentAuth = storageRef.current.auth;
    const currentConfig: StravaConfig = {
      clientId: storageRef.current.config?.clientId || DEFAULT_STRAVA_CONFIG.clientId,
      clientSecret: storageRef.current.config?.clientSecret || DEFAULT_STRAVA_CONFIG.clientSecret,
    };
    if (!currentAuth?.accessToken) {
      throw new Error('Akun Strava belum terhubung.');
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const isExpiringSoon = nowSeconds >= currentAuth.expiresAt - 300;

    if (!isExpiringSoon) {
      return currentAuth.accessToken;
    }

    // Refresh token
    const newAuth = await refreshAccessToken(currentAuth.refreshToken, currentConfig);
    const updated: StravaStorageData = {
      ...storageRef.current,
      auth: newAuth,
    };
    await saveStravaStorage(updated);
    setStorage(updated);
    return newAuth.accessToken;
  }, []);

  // Upload GPX ride to Strava
  const uploadRide = useCallback(
    async (
      file: SavedRideFile,
      activityName?: string,
    ): Promise<{ success: boolean; activityId?: number; error?: string }> => {
      if (!isConnected) {
        Alert.alert(
          'Belum Terhubung',
          'Hubungkan akun Strava Anda di tab Setelan terlebih dahulu.',
        );
        return { success: false, error: 'Belum terhubung ke Strava.' };
      }

      setUploadingFileId(file.fileName);
      setUploadProgressMessage('Mengunggah rekaman gowes ke Strava...');
      setError(null);

      try {
        const token = await getValidToken();
        const finalName = activityName || file.fileName.replace(/\.gpx$/i, '');

        const initialResult = await uploadGpxToStravaNative(file.fileUrl, token, finalName);

        // If activityId is directly available (rare for GPX uploads, but possible)
        if (initialResult.activity_id) {
          const updatedUploads = {
            ...(storageRef.current.uploadedRides ?? {}),
            [file.fileName]: initialResult.activity_id,
          };
          const updatedStorage: StravaStorageData = {
            ...storageRef.current,
            uploadedRides: updatedUploads,
          };
          await saveStravaStorage(updatedStorage);
          setStorage(updatedStorage);
          setUploadingFileId(null);
          setUploadProgressMessage(null);
          return { success: true, activityId: initialResult.activity_id };
        }

        const uploadId = initialResult.id;
        if (!uploadId) {
          throw new Error('Strava tidak mengembalikan Upload ID.');
        }

        // Poll upload status
        setUploadProgressMessage('Strava sedang memproses dan memvalidasi rute...');

        for (let attempt = 1; attempt <= MAX_POLLING_ATTEMPTS; attempt++) {
          await new Promise(res => setTimeout(res, POLLING_INTERVAL_MS));

          const statusRes = await checkStravaUploadStatusNative(uploadId, token);

          if (statusRes.error) {
            throw new Error(`Strava: ${statusRes.error}`);
          }

          if (statusRes.activity_id) {
            const updatedUploads = {
              ...(storageRef.current.uploadedRides ?? {}),
              [file.fileName]: statusRes.activity_id,
            };
            const updatedStorage: StravaStorageData = {
              ...storageRef.current,
              uploadedRides: updatedUploads,
            };
            await saveStravaStorage(updatedStorage);
            setStorage(updatedStorage);
            setUploadingFileId(null);
            setUploadProgressMessage(null);
            return { success: true, activityId: statusRes.activity_id };
          }

          if (statusRes.status && statusRes.status.toLowerCase().includes('ready')) {
            const actId = statusRes.activity_id || uploadId;
            const updatedUploads = {
              ...(storageRef.current.uploadedRides ?? {}),
              [file.fileName]: actId,
            };
            const updatedStorage: StravaStorageData = {
              ...storageRef.current,
              uploadedRides: updatedUploads,
            };
            await saveStravaStorage(updatedStorage);
            setStorage(updatedStorage);
            setUploadingFileId(null);
            setUploadProgressMessage(null);
            return { success: true, activityId: actId };
          }
        }

        // If polling timed out but upload was accepted by Strava
        setUploadingFileId(null);
        setUploadProgressMessage(null);
        return {
          success: true,
          error: 'Aktivitas berhasil diterima Strava dan sedang dalam antrean pemrosesan di server Strava.',
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Gagal mengunggah ke Strava.';
        setError(msg);
        setUploadingFileId(null);
        setUploadProgressMessage(null);
        Alert.alert('Unggahan Gagal', msg);
        return { success: false, error: msg };
      }
    },
    [isConnected, getValidToken],
  );

  // Open activity in Strava App or Web
  const openStravaActivity = useCallback(async (activityId: number) => {
    const appUrl = `strava://activities/${activityId}`;
    const webUrl = `https://www.strava.com/activities/${activityId}`;

    const canOpenApp = await Linking.canOpenURL(appUrl);
    if (canOpenApp) {
      await Linking.openURL(appUrl);
    } else {
      await Linking.openURL(webUrl);
    }
  }, []);

  return {
    loading,
    error,
    config,
    auth,
    athlete,
    isConnected,
    uploadedRides,
    uploadingFileId,
    uploadProgressMessage,
    saveCredentials,
    connect,
    disconnect,
    uploadRide,
    openStravaActivity,
  };
}
