export interface StravaAthlete {
  id: number;
  username?: string;
  firstname: string;
  lastname: string;
  profile?: string;
}

export interface StravaAuthToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp in seconds
  athlete?: StravaAthlete;
}

export interface StravaConfig {
  clientId: string;
  clientSecret: string;
}

export interface StravaStorageData {
  config?: StravaConfig;
  auth?: StravaAuthToken;
  uploadedRides?: Record<string, number>; // fileName -> stravaActivityId
}

export interface StravaUploadResult {
  id: number;
  id_str?: string;
  external_id?: string;
  error?: string | null;
  status: string;
  activity_id?: number | null;
}
