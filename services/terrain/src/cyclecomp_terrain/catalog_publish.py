from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile
from uuid import uuid4

from cryptography.hazmat.primitives import serialization

from cyclecomp_terrain.distribution import TerrainPackDistribution
from cyclecomp_terrain.signing import _load_signing_key, validate_signature_key_id, verify_signed_terrain_pack


_IDENTIFIER_PATTERN = re.compile(r"[a-z0-9][a-z0-9._-]{0,95}")


def publish_signed_terrain_catalog(
    distribution_directory: Path,
    release_id: str,
    signing_key_path: Path,
    signature_key_id: str,
    update_current: bool = True,
) -> dict[str, object]:
    _validate_identifier(release_id, "release ID")
    validate_signature_key_id(signature_key_id)

    distribution_path = distribution_directory.absolute()
    release_directory = distribution_path / "releases" / release_id
    _require_real_directory(release_directory, "terrain release directory")

    signing_key = _load_signing_key(signing_key_path)
    public_key_bytes = signing_key.public_key().public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    )
    trusted_signing_keys = {signature_key_id: public_key_bytes}
    chunk_records: list[dict[str, object]] = []

    for pack_directory in sorted(release_directory.iterdir(), key=lambda path: path.name):
        _validate_identifier(pack_directory.name, "chunk ID")
        _require_real_directory(pack_directory, "terrain chunk directory")
        verified_pack = verify_signed_terrain_pack(pack_directory, trusted_signing_keys)
        database_record = verified_pack.manifest["files"][0]
        chunk_records.append(
            {
                "chunkId": pack_directory.name,
                "databaseSha256": database_record["sha256"],
                "databaseSizeBytes": database_record["sizeBytes"],
                "elevationCoverage": verified_pack.manifest["coverage"],
                "hasElevationGrid": verified_pack.manifest["hasElevationGrid"],
                "hasRoadGraph": verified_pack.manifest["hasRoadGraph"],
                "hasRoadProfiles": verified_pack.manifest["hasRoadProfiles"],
                "manifestSha256": verified_pack.manifest_sha256,
                "packId": verified_pack.manifest["packId"],
                "requestedBoundsWgs84": verified_pack.manifest["requestedBoundsWgs84"],
                "verticalDatum": verified_pack.manifest["source"]["verticalDatum"],
            }
        )

    if not chunk_records:
        raise ValueError("terrain release must contain at least one signed chunk")

    catalog = {
        "chunks": chunk_records,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "releaseId": release_id,
        "schemaVersion": 1,
        "signatureKeyId": signature_key_id,
    }
    catalog_bytes = TerrainPackDistribution._canonical_json(catalog)
    signature_bytes = signing_key.sign(catalog_bytes)
    catalog_digest = hashlib.sha256(catalog_bytes + signature_bytes).hexdigest()

    distribution_path.mkdir(parents=True, exist_ok=True)
    catalogs_directory = distribution_path / "catalogs"
    catalogs_directory.mkdir(mode=0o755, exist_ok=True)
    _require_real_directory(catalogs_directory, "terrain catalogs directory")

    version_directory = catalogs_directory / catalog_digest
    staging_directory = catalogs_directory / f".staging-{uuid4().hex}"
    staging_directory.mkdir(mode=0o755)
    try:
        (staging_directory / "catalog.json").write_bytes(catalog_bytes)
        (staging_directory / "catalog.ed25519").write_bytes(signature_bytes)
        (staging_directory / "catalog.json").chmod(0o444)
        (staging_directory / "catalog.ed25519").chmod(0o444)
        _sync_directory(staging_directory)

        if version_directory.exists() or version_directory.is_symlink():
            _require_real_directory(version_directory, "existing terrain catalog version")
            if (
                (version_directory / "catalog.json").read_bytes() != catalog_bytes
                or (version_directory / "catalog.ed25519").read_bytes() != signature_bytes
            ):
                raise FileExistsError("terrain catalog digest already exists with different contents")
            shutil.rmtree(staging_directory)
        else:
            os.replace(staging_directory, version_directory)
            _sync_directory(catalogs_directory)

        if update_current:
            pointer_bytes = TerrainPackDistribution._canonical_json({"catalogDigest": catalog_digest})
            _replace_catalog_pointer(distribution_path, pointer_bytes)
    except Exception:
        if staging_directory.exists():
            shutil.rmtree(staging_directory, ignore_errors=True)
        raise

    return {
        "catalogDigest": catalog_digest,
        "catalogPath": str(version_directory),
        "chunkCount": len(chunk_records),
        "releaseId": release_id,
        "signatureKeyId": signature_key_id,
    }


def _replace_catalog_pointer(distribution_directory: Path, pointer_bytes: bytes) -> None:
    file_descriptor, temporary_path_value = tempfile.mkstemp(
        prefix=".current-",
        suffix=".json",
        dir=distribution_directory,
    )
    temporary_path = Path(temporary_path_value)
    try:
        with os.fdopen(file_descriptor, "wb") as pointer_file:
            pointer_file.write(pointer_bytes)
            pointer_file.flush()
            os.fsync(pointer_file.fileno())
        temporary_path.chmod(0o644)
        os.replace(temporary_path, distribution_directory / "current.json")
        _sync_directory(distribution_directory)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise


def _require_real_directory(directory: Path, description: str) -> None:
    try:
        directory_mode = directory.lstat().st_mode
    except OSError as error:
        raise ValueError(f"{description} is unavailable") from error
    if not stat.S_ISDIR(directory_mode):
        raise ValueError(f"{description} must not be a symlink")


def _validate_identifier(identifier: str, description: str) -> None:
    if not _IDENTIFIER_PATTERN.fullmatch(identifier):
        raise ValueError(f"{description} is invalid")


def _sync_directory(directory: Path) -> None:
    directory_descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(directory_descriptor)
    finally:
        os.close(directory_descriptor)
