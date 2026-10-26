from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import time

from fastapi.testclient import TestClient
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
import numpy as np
import rasterio
from rasterio.transform import from_bounds

from cyclecomp_terrain.api import create_app
from cyclecomp_terrain.catalog_publish import publish_signed_terrain_catalog
from cyclecomp_terrain.grid_pack import build_elevation_grid_pack
from cyclecomp_terrain.raster_elevation import RasterElevationStore
from cyclecomp_terrain.signing import sign_elevation_grid_pack
import cyclecomp_terrain.terrain_area_build as terrain_area_build
from cyclecomp_terrain.terrain_area_build import (
    MAX_AREA_CHUNKS,
    TerrainAreaBuildManager,
    TerrainAreaLimitError,
    select_terrain_regions,
)


SIGNATURE_KEY_ID = "terrain-area-test"
AREA_BOUNDS = (115.1, -8.9, 115.2, -8.8)


def test_area_request_only_builds_matching_chunks_and_keeps_current_catalog(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(terrain_area_build, "MINIMUM_HEADROOM_BYTES", 0)
    dataset_directory = tmp_path / "dataset"
    _create_test_dem(dataset_directory)
    region_config_path = tmp_path / "region-config.json"
    region_config_path.write_text(json.dumps({
        "releaseId": "copernicus-test-v1",
        "signatureKeyId": SIGNATURE_KEY_ID,
        "regions": [
            {
                "chunkId": "test-region-1",
                "packId": "test-region-1-grid-v1",
                "bounds": list(AREA_BOUNDS),
            },
            {
                "chunkId": "outside-region-1",
                "packId": "outside-region-1-grid-v1",
                "bounds": [116.0, -8.9, 116.1, -8.8],
            },
        ],
    }), encoding="utf-8")
    signing_key_path = tmp_path / "signing-key.pem"
    trusted_signing_key = _create_signing_key(signing_key_path)
    distribution_directory = tmp_path / "distribution"
    _publish_baseline_catalog(dataset_directory, distribution_directory, signing_key_path)
    current_pointer_before_area_build = (distribution_directory / "current.json").read_bytes()
    area_jobs_directory = tmp_path / "area-jobs"

    monkeypatch.setenv("CYCLECOMP_TERRAIN_AREA_REGION_CONFIG", str(region_config_path))
    monkeypatch.setenv("CYCLECOMP_TERRAIN_AREA_JOBS_DIR", str(area_jobs_directory))
    monkeypatch.setenv("CYCLECOMP_TERRAIN_AREA_SIGNING_KEY_ID", SIGNATURE_KEY_ID)
    app = create_app(
        distribution_directory=distribution_directory,
        trusted_signing_keys={SIGNATURE_KEY_ID: trusted_signing_key},
    )

    with TestClient(app) as client:
        area_response = client.post("/v1/terrain/areas", json={
            "areas": [{"west": 115.12, "south": -8.85, "east": 115.18, "north": -8.82}],
        })
        assert area_response.status_code == 202
        queued_job = area_response.json()
        assert queued_job["totalChunks"] == 1
        assert queued_job["status"] == "queued"

        worker = TerrainAreaBuildManager(
            region_config_path=region_config_path,
            distribution_directory=distribution_directory,
            jobs_directory=area_jobs_directory,
            trusted_signing_keys={SIGNATURE_KEY_ID: trusted_signing_key},
            dataset_directory=dataset_directory,
            signing_key_path=signing_key_path,
            signature_key_id=SIGNATURE_KEY_ID,
            run_worker=True,
        )
        try:
            deadline = time.monotonic() + 20
            area_job = queued_job
            while area_job["status"] not in {"completed", "failed"} and time.monotonic() < deadline:
                time.sleep(0.1)
                area_job_response = client.get(f"/v1/terrain/areas/{queued_job['jobId']}")
                assert area_job_response.status_code == 200
                area_job = area_job_response.json()

            assert area_job["status"] == "completed", area_job
            assert area_job["totalChunks"] == 1
            assert area_job["catalog"]["chunks"][0]["chunkId"] == "test-region-1"
            assert len(base64.b64decode(area_job["catalogSignatureBase64"], validate=True)) == 64
            assert (distribution_directory / "current.json").read_bytes() == current_pointer_before_area_build

            release_id = area_job["releaseId"]
            manifest_response = client.get(
                f"/v1/terrain/releases/{release_id}/test-region-1/manifest.json",
            )
            assert manifest_response.status_code == 200
            assert manifest_response.json()["packId"] == "test-region-1-grid-v1"
        finally:
            worker.close()


def test_area_selection_deduplicates_overlapping_saved_map_bounds() -> None:
    configured_regions = [
        {"chunkId": "first", "bounds": [1, 1, 2, 2]},
        {"chunkId": "second", "bounds": [2, 1, 3, 2]},
    ]

    matching_regions = select_terrain_regions(
        configured_regions,
        [(1.5, 1.5, 2.5, 2.5), (1.75, 1.25, 2.25, 1.75)],
    )

    assert [region["chunkId"] for region in matching_regions] == ["first", "second"]


def test_worker_skips_malformed_persisted_jobs_without_crashing(tmp_path: Path) -> None:
    region_config_path = tmp_path / "region-config.json"
    region_config_path.write_text(json.dumps({
        "releaseId": "copernicus-test-v1",
        "signatureKeyId": SIGNATURE_KEY_ID,
        "regions": [{
            "chunkId": "test-region-1",
            "packId": "test-region-1-grid-v1",
            "bounds": list(AREA_BOUNDS),
        }],
    }), encoding="utf-8")
    signing_key_path = tmp_path / "signing-key.pem"
    trusted_signing_key = _create_signing_key(signing_key_path)
    jobs_directory = tmp_path / "area-jobs"
    jobs_directory.mkdir()
    malformed_job_id = "area-" + "a" * 32
    (jobs_directory / f"{malformed_job_id}.json").write_text("[]", encoding="utf-8")

    manager = TerrainAreaBuildManager(
        region_config_path=region_config_path,
        distribution_directory=tmp_path / "distribution",
        jobs_directory=jobs_directory,
        trusted_signing_keys={SIGNATURE_KEY_ID: trusted_signing_key},
        dataset_directory=tmp_path / "dataset",
        signing_key_path=signing_key_path,
        signature_key_id=SIGNATURE_KEY_ID,
        run_worker=True,
    )
    try:
        assert manager.get(malformed_job_id) is None
        assert manager._worker is not None and manager._worker.is_alive()
    finally:
        manager.close()


def test_area_job_files_are_shared_with_the_api_service_group(tmp_path: Path) -> None:
    region_config_path = tmp_path / "region-config.json"
    region_config_path.write_text(json.dumps({
        "releaseId": "copernicus-test-v1",
        "signatureKeyId": SIGNATURE_KEY_ID,
        "regions": [{
            "chunkId": "test-region-1",
            "packId": "test-region-1-grid-v1",
            "bounds": list(AREA_BOUNDS),
        }],
    }), encoding="utf-8")
    signing_key_path = tmp_path / "signing-key.pem"
    trusted_signing_key = _create_signing_key(signing_key_path)
    jobs_directory = tmp_path / "area-jobs"
    api_manager = TerrainAreaBuildManager(
        region_config_path=region_config_path,
        distribution_directory=tmp_path / "distribution",
        jobs_directory=jobs_directory,
        trusted_signing_keys={SIGNATURE_KEY_ID: trusted_signing_key},
        signature_key_id=SIGNATURE_KEY_ID,
    )
    try:
        queued_job = api_manager.submit([AREA_BOUNDS])
        job_path = jobs_directory / f"{queued_job['jobId']}.json"
        assert job_path.stat().st_mode & 0o777 == 0o660

        worker_manager = TerrainAreaBuildManager(
            region_config_path=region_config_path,
            distribution_directory=tmp_path / "distribution",
            jobs_directory=jobs_directory,
            trusted_signing_keys={SIGNATURE_KEY_ID: trusted_signing_key},
            signature_key_id=SIGNATURE_KEY_ID,
        )
        try:
            assert worker_manager.get(queued_job["jobId"]) == queued_job
        finally:
            worker_manager.close()
    finally:
        api_manager.close()


def test_area_request_chunk_limit_fails_before_queueing(tmp_path: Path) -> None:
    dataset_directory = tmp_path / "dataset"
    _create_test_dem(dataset_directory)
    region_config_path = tmp_path / "region-config.json"
    region_config_path.write_text(json.dumps({
        "releaseId": "copernicus-test-v1",
        "signatureKeyId": SIGNATURE_KEY_ID,
        "regions": [
            {
                "chunkId": f"region-{chunk_index}",
                "packId": f"region-{chunk_index}-grid-v1",
                "bounds": [chunk_index, 1, chunk_index + 0.5, 2],
            }
            for chunk_index in range(MAX_AREA_CHUNKS + 1)
        ],
    }), encoding="utf-8")
    signing_key_path = tmp_path / "signing-key.pem"
    trusted_signing_key = _create_signing_key(signing_key_path)
    manager = TerrainAreaBuildManager(
        region_config_path=region_config_path,
        distribution_directory=tmp_path / "distribution",
        jobs_directory=tmp_path / "area-jobs",
        trusted_signing_keys={SIGNATURE_KEY_ID: trusted_signing_key},
        signature_key_id=SIGNATURE_KEY_ID,
    )
    try:
        try:
            manager.submit([(0.0, 0.0, MAX_AREA_CHUNKS + 1.0, 3.0)])
        except TerrainAreaLimitError:
            pass
        else:
            raise AssertionError("oversized terrain area request should fail")
    finally:
        manager.close()


def _create_test_dem(dataset_directory: Path) -> None:
    tiles_directory = dataset_directory / "tiles"
    tiles_directory.mkdir(parents=True, exist_ok=True)
    raster_path = tiles_directory / "test_tile.tif"
    raster_bounds = (115.0, -9.0, 116.0, -8.0)
    elevation_grid = np.full((100, 100), 250.0, dtype=np.float32)
    with rasterio.open(
        raster_path,
        "w",
        driver="GTiff",
        height=100,
        width=100,
        count=1,
        dtype=elevation_grid.dtype,
        crs="EPSG:4326",
        transform=from_bounds(*raster_bounds, width=100, height=100),
    ) as raster_file:
        raster_file.write(elevation_grid, 1)

    (dataset_directory / "manifest.json").write_text(json.dumps({
        "schemaVersion": 1,
        "datasetVersion": "synthetic-dem-v1",
        "source": {
            "name": "Synthetic DEM",
            "release": "test-release",
            "verticalDatum": "EGM2008",
            "resolutionMeters": 30,
            "attribution": "Synthetic test data",
        },
        "tiles": [{
            "id": "test_tile",
            "file": "tiles/test_tile.tif",
            "sha256": hashlib.sha256(raster_path.read_bytes()).hexdigest(),
            "bounds": list(raster_bounds),
        }],
    }), encoding="utf-8")


def _create_signing_key(signing_key_path: Path) -> bytes:
    signing_key = Ed25519PrivateKey.generate()
    signing_key_path.write_bytes(signing_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ))
    signing_key_path.chmod(0o600)
    return signing_key.public_key().public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    )


def _publish_baseline_catalog(
    dataset_directory: Path,
    distribution_directory: Path,
    signing_key_path: Path,
) -> None:
    terrain_store = RasterElevationStore(dataset_directory)
    try:
        baseline_pack = build_elevation_grid_pack(
            terrain_store,
            distribution_directory / "releases" / "baseline-release" / "baseline-chunk",
            "baseline-pack",
            AREA_BOUNDS,
        )
    finally:
        terrain_store.close()
    sign_elevation_grid_pack(baseline_pack.pack_directory, signing_key_path, SIGNATURE_KEY_ID)
    publish_signed_terrain_catalog(
        distribution_directory,
        "baseline-release",
        signing_key_path,
        SIGNATURE_KEY_ID,
    )
