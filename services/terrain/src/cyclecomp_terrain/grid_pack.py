from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import logging
import math
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile

import numpy as np

from cyclecomp_terrain.raster_elevation import (
    RasterGridBlock,
    RasterElevationStore,
    RasterGridReference,
    RasterTile,
    TerrainDatasetError,
    TerrainSource,
)
from cyclecomp_terrain.road_graph import RoadGraphBuildResult, add_osm_road_graph
from cyclecomp_terrain.road_profiles import (
    RoadProfileBuildResult,
    build_road_elevation_profiles,
)


GRID_PACK_SCHEMA_VERSION = 1
GRID_BLOCK_ROWS = 64
GRID_BLOCK_COLUMNS = 64
GRID_BLOCK_HALO_CELLS = 1
GRID_BLOCK_CORE_ROWS = GRID_BLOCK_ROWS - GRID_BLOCK_HALO_CELLS * 2
GRID_BLOCK_CORE_COLUMNS = GRID_BLOCK_COLUMNS - GRID_BLOCK_HALO_CELLS * 2
MAX_GRID_PACK_CELLS = 20_000_000
MAX_GRID_BLOCKS = 100_000
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class GridPackBuildResult:
    pack_directory: Path
    manifest: dict[str, object]


def build_elevation_grid_pack(
    terrain_store: RasterElevationStore,
    output_directory: Path,
    pack_id: str,
    bounds: tuple[float, float, float, float],
    osm_pbf_path: Path | None = None,
    osm_source_url: str | None = None,
    osm_snapshot_at: str | None = None,
    road_graph_buffer_meters: float = 1_000,
) -> GridPackBuildResult:
    _validate_pack_id(pack_id)
    graph_inputs = (osm_pbf_path, osm_source_url, osm_snapshot_at)
    if any(value is not None for value in graph_inputs) and not all(
        value is not None for value in graph_inputs
    ):
        raise ValueError("OSM graph packs require a PBF path, source URL, and snapshot timestamp")

    west, south, east, north = _validate_bounds(bounds)
    requested_tiles = _tiles_for_bounds(terrain_store, west, south, east, north)
    grid_reference = _validate_tile_alignment(terrain_store, requested_tiles, west, south, east, north)
    first_row, stop_row, first_column, stop_column = _grid_range(
        grid_reference,
        west,
        south,
        east,
        north,
    )
    requested_cell_count = (stop_row - first_row) * (stop_column - first_column)
    if requested_cell_count > MAX_GRID_PACK_CELLS:
        raise ValueError("requested terrain area exceeds the grid-pack cell limit")

    expected_block_count = _expected_block_count(
        first_row,
        stop_row,
        first_column,
        stop_column,
    )
    if expected_block_count > MAX_GRID_BLOCKS:
        raise ValueError("requested terrain area exceeds the grid-pack block limit")

    target_directory = output_directory.resolve()
    if target_directory.exists() or target_directory.is_symlink():
        raise FileExistsError(f"terrain pack already exists: {target_directory}")
    target_directory.parent.mkdir(parents=True, exist_ok=True)
    staging_directory = Path(
        tempfile.mkdtemp(prefix=f".{target_directory.name}.staging-", dir=target_directory.parent)
    )

    try:
        database_path = staging_directory / "terrain.sqlite"
        logger.info("Building elevation grid: %d cells in %d blocks", requested_cell_count, expected_block_count)
        pack_summary = _write_grid_database(
            terrain_store,
            database_path,
            pack_id,
            grid_reference,
            (first_row, stop_row, first_column, stop_column),
            requested_cell_count,
        )
        if pack_summary["validCoreCellCount"] == 0:
            raise TerrainDatasetError("requested area has no valid elevation samples")
        logger.info("Elevation grid ready: %d valid cells", pack_summary["validCoreCellCount"])

        road_graph: RoadGraphBuildResult | None = None
        road_profiles: RoadProfileBuildResult | None = None
        if osm_pbf_path is not None and osm_source_url is not None and osm_snapshot_at is not None:
            road_graph = add_osm_road_graph(
                database_path,
                osm_pbf_path,
                (west, south, east, north),
                osm_source_url,
                osm_snapshot_at,
                road_graph_buffer_meters,
            )
            road_profiles = build_road_elevation_profiles(database_path, terrain_store)

        road_graph_record = (
            road_graph.as_manifest_record(
                source_url=osm_source_url,
                snapshot_at=osm_snapshot_at,
                buffer_meters=road_graph_buffer_meters,
            )
            if road_graph is not None
            and osm_source_url is not None
            and osm_snapshot_at is not None
            else None
        )
        if road_graph_record is not None and road_profiles is not None:
            road_graph_record.update(road_profiles.road_graph_metadata())

        manifest = _build_manifest(
            terrain_store.source,
            database_path,
            pack_id,
            (west, south, east, north),
            pack_summary,
            road_graph_record,
            road_profiles.as_manifest_record(terrain_store.source)
            if road_profiles is not None
            else None,
        )
        (staging_directory / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
            encoding="utf-8",
        )
        staging_directory.rename(target_directory)
        return GridPackBuildResult(target_directory, manifest)
    except Exception:
        shutil.rmtree(staging_directory, ignore_errors=True)
        raise


