import type { RouteCoordinate } from '../routes/gpx/GpxRoute';

/** A north-up WGS84 grid window whose origin is the center of its first cell. */
export type ElevationGridWindow = {
  rows: number;
  columns: number;
  firstCellLongitude: number;
  firstCellLatitude: number;
  longitudeStep: number;
  latitudeStep: number;
  elevationsMeters: Float32Array;
  /** One bit per cell, least-significant bit first; a set bit means valid. */
  validityMask: Uint8Array;
};

export type EncodedElevationGridBlock = Omit<ElevationGridWindow, 'elevationsMeters'> & {
  /** One little-endian Float32 value per cell. */
  elevationBytes: Uint8Array;
};

export class ElevationGridBlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ElevationGridBlockError';
  }
}

const MAX_GRID_CELLS = 65_536;

/** Decode and validate one bounded, uncompressed Float32 grid block. */
export function decodeElevationGridBlock(
  block: EncodedElevationGridBlock,
): ElevationGridWindow {
  if (!isUsableGridMetadata(block)) {
    throw new ElevationGridBlockError('Blok elevasi memiliki dimensi atau metadata yang tidak valid.');
  }

  const cellCount = block.rows * block.columns;
  if (
    block.elevationBytes.length !== cellCount * Float32Array.BYTES_PER_ELEMENT ||
    block.validityMask.length !== Math.ceil(cellCount / 8)
  ) {
    throw new ElevationGridBlockError('Ukuran data blok elevasi tidak cocok dengan dimensinya.');
  }

  const lastMaskByte = block.validityMask[block.validityMask.length - 1];
  const usedBitsInLastByte = cellCount % 8;
  if (usedBitsInLastByte !== 0 && lastMaskByte !== undefined) {
    if (lastMaskByte >= 2 ** usedBitsInLastByte) {
      throw new ElevationGridBlockError('Mask validitas blok elevasi memiliki bit padding yang tidak kosong.');
    }
  }

  const elevationsView = new DataView(
    block.elevationBytes.buffer,
    block.elevationBytes.byteOffset,
    block.elevationBytes.byteLength,
  );
  const elevationsMeters = new Float32Array(cellCount);
  for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
    const elevationMeters = elevationsView.getFloat32(cellIndex * Float32Array.BYTES_PER_ELEMENT, true);
    const validityMaskByte = block.validityMask[Math.floor(cellIndex / 8)]!;
    const isValidCell = Math.floor(validityMaskByte / (2 ** (cellIndex % 8))) % 2 === 1;
    if (isValidCell && !Number.isFinite(elevationMeters)) {
      throw new ElevationGridBlockError('Sel elevasi valid harus berisi nilai finite.');
    }
    elevationsMeters[cellIndex] = elevationMeters;
  }

  return {
    rows: block.rows,
    columns: block.columns,
    firstCellLongitude: block.firstCellLongitude,
    firstCellLatitude: block.firstCellLatitude,
    longitudeStep: block.longitudeStep,
    latitudeStep: block.latitudeStep,
    elevationsMeters,
    validityMask: new Uint8Array(block.validityMask),
  };
}

/**
 * Samples one cell or bilinearly interpolates its four neighbors.
 * Invalid or uncovered pixels stay unknown; zero and negative elevations are valid.
 */
