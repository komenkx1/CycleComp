import {
  generateCandidateQueries,
  geocodePlaceName,
} from '../src/domain/routes/search/nominatimGeocode';

describe('nominatimGeocode', () => {
  describe('generateCandidateQueries', () => {
    it('keeps the venue and house number instead of falling back to an area', () => {
      const candidates = generateCandidateQueries(
        'Talasteduh, Jl. Pura Puseh No.51, Batubulan, Kec. Sukawati, Kabupaten Gianyar, Bali 80582',
      );
      expect(candidates.every(query => query.includes('Talasteduh'))).toBe(true);
      expect(candidates.every(query => query.includes('No.51'))).toBe(true);
    });

    it('expands administrative abbreviations', () => {
      const place = 'Jl. Raya Ubud, Kec. Ubud, Kab. Gianyar';
      const candidates = generateCandidateQueries(place);

      expect(candidates).toContain(
        'Jalan Raya Ubud, Kecamatan Ubud, Kabupaten Gianyar',
      );
    });
  });

  describe('geocodePlaceName', () => {
    it('rejects an unknown venue rather than routing to the surrounding street', async () => {
      jest.useFakeTimers();
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => [] });
      try {
        const lookup = geocodePlaceName('Talasteduh, Jalan Pura Puseh No.51, Bali');
        const lookupFailure = lookup.catch(error => error);
        await jest.runAllTimersAsync();
        expect(await lookupFailure).toEqual(expect.objectContaining({ message: expect.stringContaining('tidak ditemukan') }));
        expect((global.fetch as jest.Mock).mock.calls.every(([url]) => url.includes('Talasteduh'))).toBe(true);
      } finally {
        global.fetch = originalFetch;
        jest.useRealTimers();
      }
    });
  });
});
