from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
import rasterio
from affine import Affine

from cyclecomp_terrain.raster_elevation import RasterElevationStore, TerrainDatasetError


def create_dataset(
    dataset_directory: Path,
    tile_arrays: list[tuple[str, float, np.ndarray, float | None]],
    pixel_size_degrees: float = 1.0,
) -> RasterElevationStore:
    tile_directory = dataset_directory / "tiles"
    tile_directory.mkdir(parents=True)
    tile_records = []

    for tile_id, west_longitude, elevations, nodata in tile_arrays:
        tile_path = tile_directory / f"{tile_id}.tif"
        raster_options = {
            "driver": "GTiff",
            "width": elevations.shape[1],
            "height": elevations.shape[0],
            "count": 1,
            "dtype": "float32",
            "crs": "EPSG:4326",
            "transform": Affine.translation(
                west_longitude,
                elevations.shape[0] * pixel_size_degrees,
            ) @ Affine.scale(pixel_size_degrees, -pixel_size_degrees),
        }
        if nodata is not None:
            raster_options["nodata"] = nodata
        with rasterio.open(tile_path, "w", **raster_options) as raster:
            raster.write(elevations.astype(np.float32), 1)

        with rasterio.open(tile_path) as raster:
            bounds = [raster.bounds.left, raster.bounds.bottom, raster.bounds.right, raster.bounds.top]
        tile_digest = hashlib.sha256(tile_path.read_bytes()).hexdigest()
        tile_records.append(
            {
                "id": tile_id,
                "file": f"tiles/{tile_path.name}",
                "sha256": tile_digest,
                "bounds": bounds,
            }
        )

    manifest = {
        "schemaVersion": 1,
        "datasetVersion": "test-dem-1",
        "source": {
            "name": "Synthetic test surface",
            "release": "fixture-1",
            "verticalDatum": "fixture datum",
            "resolutionMeters": 30,
            "attribution": "Test fixture",
        },
        "tiles": tile_records,
    }
    (dataset_directory / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return RasterElevationStore(dataset_directory)


def test_bilinear_interpolation_keeps_zero_and_negative_elevations(tmp_path: Path) -> None:
    store = create_dataset(
        tmp_path / "dataset",
        [("signed-plane", 0, np.array([[0, -2], [-4, -6]], dtype=np.float32), None)],
    )
    try:
        zero_sample = store.sample(0.5, 1.5)
        interpolated_sample = store.sample(1.0, 1.0)

        assert zero_sample.elevation_meters == 0
        assert interpolated_sample.elevation_meters == -3
        assert zero_sample.reason is None
    finally:
        store.close()


def test_nodata_and_out_of_coverage_remain_unknown(tmp_path: Path) -> None:
    store = create_dataset(
        tmp_path / "dataset",
        [("masked-plane", 0, np.array([[1, 2], [3, -9999]], dtype=np.float32), -9999)],
    )
    try:
        nodata_sample = store.sample(1.0, 1.0)
        uncovered_sample = store.sample(3.0, 1.0)

        assert nodata_sample.elevation_meters is None
        assert nodata_sample.reason == "nodata"
        assert uncovered_sample.elevation_meters is None
        assert uncovered_sample.reason == "out_of_coverage"
    finally:
        store.close()


def test_bilinear_interpolation_uses_neighbor_tile_at_seam(tmp_path: Path) -> None:
    store = create_dataset(
        tmp_path / "dataset",
        [
            ("west", 0, np.array([[0, 1], [2, 3]], dtype=np.float32), None),
            ("east", 2, np.array([[2, 3], [4, 5]], dtype=np.float32), None),
        ],
    )
    try:
        sample = store.sample(2.0, 1.0)

        assert sample.elevation_meters == pytest.approx(2.5)
        assert sample.reason is None
    finally:
        store.close()


def test_missing_neighbor_tile_reports_incomplete_neighborhood(tmp_path: Path) -> None:
    store = create_dataset(
        tmp_path / "dataset",
        [("west", 0, np.array([[0, 1], [2, 3]], dtype=np.float32), None)],
    )
    try:
        sample = store.sample(2.0, 1.0)

        assert sample.elevation_meters is None
        assert sample.reason == "incomplete_neighborhood"
    finally:
        store.close()


def test_manifest_rejects_paths_that_escape_the_dataset_directory(tmp_path: Path) -> None:
    dataset_directory = tmp_path / "dataset"
    dataset_directory.mkdir()
    manifest = {
        "schemaVersion": 1,
        "datasetVersion": "test-dem-1",
        "source": {
            "name": "Synthetic test surface",
            "release": "fixture-1",
            "verticalDatum": "fixture datum",
            "resolutionMeters": 30,
            "attribution": "Test fixture",
        },
        "tiles": [
            {
                "id": "escape",
                "file": "../outside.tif",
                "sha256": "0" * 64,
                "bounds": [0, 0, 1, 1],
            }
        ],
    }
    (dataset_directory / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(TerrainDatasetError, match="unsafe tile path"):
        RasterElevationStore(dataset_directory)


def test_manifest_hash_mismatch_fails_before_sampling(tmp_path: Path) -> None:
    store = create_dataset(
        tmp_path / "dataset",
        [("signed-plane", 0, np.array([[0, 1], [2, 3]], dtype=np.float32), None)],
    )
    tile_path = tmp_path / "dataset" / "tiles" / "signed-plane.tif"
    tile_path.write_bytes(tile_path.read_bytes() + b"changed")

    try:
        with pytest.raises(TerrainDatasetError, match="SHA-256"):
            store.sample(0.5, 1.5)
    finally:
        store.close()


def test_cached_raster_windows_preserve_signed_samples_and_nodata_at_window_edges(tmp_path: Path) -> None:
    elevations = np.add.outer(np.arange(70) * 10, np.arange(70)).astype(np.float32) - 700
    elevations[64, 64] = -9999
    store = create_dataset(tmp_path / "dataset", [("window-edges", 0, elevations, -9999)])
    try:
        for _ in range(2):
            assert store.sample(64, 7).elevation_meters == pytest.approx(-11.5)
            assert store.sample(66, 6).elevation_meters == pytest.approx(0.5)
            masked_sample = store.sample(64, 6)
            assert masked_sample.elevation_meters is None
            assert masked_sample.reason == "nodata"
    finally:
        store.close()


def test_raster_window_cache_is_bounded_and_reloads_evicted_samples(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("cyclecomp_terrain.raster_elevation.MAXIMUM_CACHED_RASTER_WINDOWS", 2)
    elevations = np.arange(70 * 70, dtype=np.float32).reshape(70, 70)
    store = create_dataset(tmp_path / "dataset", [("window-limit", 0, elevations, None)])
    try:
        for longitude, latitude in ((0.5, 69.5), (69.5, 69.5), (0.5, 0.5), (69.5, 0.5)):
            assert store.sample(longitude, latitude).elevation_meters is not None
            assert len(store._cached_raster_windows) <= 2
        assert store.sample(0.5, 69.5).elevation_meters == 0
    finally:
        store.close()
    assert not store._cached_raster_windows