export function sampleElevationGrid(
  grid: ElevationGridWindow,
  coordinate: RouteCoordinate,
): number | null {
  const [longitude, latitude] = coordinate;
  if (!isUsableGrid(grid) || !isValidCoordinate(longitude, latitude)) {
    return null;
  }

  const gridColumn = snapToGridCell(
    (longitude - grid.firstCellLongitude) / grid.longitudeStep,
  );
  const gridRow = snapToGridCell(
    (latitude - grid.firstCellLatitude) / grid.latitudeStep,
  );
  if (
    gridColumn < 0 || gridColumn > grid.columns - 1 ||
    gridRow < 0 || gridRow > grid.rows - 1
  ) {
    return null;
  }

  const leftColumn = Math.floor(gridColumn);
  const upperRow = Math.floor(gridRow);
  const rightColumn = Math.min(leftColumn + 1, grid.columns - 1);
  const lowerRow = Math.min(upperRow + 1, grid.rows - 1);
  const columnFraction = gridColumn - leftColumn;
  const rowFraction = gridRow - upperRow;

  const weightedCorners = [
    { row: upperRow, column: leftColumn, weight: (1 - columnFraction) * (1 - rowFraction) },
    { row: upperRow, column: rightColumn, weight: columnFraction * (1 - rowFraction) },
    { row: lowerRow, column: leftColumn, weight: (1 - columnFraction) * rowFraction },
    { row: lowerRow, column: rightColumn, weight: columnFraction * rowFraction },
  ];

  let interpolatedElevationMeters = 0;
  for (const corner of weightedCorners) {
    if (corner.weight === 0) {
      continue;
    }

    const elevationMeters = readElevationCell(grid, corner.row, corner.column);
    if (elevationMeters === null) {
      return null;
    }
    interpolatedElevationMeters += elevationMeters * corner.weight;
  }

  return Number.isFinite(interpolatedElevationMeters)
    ? interpolatedElevationMeters
    : null;
}

function readElevationCell(
  grid: ElevationGridWindow,
  row: number,
  column: number,
): number | null {
  const cellIndex = row * grid.columns + column;
  const maskByte = grid.validityMask[Math.floor(cellIndex / 8)];
  const maskBit = 2 ** (cellIndex % 8);
  if (
    maskByte === undefined ||
    Math.floor(maskByte / maskBit) % 2 === 0
  ) {
    return null;
  }

  const elevationMeters = grid.elevationsMeters[cellIndex];
  return elevationMeters !== undefined && Number.isFinite(elevationMeters)
    ? elevationMeters
    : null;
}

function isUsableGrid(grid: ElevationGridWindow): boolean {
  return isUsableGridMetadata(grid) &&
    grid.elevationsMeters.length === grid.rows * grid.columns &&
    grid.validityMask.length === Math.ceil((grid.rows * grid.columns) / 8);
}

function isUsableGridMetadata(
  grid: Pick<ElevationGridWindow, 'rows' | 'columns' | 'firstCellLongitude' | 'firstCellLatitude' | 'longitudeStep' | 'latitudeStep'>,
): boolean {
  if (
    !Number.isInteger(grid.rows) || !Number.isInteger(grid.columns) ||
    grid.rows < 1 || grid.columns < 1 ||
    grid.rows * grid.columns > MAX_GRID_CELLS ||
    !Number.isFinite(grid.firstCellLongitude) ||
    !Number.isFinite(grid.firstCellLatitude) ||
    !Number.isFinite(grid.longitudeStep) || grid.longitudeStep <= 0 ||
    !Number.isFinite(grid.latitudeStep) || grid.latitudeStep >= 0
  ) {
    return false;
  }

  const lastCellLongitude = grid.firstCellLongitude + (grid.columns - 1) * grid.longitudeStep;
  const lastCellLatitude = grid.firstCellLatitude + (grid.rows - 1) * grid.latitudeStep;
  return isValidCoordinate(grid.firstCellLongitude, grid.firstCellLatitude) &&
    isValidCoordinate(lastCellLongitude, lastCellLatitude);
}

function isValidCoordinate(longitude: number, latitude: number): boolean {
  return Number.isFinite(longitude) && Number.isFinite(latitude) &&
    longitude >= -180 && longitude <= 180 &&
    latitude >= -90 && latitude <= 90;
}

function snapToGridCell(gridCoordinate: number): number {
  const nearestCell = Math.round(gridCoordinate);
  return Math.abs(gridCoordinate - nearestCell) < 1e-8 ? nearestCell : gridCoordinate;
}
