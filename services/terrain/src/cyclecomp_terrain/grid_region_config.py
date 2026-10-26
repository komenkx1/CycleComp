from __future__ import annotations

import json
import math
from pathlib import Path
from pathlib import PurePosixPath
import re
from typing import Any


DEFAULT_REGION_CHUNK_DEGREES = 0.25
MINIMUM_DISK_HEADROOM_BYTES = 20 * 1024 * 1024 * 1024


def create_grid_region_config(
    dataset_manifest_path: Path,
    release_id: str,
    signature_key_id: str,
    chunk_size_degrees: float = DEFAULT_REGION_CHUNK_DEGREES,
    excluded_tile_ids: set[str] | None = None,
    dataset_directory: Path | None = None,
) -> dict[str, Any]:
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,95}", release_id):
        raise ValueError("release ID must be a lowercase identifier of at most 96 characters")
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", signature_key_id):
        raise ValueError("signature key ID must be a lowercase identifier of at most 64 characters")
    if not math.isfinite(chunk_size_degrees) or chunk_size_degrees <= 0:
        raise ValueError("chunk size must be a finite positive number of degrees")

    dataset_manifest = json.loads(dataset_manifest_path.read_text(encoding="utf-8"))
    tile_entries = dataset_manifest.get("tiles")
    if not isinstance(tile_entries, list) or not tile_entries:
        raise ValueError("dataset manifest must contain at least one DEM tile")
    dataset_root = dataset_directory.resolve(strict=True) if dataset_directory is not None else None

    regions: list[dict[str, Any]] = []
    used_chunk_ids: set[str] = set()
    seen_tile_ids: set[str] = set()
    excluded_tile_ids = excluded_tile_ids or set()
    found_excluded_tile_ids: set[str] = set()
    for tile_entry in tile_entries:
        if not isinstance(tile_entry, dict):
            raise ValueError("dataset manifest contains an invalid DEM tile")

        tile_id = tile_entry.get("id")
        tile_bounds = tile_entry.get("bounds")
        if not isinstance(tile_id, str) or not tile_id.strip():
            raise ValueError("each DEM tile must have a non-empty ID")
        if tile_id in seen_tile_ids:
            raise ValueError(f"dataset manifest contains a duplicate DEM tile ID: {tile_id}")
        seen_tile_ids.add(tile_id)
        if tile_id in excluded_tile_ids:
            found_excluded_tile_ids.add(tile_id)
            continue
        if not isinstance(tile_bounds, list) or len(tile_bounds) != 4:
            raise ValueError(f"DEM tile {tile_id} must have four WGS84 bounds")
        if any(type(coordinate) not in (int, float) or not math.isfinite(coordinate)
               for coordinate in tile_bounds):
            raise ValueError(f"DEM tile {tile_id} bounds must be finite numbers")

        west, south, east, north = (float(coordinate) for coordinate in tile_bounds)
        if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
            raise ValueError(f"DEM tile {tile_id} bounds are invalid")

        safe_tile_id = re.sub(r"[^a-z0-9._-]+", "-", tile_id.lower()).strip("-._")
        if not safe_tile_id:
            raise ValueError(f"DEM tile {tile_id} cannot be used to create chunk IDs")
        longitude_chunk_count = _chunk_count(east - west, chunk_size_degrees)
        latitude_chunk_count = _chunk_count(north - south, chunk_size_degrees)
        tile_regions: list[dict[str, Any]] = []

        for latitude_chunk_index in range(latitude_chunk_count):
            chunk_south = south + latitude_chunk_index * chunk_size_degrees
            chunk_north = north if latitude_chunk_index == latitude_chunk_count - 1 else (
                south + (latitude_chunk_index + 1) * chunk_size_degrees
            )
            for longitude_chunk_index in range(longitude_chunk_count):
                chunk_west = west + longitude_chunk_index * chunk_size_degrees
                chunk_east = east if longitude_chunk_index == longitude_chunk_count - 1 else (
                    west + (longitude_chunk_index + 1) * chunk_size_degrees
                )
                chunk_id = f"{safe_tile_id}-r{latitude_chunk_index:02}-c{longitude_chunk_index:02}"
                if chunk_id in used_chunk_ids:
                    raise ValueError(f"DEM tile IDs create a duplicate terrain chunk ID: {chunk_id}")
                used_chunk_ids.add(chunk_id)
                tile_regions.append({
                    "chunkId": chunk_id,
                    "packId": f"{chunk_id}-grid-v1",
                    "bounds": [chunk_west, chunk_south, chunk_east, chunk_north],
                })

        if dataset_root is None:
            regions.extend(tile_regions)
            continue

        raster_path = _dataset_tile_path(dataset_root, tile_entry)
        regions.extend(_regions_with_valid_source_cells(
            raster_path,
            tile_regions,
            tile_id,
            (west, south, east, north),
        ))

    missing_excluded_tile_ids = excluded_tile_ids - found_excluded_tile_ids
    if missing_excluded_tile_ids:
        missing_tile_id = sorted(missing_excluded_tile_ids)[0]
        raise ValueError(f"excluded DEM tile was not present in the manifest: {missing_tile_id}")
    if not regions:
        raise ValueError("no DEM tiles remain after applying the excluded tile IDs")

    return {
        "releaseId": release_id,
        "signatureKeyId": signature_key_id,
        "minimumDiskHeadroomBytes": MINIMUM_DISK_HEADROOM_BYTES,
        "regions": regions,
    }


