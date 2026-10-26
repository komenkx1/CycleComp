from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sqlite3

import numpy as np
import pytest

from cyclecomp_terrain.grid_pack import build_elevation_grid_pack
from cyclecomp_terrain.raster_elevation import TerrainDatasetError
from test_raster_elevation import create_dataset


def test_grid_pack_keeps_signed_samples_and_reports_nodata(tmp_path: Path) -> None:
    terrain_store = create_dataset(
        tmp_path / "source",
        [("signed", 0, np.array([[-5, 0], [10, -9999]], dtype=np.float32), -9999)],
    )
    output_directory = tmp_path / "packs" / "bali-grid-sample"

    try:
        pack = build_elevation_grid_pack(
            terrain_store,
            output_directory,
            "bali-grid-sample",
            (0.49, 0.49, 1.51, 1.51),
        )
    finally:
        terrain_store.close()

    assert pack.manifest["hasElevationGrid"] is True
    assert pack.manifest["hasRoadGraph"] is False
    assert pack.manifest["signatureStatus"] == "unsigned_pilot"
    assert pack.manifest["coverage"] == {
        "status": "partial",
        "requestedCellCount": 4,
        "validCellCount": 3,
        "coverageFraction": 0.75,
        "unknownReasonCounts": {
            "out_of_coverage": 0,
            "nodata": 1,
            "incomplete_neighborhood": 0,
        },
    }

    sqlite_path = output_directory / "terrain.sqlite"
    file_record = pack.manifest["files"][0]
    assert file_record["sizeBytes"] == sqlite_path.stat().st_size
    assert file_record["sha256"] == hashlib.sha256(sqlite_path.read_bytes()).hexdigest()

    with sqlite3.connect(sqlite_path) as database:
        database_result = database.execute("PRAGMA integrity_check").fetchone()
        assert database_result == ("ok",)
        block = database.execute(
            """SELECT rows, columns, elevations_f32le, validity_mask_lsb
               FROM elevation_grid_blocks"""
        ).fetchone()
        assert block is not None
        rows, columns, elevation_bytes, validity_mask = block
        elevations = np.frombuffer(elevation_bytes, dtype="<f4").reshape(rows, columns)
        cell_mask = np.unpackbits(np.frombuffer(validity_mask, dtype=np.uint8), bitorder="little")
        cell_mask = cell_mask[: rows * columns].reshape(rows, columns)

        assert elevations[1, 1] == -5
        assert elevations[1, 2] == 0
        assert elevations[2, 1] == 10
        assert cell_mask[1, 1] == 1
        assert cell_mask[1, 2] == 1
        assert cell_mask[2, 1] == 1
        assert cell_mask[2, 2] == 0


def test_grid_pack_includes_neighbor_pixels_across_a_source_tile_seam(tmp_path: Path) -> None:
    terrain_store = create_dataset(
        tmp_path / "source",
        [
            ("west", 0, np.array([[0, 1], [2, 3]], dtype=np.float32), None),
            ("east", 2, np.array([[4, 5], [6, 7]], dtype=np.float32), None),
        ],
    )
    try:
        pack = build_elevation_grid_pack(
            terrain_store,
            tmp_path / "packs" / "seam-grid",
            "seam-grid",
            (1.49, 0.49, 2.51, 1.51),
        )
    finally:
        terrain_store.close()

    with sqlite3.connect(pack.pack_directory / "terrain.sqlite") as database:
        block = database.execute(
            """SELECT rows, columns, first_cell_longitude, elevations_f32le, validity_mask_lsb
               FROM elevation_grid_blocks"""
        ).fetchone()
        assert block is not None
        rows, columns, first_longitude, elevation_bytes, validity_mask = block
        elevations = np.frombuffer(elevation_bytes, dtype="<f4").reshape(rows, columns)
        cell_mask = np.unpackbits(np.frombuffer(validity_mask, dtype=np.uint8), bitorder="little")
        cell_mask = cell_mask[: rows * columns].reshape(rows, columns)

    seam_column = round((2.5 - first_longitude) / (1 / 3600)) if columns > 4 else 2
    assert columns >= 4
    assert rows >= 2
    assert cell_mask[1:-1, seam_column - 1:seam_column + 1].all()
    assert np.isfinite(elevations[1:-1, seam_column - 1:seam_column + 1]).all()
    assert elevations[1, seam_column - 1:seam_column + 1].tolist() == [1, 4]


