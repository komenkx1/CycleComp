import {
  decodeElevationGridBlock,
  ElevationGridBlockError,
  sampleElevationGrid,
  type EncodedElevationGridBlock,
  type ElevationGridWindow,
} from '../src/domain/terrain/elevationGrid';

describe('decodeElevationGridBlock', () => {
  it('decodes little-endian signed samples and keeps valid zero and nodata separate', () => {
    const grid = decodeElevationGridBlock(createEncodedGrid({
      elevationsMeters: [-10, 0, Number.NaN, -20],
      validityMask: [0b00001011],
    }));

    expect(sampleElevationGrid(grid, [115, -8])).toBe(-10);
    expect(sampleElevationGrid(grid, [115.01, -8])).toBe(0);
    expect(sampleElevationGrid(grid, [115, -8.01])).toBeNull();
    expect(sampleElevationGrid(grid, [115.01, -8.01])).toBe(-20);
  });

  it.each([
    ['wrong elevation byte count', { elevationBytes: new Uint8Array(8) }],
    ['wrong validity mask length', { validityMask: new Uint8Array() }],
    ['non-finite valid elevation', { elevationsMeters: [1, 2, 3, Number.POSITIVE_INFINITY] }],
    ['non-empty mask padding', { validityMask: [0b11111111] }],
    ['invalid grid spacing', { longitudeStep: 0 }],
    ['oversized grid', { rows: 257, columns: 256 }],
  ])('rejects %s', (_description, override) => {
    const block = createEncodedGrid({
      elevationsMeters: [1, 2, 3, 4],
      validityMask: [0b00001111],
      ...override,
    });

    expect(() => decodeElevationGridBlock(block)).toThrow(ElevationGridBlockError);
  });
});

describe('sampleElevationGrid', () => {
  it('bilinearly samples a signed elevation plane', () => {
    const grid = createGrid({
      elevationsMeters: [-10, 0, 10, 20],
      validityMask: [0b00001111],
    });

    expect(sampleElevationGrid(grid, [115.005, -8.005])).toBeCloseTo(5, 6);
    expect(sampleElevationGrid(grid, [115, -8])).toBe(-10);
    expect(sampleElevationGrid(grid, [115.01, -8.01])).toBe(20);
  });

  it('preserves zero and negative values at valid cells beside nodata', () => {
    const grid = createGrid({
      elevationsMeters: [0, -4, 0, 0],
      validityMask: [0b00000001],
    });

    expect(sampleElevationGrid(grid, [115, -8])).toBe(0);
    expect(sampleElevationGrid(grid, [115.005, -8.005])).toBeNull();
  });

  it('returns unknown when interpolation would cross a nodata cell', () => {
    const grid = createGrid({
      elevationsMeters: [10, 20, 30, 40],
      validityMask: [0b00001101],
    });

    expect(sampleElevationGrid(grid, [115.005, -8.005])).toBeNull();
  });

  it('samples continuously across adjoining cells', () => {
    const grid: ElevationGridWindow = {
      rows: 2,
      columns: 3,
      firstCellLongitude: 115,
      firstCellLatitude: -8,
      longitudeStep: 0.01,
      latitudeStep: -0.01,
      elevationsMeters: new Float32Array([0, 10, 20, 20, 30, 40]),
      validityMask: new Uint8Array([0b00111111]),
    };

    expect(sampleElevationGrid(grid, [115.015, -8])).toBeCloseTo(15, 6);
  });

  it('returns unknown outside the grid and rejects malformed windows', () => {
    const grid = createGrid({
      elevationsMeters: [1, 2, 3, 4],
      validityMask: [0b00001111],
    });
    const malformedGrid = { ...grid, validityMask: new Uint8Array() };

    expect(sampleElevationGrid(grid, [114.999, -8])).toBeNull();
    expect(sampleElevationGrid(malformedGrid, [115, -8])).toBeNull();
    expect(sampleElevationGrid(grid, [Number.NaN, -8])).toBeNull();
  });
});

function createGrid(input: {
  elevationsMeters: number[];
  validityMask: number[];
}): ElevationGridWindow {
  return {
    rows: 2,
    columns: 2,
    firstCellLongitude: 115,
    firstCellLatitude: -8,
    longitudeStep: 0.01,
    latitudeStep: -0.01,
    elevationsMeters: new Float32Array(input.elevationsMeters),
    validityMask: new Uint8Array(input.validityMask),
  };
}

function createEncodedGrid(
  input: Partial<Omit<EncodedElevationGridBlock, 'validityMask' | 'elevationBytes'>> & {
    elevationBytes?: Uint8Array;
    elevationsMeters?: number[];
    validityMask?: number[] | Uint8Array;
  },
): EncodedElevationGridBlock {
  const rows = input.rows ?? 2;
  const columns = input.columns ?? 2;
  const elevationsMeters = input.elevationsMeters ?? Array(rows * columns).fill(0);
  const elevationBytes = new Uint8Array(elevationsMeters.length * Float32Array.BYTES_PER_ELEMENT);
  const elevationView = new DataView(elevationBytes.buffer);
  elevationsMeters.forEach((elevationMeters, cellIndex) => {
    elevationView.setFloat32(cellIndex * Float32Array.BYTES_PER_ELEMENT, elevationMeters, true);
  });

  return {
    rows,
    columns,
    firstCellLongitude: input.firstCellLongitude ?? 115,
    firstCellLatitude: input.firstCellLatitude ?? -8,
    longitudeStep: input.longitudeStep ?? 0.01,
    latitudeStep: input.latitudeStep ?? -0.01,
    elevationBytes: input.elevationBytes ?? elevationBytes,
    validityMask: input.validityMask instanceof Uint8Array
      ? new Uint8Array(input.validityMask)
      : new Uint8Array(input.validityMask ?? Array(Math.ceil(rows * columns / 8)).fill(0xff)),
  };
}
