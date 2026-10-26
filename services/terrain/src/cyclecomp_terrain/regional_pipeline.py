from __future__ import annotations

import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import re
import shutil
import tempfile

from cryptography.hazmat.primitives import serialization

from cyclecomp_terrain.catalog_publish import (
    _require_real_directory,
    _sync_directory,
    publish_signed_terrain_catalog,
)
from cyclecomp_terrain.distribution import TerrainPackDistribution
from cyclecomp_terrain.grid_pack import build_elevation_grid_pack
from cyclecomp_terrain.raster_elevation import RasterElevationStore
from cyclecomp_terrain.signing import (
    _load_signing_key,
    sign_elevation_grid_pack,
    validate_signature_key_id,
    verify_signed_terrain_pack,
)

MINIMUM_HEADROOM_BYTES = 20 * 1024 * 1024 * 1024  # 20 GiB per Section 12 gate


_IDENTIFIER_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,95}$")


def _validate_identifier(identifier: object, label: str) -> str:
    if (
        not isinstance(identifier, str)
        or not _IDENTIFIER_PATTERN.fullmatch(identifier)
        or ".." in identifier
        or "/" in identifier
        or "\\" in identifier
    ):
        raise ValueError(f"Invalid {label}: {identifier!r}")
    return identifier


def check_disk_headroom(path: Path, required_bytes: int = MINIMUM_HEADROOM_BYTES) -> int:
    path.mkdir(parents=True, exist_ok=True)
    usage = shutil.disk_usage(path)
    if usage.free < required_bytes:
        raise OSError(
            f"Disk headroom check failed on {path}: {usage.free / (1024**3):.2f} GiB available, "
            f"minimum {required_bytes / (1024**3):.2f} GiB required."
        )
    return usage.free


def run_regional_pipeline(
    config_path: Path,
    dataset_dir: Path,
    distribution_dir: Path,
    signing_key_path: Path,
    audit_only: bool = False,
    override_headroom_bytes: int | None = None,
) -> dict[str, object]:
    logging.info("Loading regional pipeline configuration from %s", config_path)
    config = json.loads(config_path.read_text(encoding="utf-8"))

    release_id = _validate_identifier(config.get("releaseId"), "release ID")

    signature_key_id = config.get("signatureKeyId")
    if not isinstance(signature_key_id, str):
        raise ValueError("config must define a valid 'signatureKeyId'")
    validate_signature_key_id(signature_key_id)

    raw_regions = config.get("regions")
    if not isinstance(raw_regions, list) or not raw_regions:
        raise ValueError("config must define a non-empty 'regions' list")

    seen_chunk_ids: set[str] = set()
    regions: list[dict[str, object]] = []
    for region_idx, region in enumerate(raw_regions):
        if not isinstance(region, dict):
            raise ValueError(f"Region at index {region_idx} must be a dictionary")
        chunk_id = _validate_identifier(region.get("chunkId"), f"chunk ID in region {region_idx}")
        pack_id = _validate_identifier(region.get("packId"), f"pack ID in region {region_idx}")
        if chunk_id in seen_chunk_ids:
            raise ValueError(f"Duplicate chunk ID in configuration: {chunk_id}")
        seen_chunk_ids.add(chunk_id)

        raw_bounds = region.get("bounds")
        if not isinstance(raw_bounds, (list, tuple)) or len(raw_bounds) != 4:
            raise ValueError(f"Region {chunk_id} bounds must be 4 numbers")
        west, south, east, north = raw_bounds
        if not all(type(coordinate) in (int, float) and math.isfinite(coordinate) for coordinate in raw_bounds):
            raise ValueError(f"Region {chunk_id} bounds contains non-numeric values")
        if not (-180.0 <= west < east <= 180.0 and -90.0 <= south < north <= 90.0):
            raise ValueError(f"Region {chunk_id} bounds are invalid: {raw_bounds}")

        osm_pbf = None
        graph_inputs = (region.get("osmPbf"), region.get("osmSourceUrl"), region.get("osmSnapshotAt"))
        if any(value is not None for value in graph_inputs):
            if not all(isinstance(value, str) and value.strip() for value in graph_inputs):
                raise ValueError(f"Region {chunk_id} requires a PBF path, source URL, and snapshot timestamp")
            osm_pbf = Path(region["osmPbf"]).expanduser().absolute()
            if not osm_pbf.is_file():
                raise ValueError(f"Region {chunk_id} osmPbf file not found: {osm_pbf}")

        regions.append({
            "chunkId": chunk_id,
            "packId": pack_id,
            "bounds": (float(west), float(south), float(east), float(north)),
            "osmPbf": osm_pbf,
            "osmSourceUrl": region.get("osmSourceUrl"),
            "osmSnapshotAt": region.get("osmSnapshotAt"),
        })

    required_headroom = (
        override_headroom_bytes
        if override_headroom_bytes is not None
        else config.get("minimumDiskHeadroomBytes", MINIMUM_HEADROOM_BYTES)
    )
    if type(required_headroom) is not int or required_headroom < 0:
        raise ValueError("minimum disk headroom must be a non-negative integer")

    signing_key = _load_signing_key(signing_key_path)
    raw_public_key = signing_key.public_key().public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    )
    trusted_signing_keys = {signature_key_id: raw_public_key}

    logging.info("Validating raster elevation store at %s", dataset_dir)
    test_store = RasterElevationStore(dataset_dir)
    dataset_version = test_store.source.dataset_version
    vertical_datum = test_store.source.vertical_datum
    test_store.close()

    distribution_path = distribution_dir.expanduser().absolute()
    check_target = distribution_path
    while not check_target.exists() and check_target.parent != check_target:
        check_target = check_target.parent
    available_bytes = check_disk_headroom(check_target, required_headroom)
    logging.info("Disk headroom confirmed: %.2f GiB available", available_bytes / (1024**3))

    report: dict[str, object] = {
        "releaseId": release_id,
        "signatureKeyId": signature_key_id,
        "datasetVersion": dataset_version,
        "verticalDatum": vertical_datum,
        "regionCount": len(regions),
        "availableDiskBytes": available_bytes,
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "stages": [],
        "auditOnly": audit_only,
    }

    if audit_only:
        logging.info("Audit-only mode complete. Validated configuration, signing key, and dataset.")
        return report

    build_inputs = _build_input_identity(dataset_dir, regions, signature_key_id, raw_public_key)
    distribution_path.mkdir(parents=True, exist_ok=True)
    _require_real_directory(distribution_path, "terrain distribution")
    # One publisher owns the staging tree and current pointer at a time.
    with (distribution_path / ".pipeline.lock").open("a") as build_lock:
        fcntl.flock(build_lock, fcntl.LOCK_EX)
        _build_and_publish_release(
            report, regions, build_inputs, dataset_dir, distribution_path,
            signing_key_path, trusted_signing_keys, required_headroom,
        )
    return report


