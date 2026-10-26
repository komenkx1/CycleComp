import type { StravaAuthToken, StravaConfig } from './stravaTypes';

const STRAVA_AUTH_BASE = 'https://www.strava.com/oauth/mobile/authorize';
const STRAVA_TOKEN_ENDPOINT = 'https://www.strava.com/oauth/token';
export const STRAVA_REDIRECT_URI = 'cyclecomp://cyclecomp';
export const STRAVA_SCOPE = 'read,activity:write,activity:read_all';

export function buildAuthorizeUrl(clientId: string): string {
  const params = new URLSearchParams({
    client_id: clientId.trim(),
    redirect_uri: STRAVA_REDIRECT_URI,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: STRAVA_SCOPE,
  });
  return `${STRAVA_AUTH_BASE}?${params.toString()}`;
}

export function parseCallbackCode(url: string): { code?: string; error?: string } {
  try {
    const questionIndex = url.indexOf('?');
    if (questionIndex === -1) return {};
    const queryString = url.slice(questionIndex + 1);
    const searchParams = new URLSearchParams(queryString);
    const code = searchParams.get('code') || undefined;
    const error = searchParams.get('error') || undefined;
    return { code, error };
  } catch {
    return {};
  }
}

interface StravaTokenResponse {
  token_type: string;
  access_token: string;
  expires_at: number;
  expires_in: number;
  refresh_token: string;
  athlete?: {
    id: number;
    username?: string;
    firstname: string;
    lastname: string;
    profile?: string;
  };
  message?: string;
  errors?: Array<{ resource: string; field: string; code: string }>;
}

export async function exchangeAuthorizationCode(
  code: string,
  config: StravaConfig,
): Promise<StravaAuthToken> {
  if (!config.clientId || !config.clientSecret) {
    throw new Error('Client ID dan Client Secret Strava belum diatur.');
  }

  const response = await fetch(STRAVA_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: config.clientId.trim(),
      client_secret: config.clientSecret.trim(),
      code: code.trim(),
      grant_type: 'authorization_code',
    }),
  });

  const data = (await response.json()) as StravaTokenResponse;

  if (!response.ok || !data.access_token) {
    const errorMsg = data.message || `Otorisasi Strava gagal (HTTP ${response.status})`;
    throw new Error(errorMsg);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at,
    athlete: data.athlete
      ? {
          id: data.athlete.id,
          username: data.athlete.username,
          firstname: data.athlete.firstname,
          lastname: data.athlete.lastname,
          profile: data.athlete.profile,
        }
      : undefined,
  };
}

export async function refreshAccessToken(
  refreshToken: string,
  config: StravaConfig,
): Promise<StravaAuthToken> {
  if (!config.clientId || !config.clientSecret) {
    throw new Error('Client ID dan Client Secret Strava belum diatur.');
  }

  const response = await fetch(STRAVA_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: config.clientId.trim(),
      client_secret: config.clientSecret.trim(),
      refresh_token: refreshToken.trim(),
      grant_type: 'refresh_token',
    }),
  });

  const data = (await response.json()) as StravaTokenResponse;

  if (!response.ok || !data.access_token) {
    const errorMsg = data.message || `Gagal memperbarui token Strava (HTTP ${response.status})`;
    throw new Error(errorMsg);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at,
    athlete: data.athlete
      ? {
          id: data.athlete.id,
          username: data.athlete.username,
          firstname: data.athlete.firstname,
          lastname: data.athlete.lastname,
          profile: data.athlete.profile,
        }
      : undefined,
  };
}