def _write_grid_database(
    terrain_store: RasterElevationStore,
    database_path: Path,
    pack_id: str,
    grid_reference: RasterGridReference,
    grid_range: tuple[int, int, int, int],
    requested_cell_count: int,
) -> dict[str, object]:
    first_row, stop_row, first_column, stop_column = grid_range
    connection = sqlite3.connect(database_path)
    connection.execute("PRAGMA page_size = 4096")
    connection.execute("PRAGMA journal_mode = DELETE")
    connection.execute("PRAGMA synchronous = FULL")
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA application_id = 1129927500")
    connection.execute(f"PRAGMA user_version = {GRID_PACK_SCHEMA_VERSION}")
    connection.executescript(
        """
        CREATE TABLE pack_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        ) WITHOUT ROWID;

        CREATE TABLE elevation_grid_metadata (
            grid_id TEXT PRIMARY KEY,
            source_name TEXT NOT NULL,
            source_release TEXT NOT NULL,
            vertical_datum TEXT NOT NULL,
            source_resolution_meters REAL NOT NULL,
            first_cell_longitude REAL NOT NULL,
            first_cell_latitude REAL NOT NULL,
            longitude_step REAL NOT NULL,
            latitude_step REAL NOT NULL
        ) WITHOUT ROWID;

        CREATE TABLE elevation_grid_blocks (
            block_id INTEGER PRIMARY KEY,
            grid_id TEXT NOT NULL REFERENCES elevation_grid_metadata(grid_id),
            core_start_row INTEGER NOT NULL,
            core_start_column INTEGER NOT NULL,
            core_rows INTEGER NOT NULL CHECK(core_rows BETWEEN 1 AND 62),
            core_columns INTEGER NOT NULL CHECK(core_columns BETWEEN 1 AND 62),
            first_cell_longitude REAL NOT NULL,
            first_cell_latitude REAL NOT NULL,
            rows INTEGER NOT NULL CHECK(rows BETWEEN 1 AND 64),
            columns INTEGER NOT NULL CHECK(columns BETWEEN 1 AND 64),
            elevations_f32le BLOB NOT NULL,
            validity_mask_lsb BLOB NOT NULL,
            valid_cell_count INTEGER NOT NULL CHECK(valid_cell_count BETWEEN 1 AND 4096),
            CHECK(length(elevations_f32le) = rows * columns * 4),
            CHECK(length(validity_mask_lsb) = ((rows * columns + 7) / 8))
        );

        CREATE VIRTUAL TABLE elevation_grid_block_index USING rtree(
            block_id,
            minimum_longitude,
            maximum_longitude,
            minimum_latitude,
            maximum_latitude
        );
        """
    )

    valid_core_cell_count = 0
    unknown_core_cell_count = 0
    reason_counts = {"out_of_coverage": 0, "nodata": 0, "incomplete_neighborhood": 0}
    block_id = 0

    try:
        with connection:
            connection.execute(
                """INSERT INTO elevation_grid_metadata VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    pack_id,
                    terrain_store.source.name,
                    terrain_store.source.source_release,
                    terrain_store.source.vertical_datum,
                    terrain_store.source.source_resolution_meters,
                    grid_reference.first_cell_longitude,
                    grid_reference.first_cell_latitude,
                    grid_reference.longitude_step,
                    grid_reference.latitude_step,
                ),
            )

            for core_row_start in range(first_row, stop_row, GRID_BLOCK_CORE_ROWS):
                core_row_stop = min(core_row_start + GRID_BLOCK_CORE_ROWS, stop_row)
                for core_column_start in range(
                    first_column,
                    stop_column,
                    GRID_BLOCK_CORE_COLUMNS,
                ):
                    core_column_stop = min(
                        core_column_start + GRID_BLOCK_CORE_COLUMNS,
                        stop_column,
                    )
                    block_row_start, block_row_stop = _block_data_range(
                        core_row_start,
                        core_row_stop,
                        grid_reference.first_cell_latitude,
                        grid_reference.latitude_step,
                        -90,
                        90,
                    )
                    block_column_start, block_column_stop = _block_data_range(
                        core_column_start,
                        core_column_stop,
                        grid_reference.first_cell_longitude,
                        grid_reference.longitude_step,
                        -180,
                        180,
                    )
                    block_rows = block_row_stop - block_row_start
                    block_columns = block_column_stop - block_column_start
                    raster_grid_block = terrain_store.read_aligned_grid_block(
                        grid_reference,
                        block_row_start,
                        block_row_stop,
                        block_column_start,
                        block_column_stop,
                    )
                    elevation_bytes, validity_mask, valid_block_cell_count = _encode_grid_block(
                        raster_grid_block
                    )
                    core_valid_cell_count, core_unknown_reasons = _count_core_grid_cells(
                        raster_grid_block,
                        block_rows,
                        block_columns,
                        block_row_start,
                        block_row_stop,
                        block_column_start,
                        block_column_stop,
                        core_row_start,
                        core_row_stop,
                        core_column_start,
                        core_column_stop,
                    )
                    if core_valid_cell_count == 0 and valid_block_cell_count == 0:
                        unknown_core_cell_count += (core_row_stop - core_row_start) * (
                            core_column_stop - core_column_start
                        )
                        for reason, count in core_unknown_reasons.items():
                            reason_counts[reason] += count
                        continue

                    first_cell_longitude = grid_reference.first_cell_longitude + (
                        block_column_start * grid_reference.longitude_step
                    )
                    first_cell_latitude = grid_reference.first_cell_latitude + (
                        block_row_start * grid_reference.latitude_step
                    )
                    block_id += 1
                    connection.execute(
                        """INSERT INTO elevation_grid_blocks VALUES (
                               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                           )""",
                        (
                            block_id,
                            pack_id,
                            core_row_start,
                            core_column_start,
                            core_row_stop - core_row_start,
                            core_column_stop - core_column_start,
                            first_cell_longitude,
                            first_cell_latitude,
                            block_rows,
                            block_columns,
                            elevation_bytes,
                            validity_mask,
                            valid_block_cell_count,
                        ),
                    )
                    connection.execute(
                        """INSERT INTO elevation_grid_block_index VALUES (?, ?, ?, ?, ?)""",
                        (
                            block_id,
                            first_cell_longitude - abs(grid_reference.longitude_step) / 2,
                            first_cell_longitude + (block_columns - 0.5) * grid_reference.longitude_step,
                            first_cell_latitude + (block_rows - 0.5) * grid_reference.latitude_step,
                            first_cell_latitude + abs(grid_reference.latitude_step) / 2,
                        ),
                    )
                    valid_core_cell_count += core_valid_cell_count
                    unknown_core_cell_count += (core_row_stop - core_row_start) * (
                        core_column_stop - core_column_start
                    ) - core_valid_cell_count
                    for reason, count in core_unknown_reasons.items():
                        reason_counts[reason] += count

        integrity_result = connection.execute("PRAGMA integrity_check").fetchone()
        if integrity_result is None or integrity_result[0] != "ok":
            raise TerrainDatasetError("terrain pack SQLite integrity check failed")
        metadata = {
            "packId": pack_id,
            "schemaVersion": GRID_PACK_SCHEMA_VERSION,
            "requestedCellCount": requested_cell_count,
            "validCoreCellCount": valid_core_cell_count,
            "unknownCoreCellCount": unknown_core_cell_count,
            "coverageFraction": valid_core_cell_count / requested_cell_count,
            "reasonCounts": reason_counts,
            "blockCount": block_id,
            "hasRoadGraph": False,
            "hasRoadProfiles": False,
            "graphVersion": None,
            "profileAlgorithmVersion": None,
            "roadProfileSummary": None,
        }
        connection.executemany(
            "INSERT INTO pack_metadata(key, value) VALUES (?, ?)",
            [(key, json.dumps(value, sort_keys=True)) for key, value in metadata.items()],
        )
        connection.commit()
        integrity_result = connection.execute("PRAGMA integrity_check").fetchone()
        if integrity_result is None or integrity_result[0] != "ok":
            raise TerrainDatasetError("terrain pack SQLite integrity check failed after commit")
        return metadata
    finally:
        connection.close()


def _build_manifest(
    source: TerrainSource,
    database_path: Path,
    pack_id: str,
    requested_bounds: tuple[float, float, float, float],
    pack_summary: dict[str, object],
    road_graph_record: dict[str, object] | None,
    road_profiles_record: dict[str, object] | None,
) -> dict[str, object]:
    file_size = database_path.stat().st_size
    return {
        "packId": pack_id,
        "schemaVersion": GRID_PACK_SCHEMA_VERSION,
        "minimumReaderVersion": 2 if road_graph_record is not None else 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "datasetVersion": source.dataset_version,
        "source": {
            "name": source.name,
            "release": source.source_release,
            "resolutionMeters": source.source_resolution_meters,
            "coordinateReferenceSystem": "EPSG:4326",
            "cellCoordinate": "center",
            "verticalDatum": source.vertical_datum,
            "attribution": source.attribution,
        },
        "requestedBoundsWgs84": list(requested_bounds),
        "hasElevationGrid": True,
        "hasRoadGraph": road_graph_record is not None,
        "hasRoadProfiles": (
            road_profiles_record is not None
            and road_profiles_record["profiledEdgeCount"] > 0
        ),
        "graphVersion": "osm-directed-v1" if road_graph_record is not None else None,
        "profileAlgorithmVersion": (
            road_profiles_record["profileAlgorithmVersion"]
            if road_profiles_record is not None
            else None
        ),
        "roadGraph": road_graph_record,
        "roadProfiles": road_profiles_record,
        "coverage": {
            "status": "complete" if pack_summary["coverageFraction"] == 1 else "partial",
            "requestedCellCount": pack_summary["requestedCellCount"],
            "validCellCount": pack_summary["validCoreCellCount"],
            "coverageFraction": pack_summary["coverageFraction"],
            "unknownReasonCounts": pack_summary["reasonCounts"],
        },
        "files": [
            {
                "path": database_path.name,
                "sizeBytes": file_size,
                "sha256": _file_sha256(database_path),
            }
        ],
        "signatureKeyId": None,
        "signatureStatus": "unsigned_pilot",
    }


def _tiles_for_bounds(
    terrain_store: RasterElevationStore,
    west: float,
    south: float,
    east: float,
    north: float,
) -> tuple[RasterTile, ...]:
    intersecting_tiles = tuple(
        tile
        for tile in terrain_store.tiles
        if tile.bounds[0] <= east
        and tile.bounds[2] >= west
        and tile.bounds[1] <= north
        and tile.bounds[3] >= south
    )
    if not intersecting_tiles:
        raise TerrainDatasetError("requested bounds do not intersect an installed terrain tile")
    return intersecting_tiles


def _validate_tile_alignment(
    terrain_store: RasterElevationStore,
    requested_tiles: tuple[RasterTile, ...],
    west: float,
    south: float,
    east: float,
    north: float,
) -> RasterGridReference:
    first_tile = requested_tiles[0]
    first_tile_center = (
        (first_tile.bounds[0] + first_tile.bounds[2]) / 2,
        (first_tile.bounds[1] + first_tile.bounds[3]) / 2,
    )
    grid_reference = terrain_store.grid_reference_at(*first_tile_center)
    longitude_step = grid_reference.longitude_step
    latitude_step = abs(grid_reference.latitude_step)
    expanded_bounds = (
        west - longitude_step,
        south - latitude_step,
        east + longitude_step,
        north + latitude_step,
    )

    for tile in terrain_store.tiles:
        tile_west, tile_south, tile_east, tile_north = tile.bounds
        if (
            tile_east < expanded_bounds[0]
            or tile_west > expanded_bounds[2]
            or tile_north < expanded_bounds[1]
            or tile_south > expanded_bounds[3]
        ):
            continue

        tile_center = (
            (tile_west + tile_east) / 2,
            (tile_south + tile_north) / 2,
        )
        candidate_reference = terrain_store.grid_reference_at(*tile_center)
        if (
            abs(candidate_reference.longitude_step - grid_reference.longitude_step) > 1e-12
            or abs(candidate_reference.latitude_step - grid_reference.latitude_step) > 1e-12
        ):
            raise TerrainDatasetError("terrain tiles in the requested area use different grid resolutions")

        column_offset = (
            candidate_reference.first_cell_longitude - grid_reference.first_cell_longitude
        ) / longitude_step
        row_offset = (
            candidate_reference.first_cell_latitude - grid_reference.first_cell_latitude
        ) / grid_reference.latitude_step
        if abs(column_offset - round(column_offset)) > 1e-6 or abs(row_offset - round(row_offset)) > 1e-6:
            raise TerrainDatasetError("terrain tiles in the requested area do not share grid alignment")

    return grid_reference


def _grid_range(
    grid_reference: RasterGridReference,
    west: float,
    south: float,
    east: float,
    north: float,
) -> tuple[int, int, int, int]:
    longitude_step = grid_reference.longitude_step
    latitude_step = abs(grid_reference.latitude_step)
    first_row = math.ceil((grid_reference.first_cell_latitude - north) / latitude_step - 1e-9)
    stop_row = math.ceil((grid_reference.first_cell_latitude - south) / latitude_step - 1e-9)
    first_column = math.ceil((west - grid_reference.first_cell_longitude) / longitude_step - 1e-9)
    stop_column = math.ceil((east - grid_reference.first_cell_longitude) / longitude_step - 1e-9)
    if first_row >= stop_row or first_column >= stop_column:
        raise ValueError("requested bounds contain no source grid cell centers")
    return first_row, stop_row, first_column, stop_column


def _expected_block_count(
    first_row: int,
    stop_row: int,
    first_column: int,
    stop_column: int,
) -> int:
    row_block_count = math.ceil((stop_row - first_row) / GRID_BLOCK_CORE_ROWS)
    column_block_count = math.ceil((stop_column - first_column) / GRID_BLOCK_CORE_COLUMNS)
    return row_block_count * column_block_count


def _block_data_range(
    core_start: int,
    core_stop: int,
    first_cell_coordinate: float,
    coordinate_step: float,
    minimum_coordinate: float,
    maximum_coordinate: float,
) -> tuple[int, int]:
    halo_start = core_start - GRID_BLOCK_HALO_CELLS
    halo_stop = core_stop + GRID_BLOCK_HALO_CELLS
    if not minimum_coordinate <= first_cell_coordinate + halo_start * coordinate_step <= maximum_coordinate:
        halo_start = core_start
    if not minimum_coordinate <= first_cell_coordinate + (halo_stop - 1) * coordinate_step <= maximum_coordinate:
        halo_stop = core_stop
    return halo_start, halo_stop


def _encode_grid_block(
    raster_grid_block: RasterGridBlock,
) -> tuple[bytes, bytes, int]:
    elevation_bytes = raster_grid_block.elevations_meters.astype("<f4", copy=False).tobytes(order="C")
    validity_mask = np.packbits(
        raster_grid_block.valid_cells.reshape(-1),
        bitorder="little",
    ).tobytes()
    valid_cell_count = int(np.count_nonzero(raster_grid_block.valid_cells))
    return elevation_bytes, validity_mask, valid_cell_count


def _count_core_grid_cells(
    raster_grid_block: RasterGridBlock,
    block_rows: int,
    block_columns: int,
    block_row_start: int,
    block_row_stop: int,
    block_column_start: int,
    block_column_stop: int,
    core_row_start: int,
    core_row_stop: int,
    core_column_start: int,
    core_column_stop: int,
) -> tuple[int, dict[str, int]]:
    if (
        raster_grid_block.valid_cells.shape != (block_rows, block_columns)
        or raster_grid_block.covered_cells.shape != (block_rows, block_columns)
        or block_row_start > core_row_start
        or block_row_stop < core_row_stop
        or block_column_start > core_column_start
        or block_column_stop < core_column_stop
    ):
        raise TerrainDatasetError("grid-pack block dimensions do not contain their core cells")

    core_rows = slice(core_row_start - block_row_start, core_row_stop - block_row_start)
    core_columns = slice(core_column_start - block_column_start, core_column_stop - block_column_start)
    core_valid_cells = raster_grid_block.valid_cells[core_rows, core_columns]
    core_covered_cells = raster_grid_block.covered_cells[core_rows, core_columns]
    core_valid_cell_count = int(np.count_nonzero(core_valid_cells))
    unknown_reason_counts = {
        "out_of_coverage": int(np.count_nonzero(~core_covered_cells)),
        "nodata": int(np.count_nonzero(core_covered_cells & ~core_valid_cells)),
        "incomplete_neighborhood": 0,
    }
    return core_valid_cell_count, unknown_reason_counts


def _validate_pack_id(pack_id: str) -> None:
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,95}", pack_id):
        raise ValueError("pack_id must be a lowercase identifier of at most 96 characters")


def _validate_bounds(bounds: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    if len(bounds) != 4 or any(not math.isfinite(coordinate) for coordinate in bounds):
        raise ValueError("bounds must contain four finite WGS84 coordinates")
    west, south, east, north = bounds
    if west < -180 or east > 180 or south < -90 or north > 90 or west >= east or south >= north:
        raise ValueError("bounds are outside WGS84 or have no area")
    return west, south, east, north


def _file_sha256(file_path: Path) -> str:
    file_hash = hashlib.sha256()
    with file_path.open("rb") as pack_file:
        for chunk in iter(lambda: pack_file.read(1024 * 1024), b""):
            file_hash.update(chunk)
    return file_hash.hexdigest()
