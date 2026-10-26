from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from cyclecomp_terrain.grid_region_config import create_grid_region_config


def write_dataset_manifest(tmp_path: Path, tiles: list[dict[str, object]]) -> Path:
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps({"tiles": tiles}), encoding="utf-8")
    return manifest_path


def test_splits_one_degree_tile_into_sixteen_small_elevation_regions(tmp_path: Path) -> None:
    manifest_path = write_dataset_manifest(tmp_path, [{
        "id": "Copernicus_DSM_COG_10_S07_00_E107_00_DEM",
        "bounds": [107.0, -7.0, 108.0, -6.0],
    }])

    config = create_grid_region_config(manifest_path, "regional-grid-pilot", "terrain-key")

    regions = config["regions"]
    assert len(regions) == 16
    assert regions[0]["bounds"] == [107.0, -7.0, 107.25, -6.75]
    assert regions[-1]["bounds"] == [107.75, -6.25, 108.0, -6.0]
    assert len({region["chunkId"] for region in regions}) == 16


def test_keeps_short_edge_chunks_inside_source_tile_bounds(tmp_path: Path) -> None:
    manifest_path = write_dataset_manifest(tmp_path, [{
        "id": "small-edge-tile",
        "bounds": [120.0, -9.0, 120.4, -8.6],
    }])

    config = create_grid_region_config(manifest_path, "regional-grid-pilot", "terrain-key")

    assert len(config["regions"]) == 4
    assert config["regions"][-1]["bounds"] == [120.25, -8.75, 120.4, -8.6]


def test_ignores_floating_point_sliver_at_source_tile_edge(tmp_path: Path) -> None:
    manifest_path = write_dataset_manifest(tmp_path, [{
        "id": "tile-with-decimal-rounding",
        "bounds": [120.0, -9.0, 121.0, -7.999999999999999],
    }])

    config = create_grid_region_config(manifest_path, "regional-grid-pilot", "terrain-key")

    assert len(config["regions"]) == 16
    assert config["regions"][-1]["bounds"][3] == -7.999999999999999


def test_rejects_non_finite_or_non_positive_chunk_size(tmp_path: Path) -> None:
    manifest_path = write_dataset_manifest(tmp_path, [{
        "id": "tile",
        "bounds": [120.0, -9.0, 121.0, -8.0],
    }])

    for chunk_size in (0, -0.25, float("nan"), float("inf")):
        with pytest.raises(ValueError, match="chunk size"):
            create_grid_region_config(manifest_path, "regional-grid-pilot", "terrain-key", chunk_size)


def test_rejects_invalid_tile_bounds_and_duplicate_chunk_ids(tmp_path: Path) -> None:
    invalid_manifest_path = write_dataset_manifest(tmp_path, [{
        "id": "tile",
        "bounds": [120.0, -9.0, float("nan"), -8.0],
    }])
    with pytest.raises(ValueError, match="finite numbers"):
        create_grid_region_config(invalid_manifest_path, "regional-grid-pilot", "terrain-key")

    duplicate_manifest_path = write_dataset_manifest(tmp_path, [
        {"id": "duplicate tile", "bounds": [120.0, -9.0, 121.0, -8.0]},
        {"id": "duplicate-tile", "bounds": [120.0, -9.0, 121.0, -8.0]},
    ])
    with pytest.raises(ValueError, match="duplicate terrain chunk ID"):
        create_grid_region_config(duplicate_manifest_path, "regional-grid-pilot", "terrain-key")


def test_skips_a_source_tile_that_is_already_covered_by_an_existing_package(tmp_path: Path) -> None:
    manifest_path = write_dataset_manifest(tmp_path, [
        {"id": "keep-tile", "bounds": [120.0, -9.0, 121.0, -8.0]},
        {"id": "already-covered", "bounds": [121.0, -9.0, 122.0, -8.0]},
    ])

    config = create_grid_region_config(
        manifest_path,
        "regional-grid-pilot",
        "terrain-key",
        excluded_tile_ids={"already-covered"},
    )

    assert len(config["regions"]) == 16
    assert all("already-covered" not in region["chunkId"] for region in config["regions"])


def test_rejects_an_excluded_tile_id_missing_from_manifest(tmp_path: Path) -> None:
    manifest_path = write_dataset_manifest(tmp_path, [{
        "id": "tile",
        "bounds": [120.0, -9.0, 121.0, -8.0],
    }])

    with pytest.raises(ValueError, match="not present in the manifest"):
        create_grid_region_config(
            manifest_path,
            "regional-grid-pilot",
            "terrain-key",
            excluded_tile_ids={"missing-tile"},
        )


def test_omits_regions_without_any_valid_source_elevation_cells(tmp_path: Path) -> None:
    dataset_directory = tmp_path / "dataset"
    tiles_directory = dataset_directory / "tiles"
    tiles_directory.mkdir(parents=True)
    raster_path = tiles_directory / "test-tile.tif"
    raster_values = np.full((4, 4), -9999, dtype=np.float32)
    raster_values[:2, :2] = [[10, 20], [30, 40]]
    with rasterio.open(
        raster_path,
        "w",
        driver="GTiff",
        height=4,
        width=4,
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=from_origin(120, -8, 0.25, 0.25),
        nodata=-9999,
    ) as raster:
        raster.write(raster_values, 1)

    manifest_path = write_dataset_manifest(dataset_directory, [{
        "id": "test-tile",
        "file": "tiles/test-tile.tif",
        "bounds": [120.0, -9.0, 121.0, -8.0],
    }])

    config = create_grid_region_config(
        manifest_path,
        "regional-grid-pilot",
        "terrain-key",
        chunk_size_degrees=0.5,
        dataset_directory=dataset_directory,
    )

    assert len(config["regions"]) == 1
    valid_region = config["regions"][0]
    assert valid_region["chunkId"].endswith("-r01-c00")
    assert valid_region["sourceCellCoverage"] == {
        "validCellCount": 4,
        "requestedCellCount": 4,
        "coverageFraction": 1,
    }
