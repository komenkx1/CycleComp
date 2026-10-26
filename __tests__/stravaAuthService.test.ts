import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  parseCallbackCode,
  refreshAccessToken,
  STRAVA_REDIRECT_URI,
  STRAVA_SCOPE,
} from '../src/features/strava/stravaAuthService';

describe('stravaAuthService', () => {
  const mockConfig = {
    clientId: '123456',
    clientSecret: 'abcdef1234567890',
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('buildAuthorizeUrl', () => {
    it('creates correct OAuth url with custom scheme redirect and write scopes', () => {
      const url = buildAuthorizeUrl('123456');
      expect(url).toContain('https://www.strava.com/oauth/mobile/authorize');
      expect(url).toContain('client_id=123456');
      expect(url).toContain(`redirect_uri=${encodeURIComponent(STRAVA_REDIRECT_URI)}`);
      expect(url).toContain(`scope=${encodeURIComponent(STRAVA_SCOPE)}`);
      expect(url).toContain('response_type=code');
    });
  });

  describe('parseCallbackCode', () => {
    it('extracts code from redirect uri', () => {
      const uri = 'cyclecomp://strava-callback?state=&code=test_auth_code_999&scope=read,activity:write';
      const result = parseCallbackCode(uri);
      expect(result.code).toBe('test_auth_code_999');
      expect(result.error).toBeUndefined();
    });

    it('extracts error if user canceled', () => {
      const uri = 'cyclecomp://strava-callback?error=access_denied';
      const result = parseCallbackCode(uri);
      expect(result.error).toBe('access_denied');
      expect(result.code).toBeUndefined();
    });

    it('returns empty object if no query params', () => {
      const result = parseCallbackCode('cyclecomp://strava-callback');
      expect(result.code).toBeUndefined();
      expect(result.error).toBeUndefined();
    });
  });

  describe('exchangeAuthorizationCode', () => {
    it('successfully exchanges code for tokens and athlete profile', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          token_type: 'Bearer',
          access_token: 'mock_access_token_123',
          expires_at: 1770000000,
          expires_in: 21600,
          refresh_token: 'mock_refresh_token_456',
          athlete: {
            id: 998877,
            firstname: 'Mang',
            lastname: 'Wahyu',
          },
        }),
      } as Response);

      const token = await exchangeAuthorizationCode('auth_code_1', mockConfig);

      expect(token.accessToken).toBe('mock_access_token_123');
      expect(token.refreshToken).toBe('mock_refresh_token_456');
      expect(token.athlete?.firstname).toBe('Mang');
      expect(token.athlete?.id).toBe(998877);

      expect(fetch).toHaveBeenCalledWith(
        'https://www.strava.com/oauth/token',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            client_id: '123456',
            client_secret: 'abcdef1234567890',
            code: 'auth_code_1',
            grant_type: 'authorization_code',
          }),
        }),
      );
    });

    it('throws error if Strava rejects credentials or code', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          message: 'Bad Request: Invalid client_id',
        }),
      } as Response);

      await expect(exchangeAuthorizationCode('invalid_code', mockConfig)).rejects.toThrow(
        'Bad Request: Invalid client_id',
      );
    });
  });

  describe('refreshAccessToken', () => {
    it('refreshes token using refresh_token grant', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          token_type: 'Bearer',
          access_token: 'refreshed_access_token',
          expires_at: 1780000000,
          expires_in: 21600,
          refresh_token: 'new_refresh_token',
        }),
      } as Response);

      const token = await refreshAccessToken('old_refresh_token', mockConfig);

      expect(token.accessToken).toBe('refreshed_access_token');
      expect(token.refreshToken).toBe('new_refresh_token');

      expect(fetch).toHaveBeenCalledWith(
        'https://www.strava.com/oauth/token',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            client_id: '123456',
            client_secret: 'abcdef1234567890',
            refresh_token: 'old_refresh_token',
            grant_type: 'refresh_token',
          }),
        }),
      );
    });
  });
});
