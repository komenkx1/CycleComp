from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import tempfile
import time
from typing import Any
from urllib.parse import quote
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import rasterio


DEFAULT_DOWNLOAD_WORKERS = 4
DEFAULT_MINIMUM_DISK_HEADROOM_BYTES = 20 * 1024 * 1024 * 1024
COPERNICUS_ATTRIBUTION = (
    "© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 "
    "provided under COPERNICUS by the European Union and ESA; all rights reserved."
)


@dataclass(frozen=True)
class CopernicusTile:
    object_key: str
    expected_size_bytes: int
    expected_etag: str

    @property
    def tile_id(self) -> str:
        return PurePosixPath(self.object_key).stem

    @property
    def filename(self) -> str:
        return f"{self.tile_id}.tif"


def stage_copernicus_dataset(
    inventory_path: Path,
    output_directory: Path,
    dataset_version: str,
    maximum_workers: int = DEFAULT_DOWNLOAD_WORKERS,
    minimum_free_bytes: int = DEFAULT_MINIMUM_DISK_HEADROOM_BYTES,
) -> dict[str, Any]:
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,95}", dataset_version):
        raise ValueError("dataset version must be a lowercase identifier of at most 96 characters")
    if not 1 <= maximum_workers <= 8:
        raise ValueError("download worker count must be between one and eight")
    if minimum_free_bytes < 0:
        raise ValueError("minimum free disk space must be non-negative")

    inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    source_url = inventory.get("source")
    raw_tiles = inventory.get("tiles")
    if not isinstance(source_url, str) or not source_url.startswith("https://"):
        raise ValueError("inventory must define an HTTPS source URL")
    if not isinstance(raw_tiles, list) or not raw_tiles:
        raise ValueError("inventory must contain at least one Copernicus tile")

    tiles = [_parse_tile_entry(raw_tile) for raw_tile in raw_tiles]
    tile_ids = [tile.tile_id for tile in tiles]
    if len(set(tile_ids)) != len(tile_ids):
        raise ValueError("inventory contains duplicate Copernicus tile IDs")
    expected_total_bytes = sum(tile.expected_size_bytes for tile in tiles)
    if inventory.get("total_bytes") != expected_total_bytes:
        raise ValueError("inventory total_bytes does not match its tile entries")

    target_directory = output_directory.expanduser().absolute()
    if target_directory.is_symlink():
        raise ValueError("staging output directory cannot be a symlink")
    target_directory.mkdir(parents=True, exist_ok=True)
    tiles_directory = target_directory / "tiles"
    tiles_directory.mkdir(exist_ok=True)
    staging_state_path = target_directory / "stage-state.json"
    staging_state = {
        "datasetVersion": dataset_version,
        "inventorySha256": _file_sha256(inventory_path),
    }
    if staging_state_path.is_file():
        existing_staging_state = json.loads(staging_state_path.read_text(encoding="utf-8"))
        if existing_staging_state != staging_state:
            raise ValueError("staging directory already belongs to a different DEM inventory")
    elif any(tiles_directory.iterdir()):
        raise ValueError("staging directory contains untracked tile files; use a new staging path")

    expected_download_bytes = 0
    for tile in tiles:
        final_path = tiles_directory / tile.filename
        partial_path = _partial_path(final_path)
        if final_path.is_file() and final_path.stat().st_size == tile.expected_size_bytes:
            continue
        if final_path.exists():
            final_path.unlink()
        partial_size = partial_path.stat().st_size if partial_path.is_file() else 0
        if partial_size > tile.expected_size_bytes:
            partial_path.unlink()
            partial_size = 0
        expected_download_bytes += tile.expected_size_bytes - partial_size

    free_bytes = shutil.disk_usage(target_directory).free
    if free_bytes < expected_download_bytes + minimum_free_bytes:
        raise OSError(
            f"staging requires {expected_download_bytes} bytes plus {minimum_free_bytes} bytes "
            f"of free-space headroom; only {free_bytes} bytes are available"
        )
    if not staging_state_path.exists():
        _write_json_atomically(staging_state_path, staging_state)

    completed_tile_count = 0
    downloaded_bytes = 0
    with ThreadPoolExecutor(max_workers=maximum_workers) as executor:
        futures = {
            executor.submit(_download_tile, source_url, tile, tiles_directory): tile
            for tile in tiles
        }
        try:
            for future in as_completed(futures):
                tile = futures[future]
                tile_size = future.result()
                completed_tile_count += 1
                downloaded_bytes += tile_size
                print(
                    f"staged {completed_tile_count}/{len(tiles)} {tile.filename} "
                    f"({tile_size} bytes)",
                    flush=True,
                )
        except Exception:
            for future in futures:
                future.cancel()
            raise

    tile_manifest_entries = [
        _make_dataset_manifest_entry(tile, tiles_directory / tile.filename)
        for tile in tiles
    ]
    dataset_manifest = {
        "schemaVersion": 1,
        "datasetVersion": dataset_version,
        "source": {
            "name": "Copernicus GLO-30 DSM",
            "release": inventory.get("distribution_release", "unknown"),
            "verticalDatum": "EGM2008",
            "resolutionMeters": 30.0,
            "attribution": COPERNICUS_ATTRIBUTION,
        },
        "coverageSelection": {
            "source": inventory.get("boundary_api"),
            "boundarySha256": inventory.get("boundary_sha256"),
            "bounds": inventory.get("bounds"),
            "missingBoundaryCells": inventory.get("missing_boundary_cells", []),
        },
        "tiles": tile_manifest_entries,
    }
    _write_json_atomically(target_directory / "manifest.json", dataset_manifest)

    return {
        "datasetVersion": dataset_version,
        "tileCount": len(tiles),
        "totalSourceBytes": expected_total_bytes,
        "downloadedBytesThisRun": downloaded_bytes,
        "manifestPath": str(target_directory / "manifest.json"),
    }


