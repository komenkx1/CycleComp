from __future__ import annotations

import json
from pathlib import Path
import shutil

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
import numpy as np
import pytest
from fastapi.testclient import TestClient

from cyclecomp_terrain.api import create_app
from cyclecomp_terrain.catalog_publish import publish_signed_terrain_catalog
from cyclecomp_terrain.grid_pack import build_elevation_grid_pack
from cyclecomp_terrain.signing import sign_elevation_grid_pack
from test_raster_elevation import create_dataset


def test_signed_catalog_serves_verified_pack_files_and_resumable_ranges(tmp_path: Path) -> None:
    distribution_directory, trusted_public_key = create_published_distribution(tmp_path)
    app = create_app(
        distribution_directory=distribution_directory,
        trusted_signing_keys={"terrain-test-2026": trusted_public_key},
    )

    with TestClient(app) as client:
        catalog_response = client.get("/v1/terrain/catalog.json")
        catalog_signature_response = client.get("/v1/terrain/catalog.ed25519")
        catalog = catalog_response.json()
        chunk_record = catalog["chunks"][0]
        manifest_url = "/v1/terrain/releases/release-1/bali-core/manifest.json"
        signature_url = "/v1/terrain/releases/release-1/bali-core/manifest.ed25519"
        manifest_response = client.get(manifest_url)
        signature_response = client.get(signature_url)
        artifact_url = (
            f"/v1/terrain/releases/release-1/bali-core/{chunk_record['databaseSha256']}.sqlite"
        )
        artifact_response = client.get(artifact_url)
        ranged_response = client.get(artifact_url, headers={"Range": "bytes=2-8"})
        suffix_response = client.get(artifact_url, headers={"Range": "bytes=-4"})
        invalid_range_response = client.get(artifact_url, headers={"Range": "bytes=999999999-"})
        unchanged_catalog_response = client.get(
            "/v1/terrain/catalog.json",
            headers={"If-None-Match": catalog_response.headers["etag"]},
        )

    assert catalog_response.status_code == 200
    assert catalog_response.headers["cache-control"] == "public, max-age=60"
    assert len(catalog_signature_response.content) == 64
    Ed25519PublicKey.from_public_bytes(trusted_public_key).verify(
        catalog_signature_response.content,
        catalog_response.content,
    )
    assert len(manifest_response.content) > 0
    assert len(signature_response.content) == 64
    assert artifact_response.status_code == 200
    assert len(artifact_response.content) == chunk_record["databaseSizeBytes"]
    assert artifact_response.headers["accept-ranges"] == "bytes"
    assert ranged_response.status_code == 206
    assert ranged_response.headers["content-range"] == f"bytes 2-8/{len(artifact_response.content)}"
    assert ranged_response.content == artifact_response.content[2:9]
    assert suffix_response.status_code == 206
    assert suffix_response.content == artifact_response.content[-4:]
    assert invalid_range_response.status_code == 416
    assert unchanged_catalog_response.status_code == 304


def test_distribution_rejects_untrusted_or_changed_catalog_and_pack_content(tmp_path: Path) -> None:
    distribution_directory, _ = create_published_distribution(tmp_path / "untrusted")
    app_with_wrong_key = create_app(
        distribution_directory=distribution_directory,
        trusted_signing_keys={"other-key": b"\x01" * 32},
    )
    with TestClient(app_with_wrong_key) as client:
        assert client.get("/v1/terrain/catalog.json").status_code == 503

    distribution_directory, trusted_public_key = create_published_distribution(tmp_path / "tampered")
    database_path = distribution_directory / "releases" / "release-1" / "bali-core" / "terrain.sqlite"
    database_path.write_bytes(database_path.read_bytes() + b"changed")
    app_with_tampered_pack = create_app(
        distribution_directory=distribution_directory,
        trusted_signing_keys={"terrain-test-2026": trusted_public_key},
    )
    with TestClient(app_with_tampered_pack) as client:
        assert client.get("/v1/terrain/catalog.json").status_code == 503
        assert client.get("/v1/terrain/releases/release-1/bali-core/manifest.json").status_code == 503

    distribution_directory, trusted_public_key = create_published_distribution(tmp_path / "bad-signature")
    pointer = json.loads((distribution_directory / "current.json").read_bytes())
    catalog_signature_path = (
        distribution_directory / "catalogs" / pointer["catalogDigest"] / "catalog.ed25519"
    )
    catalog_signature_path.chmod(0o644)
    catalog_signature_path.write_bytes(b"x" * 64)
    app_with_changed_signature = create_app(
        distribution_directory=distribution_directory,
        trusted_signing_keys={"terrain-test-2026": trusted_public_key},
    )
    with TestClient(app_with_changed_signature) as client:
        assert client.get("/v1/terrain/catalog.json").status_code == 503


def test_distribution_routes_do_not_expose_unlisted_or_malformed_pack_ids(tmp_path: Path) -> None:
    distribution_directory, trusted_public_key = create_published_distribution(tmp_path)
    app = create_app(
        distribution_directory=distribution_directory,
        trusted_signing_keys={"terrain-test-2026": trusted_public_key},
    )

    with TestClient(app) as client:
        assert client.get("/v1/terrain/releases/release-1/missing/manifest.json").status_code == 404
        assert client.get("/v1/terrain/releases/../outside/manifest.json").status_code in {404, 422}
        assert client.get("/v1/terrain/releases/release-1/bali-core/" + "0" * 64 + ".sqlite").status_code == 404