def _build_input_identity(
    dataset_dir: Path,
    regions: list[dict[str, object]],
    signature_key_id: str,
    public_key_bytes: bytes,
) -> dict[str, object]:
    module_directory = Path(__file__).resolve().parent
    source_paths = [module_directory / name for name in ("grid_pack.py", "raster_elevation.py", "signing.py")]
    source_paths.append(module_directory.parents[1] / "requirements.txt")
    if any(region["osmPbf"] is not None for region in regions):
        source_paths.extend(module_directory / name for name in (
            "road_graph.py", "road_corridors.py", "road_profiles.py",
        ))
        repository = module_directory.parents[3]
        source_paths.extend((
            repository / "services/terrain/tools/analyze_road_profiles.mts",
            repository / "src/domain/routes/elevation/routeElevationAnalysis.ts",
        ))
    dataset_manifest_path = dataset_dir / "manifest.json"
    dataset_manifest = json.loads(dataset_manifest_path.read_bytes())
    return {
        "schemaVersion": 1,
        "signatureKeyId": signature_key_id,
        "signingPublicKeySha256": hashlib.sha256(public_key_bytes).hexdigest(),
        "datasetManifestSha256": _file_sha256(dataset_manifest_path),
        "datasetVersion": dataset_manifest["datasetVersion"],
        "elevationSource": {
            field: dataset_manifest["source"][field]
            for field in ("name", "release", "resolutionMeters", "verticalDatum", "attribution")
        },
        "builderSources": {path.name: _file_sha256(path) for path in source_paths},
        "regions": [{
            "chunkId": region["chunkId"],
            "packId": region["packId"],
            "bounds": list(region["bounds"]),
            "osmPbfSha256": _file_sha256(region["osmPbf"]) if region["osmPbf"] is not None else None,
            "osmSourceUrl": region["osmSourceUrl"],
            "osmSnapshotAt": region["osmSnapshotAt"],
        } for region in sorted(regions, key=lambda region: region["chunkId"])],
    }