def _parse_tile_entry(raw_tile: object) -> CopernicusTile:
    if not isinstance(raw_tile, dict):
        raise ValueError("inventory contains an invalid tile entry")
    object_key = raw_tile.get("key")
    expected_size_bytes = raw_tile.get("bytes")
    expected_etag = raw_tile.get("etag")
    if (
        not isinstance(object_key, str)
        or not object_key.endswith("_DEM.tif")
        or not isinstance(expected_size_bytes, int)
        or expected_size_bytes <= 0
        or not isinstance(expected_etag, str)
        or not expected_etag
    ):
        raise ValueError("inventory tile must define a DEM object key, positive size, and ETag")
    object_path = PurePosixPath(object_key)
    if object_path.is_absolute() or ".." in object_path.parts:
        raise ValueError("inventory contains an unsafe tile object key")
    if not re.fullmatch(r"[A-Za-z0-9._-]+", object_path.stem):
        raise ValueError("inventory tile ID contains unsafe characters")
    return CopernicusTile(object_key, expected_size_bytes, expected_etag)


def _download_tile(source_url: str, tile: CopernicusTile, tiles_directory: Path) -> int:
    final_path = tiles_directory / tile.filename
    partial_path = _partial_path(final_path)
    if final_path.is_file() and final_path.stat().st_size == tile.expected_size_bytes:
        return 0

    if final_path.exists():
        final_path.unlink()
    if partial_path.exists() and partial_path.stat().st_size > tile.expected_size_bytes:
        partial_path.unlink()

    tile_url = source_url.rstrip("/") + "/" + quote(tile.object_key, safe="/")
    for attempt in range(4):
        existing_partial_bytes = partial_path.stat().st_size if partial_path.exists() else 0
        if existing_partial_bytes == tile.expected_size_bytes:
            os.replace(partial_path, final_path)
            return tile.expected_size_bytes

        headers = {"If-Match": tile.expected_etag}
        if existing_partial_bytes:
            headers["Range"] = f"bytes={existing_partial_bytes}-"
        request = Request(tile_url, headers=headers)
        try:
            with urlopen(request, timeout=120) as response:
                response_etag = response.headers.get("ETag")
                if response_etag != tile.expected_etag:
                    raise ValueError(f"Copernicus ETag changed while downloading {tile.tile_id}")
                response_status = response.status
                if existing_partial_bytes and response_status == 206:
                    _validate_content_range(
                        response.headers.get("Content-Range"),
                        existing_partial_bytes,
                        tile.expected_size_bytes,
                    )
                    write_mode = "ab"
                    bytes_expected_in_response = tile.expected_size_bytes - existing_partial_bytes
                elif response_status == 200:
                    write_mode = "wb"
                    bytes_expected_in_response = tile.expected_size_bytes
                else:
                    raise ValueError(
                        f"unexpected HTTP {response_status} for Copernicus tile {tile.tile_id}"
                    )

                response_length = response.headers.get("Content-Length")
                if response_length is not None and int(response_length) != bytes_expected_in_response:
                    raise ValueError(f"Copernicus response length changed for {tile.tile_id}")

                with partial_path.open(write_mode) as output_file:
                    shutil.copyfileobj(response, output_file, length=1024 * 1024)
                    output_file.flush()
                    os.fsync(output_file.fileno())
        except ValueError:
            raise
        except HTTPError as error:
            if error.code == 412:
                raise ValueError(
                    f"Copernicus ETag changed while downloading {tile.tile_id}"
                ) from error
            if attempt == 3:
                raise
            time.sleep(min(2 ** attempt, 8))
        except Exception:
            if attempt == 3:
                raise
            time.sleep(min(2 ** attempt, 8))
            continue

        if partial_path.stat().st_size != tile.expected_size_bytes:
            if attempt == 3:
                raise OSError(f"incomplete Copernicus tile download: {tile.tile_id}")
            time.sleep(min(2 ** attempt, 8))
            continue

        sha256 = _file_sha256(partial_path)
        if len(sha256) != 64:
            raise ValueError(f"Copernicus tile SHA-256 could not be computed: {tile.tile_id}")
        os.replace(partial_path, final_path)
        return tile.expected_size_bytes

    raise OSError(f"Copernicus tile download did not finish: {tile.tile_id}")


