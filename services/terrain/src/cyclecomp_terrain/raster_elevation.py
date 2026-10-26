from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import re
import threading
from typing import Literal

import numpy as np
import rasterio
from rasterio.windows import Window


ElevationReason = Literal["out_of_coverage", "nodata", "incomplete_neighborhood"]
GDAL_BLOCK_CACHE_BYTES = 64 * 1024 * 1024
RASTER_WINDOW_SIZE_CELLS = 64
MAXIMUM_CACHED_RASTER_WINDOWS = 128


class TerrainDatasetError(RuntimeError):
    pass


@dataclass(frozen=True)
class TerrainSource:
    dataset_version: str
    name: str
    source_release: str
    vertical_datum: str
    source_resolution_meters: float
    attribution: str


@dataclass(frozen=True)
class RasterTile:
    tile_id: str
    relative_file: str
    sha256: str
    bounds: tuple[float, float, float, float]


@dataclass(frozen=True)
class RasterGridReference:
    first_cell_longitude: float
    first_cell_latitude: float
    longitude_step: float
    latitude_step: float


@dataclass(frozen=True)
class RasterGridBlock:
    elevations_meters: np.ndarray
    valid_cells: np.ndarray
    covered_cells: np.ndarray


@dataclass(frozen=True)
class ElevationSample:
    elevation_meters: float | None
    reason: ElevationReason | None