def test_distribution_endpoints_report_unconfigured_catalog(tmp_path: Path) -> None:
    app = create_app()

    with TestClient(app) as client:
        assert client.get("/v1/terrain/catalog.json").status_code == 503
        assert client.get("/v1/terrain/catalog.ed25519").status_code == 503


def test_old_release_download_urls_survive_a_new_catalog_and_server_restart(tmp_path: Path) -> None:
    distribution_directory, trusted_public_key = create_published_distribution(tmp_path)
    old_pointer = json.loads((distribution_directory / "current.json").read_bytes())
    old_catalog_path = distribution_directory / "catalogs" / old_pointer["catalogDigest"] / "catalog.json"
    old_chunk = json.loads(old_catalog_path.read_bytes())["chunks"][0]
    old_pack_directory = distribution_directory / "releases" / "release-1" / "bali-core"
    old_manifest = (old_pack_directory / "manifest.json").read_bytes()
    new_pack_directory = distribution_directory / "releases" / "release-2" / "bali-core"
    new_pack_directory.parent.mkdir()
    shutil.copytree(old_pack_directory, new_pack_directory)
    publish_signed_terrain_catalog(
        distribution_directory, "release-2", tmp_path / "signing-key.pem", "terrain-test-2026"
    )

    app_after_publication = create_app(
        distribution_directory=distribution_directory,
        trusted_signing_keys={"terrain-test-2026": trusted_public_key},
    )
    with TestClient(app_after_publication) as client:
        assert client.get("/v1/terrain/catalog.json").json()["releaseId"] == "release-2"
        old_manifest_response = client.get("/v1/terrain/releases/release-1/bali-core/manifest.json")
        old_range_response = client.get(
            f"/v1/terrain/releases/release-1/bali-core/{old_chunk['databaseSha256']}.sqlite",
            headers={"Range": "bytes=0-15"},
        )
        assert old_manifest_response.status_code == 200
        assert old_manifest_response.content == old_manifest
        assert old_range_response.status_code == 206
        assert old_range_response.content == b"SQLite format 3\x00"
        assert client.get("/v1/terrain/releases/release-1/unlisted/manifest.json").status_code == 404


def test_historical_release_requires_an_unchanged_signed_catalog(tmp_path: Path) -> None:
    distribution_directory, trusted_public_key = create_published_distribution(tmp_path)
    old_pointer = json.loads((distribution_directory / "current.json").read_bytes())
    old_signature_path = distribution_directory / "catalogs" / old_pointer["catalogDigest"] / "catalog.ed25519"
    new_pack_directory = distribution_directory / "releases" / "release-2" / "bali-core"
    new_pack_directory.parent.mkdir()
    shutil.copytree(distribution_directory / "releases/release-1/bali-core", new_pack_directory)
    publish_signed_terrain_catalog(
        distribution_directory, "release-2", tmp_path / "signing-key.pem", "terrain-test-2026"
    )
    old_signature_path.chmod(0o644)
    old_signature_path.write_bytes(b"x" * 64)

    app = create_app(
        distribution_directory=distribution_directory,
        trusted_signing_keys={"terrain-test-2026": trusted_public_key},
    )
    with TestClient(app) as client:
        assert client.get("/v1/terrain/catalog.json").status_code == 200
        assert client.get("/v1/terrain/releases/release-1/bali-core/manifest.json").status_code == 503


def test_catalog_publisher_keeps_current_pointer_when_a_chunk_fails_verification(tmp_path: Path) -> None:
    distribution_directory, _ = create_published_distribution(tmp_path)
    pointer_path = distribution_directory / "current.json"
    original_pointer = pointer_path.read_bytes()
    (distribution_directory / "releases" / "release-1" / "invalid-chunk").mkdir()

    with pytest.raises(ValueError):
        publish_signed_terrain_catalog(
            distribution_directory,
            "release-1",
            tmp_path / "signing-key.pem",
            "terrain-test-2026",
        )

    assert pointer_path.read_bytes() == original_pointer
    assert not list((distribution_directory / "catalogs").glob(".staging-*"))


def create_published_distribution(tmp_path: Path) -> tuple[Path, bytes]:
    dataset_directory = tmp_path / "source"
    terrain_store = create_dataset(
        dataset_directory,
        [("signed-grid", 0, np.array([[-5, 0], [10, 15]], dtype=np.float32), None)],
    )
    private_key = Ed25519PrivateKey.generate()
    private_key_path = tmp_path / "signing-key.pem"
    private_key_path.write_bytes(
        private_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    private_key_path.chmod(0o600)
    staged_pack_directory = tmp_path / "staged-pack"
    try:
        build_elevation_grid_pack(
            terrain_store,
            staged_pack_directory,
            "bali-grid",
            (0.49, 0.49, 1.51, 1.51),
        )
    finally:
        terrain_store.close()

    sign_elevation_grid_pack(staged_pack_directory, private_key_path, "terrain-test-2026")
    distribution_directory = tmp_path / "distribution"
    pack_directory = distribution_directory / "releases" / "release-1" / "bali-core"
    pack_directory.parent.mkdir(parents=True)
    shutil.move(str(staged_pack_directory), str(pack_directory))
    publish_signed_terrain_catalog(
        distribution_directory,
        "release-1",
        private_key_path,
        "terrain-test-2026",
    )
    trusted_public_key = private_key.public_key().public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    )
    return distribution_directory, trusted_public_key