def _validate_content_range(header_value: str | None, expected_start: int, total_bytes: int) -> None:
    if header_value is None:
        raise ValueError("resumed Copernicus download did not include Content-Range")
    match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", header_value)
    if (
        match is None
        or int(match.group(1)) != expected_start
        or int(match.group(2)) != total_bytes - 1
        or int(match.group(3)) != total_bytes
    ):
        raise ValueError("resumed Copernicus download returned an inconsistent byte range")


def _make_dataset_manifest_entry(tile: CopernicusTile, raster_path: Path) -> dict[str, Any]:
    with rasterio.open(raster_path) as raster:
        if raster.crs is None or raster.crs.to_epsg() != 4326:
            raise ValueError(f"Copernicus tile {tile.tile_id} is not in EPSG:4326")
        raster_bounds = raster.bounds
        bounds = [
            float(raster_bounds.left),
            float(raster_bounds.bottom),
            float(raster_bounds.right),
            float(raster_bounds.top),
        ]
        if any(not math.isfinite(coordinate) for coordinate in bounds):
            raise ValueError(f"Copernicus tile {tile.tile_id} has invalid bounds")
    if raster_path.stat().st_size != tile.expected_size_bytes:
        raise ValueError(f"Copernicus tile {tile.tile_id} has an unexpected final size")
    return {
        "id": tile.tile_id,
        "file": f"tiles/{tile.filename}",
        "sha256": _file_sha256(raster_path),
        "bounds": bounds,
    }


def _partial_path(final_path: Path) -> Path:
    return final_path.with_name(f".{final_path.name}.partial")


def _file_sha256(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as source_file:
        while block := source_file.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def _write_json_atomically(output_path: Path, contents: dict[str, Any]) -> None:
    file_descriptor, temporary_path_value = tempfile.mkstemp(
        prefix=f".{output_path.name}-",
        suffix=".tmp",
        dir=output_path.parent,
    )
    temporary_path = Path(temporary_path_value)
    try:
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as output_file:
            json.dump(contents, output_file, indent=2, sort_keys=True)
            output_file.write("\n")
            output_file.flush()
            os.fsync(output_file.fileno())
        os.replace(temporary_path, output_path)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise
