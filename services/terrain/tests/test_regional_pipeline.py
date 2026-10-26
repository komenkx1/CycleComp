from __future__ import annotations

import json
from pathlib import Path
import shutil
import pytest

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
import numpy as np
import rasterio
from rasterio.transform import from_bounds

from cyclecomp_terrain.regional_pipeline import (
    _build_input_identity,
    check_disk_headroom,
    run_regional_pipeline,
)
import cyclecomp_terrain.regional_pipeline as regional_pipeline
from test_raster_elevation import create_dataset
from test_road_graph import OSM_SNAPSHOT_AT, OSM_SOURCE_URL, ROAD_BOUNDS, _write_road_graph_fixture


def _create_synthetic_dem(dataset_dir: Path) -> None:
    dataset_dir.mkdir(parents=True, exist_ok=True)
    tiles_dir = dataset_dir / "tiles"
    tiles_dir.mkdir(exist_ok=True)

    tif_path = tiles_dir / "test_tile.tif"
    bounds = (115.0, -9.0, 116.0, -8.0)
    data = np.ones((10, 10), dtype=np.float32) * 250.0

    transform = from_bounds(*bounds, width=10, height=10)
    with rasterio.open(
        tif_path,
        "w",
        driver="GTiff",
        height=10,
        width=10,
        count=1,
        dtype=data.dtype,
        crs="EPSG:4326",
        transform=transform,
    ) as dst:
        dst.write(data, 1)

    import hashlib
    sha256 = hashlib.sha256(tif_path.read_bytes()).hexdigest()

    manifest = {
        "schemaVersion": 1,
        "datasetVersion": "test-dem-v1",
        "source": {
            "name": "Synthetic DEM",
            "release": "2026-test",
            "verticalDatum": "EGM2008",
            "resolutionMeters": 30.0,
            "attribution": "Test attribution",
        },
        "tiles": [
            {
                "id": "test_tile",
                "file": "tiles/test_tile.tif",
                "sha256": sha256,
                "bounds": list(bounds),
            }
        ],
    }
    (dataset_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")


def _create_signing_key(key_path: Path) -> None:
    key = Ed25519PrivateKey.generate()
    pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    key_path.write_bytes(pem)
    key_path.chmod(0o600)


def test_disk_headroom_gate(tmp_path: Path) -> None:
    # Testing with tiny requirement passes
    free_bytes = check_disk_headroom(tmp_path, required_bytes=1024)
    assert free_bytes > 1024

    # Testing with absurd requirement fails with OSError
    with pytest.raises(OSError, match="Disk headroom check failed"):
        check_disk_headroom(tmp_path, required_bytes=10**18)


def test_regional_pipeline_audit_only(tmp_path: Path) -> None:
    dataset_dir = tmp_path / "dataset"
    _create_synthetic_dem(dataset_dir)

    key_path = tmp_path / "signing-key.pem"
    _create_signing_key(key_path)

    config_path = tmp_path / "config.json"
    config = {
        "releaseId": "release-test-v1",
        "signatureKeyId": "test-key-id",
        "regions": [
            {
                "chunkId": "test-region-1",
                "packId": "test-pack-1",
                "bounds": [115.1, -8.9, 115.3, -8.7],
            }
        ],
    }
    config_path.write_text(json.dumps(config), encoding="utf-8")

    report = run_regional_pipeline(
        config_path,
        dataset_dir,
        tmp_path / "dist",
        key_path,
        audit_only=True,
        override_headroom_bytes=1024,
    )

    assert report["auditOnly"] is True
    assert report["releaseId"] == "release-test-v1"
    assert report["datasetVersion"] == "test-dem-v1"
    assert report["regionCount"] == 1
    assert not (tmp_path / "dist").exists()


def test_regional_pipeline_full_build_and_reuse(tmp_path: Path) -> None:
    dataset_dir = tmp_path / "dataset"
    _create_synthetic_dem(dataset_dir)

    key_path = tmp_path / "signing-key.pem"
    _create_signing_key(key_path)

    dist_dir = tmp_path / "dist"
    config_path = tmp_path / "config.json"
    config = {
        "releaseId": "release-test-v1",
        "signatureKeyId": "test-key-id",
        "regions": [
            {
                "chunkId": "test-region-1",
                "packId": "test-pack-1",
                "bounds": [115.1, -8.9, 115.3, -8.7],
            }
        ],
    }
    config_path.write_text(json.dumps(config), encoding="utf-8")

    # Initial run: builds and publishes
    report1 = run_regional_pipeline(
        config_path,
        dataset_dir,
        dist_dir,
        key_path,
        audit_only=False,
        override_headroom_bytes=1024,
    )
    assert len(report1["stages"]) == 1
    assert report1["stages"][0]["status"] == "built_and_verified"
    assert "publication" in report1

    # Second run: reuses existing verified chunk
    report2 = run_regional_pipeline(
        config_path,
        dataset_dir,
        dist_dir,
        key_path,
        audit_only=False,
        override_headroom_bytes=1024,
    )
    assert len(report2["stages"]) == 1
    assert report2["stages"][0]["status"] == "reused"
    assert report2["publication"] == report1["publication"]


@pytest.fixture
def pipeline_workspace(tmp_path: Path) -> tuple[Path, Path, Path, Path, dict[str, object]]:
    dataset_directory = tmp_path / "dataset"
    _create_synthetic_dem(dataset_directory)
    signing_key_path = tmp_path / "signing-key.pem"
    _create_signing_key(signing_key_path)
    config_path = tmp_path / "config.json"
    configuration = {
        "releaseId": "release-1", "signatureKeyId": "test-key",
        "regions": [{
            "chunkId": "test-region", "packId": "test-pack",
            "bounds": [115.1, -8.9, 115.3, -8.7],
        }],
    }
    config_path.write_text(json.dumps(configuration))
    return config_path, dataset_directory, tmp_path / "distribution", signing_key_path, configuration


def _run_pipeline(workspace: tuple[Path, Path, Path, Path, dict[str, object]]) -> dict[str, object]:
    config_path, dataset_directory, distribution_directory, signing_key_path, configuration = workspace
    config_path.write_text(json.dumps(configuration))
    return run_regional_pipeline(
        config_path, dataset_directory, distribution_directory, signing_key_path,
        override_headroom_bytes=1024,
    )


def _release_bytes(distribution_directory: Path, release_id: str) -> dict[str, bytes]:
    release_directory = distribution_directory / "releases" / release_id
    return {
        str(path.relative_to(release_directory)): path.read_bytes()
        for path in release_directory.rglob("*") if path.is_file()
    }


def test_changed_published_bounds_require_new_release_and_keep_old_catalog_valid(pipeline_workspace) -> None:
    first_build = _run_pipeline(pipeline_workspace)
    _, _, distribution_directory, _, configuration = pipeline_workspace
    original_release = _release_bytes(distribution_directory, "release-1")
    original_pointer = (distribution_directory / "current.json").read_bytes()
    configuration["regions"][0]["bounds"] = [115.6, -8.9, 115.8, -8.7]

    with pytest.raises(FileExistsError, match="immutable; use a new release ID"):
        _run_pipeline(pipeline_workspace)

    assert _release_bytes(distribution_directory, "release-1") == original_release
    assert (distribution_directory / "current.json").read_bytes() == original_pointer
    configuration["releaseId"] = "release-2"
    second_build = _run_pipeline(pipeline_workspace)
    assert second_build["stages"][0]["status"] == "built_and_verified"
    assert _release_bytes(distribution_directory, "release-1") == original_release
    old_catalog = json.loads((Path(first_build["publication"]["catalogPath"]) / "catalog.json").read_bytes())
    assert old_catalog["chunks"][0]["manifestSha256"] == first_build["stages"][0]["manifestSha256"]


@pytest.mark.parametrize("changed_field", ["datasetVersion", "name", "release", "verticalDatum", "attribution"])
def test_dataset_identity_change_cannot_reuse_published_release(pipeline_workspace, changed_field: str) -> None:
    _run_pipeline(pipeline_workspace)
    _, dataset_directory, distribution_directory, _, _ = pipeline_workspace
    original_release = _release_bytes(distribution_directory, "release-1")
    original_pointer = (distribution_directory / "current.json").read_bytes()
    manifest_path = dataset_directory / "manifest.json"
    manifest = json.loads(manifest_path.read_bytes())
    if changed_field == "datasetVersion":
        manifest[changed_field] += "-changed"
    else:
        manifest["source"][changed_field] += "-changed"
    manifest_path.write_text(json.dumps(manifest))

    with pytest.raises(FileExistsError, match="new release ID"):
        _run_pipeline(pipeline_workspace)

    assert _release_bytes(distribution_directory, "release-1") == original_release
    assert (distribution_directory / "current.json").read_bytes() == original_pointer


def test_changed_signing_key_or_builder_cannot_reuse_published_release(pipeline_workspace, monkeypatch) -> None:
    _run_pipeline(pipeline_workspace)
    _, _, distribution_directory, signing_key_path, _ = pipeline_workspace
    original_pointer = (distribution_directory / "current.json").read_bytes()
    original_key = signing_key_path.read_bytes()
    _create_signing_key(signing_key_path)
    with pytest.raises(FileExistsError, match="new release ID"):
        _run_pipeline(pipeline_workspace)
    signing_key_path.write_bytes(original_key)
    file_sha256 = regional_pipeline._file_sha256
    monkeypatch.setattr(
        regional_pipeline, "_file_sha256",
        lambda path: "changed-builder" if path.name == "grid_pack.py" else file_sha256(path),
    )
    with pytest.raises(FileExistsError, match="new release ID"):
        _run_pipeline(pipeline_workspace)
    assert (distribution_directory / "current.json").read_bytes() == original_pointer


def test_build_identity_tracks_osm_bytes_provenance_and_profile_implementation(tmp_path: Path) -> None:
    dataset_directory = tmp_path / "dataset"
    _create_synthetic_dem(dataset_directory)
    pbf_path = tmp_path / "roads.pbf"
    pbf_path.write_bytes(b"first OSM snapshot")
    region = {
        "chunkId": "roads", "packId": "roads-pack", "bounds": [115.1, -8.9, 115.3, -8.7],
        "osmPbf": pbf_path, "osmSourceUrl": "https://example.invalid/roads.pbf",
        "osmSnapshotAt": "2026-10-17T00:00:00Z",
    }
    first_identity = _build_input_identity(dataset_directory, [region], "test-key", b"key")
    assert "road_profiles.py" in first_identity["builderSources"]
    assert "routeElevationAnalysis.ts" in first_identity["builderSources"]
    pbf_path.write_bytes(b"second OSM snapshot")
    assert _build_input_identity(dataset_directory, [region], "test-key", b"key") != first_identity
    pbf_path.write_bytes(b"first OSM snapshot")
    for provenance_field in ("osmSourceUrl", "osmSnapshotAt"):
        changed_region = {**region, provenance_field: region[provenance_field] + "-changed"}
        assert _build_input_identity(dataset_directory, [changed_region], "test-key", b"key") != first_identity


def test_graph_release_cannot_reuse_changed_osm_snapshot_or_pbf_bytes(tmp_path: Path) -> None:
    dataset_directory = tmp_path / "dataset"
    terrain_store = create_dataset(
        dataset_directory,
        [("roads", 0, np.array([[10, 20], [30, 40]], dtype=np.float32), None)],
    )
    terrain_store.close()
    signing_key_path = tmp_path / "signing-key.pem"
    _create_signing_key(signing_key_path)
    pbf_path = _write_road_graph_fixture(tmp_path / "roads.pbf")
    configuration = {
        "releaseId": "graph-release", "signatureKeyId": "test-key",
        "regions": [{
            "chunkId": "road-region", "packId": "road-pack", "bounds": list(ROAD_BOUNDS),
            "osmPbf": str(pbf_path), "osmSourceUrl": OSM_SOURCE_URL, "osmSnapshotAt": OSM_SNAPSHOT_AT,
        }],
    }
    distribution_directory = tmp_path / "distribution"
    graph_workspace = (tmp_path / "config.json", dataset_directory, distribution_directory, signing_key_path, configuration)
    _run_pipeline(graph_workspace)
    original_release = _release_bytes(distribution_directory, "graph-release")
    original_pointer = (distribution_directory / "current.json").read_bytes()
    configuration["regions"][0]["osmSnapshotAt"] = "2026-10-18T00:00:00Z"
    with pytest.raises(FileExistsError, match="new release ID"):
        _run_pipeline(graph_workspace)
    configuration["regions"][0]["osmSnapshotAt"] = OSM_SNAPSHOT_AT
    pbf_path.write_bytes(pbf_path.read_bytes() + b"changed OSM input")
    with pytest.raises(FileExistsError, match="new release ID"):
        _run_pipeline(graph_workspace)
    assert _release_bytes(distribution_directory, "graph-release") == original_release
    assert (distribution_directory / "current.json").read_bytes() == original_pointer


def test_retry_of_older_release_does_not_roll_back_current_pointer(pipeline_workspace) -> None:
    first_build = _run_pipeline(pipeline_workspace)
    _, _, distribution_directory, _, configuration = pipeline_workspace
    configuration["releaseId"] = "release-2"
    _run_pipeline(pipeline_workspace)
    newest_pointer = (distribution_directory / "current.json").read_bytes()
    configuration["releaseId"] = "release-1"
    retried_build = _run_pipeline(pipeline_workspace)
    assert retried_build["publication"] == first_build["publication"]
    assert (distribution_directory / "current.json").read_bytes() == newest_pointer


def test_failed_build_leaves_current_release_untouched_and_reuses_private_staging(pipeline_workspace, monkeypatch) -> None:
    _run_pipeline(pipeline_workspace)
    _, _, distribution_directory, _, configuration = pipeline_workspace
    original_release = _release_bytes(distribution_directory, "release-1")
    original_pointer = (distribution_directory / "current.json").read_bytes()
    configuration["releaseId"] = "release-2"
    configuration["regions"].append({
        "chunkId": "second-region", "packId": "second-pack", "bounds": [115.6, -8.9, 115.8, -8.7],
    })
    build_pack = regional_pipeline.build_elevation_grid_pack

    def fail_second_region(*arguments, **keywords):
        if arguments[2] == "second-pack":
            raise RuntimeError("second region failed")
        return build_pack(*arguments, **keywords)

    monkeypatch.setattr(regional_pipeline, "build_elevation_grid_pack", fail_second_region)
    with pytest.raises(RuntimeError, match="second region failed"):
        _run_pipeline(pipeline_workspace)

    assert not (distribution_directory / "releases/release-2").exists()
    assert (distribution_directory / ".builds/release-2/chunks/test-region/manifest.json").is_file()
    assert _release_bytes(distribution_directory, "release-1") == original_release
    assert (distribution_directory / "current.json").read_bytes() == original_pointer
    monkeypatch.setattr(regional_pipeline, "build_elevation_grid_pack", build_pack)
    retried_build = _run_pipeline(pipeline_workspace)
    assert [chunk["status"] for chunk in retried_build["stages"]] == ["reused", "built_and_verified"]


def test_failed_publication_can_retry_without_rebuilding_artifacts(pipeline_workspace, monkeypatch) -> None:
    _run_pipeline(pipeline_workspace)
    _, _, distribution_directory, _, configuration = pipeline_workspace
    original_pointer = (distribution_directory / "current.json").read_bytes()
    configuration["releaseId"] = "release-2"
    publish_catalog = regional_pipeline.publish_signed_terrain_catalog

    def fail_publication(*arguments):
        raise OSError("publisher unavailable")

    monkeypatch.setattr(regional_pipeline, "publish_signed_terrain_catalog", fail_publication)
    with pytest.raises(OSError, match="publisher unavailable"):
        _run_pipeline(pipeline_workspace)
    promoted_release = _release_bytes(distribution_directory, "release-2")
    assert (distribution_directory / "current.json").read_bytes() == original_pointer
    monkeypatch.setattr(regional_pipeline, "publish_signed_terrain_catalog", publish_catalog)
    retried_build = _run_pipeline(pipeline_workspace)
    assert retried_build["stages"][0]["status"] == "reused"
    assert _release_bytes(distribution_directory, "release-2") == promoted_release


def test_corrupt_published_pack_is_not_deleted_or_rebuilt(pipeline_workspace) -> None:
    _run_pipeline(pipeline_workspace)
    _, _, distribution_directory, _, _ = pipeline_workspace
    original_pointer = (distribution_directory / "current.json").read_bytes()
    manifest_path = distribution_directory / "releases/release-1/test-region/manifest.json"
    manifest_path.write_bytes(b"corrupted manifest")

    with pytest.raises(ValueError):
        _run_pipeline(pipeline_workspace)

    assert manifest_path.read_bytes() == b"corrupted manifest"
    assert (manifest_path.parent / "terrain.sqlite").is_file()
    assert (distribution_directory / "current.json").read_bytes() == original_pointer


def test_legacy_release_without_input_receipt_remains_read_only(pipeline_workspace) -> None:
    _run_pipeline(pipeline_workspace)
    _, _, distribution_directory, _, _ = pipeline_workspace
    original_release = _release_bytes(distribution_directory, "release-1")
    original_pointer = (distribution_directory / "current.json").read_bytes()
    (distribution_directory / ".builds/release-1/build.json").unlink()

    with pytest.raises(FileExistsError, match="unrecorded inputs"):
        _run_pipeline(pipeline_workspace)

    assert _release_bytes(distribution_directory, "release-1") == original_release
    assert (distribution_directory / "current.json").read_bytes() == original_pointer


def test_missing_published_artifact_is_not_rebuilt_under_old_catalog(pipeline_workspace) -> None:
    _run_pipeline(pipeline_workspace)
    _, _, distribution_directory, _, _ = pipeline_workspace
    original_pointer = (distribution_directory / "current.json").read_bytes()
    shutil.rmtree(distribution_directory / "releases/release-1")

    with pytest.raises(ValueError, match="restore its artifacts instead of rebuilding"):
        _run_pipeline(pipeline_workspace)

    assert not (distribution_directory / "releases/release-1").exists()
    assert (distribution_directory / "current.json").read_bytes() == original_pointer


@pytest.mark.parametrize("changed_staging_inputs", [False, True])
def test_retry_rebuilds_only_private_chunks_when_staging_is_stale_or_corrupt(
    pipeline_workspace, monkeypatch, changed_staging_inputs: bool,
) -> None:
    _, _, distribution_directory, _, configuration = pipeline_workspace
    configuration["regions"].append({
        "chunkId": "second-region", "packId": "second-pack", "bounds": [115.6, -8.9, 115.8, -8.7],
    })
    build_pack = regional_pipeline.build_elevation_grid_pack

    def fail_second_region(*arguments, **keywords):
        if arguments[2] == "second-pack":
            raise RuntimeError("second region failed")
        return build_pack(*arguments, **keywords)

    monkeypatch.setattr(regional_pipeline, "build_elevation_grid_pack", fail_second_region)
    with pytest.raises(RuntimeError, match="second region failed"):
        _run_pipeline(pipeline_workspace)
    staged_manifest = distribution_directory / ".builds/release-1/chunks/test-region/manifest.json"
    if changed_staging_inputs:
        configuration["regions"][0]["bounds"] = [115.2, -8.8, 115.4, -8.6]
    else:
        staged_manifest.write_bytes(b"corrupt staging")
    monkeypatch.setattr(regional_pipeline, "build_elevation_grid_pack", build_pack)

    retried_build = _run_pipeline(pipeline_workspace)

    assert [chunk["status"] for chunk in retried_build["stages"]] == ["built_and_verified", "built_and_verified"]
    final_manifest = distribution_directory / "releases/release-1/test-region/manifest.json"
    assert json.loads(final_manifest.read_bytes())["requestedBoundsWgs84"] == configuration["regions"][0]["bounds"]


@pytest.mark.parametrize("release_id", ["../escaped-release", "has/slash", "has\\backslash", "two..dots", "", None])
def test_invalid_release_identifier_is_rejected_without_filesystem_writes(pipeline_workspace, release_id) -> None:
    config_path, dataset_directory, distribution_directory, signing_key_path, configuration = pipeline_workspace
    configuration["releaseId"] = release_id
    config_path.write_text(json.dumps(configuration))
    with pytest.raises(ValueError, match="Invalid release ID"):
        run_regional_pipeline(
            config_path, dataset_directory, distribution_directory, signing_key_path,
            audit_only=True, override_headroom_bytes=1024,
        )
    assert not distribution_directory.exists()


@pytest.mark.parametrize("publish_newer_release", [False, True])
def test_interruption_after_pointer_promotion_recovers_receipt_without_automatic_rollback(
    pipeline_workspace, monkeypatch, publish_newer_release: bool,
) -> None:
    _, _, distribution_directory, _, configuration = pipeline_workspace
    write_build_record = regional_pipeline._write_build_record

    def interrupt_after_publication(record_path, build_record):
        if "publication" in build_record:
            raise OSError("interrupted after pointer promotion")
        write_build_record(record_path, build_record)

    monkeypatch.setattr(regional_pipeline, "_write_build_record", interrupt_after_publication)
    with pytest.raises(OSError, match="interrupted after pointer promotion"):
        _run_pipeline(pipeline_workspace)
    monkeypatch.setattr(regional_pipeline, "_write_build_record", write_build_record)
    if publish_newer_release:
        configuration["releaseId"] = "release-2"
        _run_pipeline(pipeline_workspace)
    original_pointer = (distribution_directory / "current.json").read_bytes()
    configuration["releaseId"] = "release-1"

    def unexpected_publication(*arguments):
        pytest.fail("interrupted publication must not republish or roll back the catalog")

    monkeypatch.setattr(regional_pipeline, "publish_signed_terrain_catalog", unexpected_publication)
    if publish_newer_release:
        with pytest.raises(ValueError, match="automatic rollback refused"):
            _run_pipeline(pipeline_workspace)
    else:
        recovered_build = _run_pipeline(pipeline_workspace)
        assert recovered_build["publication"]["releaseId"] == "release-1"
    assert (distribution_directory / "current.json").read_bytes() == original_pointer


@pytest.mark.parametrize("coordinate", [True, float("nan"), float("inf"), "115"])
def test_non_finite_or_non_numeric_bounds_are_rejected_before_build(pipeline_workspace, coordinate) -> None:
    config_path, dataset_directory, distribution_directory, signing_key_path, configuration = pipeline_workspace
    configuration["regions"][0]["bounds"][0] = coordinate
    config_path.write_text(json.dumps(configuration))
    with pytest.raises(ValueError, match="non-numeric values"):
        run_regional_pipeline(
            config_path, dataset_directory, distribution_directory, signing_key_path,
            override_headroom_bytes=1024,
        )
    assert not distribution_directory.exists()