def _build_and_publish_release(
    report: dict[str, object],
    regions: list[dict[str, object]],
    build_inputs: dict[str, object],
    dataset_dir: Path,
    distribution_path: Path,
    signing_key_path: Path,
    trusted_signing_keys: dict[str, bytes],
    required_headroom: int,
) -> None:
    release_id = str(report["releaseId"])
    signature_key_id = str(report["signatureKeyId"])
    releases_directory = distribution_path / "releases"
    builds_directory = distribution_path / ".builds"
    for directory in (releases_directory, builds_directory):
        directory.mkdir(exist_ok=True)
        _require_real_directory(directory, "terrain build directory")
    release_root = releases_directory / release_id
    build_directory = builds_directory / release_id
    build_record_path = build_directory / "build.json"
    release_exists = release_root.exists() or release_root.is_symlink()
    if build_directory.exists() or build_directory.is_symlink():
        _require_real_directory(build_directory, "terrain staging directory")
    build_record = json.loads(build_record_path.read_bytes()) if build_record_path.is_file() else {}
    if not isinstance(build_record, dict):
        raise ValueError("terrain build record must contain an object")
    if build_record.get("publication") is not None and not release_exists:
        raise ValueError("published release is missing; restore its artifacts instead of rebuilding it")
    if release_exists:
        _require_real_directory(release_root, "terrain release directory")
        if build_record.get("inputs") != build_inputs:
            raise FileExistsError(f"Release {release_id} is immutable; use a new release ID for changed or unrecorded inputs")
        expected_chunks = {str(region["chunkId"]) for region in regions}
        if {entry.name for entry in release_root.iterdir()} != expected_chunks:
            raise ValueError("existing release chunks differ from recorded inputs; use a new release ID")
    elif build_record.get("inputs") != build_inputs:
        if build_directory.exists():
            shutil.rmtree(build_directory)
        build_directory.mkdir()
        build_record = {"inputs": build_inputs}
        _write_build_record(build_record_path, build_record)

    staged_chunks = build_directory / "chunks"
    if not release_exists:
        staged_chunks.mkdir(exist_ok=True)
        _require_real_directory(staged_chunks, "terrain staged chunks")
    built_chunks: list[dict[str, object]] = []
    for region in regions:
        chunk_id = str(region["chunkId"])
        chunk_directory = (release_root if release_exists else staged_chunks) / chunk_id
        if chunk_directory.exists() or chunk_directory.is_symlink():
            try:
                built_chunks.append(_verified_chunk_record(chunk_directory, region, build_inputs, trusted_signing_keys, "reused"))
                continue
            except (OSError, ValueError):
                if release_exists:
                    raise
                _require_real_directory(chunk_directory, "terrain staged chunk")
                shutil.rmtree(chunk_directory)
        check_disk_headroom(distribution_path, required_headroom)
        staging_directory = Path(tempfile.mkdtemp(prefix=f".staging-{chunk_id}-", dir=build_directory))
        try:
            terrain_store = RasterElevationStore(dataset_dir)
            try:
                pack = build_elevation_grid_pack(
                    terrain_store, staging_directory / chunk_id, str(region["packId"]),
                    tuple(region["bounds"]), osm_pbf_path=region["osmPbf"],
                    osm_source_url=region["osmSourceUrl"], osm_snapshot_at=region["osmSnapshotAt"],
                )
            finally:
                terrain_store.close()
            sign_elevation_grid_pack(pack.pack_directory, signing_key_path, signature_key_id)
            chunk_record = _verified_chunk_record(pack.pack_directory, region, build_inputs, trusted_signing_keys, "built_and_verified")
            pack.pack_directory.rename(chunk_directory)
            _sync_directory(staged_chunks)
            built_chunks.append(chunk_record)
        finally:
            shutil.rmtree(staging_directory, ignore_errors=True)
    report["stages"] = built_chunks
    if not release_exists:
        # No release URL is visible until every requested chunk has passed verification.
        staged_chunks.rename(release_root)
        _sync_directory(releases_directory)

    existing_publication = build_record.get("publication")
    if existing_publication is not None:
        catalog_digest = existing_publication["catalogDigest"]
        catalog_directory = distribution_path / "catalogs" / catalog_digest
        verified_catalog = TerrainPackDistribution(distribution_path, trusted_signing_keys)._verify_catalog(
            (catalog_directory / "catalog.json").read_bytes(),
            (catalog_directory / "catalog.ed25519").read_bytes(), catalog_digest,
        )
        if verified_catalog.catalog["releaseId"] != release_id:
            raise ValueError("recorded publication does not match the release")
        report["publication"] = {**existing_publication, "catalogPath": str(catalog_directory)}
        return
    pointer_path = distribution_path / "current.json"
    current_pointer = pointer_path.read_text(encoding="utf-8") if pointer_path.exists() else None
    if "publicationStartedFrom" in build_record:
        if current_pointer != build_record["publicationStartedFrom"]:
            current_catalog = TerrainPackDistribution(distribution_path, trusted_signing_keys).current_catalog()
            if current_catalog.catalog["releaseId"] != release_id:
                raise ValueError("another release became current after interrupted publication; automatic rollback refused")
            publication = {
                "catalogDigest": current_catalog.etag,
                "catalogPath": str(distribution_path / "catalogs" / current_catalog.etag),
                "chunkCount": len(current_catalog.catalog["chunks"]),
                "releaseId": release_id,
                "signatureKeyId": signature_key_id,
            }
            report["publication"] = publication
            build_record["publication"] = publication
            _write_build_record(build_record_path, build_record)
            return
    else:
        # Preserve the predecessor so an interrupted retry cannot roll back a newer release.
        build_record["publicationStartedFrom"] = current_pointer
        _write_build_record(build_record_path, build_record)
    publication = publish_signed_terrain_catalog(
        distribution_path, release_id, signing_key_path, signature_key_id,
    )
    report["publication"] = publication
    build_record["publication"] = publication
    _write_build_record(build_record_path, build_record)