def test_aligned_grid_block_matches_point_sampling_across_tile_seam_and_nodata(tmp_path: Path) -> None:
    terrain_store = create_dataset(
        tmp_path / "source",
        [
            ("west", 0, np.array([[-5, 0], [10, -9999]], dtype=np.float32), -9999),
            ("east", 2, np.array([[4, 5], [6, 7]], dtype=np.float32), None),
        ],
    )
    try:
        grid_reference = terrain_store.grid_reference_at(1, 1)
        raster_grid_block = terrain_store.read_aligned_grid_block(
            grid_reference,
            0,
            2,
            0,
            5,
        )

        for row in range(2):
            latitude = grid_reference.first_cell_latitude + row * grid_reference.latitude_step
            for column in range(5):
                longitude = grid_reference.first_cell_longitude + column * grid_reference.longitude_step
                point_sample = terrain_store.sample(longitude, latitude)
                assert raster_grid_block.valid_cells[row, column] == (
                    point_sample.elevation_meters is not None
                )
                assert raster_grid_block.covered_cells[row, column] == (
                    point_sample.reason != "out_of_coverage"
                )
                if point_sample.elevation_meters is not None:
                    assert raster_grid_block.elevations_meters[row, column] == pytest.approx(
                        point_sample.elevation_meters
                    )
    finally:
        terrain_store.close()


def test_aligned_grid_block_keeps_valid_cells_next_to_nodata(tmp_path: Path) -> None:
    elevation_surface = np.array(
        [[1, 2, 3, 4], [5, -9999, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16]],
        dtype=np.float32,
    )
    terrain_store = create_dataset(
        tmp_path / "source",
        [("small-pixels", 115, elevation_surface, -9999)],
        pixel_size_degrees=1 / 3600,
    )
    try:
        grid_reference = terrain_store.grid_reference_at(115.0005, 0.0005)
        raster_grid_block = terrain_store.read_aligned_grid_block(
            grid_reference,
            0,
            4,
            0,
            4,
        )

        expected_valid_cells = elevation_surface != -9999
        assert np.array_equal(raster_grid_block.valid_cells, expected_valid_cells)
        assert np.array_equal(raster_grid_block.covered_cells, np.ones((4, 4), dtype=np.bool_))
        assert np.array_equal(
            raster_grid_block.elevations_meters[expected_valid_cells],
            elevation_surface[expected_valid_cells],
        )
    finally:
        terrain_store.close()


def test_empty_or_uncovered_pack_does_not_leave_a_partial_directory(tmp_path: Path) -> None:
    terrain_store = create_dataset(
        tmp_path / "source",
        [("masked", 0, np.full((2, 2), -9999, dtype=np.float32), -9999)],
    )
    output_directory = tmp_path / "packs" / "empty-grid"
    try:
        with pytest.raises(TerrainDatasetError, match="no valid elevation samples"):
            build_elevation_grid_pack(
                terrain_store,
                output_directory,
                "empty-grid",
                (0.49, 0.49, 1.51, 1.51),
            )
    finally:
        terrain_store.close()

    assert not output_directory.exists()
    assert list((tmp_path / "packs").iterdir()) == []


def test_grid_pack_splits_large_areas_into_bounded_core_blocks(tmp_path: Path) -> None:
    elevation_surface = np.arange(63 * 63, dtype=np.float32).reshape(63, 63)
    terrain_store = create_dataset(
        tmp_path / "source",
        [("large-surface", 0, elevation_surface, None)],
    )
    try:
        pack = build_elevation_grid_pack(
            terrain_store,
            tmp_path / "packs" / "large-grid",
            "large-grid",
            (0, 0, 63, 63),
        )
    finally:
        terrain_store.close()

    with sqlite3.connect(pack.pack_directory / "terrain.sqlite") as database:
        core_blocks = database.execute(
            "SELECT core_rows, core_columns, rows, columns FROM elevation_grid_blocks"
        ).fetchall()
        metadata = dict(database.execute("SELECT key, value FROM pack_metadata"))

    assert len(core_blocks) == 4
    assert sum(core_rows * core_columns for core_rows, core_columns, _, _ in core_blocks) == 63 * 63
    assert all(core_rows <= 62 and core_columns <= 62 for core_rows, core_columns, _, _ in core_blocks)
    assert all(block_rows <= 64 and block_columns <= 64 for _, _, block_rows, block_columns in core_blocks)
    assert json.loads(metadata["validCoreCellCount"]) == 63 * 63
