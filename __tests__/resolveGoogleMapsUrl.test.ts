import {
  parseGoogleMapsLink,
  looksLikeGoogleMapsUrl,
  extractWaypoints,
  GoogleMapsLinkError,
} from '../src/domain/routes/search/resolveGoogleMapsUrl';

describe('resolveGoogleMapsUrl', () => {
  describe('looksLikeGoogleMapsUrl', () => {
    it('detects short links', () => {
      expect(looksLikeGoogleMapsUrl('https://maps.app.goo.gl/abcdef')).toBe(true);
      expect(looksLikeGoogleMapsUrl('https://goo.gl/maps/xyz123')).toBe(true);
    });

    it('detects google maps directions URLs', () => {
      expect(
        looksLikeGoogleMapsUrl(
          'https://www.google.com/maps/dir/-8.50,115.26/-8.40,115.18',
        ),
      ).toBe(true);
      expect(
        looksLikeGoogleMapsUrl(
          'https://www.google.co.id/maps/dir/Sanur/Ubud',
        ),
      ).toBe(true);
    });

    it('rejects non-Google URLs', () => {
      expect(looksLikeGoogleMapsUrl('https://apple.com/maps')).toBe(false);
      expect(looksLikeGoogleMapsUrl('https://example.com')).toBe(false);
    });
  });

  describe('extractWaypoints', () => {
    it('extracts coordinate pairs from path segments', () => {
      const url =
        'https://www.google.com/maps/dir/-8.5069,115.2625/-8.4095,115.1889/@-8.45,115.22,12z';
      const waypoints = extractWaypoints(url);

      expect(waypoints).toHaveLength(2);
      expect(waypoints[0]).toEqual({
        type: 'coordinate',
        latitude: -8.5069,
        longitude: 115.2625,
      });
      expect(waypoints[1]).toEqual({
        type: 'coordinate',
        latitude: -8.4095,
        longitude: 115.1889,
      });
    });

    it('extracts place names from path segments', () => {
      const url =
        'https://www.google.com/maps/dir/Pantai+Sanur/Ubud+Palace/Tegallalang';
      const waypoints = extractWaypoints(url);

      expect(waypoints).toHaveLength(3);
      expect(waypoints[0]).toEqual({
        type: 'placeName',
        name: 'Pantai Sanur',
      });
      expect(waypoints[1]).toEqual({
        type: 'placeName',
        name: 'Ubud Palace',
      });
      expect(waypoints[2]).toEqual({
        type: 'placeName',
        name: 'Tegallalang',
      });
    });

    it('extracts waypoints from query params (origin, destination, waypoints)', () => {
      const url =
        'https://www.google.com/maps/dir/?api=1&origin=-8.50,115.26&destination=-8.40,115.18&waypoints=Denpasar|Ubud';
      const waypoints = extractWaypoints(url);

      expect(waypoints).toHaveLength(4);
      expect(waypoints[0]).toEqual({
        type: 'coordinate',
        latitude: -8.5,
        longitude: 115.26,
      });
      expect(waypoints[1]).toEqual({
        type: 'placeName',
        name: 'Denpasar',
      });
      expect(waypoints[2]).toEqual({
        type: 'placeName',
        name: 'Ubud',
      });
      expect(waypoints[3]).toEqual({
        type: 'coordinate',
        latitude: -8.4,
        longitude: 115.18,
      });
    });

    it('extracts coordinates from !3d and !4d data params', () => {
      const url =
        'https://www.google.com/maps/dir/data=!4m2!4m1!3e1!3d-8.5069!4d115.2625!3d-8.4095!4d115.1889';
      const waypoints = extractWaypoints(url);

      expect(waypoints).toHaveLength(2);
      expect(waypoints[0]).toEqual({
        type: 'coordinate',
        latitude: -8.5069,
        longitude: 115.2625,
      });
      expect(waypoints[1]).toEqual({
        type: 'coordinate',
        latitude: -8.4095,
        longitude: 115.1889,
      });
    });

    it('extracts coordinates from !1d and !2d data params', () => {
      const url =
        'https://www.google.com/maps/dir/Kec.+Penebel,+Kabupaten+Tabanan,+Bali/Ubud/@-8.45,115.15,12z/data=!4m14!4m13!1m5!1m1!1s0x2dd187:0x1!2m2!1d115.1261464!2d-8.407859!1m5!1m1!1s0x2dd23d:0x2!2m2!1d115.2624734!2d-8.5068536!3e1';
      const waypoints = extractWaypoints(url);

      expect(waypoints).toHaveLength(2);
      expect(waypoints[0]).toEqual({
        type: 'coordinate',
        latitude: -8.407859,
        longitude: 115.1261464,
      });
      expect(waypoints[1]).toEqual({
        type: 'coordinate',
        latitude: -8.5068536,
        longitude: 115.2624734,
      });
    });

    it('does not use a place camera center as its pin', () => {
      const url =
        'https://www.google.com/maps/place/Monumen+Bajra+Sandhi/@-8.6717,115.2339,17z';
      const waypoints = extractWaypoints(url);

      expect(waypoints).toHaveLength(1);
      expect(waypoints[0]).toEqual({
        type: 'placeName',
        name: 'Monumen Bajra Sandhi',
      });
    });
  });

  describe('parseGoogleMapsLink', () => {
    it('throws on empty link', async () => {
      await expect(parseGoogleMapsLink('')).rejects.toThrow(
        GoogleMapsLinkError,
      );
    });

    it('throws on non-Google link', async () => {
      await expect(parseGoogleMapsLink('https://bing.com/maps')).rejects.toThrow(
        'bukan URL Google Maps',
      );
    });

    it('prepends user origin coordinate for single-place URLs', async () => {
      const url =
        'https://www.google.com/maps/place/Monumen+Bajra+Sandhi/@-8.6717,115.2339,17z';
      const parsed = await parseGoogleMapsLink(url, [115.2167, -8.65]);

      expect(parsed.waypoints).toHaveLength(2);
      expect(parsed.waypoints[0]).toEqual({
        type: 'coordinate',
        latitude: -8.65,
        longitude: 115.2167,
      });
      expect(parsed.waypoints[1]).toEqual({
        type: 'placeName',
        name: 'Monumen Bajra Sandhi',
      });
    });

    it('follows short links and extracts waypoints', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        url: 'https://www.google.com/maps/dir/-8.50,115.26/-8.40,115.18',
        text: async () => '',
      } as any);

      try {
        const parsed = await parseGoogleMapsLink('https://maps.app.goo.gl/abc123xyz');
        expect(parsed.waypoints).toHaveLength(2);
        expect(parsed.waypoints[0]).toEqual({
          type: 'coordinate',
          latitude: -8.5,
          longitude: 115.26,
        });
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('extracts suggested route name from place path segments', async () => {
      const url =
        'https://www.google.com/maps/dir/Kec.+Penebel,+Kabupaten+Tabanan,+Bali/Ubud/@-8.45,115.15,12z';
      const parsed = await parseGoogleMapsLink(url);
      expect(parsed.suggestedName).toBe('Penebel → Ubud');
    });

    it('ignores HTML pins and preserves explicit stops in the resolved short link', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        url: 'https://www.google.com/maps/dir/-8.692,115.228/-8.681,115.215',
        text: async () => '!3d-8.70!4d115.20!3d-8.72!4d115.21',
      });
      try {
        const parsed = await parseGoogleMapsLink('https://maps.app.goo.gl/test');
        expect(parsed.waypoints).toEqual([
          { type: 'coordinate', latitude: -8.692, longitude: 115.228 },
          { type: 'coordinate', latitude: -8.681, longitude: 115.215 },
        ]);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('preserves query stops despite conflicting embedded pins', async () => {
      const parsed = await parseGoogleMapsLink(
        'https://www.google.com/maps/dir/?origin=-8.692,115.228&destination=-8.681,115.215&waypoints=-8.69,115.22&data=!3d-8.7!4d115.2!3d-8.72!4d115.21',
      );
      expect(parsed.waypoints).toHaveLength(3);
      expect(parsed.waypoints[2]).toEqual({ type: 'coordinate', latitude: -8.681, longitude: 115.215 });
    });

    it('decodes the actual Wheel Co link geocode pins without searching its name', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        url: 'https://www.google.com/maps?geocode=FUtfe_8dnjveBg%3D%3D;FSN7e_8dhA7eBilz5MjQ5kDSLTF8GSWZB1ej6g%3D%3D&daddr=Wheel+Co+Sepeda+Bali,+Jalan+Raya+Sesetan,+Sesetan,+Kota+Denpasar,+Bali&saddr=-8.6918936,115.2275500&dirflg=d',
        text: async () => '',
      });
      try {
        const parsed = await parseGoogleMapsLink('https://maps.app.goo.gl/pmLBwU3K36WZvvPKA?g_st=ic');
        expect(parsed.waypoints).toEqual([
          { type: 'coordinate', latitude: -8.6918936, longitude: 115.22755 },
          { type: 'coordinate', latitude: -8.684765, longitude: 115.216004 },
        ]);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('ignores malformed geocode bytes instead of guessing a pin', () => {
      const stops = extractWaypoints('https://www.google.com/maps?saddr=-8.692,115.228&daddr=Wheel+Co&geocode=broken;AAAAAAAAAAAAAA==');
      expect(stops[1]).toEqual({ type: 'placeName', name: 'Wheel Co' });
    });

    it('decodes a destination pin with an empty origin geocode field', () => {
      const stops = extractWaypoints('https://www.google.com/maps?daddr=Wheel+Co&geocode=;FSN7e_8dhA7eBg==');
      expect(stops).toEqual([{ type: 'coordinate', latitude: -8.684765, longitude: 115.216004 }]);
    });

    it('uses the Google destination pin with a GPS origin and a named legacy destination', async () => {
      const parsed = await parseGoogleMapsLink(
        'https://www.google.com/maps?saddr=-8.692,115.228&daddr=Wheel+Co+Sepeda+Bali&data=!3d-8.681!4d115.215',
      );
      expect(parsed.waypoints).toEqual([
        { type: 'coordinate', latitude: -8.692, longitude: 115.228 },
        { type: 'coordinate', latitude: -8.681, longitude: 115.215 },
      ]);
    });

    it('uses an encoded Google pin instead of geocoding a destination query', async () => {
      const parsed = await parseGoogleMapsLink(
        'https://www.google.com/maps/dir/?api=1&destination=Wheel+Co+Sepeda+Bali&data=%213d-8.681%214d115.215',
        [115.228, -8.692],
      );
      expect(parsed.waypoints[1]).toEqual({ type: 'coordinate', latitude: -8.681, longitude: 115.215 });
    });

    it('does not duplicate a destination repeated in different pin encodings', async () => {
      const parsed = await parseGoogleMapsLink(
        'https://www.google.com/maps/dir//Wheel+Co/data=!1d115.215!2d-8.681!3d-8.681!4d115.215',
        [115.228, -8.692],
      );
      expect(parsed.waypoints).toHaveLength(2);
      expect(parsed.waypoints[0]).toEqual({ type: 'coordinate', latitude: -8.692, longitude: 115.228 });
    });

    it('handles direction links from "Your Location" with single destination coordinates and user GPS', async () => {
      const url =
        'https://www.google.com/maps/dir//Talasteduh,+Jl.+Pura+Puseh+No.51,+Batubulan,+Kec.+Sukawati,+Kabupaten+Gianyar,+Bali+80582/@-8.5997871,115.2612345,17z/data=!4m8!4m7!1m0!1m5!1m1!1s0x2dd23f0000000001:0x1234567890abcdef!2m2!1d115.2612345!2d-8.5997871';

      const userGps: [number, number] = [115.22, -8.67]; // [lng, lat]
      const parsed = await parseGoogleMapsLink(url, userGps);

      expect(parsed.waypoints).toHaveLength(2);
      expect(parsed.waypoints[0]).toEqual({
        type: 'coordinate',
        latitude: -8.67,
        longitude: 115.22,
      });
      expect(parsed.waypoints[1]).toEqual({
        type: 'coordinate',
        latitude: -8.5997871,
        longitude: 115.2612345,
      });
      expect(parsed.suggestedName).toBe('Talasteduh');
    });

    it('preserves place name for direction link from "Your Location" when no data param exists', async () => {
      const url =
        'https://www.google.com/maps/dir//Talasteduh/@-8.5997871,115.2612345,17z';

      const userGps: [number, number] = [115.22, -8.67];
      const parsed = await parseGoogleMapsLink(url, userGps);

      expect(parsed.waypoints).toHaveLength(2);
      expect(parsed.waypoints[0]).toEqual({
        type: 'coordinate',
        latitude: -8.67,
        longitude: 115.22,
      });
      // The destination is preserved as placeName so it gets geocoded accurately,
      // avoiding using the overview camera center as destination.
      expect(parsed.waypoints[1]).toEqual({
        type: 'placeName',
        name: 'Talasteduh',
      });
      expect(parsed.suggestedName).toBe('Talasteduh');
    });
  });
});