def _verified_chunk_record(
    chunk_directory: Path,
    region: dict[str, object],
    build_inputs: dict[str, object],
    trusted_signing_keys: dict[str, bytes],
    status: str,
) -> dict[str, object]:
    verified_pack = verify_signed_terrain_pack(chunk_directory, trusted_signing_keys)
    manifest = verified_pack.manifest
    if manifest["packId"] != region["packId"] or manifest["requestedBoundsWgs84"] != list(region["bounds"]):
        raise ValueError("terrain chunk does not match its requested pack ID and bounds")
    if manifest["datasetVersion"] != build_inputs["datasetVersion"] or any(
        manifest["source"].get(field) != expected
        for field, expected in build_inputs["elevationSource"].items()
    ):
        raise ValueError("terrain chunk does not match its recorded elevation source")
    if manifest["hasRoadGraph"] != (region["osmPbf"] is not None):
        raise ValueError("terrain chunk does not match its requested road graph")
    if region["osmPbf"] is not None:
        region_inputs = next(chunk for chunk in build_inputs["regions"] if chunk["chunkId"] == region["chunkId"])
        road_graph = manifest["roadGraph"]
        if (
            road_graph["pbfSha256"] != region_inputs["osmPbfSha256"]
            or road_graph["sourceUrl"] != region["osmSourceUrl"]
            or road_graph["snapshotAt"] != region["osmSnapshotAt"]
        ):
            raise ValueError("terrain chunk does not match its recorded OSM snapshot")
    return {
        "chunkId": region["chunkId"], "packId": region["packId"], "status": status,
        "manifestSha256": verified_pack.manifest_sha256,
        "sizeBytes": manifest["files"][0]["sizeBytes"],
    }


def _file_sha256(path: Path) -> str:
    checksum = hashlib.sha256()
    with path.open("rb") as source_file:
        for block in iter(lambda: source_file.read(1024 * 1024), b""):
            checksum.update(block)
    return checksum.hexdigest()


def _write_build_record(record_path: Path, build_record: dict[str, object]) -> None:
    descriptor, temporary_path = tempfile.mkstemp(prefix=".build-", dir=record_path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as record_file:
            json.dump(build_record, record_file, sort_keys=True, separators=(",", ":"))
            record_file.flush()
            os.fsync(record_file.fileno())
        os.replace(temporary_path, record_path)
        _sync_directory(record_path.parent)
    finally:
        Path(temporary_path).unlink(missing_ok=True)


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Regional and national batch pipeline for CycleComp offline terrain."
    )
    parser.add_argument("--config", required=True, type=Path, help="Path to regional build config JSON")
    parser.add_argument("--dataset-dir", required=True, type=Path, help="Directory containing DEM raster files")
    parser.add_argument("--distribution-dir", required=True, type=Path, help="Output distribution directory")
    parser.add_argument("--signing-key", required=True, type=Path, help="Ed25519 private key PEM file")
    parser.add_argument("--audit-only", action="store_true", help="Validate configuration and gates without building")
    parser.add_argument("--override-headroom-bytes", type=int, help="Override minimum required disk headroom in bytes")

    options = parser.parse_args(arguments)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

    try:
        report = run_regional_pipeline(
            options.config,
            options.dataset_dir,
            options.distribution_dir,
            options.signing_key,
            audit_only=options.audit_only,
            override_headroom_bytes=options.override_headroom_bytes,
        )
        print(json.dumps(report, indent=2))
        return 0
    except Exception as error:
        logging.error("Regional pipeline failed: %s", error)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