def _chunk_count(extent_degrees: float, chunk_size_degrees: float) -> int:
    chunk_count_with_tolerance = extent_degrees / chunk_size_degrees - 1e-9
    return max(1, math.ceil(chunk_count_with_tolerance))


def _dataset_tile_path(dataset_root: Path, tile_entry: dict[str, Any]) -> Path:
    relative_file = tile_entry.get("file")
    if not isinstance(relative_file, str):
        raise ValueError("dataset tile must define a relative raster file path")
    relative_path = PurePosixPath(relative_file)
    if relative_path.is_absolute() or ".." in relative_path.parts:
        raise ValueError("dataset tile raster path must stay inside the dataset directory")

    raster_path = (dataset_root / Path(*relative_path.parts)).resolve(strict=True)
    try:
        raster_path.relative_to(dataset_root)
    except ValueError as error:
        raise ValueError("dataset tile raster path resolves outside the dataset directory") from error
    if raster_path.suffix.lower() not in {".tif", ".tiff"}:
        raise ValueError("dataset tile raster path must end in .tif or .tiff")
    return raster_path


def _regions_with_valid_source_cells(
    raster_path: Path,
    tile_regions: list[dict[str, Any]],
    tile_id: str,
    expected_tile_bounds: tuple[float, float, float, float],
) -> list[dict[str, Any]]:
    import numpy as np
    import rasterio
    from rasterio.windows import Window

    try:
        with rasterio.open(raster_path) as source_raster:
            if source_raster.crs is None or source_raster.crs.to_epsg() != 4326:
                raise ValueError(f"DEM tile {tile_id} must use EPSG:4326")
            actual_tile_bounds = (
                float(source_raster.bounds.left),
                float(source_raster.bounds.bottom),
                float(source_raster.bounds.right),
                float(source_raster.bounds.top),
            )
            if any(
                abs(actual - expected) > 1e-9
                for actual, expected in zip(actual_tile_bounds, expected_tile_bounds)
            ):
                raise ValueError(f"DEM tile {tile_id} bounds do not match the dataset manifest")
            transform = source_raster.transform
            if transform.b != 0 or transform.d != 0 or transform.a <= 0 or transform.e >= 0:
                raise ValueError(f"DEM tile {tile_id} must be a north-up raster")

            first_cell_longitude, first_cell_latitude = transform @ (0.5, 0.5)
            longitude_step = transform.a
            latitude_step = abs(transform.e)
            regions_with_valid_cells: list[dict[str, Any]] = []

            for region in tile_regions:
                west, south, east, north = region["bounds"]
                first_row = max(0, math.ceil(
                    (first_cell_latitude - north) / latitude_step - 1e-9
                ))
                stop_row = min(source_raster.height, math.ceil(
                    (first_cell_latitude - south) / latitude_step - 1e-9
                ))
                first_column = max(0, math.ceil(
                    (west - first_cell_longitude) / longitude_step - 1e-9
                ))
                stop_column = min(source_raster.width, math.ceil(
                    (east - first_cell_longitude) / longitude_step - 1e-9
                ))
                requested_cell_count = max(0, stop_row - first_row) * max(
                    0,
                    stop_column - first_column,
                )
                if requested_cell_count == 0:
                    continue

                elevation_window = Window(
                    first_column,
                    first_row,
                    stop_column - first_column,
                    stop_row - first_row,
                )
                elevation_values = source_raster.read(
                    1,
                    window=elevation_window,
                    masked=True,
                )
                valid_cell_mask = (
                    ~np.ma.getmaskarray(elevation_values)
                    & np.isfinite(np.ma.getdata(elevation_values))
                )
                valid_cell_count = int(np.count_nonzero(valid_cell_mask))
                if valid_cell_count == 0:
                    continue

                regions_with_valid_cells.append({
                    **region,
                    "sourceCellCoverage": {
                        "validCellCount": valid_cell_count,
                        "requestedCellCount": requested_cell_count,
                        "coverageFraction": valid_cell_count / requested_cell_count,
                    },
                })

            return regions_with_valid_cells
    except rasterio.errors.RasterioIOError as error:
        raise ValueError(f"could not read DEM tile {tile_id}: {error}") from error