class RasterElevationStore:
    def __init__(self, dataset_directory: Path, maximum_open_tiles: int = 4) -> None:
        if maximum_open_tiles < 1:
            raise ValueError("maximum_open_tiles must be positive")

        self.dataset_directory = dataset_directory.resolve(strict=True)
        self.source, self.tiles = self._read_manifest(self.dataset_directory)
        self.maximum_open_tiles = maximum_open_tiles
        self._open_datasets: OrderedDict[str, rasterio.DatasetReader] = OrderedDict()
        self._cached_raster_windows: OrderedDict[tuple[str, int, int], np.ma.MaskedArray] = OrderedDict()
        self._verified_tiles: set[str] = set()
        self._lock = threading.RLock()

    @property
    def is_ready(self) -> bool:
        return bool(self.tiles)

    def close(self) -> None:
        with self._lock:
            for dataset in self._open_datasets.values():
                dataset.close()
            self._open_datasets.clear()
            self._cached_raster_windows.clear()

    def sample(self, longitude: float, latitude: float) -> ElevationSample:
        with self._lock, rasterio.Env(GDAL_CACHEMAX=GDAL_BLOCK_CACHE_BYTES):
            return self._sample_locked(longitude, latitude)

    def sample_batch(self, coordinates: list[tuple[float, float]]) -> list[ElevationSample]:
        with self._lock, rasterio.Env(GDAL_CACHEMAX=GDAL_BLOCK_CACHE_BYTES):
            return [
                self._sample_locked(longitude, latitude)
                for longitude, latitude in coordinates
            ]

    def grid_reference_at(self, longitude: float, latitude: float) -> RasterGridReference:
        with self._lock, rasterio.Env(GDAL_CACHEMAX=GDAL_BLOCK_CACHE_BYTES):
            tile = self._find_tile(longitude, latitude)
            if tile is None:
                raise ValueError("coordinate is outside all raster tiles")

            dataset = self._open_tile(tile)
            transform = dataset.transform
            if abs(transform.b) > 1e-12 or abs(transform.d) > 1e-12 or transform.a <= 0 or transform.e >= 0:
                raise TerrainDatasetError(f"terrain tile {tile.tile_id} is not a north-up grid")

            first_cell_longitude, first_cell_latitude = dataset.transform @ (0.5, 0.5)
            return RasterGridReference(
                first_cell_longitude=float(first_cell_longitude),
                first_cell_latitude=float(first_cell_latitude),
                longitude_step=float(transform.a),
                latitude_step=float(transform.e),
            )

    def read_aligned_grid_block(
        self,
        grid_reference: RasterGridReference,
        first_row: int,
        stop_row: int,
        first_column: int,
        stop_column: int,
    ) -> RasterGridBlock:
        if first_row >= stop_row or first_column >= stop_column:
            raise ValueError("raster grid block must contain at least one cell")

        block_shape = (stop_row - first_row, stop_column - first_column)
        elevations_meters = np.zeros(block_shape, dtype="<f4")
        valid_cells = np.zeros(block_shape, dtype=np.bool_)
        covered_cells = np.zeros(block_shape, dtype=np.bool_)

        with self._lock, rasterio.Env(GDAL_CACHEMAX=GDAL_BLOCK_CACHE_BYTES):
            first_cell_longitude = (
                grid_reference.first_cell_longitude + first_column * grid_reference.longitude_step
            )
            last_cell_longitude = (
                grid_reference.first_cell_longitude + (stop_column - 1) * grid_reference.longitude_step
            )
            first_cell_latitude = (
                grid_reference.first_cell_latitude + first_row * grid_reference.latitude_step
            )
            last_cell_latitude = (
                grid_reference.first_cell_latitude + (stop_row - 1) * grid_reference.latitude_step
            )
            block_west = min(first_cell_longitude, last_cell_longitude)
            block_east = max(first_cell_longitude, last_cell_longitude)
            block_south = min(first_cell_latitude, last_cell_latitude)
            block_north = max(first_cell_latitude, last_cell_latitude)

            for tile in self.tiles:
                tile_west, tile_south, tile_east, tile_north = tile.bounds
                if (
                    tile_east < block_west
                    or tile_west > block_east
                    or tile_north < block_south
                    or tile_south > block_north
                ):
                    continue

                dataset = self._open_tile(tile)
                tile_first_cell_longitude, tile_first_cell_latitude = dataset.transform @ (0.5, 0.5)
                column_offset = (
                    tile_first_cell_longitude - grid_reference.first_cell_longitude
                ) / grid_reference.longitude_step
                row_offset = (
                    tile_first_cell_latitude - grid_reference.first_cell_latitude
                ) / grid_reference.latitude_step
                rounded_column_offset = round(column_offset)
                rounded_row_offset = round(row_offset)
                if (
                    abs(column_offset - rounded_column_offset) > 1e-6
                    or abs(row_offset - rounded_row_offset) > 1e-6
                    or abs(dataset.transform.a - grid_reference.longitude_step) > 1e-12
                    or abs(dataset.transform.e - grid_reference.latitude_step) > 1e-12
                ):
                    raise TerrainDatasetError("terrain tile does not align with the requested elevation grid")

                tile_first_row = rounded_row_offset
                tile_stop_row = tile_first_row + dataset.height
                tile_first_column = rounded_column_offset
                tile_stop_column = tile_first_column + dataset.width
                overlap_first_row = max(first_row, tile_first_row)
                overlap_stop_row = min(stop_row, tile_stop_row)
                overlap_first_column = max(first_column, tile_first_column)
                overlap_stop_column = min(stop_column, tile_stop_column)
                if overlap_first_row >= overlap_stop_row or overlap_first_column >= overlap_stop_column:
                    continue

                target_rows = slice(overlap_first_row - first_row, overlap_stop_row - first_row)
                target_columns = slice(
                    overlap_first_column - first_column,
                    overlap_stop_column - first_column,
                )
                covered_region = covered_cells[target_rows, target_columns]
                unassigned_cells = ~covered_region
                if not unassigned_cells.any():
                    continue

                source_row = overlap_first_row - tile_first_row
                source_column = overlap_first_column - tile_first_column
                source_values = dataset.read(
                    1,
                    window=Window(
                        source_column,
                        source_row,
                        overlap_stop_column - overlap_first_column,
                        overlap_stop_row - overlap_first_row,
                    ),
                    masked=True,
                )
                source_elevations = np.asarray(np.ma.getdata(source_values), dtype="<f4")
                source_is_valid = ~np.ma.getmaskarray(source_values) & np.isfinite(source_elevations)
                valid_region = valid_cells[target_rows, target_columns]
                elevation_region = elevations_meters[target_rows, target_columns]

                covered_region[unassigned_cells] = True
                valid_region[unassigned_cells] = source_is_valid[unassigned_cells]
                valid_source_cells = unassigned_cells & source_is_valid
                elevation_region[valid_source_cells] = source_elevations[valid_source_cells]

        return RasterGridBlock(elevations_meters, valid_cells, covered_cells)

    def _sample_locked(self, longitude: float, latitude: float) -> ElevationSample:
        if not math.isfinite(longitude) or not math.isfinite(latitude):
            raise ValueError("coordinates must be finite")
        if not -180 <= longitude <= 180 or not -90 <= latitude <= 90:
            raise ValueError("coordinates are outside WGS84 bounds")

        base_tile = self._find_tile(longitude, latitude)
        if base_tile is None:
            return ElevationSample(None, "out_of_coverage")

        base_dataset = self._open_tile(base_tile)
        pixel_column, pixel_row = (~base_dataset.transform) @ (longitude, latitude)
        center_column = pixel_column - 0.5
        center_row = pixel_row - 0.5
        column_before = math.floor(center_column)
        row_before = math.floor(center_row)
        horizontal_fraction = center_column - column_before
        vertical_fraction = center_row - row_before

        weighted_samples = (
            (row_before, column_before, (1 - horizontal_fraction) * (1 - vertical_fraction)),
            (row_before, column_before + 1, horizontal_fraction * (1 - vertical_fraction)),
            (row_before + 1, column_before, (1 - horizontal_fraction) * vertical_fraction),
            (row_before + 1, column_before + 1, horizontal_fraction * vertical_fraction),
        )

        neighboring_centers = [
            (base_dataset.transform @ (column + 0.5, row + 0.5), weight)
            for row, column, weight in weighted_samples
            if weight > 1e-12
        ]
        interpolated_elevation = 0.0
        for pixel_center, weight in neighboring_centers:
            neighboring_tile = self._find_tile(pixel_center[0], pixel_center[1])
            if neighboring_tile is None:
                return ElevationSample(None, "incomplete_neighborhood")

            elevation, missing_reason = self._read_pixel_at_center(neighboring_tile, pixel_center)
            if elevation is None:
                return ElevationSample(None, missing_reason)
            interpolated_elevation += elevation * weight

        if not math.isfinite(interpolated_elevation):
            return ElevationSample(None, "nodata")
        return ElevationSample(interpolated_elevation, None)

    def _read_pixel_at_center(
        self,
        tile: RasterTile,
        pixel_center: tuple[float, float],
    ) -> tuple[float | None, ElevationReason | None]:
        dataset = self._open_tile(tile)
        pixel_column, pixel_row = (~dataset.transform) @ pixel_center
        column = round(pixel_column - 0.5)
        row = round(pixel_row - 0.5)
        if row < 0 or column < 0 or row >= dataset.height or column >= dataset.width:
            return None, "incomplete_neighborhood"

        actual_center = dataset.transform @ (column + 0.5, row + 0.5)
        horizontal_pixel_size = math.hypot(dataset.transform.a, dataset.transform.d)
        vertical_pixel_size = math.hypot(dataset.transform.b, dataset.transform.e)
        if (
            abs(actual_center[0] - pixel_center[0]) > horizontal_pixel_size * 0.01
            or abs(actual_center[1] - pixel_center[1]) > vertical_pixel_size * 0.01
        ):
            return None, "incomplete_neighborhood"

        first_window_row = row // RASTER_WINDOW_SIZE_CELLS * RASTER_WINDOW_SIZE_CELLS
        first_window_column = column // RASTER_WINDOW_SIZE_CELLS * RASTER_WINDOW_SIZE_CELLS
        window_key = (tile.tile_id, first_window_row, first_window_column)
        masked_window = self._cached_raster_windows.pop(window_key, None)
        if masked_window is None:
            masked_window = dataset.read(
                1,
                window=Window(
                    first_window_column,
                    first_window_row,
                    min(RASTER_WINDOW_SIZE_CELLS, dataset.width - first_window_column),
                    min(RASTER_WINDOW_SIZE_CELLS, dataset.height - first_window_row),
                ),
                masked=True,
            )
        self._cached_raster_windows[window_key] = masked_window
        while len(self._cached_raster_windows) > MAXIMUM_CACHED_RASTER_WINDOWS:
            self._cached_raster_windows.popitem(last=False)

        elevation_pixel = masked_window[row - first_window_row, column - first_window_column]
        if np.ma.is_masked(elevation_pixel):
            return None, "nodata"

        elevation = float(elevation_pixel)
        return (elevation, None) if math.isfinite(elevation) else (None, "nodata")

    def _find_tile(self, longitude: float, latitude: float) -> RasterTile | None:
        for tile in self.tiles:
            west, south, east, north = tile.bounds
            if west <= longitude <= east and south <= latitude <= north:
                return tile
        return None

    def _open_tile(self, tile: RasterTile) -> rasterio.DatasetReader:
        cached_dataset = self._open_datasets.pop(tile.tile_id, None)
        if cached_dataset is not None:
            self._open_datasets[tile.tile_id] = cached_dataset
            return cached_dataset

        tile_path = self._resolve_tile_path(tile.relative_file)
        if tile.tile_id not in self._verified_tiles:
            tile_digest = hashlib.sha256()
            try:
                with tile_path.open("rb") as tile_file:
                    for chunk in iter(lambda: tile_file.read(1024 * 1024), b""):
                        tile_digest.update(chunk)
            except OSError as error:
                raise TerrainDatasetError(f"could not verify terrain tile {tile.tile_id}") from error
            if tile_digest.hexdigest() != tile.sha256:
                raise TerrainDatasetError(f"terrain tile {tile.tile_id} failed SHA-256 verification")
            self._verified_tiles.add(tile.tile_id)

        try:
            dataset = rasterio.open(tile_path)
        except (OSError, rasterio.errors.RasterioError) as error:
            raise TerrainDatasetError(f"could not open terrain tile {tile.tile_id}") from error

        if dataset.crs is None or dataset.crs.to_epsg() != 4326 or dataset.count != 1:
            dataset.close()
            raise TerrainDatasetError(f"terrain tile {tile.tile_id} has an unsupported raster layout")

        if np.dtype(dataset.dtypes[0]).kind not in {"i", "u", "f"}:
            dataset.close()
            raise TerrainDatasetError(f"terrain tile {tile.tile_id} has a non-numeric elevation band")

        actual_bounds = (dataset.bounds.left, dataset.bounds.bottom, dataset.bounds.right, dataset.bounds.top)
        if any(abs(actual - expected) > 1e-7 for actual, expected in zip(actual_bounds, tile.bounds)):
            dataset.close()
            raise TerrainDatasetError(f"terrain tile {tile.tile_id} bounds do not match its manifest")

        self._open_datasets[tile.tile_id] = dataset
        while len(self._open_datasets) > self.maximum_open_tiles:
            _, expired_dataset = self._open_datasets.popitem(last=False)
            expired_dataset.close()
        return dataset

    def _resolve_tile_path(self, relative_file: str) -> Path:
        relative_path = PurePosixPath(relative_file)
        if (
            relative_path.is_absolute()
            or ".." in relative_path.parts
            or "\\" in relative_file
            or relative_path.suffix.lower() not in {".tif", ".tiff"}
        ):
            raise TerrainDatasetError("terrain manifest contains an unsafe tile path")

        tile_path = self.dataset_directory.joinpath(*relative_path.parts).resolve(strict=True)
        if self.dataset_directory not in tile_path.parents:
            raise TerrainDatasetError("terrain tile path escapes the dataset directory")
        return tile_path

    @classmethod
    def _read_manifest(cls, dataset_directory: Path) -> tuple[TerrainSource, tuple[RasterTile, ...]]:
        try:
            manifest_path = (dataset_directory / "manifest.json").resolve(strict=True)
        except OSError as error:
            raise TerrainDatasetError("terrain manifest is missing or invalid") from error
        if dataset_directory not in manifest_path.parents:
            raise TerrainDatasetError("terrain manifest path escapes the dataset directory")

        try:
            if manifest_path.stat().st_size > 16 * 1024 * 1024:
                raise TerrainDatasetError("terrain manifest exceeds the 16 MiB limit")
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise TerrainDatasetError("terrain manifest is missing or invalid") from error

        if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1:
            raise TerrainDatasetError("terrain manifest schema is unsupported")

        source_manifest = manifest.get("source")
        if not isinstance(source_manifest, dict):
            raise TerrainDatasetError("terrain manifest has no source metadata")

        try:
            source = TerrainSource(
                dataset_version=cls._required_text(manifest, "datasetVersion"),
                name=cls._required_text(source_manifest, "name"),
                source_release=cls._required_text(source_manifest, "release"),
                vertical_datum=cls._required_text(source_manifest, "verticalDatum"),
                source_resolution_meters=cls._positive_number(source_manifest, "resolutionMeters"),
                attribution=cls._required_text(source_manifest, "attribution"),
            )
        except (TypeError, ValueError) as error:
            raise TerrainDatasetError("terrain source metadata is incomplete") from error

        tile_manifest = manifest.get("tiles")
        if not isinstance(tile_manifest, list) or len(tile_manifest) > 10_000:
            raise TerrainDatasetError("terrain manifest has no tile list")

        tiles: list[RasterTile] = []
        tile_ids: set[str] = set()
        relative_files: set[str] = set()
        for tile_record in tile_manifest:
            if not isinstance(tile_record, dict):
                raise TerrainDatasetError("terrain manifest contains an invalid tile record")
            try:
                tile_id = cls._required_text(tile_record, "id")
                relative_file = cls._required_text(tile_record, "file")
                sha256 = cls._required_text(tile_record, "sha256").lower()
                bounds = cls._bounds(tile_record.get("bounds"))
            except (TypeError, ValueError) as error:
                raise TerrainDatasetError("terrain manifest contains incomplete tile metadata") from error

            if not re.fullmatch(r"[0-9a-f]{64}", sha256):
                raise TerrainDatasetError(f"terrain tile {tile_id} has an invalid SHA-256")
            if tile_id in tile_ids or relative_file in relative_files:
                raise TerrainDatasetError("terrain manifest contains duplicate tile identities")

            tile = RasterTile(tile_id, relative_file, sha256, bounds)
            resolved_path = cls._resolve_manifest_path(dataset_directory, tile)
            if not resolved_path.is_file():
                raise TerrainDatasetError(f"terrain tile {tile_id} is missing")
            tiles.append(tile)
            tile_ids.add(tile_id)
            relative_files.add(relative_file)

        if not tiles:
            raise TerrainDatasetError("terrain manifest contains no available tiles")
        tiles.sort(key=lambda tile: tile.tile_id)
        return source, tuple(tiles)

    @classmethod
    def _resolve_manifest_path(cls, dataset_directory: Path, tile: RasterTile) -> Path:
        relative_path = PurePosixPath(tile.relative_file)
        if (
            relative_path.is_absolute()
            or ".." in relative_path.parts
            or "\\" in tile.relative_file
            or relative_path.suffix.lower() not in {".tif", ".tiff"}
        ):
            raise TerrainDatasetError("terrain manifest contains an unsafe tile path")
        try:
            resolved_path = dataset_directory.joinpath(*relative_path.parts).resolve(strict=True)
        except FileNotFoundError as error:
            raise TerrainDatasetError(f"terrain tile {tile.tile_id} is missing") from error
        if dataset_directory not in resolved_path.parents:
            raise TerrainDatasetError("terrain tile path escapes the dataset directory")
        return resolved_path

    @staticmethod
    def _required_text(record: dict, key: str) -> str:
        value = record.get(key)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(key)
        return value.strip()

    @staticmethod
    def _positive_number(record: dict, key: str) -> float:
        value = record.get(key)
        if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or value <= 0:
            raise ValueError(key)
        return float(value)

    @staticmethod
    def _bounds(value: object) -> tuple[float, float, float, float]:
        if not isinstance(value, list) or len(value) != 4:
            raise ValueError("bounds")
        west, south, east, north = value
        has_invalid_coordinate = any(
            isinstance(coordinate, bool)
            or not isinstance(coordinate, (int, float))
            or not math.isfinite(coordinate)
            for coordinate in value
        )
        if has_invalid_coordinate:
            raise ValueError("bounds")
        if west < -180 or east > 180 or south < -90 or north > 90 or west >= east or south >= north:
            raise ValueError("bounds")
        return float(west), float(south), float(east), float(north)
