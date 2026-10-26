from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import shutil

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
import numpy as np
import pytest

from cyclecomp_terrain.grid_pack import build_elevation_grid_pack
from cyclecomp_terrain.pack_cli import main as build_pack_from_cli
from cyclecomp_terrain.signing import sign_elevation_grid_pack, verify_signed_terrain_pack
from test_raster_elevation import create_dataset


def test_cli_signs_pack_atomically_and_signature_verifies_exact_manifest_bytes(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
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
    output_directory = tmp_path / "published" / "bali-pilot"

    try:
        exit_code = build_pack_from_cli(
            [
                "--dataset-dir",
                str(dataset_directory),
                "--output-dir",
                str(output_directory),
                "--pack-id",
                "bali-pilot",
                "--bounds",
                "0.49",
                "0.49",
                "1.51",
                "1.51",
                "--signing-key",
                str(private_key_path),
                "--signature-key-id",
                "terrain-test-2026",
            ]
        )
    finally:
        terrain_store.close()

    assert exit_code == 0
    cli_summary = json.loads(capsys.readouterr().out)
    assert cli_summary["signatureStatus"] == "signed"
    assert cli_summary["signatureKeyId"] == "terrain-test-2026"
    assert cli_summary["trustedPublicKeyBase64"] == base64.b64encode(
        private_key.public_key().public_bytes(
            serialization.Encoding.Raw,
            serialization.PublicFormat.Raw,
        )
    ).decode("ascii")
    assert Path(cli_summary["packDirectory"]) == output_directory
    assert {path.name for path in output_directory.iterdir()} == {
        "manifest.json",
        "manifest.ed25519",
        "terrain.sqlite",
    }
    assert not list(output_directory.parent.glob(".bali-pilot.staging-*"))

    manifest_bytes = (output_directory / "manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    assert manifest["signatureStatus"] == "signed"
    assert manifest["signatureKeyId"] == "terrain-test-2026"
    assert manifest_bytes == json.dumps(
        manifest,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    signature_bytes = (output_directory / "manifest.ed25519").read_bytes()
    assert len(signature_bytes) == 64
    private_key.public_key().verify(signature_bytes, manifest_bytes)


def test_unsigned_pilot_must_be_explicit_and_cannot_claim_a_signing_key(
    tmp_path: Path,
) -> None:
    required_arguments = [
        "--dataset-dir",
        str(tmp_path / "source"),
        "--output-dir",
        str(tmp_path / "pack"),
        "--pack-id",
        "test-grid",
        "--bounds",
        "0",
        "0",
        "1",
        "1",
    ]

    with pytest.raises(SystemExit) as missing_signing_mode:
        build_pack_from_cli(required_arguments)
    assert missing_signing_mode.value.code == 2

    with pytest.raises(SystemExit) as missing_key_id:
        build_pack_from_cli([*required_arguments, "--signing-key", str(tmp_path / "key.pem")])
    assert missing_key_id.value.code == 2

    with pytest.raises(SystemExit) as unexpected_key_id:
        build_pack_from_cli([*required_arguments, "--unsigned-pilot", "--signature-key-id", "test-key"])
    assert unexpected_key_id.value.code == 2

    with pytest.raises(SystemExit) as invalid_key_id:
        build_pack_from_cli(
            [
                *required_arguments,
                "--signing-key",
                str(tmp_path / "key.pem"),
                "--signature-key-id",
                "Release Key",
            ]
        )
    assert invalid_key_id.value.code == 2


def test_cli_keeps_explicit_unsigned_pilot_output_unsigned(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    dataset_directory = tmp_path / "source"
    terrain_store = create_dataset(
        dataset_directory,
        [("unsigned-grid", 0, np.array([[-5, 0], [10, 15]], dtype=np.float32), None)],
    )
    output_directory = tmp_path / "published" / "unsigned-pilot"

    try:
        exit_code = build_pack_from_cli(
            [
                "--dataset-dir",
                str(dataset_directory),
                "--output-dir",
                str(output_directory),
                "--pack-id",
                "unsigned-grid",
                "--bounds",
                "0.49",
                "0.49",
                "1.51",
                "1.51",
                "--unsigned-pilot",
            ]
        )
    finally:
        terrain_store.close()

    assert exit_code == 0
    cli_summary = json.loads(capsys.readouterr().out)
    assert cli_summary["signatureStatus"] == "unsigned_pilot"
    assert cli_summary["signatureKeyId"] is None
    assert cli_summary["trustedPublicKeyBase64"] is None
    assert not (output_directory / "manifest.ed25519").exists()


def test_signer_rejects_a_tampered_database_without_adding_a_signature(tmp_path: Path) -> None:
    dataset_directory = tmp_path / "source"
    terrain_store = create_dataset(
        dataset_directory,
        [("signed-grid", 0, np.array([[-5, 0], [10, 15]], dtype=np.float32), None)],
    )
    private_key_path = _write_private_key(tmp_path / "signing-key.pem")
    output_directory = tmp_path / "pack"
    try:
        pack = build_elevation_grid_pack(
            terrain_store,
            output_directory,
            "signed-grid",
            (0.49, 0.49, 1.51, 1.51),
        )
    finally:
        terrain_store.close()

    manifest_before_signing = (output_directory / "manifest.json").read_bytes()
    database_path = output_directory / "terrain.sqlite"
    database_path.write_bytes(database_path.read_bytes() + b"tampered")

    with pytest.raises(ValueError, match="database size does not match"):
        sign_elevation_grid_pack(pack.pack_directory, private_key_path, "terrain-test-2026")

    assert not (output_directory / "manifest.ed25519").exists()
    assert (output_directory / "manifest.json").read_bytes() == manifest_before_signing


def test_cli_does_not_publish_a_pack_when_signing_key_permissions_are_open(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    dataset_directory = tmp_path / "source"
    terrain_store = create_dataset(
        dataset_directory,
        [("signed-grid", 0, np.array([[-5, 0], [10, 15]], dtype=np.float32), None)],
    )
    private_key_path = _write_private_key(tmp_path / "signing-key.pem")
    private_key_path.chmod(0o644)
    output_directory = tmp_path / "published" / "bali-pilot"

    try:
        with pytest.raises(SystemExit) as build_failure:
            build_pack_from_cli(
                [
                    "--dataset-dir",
                    str(dataset_directory),
                    "--output-dir",
                    str(output_directory),
                    "--pack-id",
                    "bali-pilot",
                    "--bounds",
                    "0.49",
                    "0.49",
                    "1.51",
                    "1.51",
                    "--signing-key",
                    str(private_key_path),
                    "--signature-key-id",
                    "terrain-test-2026",
                ]
            )
    finally:
        terrain_store.close()

    assert build_failure.value.code == 2
    assert "permissions must be 0400 or 0600" in capsys.readouterr().err
    assert not output_directory.exists()
    assert not list(output_directory.parent.glob(".bali-pilot.staging-*"))


def test_signer_rejects_a_previously_signed_or_unexpected_package_file(tmp_path: Path) -> None:
    terrain_store = create_dataset(
        tmp_path / "source",
        [("signed-grid", 0, np.array([[-5, 0], [10, 15]], dtype=np.float32), None)],
    )
    private_key_path = _write_private_key(tmp_path / "signing-key.pem")
    output_directory = tmp_path / "pack"
    try:
        pack = build_elevation_grid_pack(
            terrain_store,
            output_directory,
            "signed-grid",
            (0.49, 0.49, 1.51, 1.51),
        )
    finally:
        terrain_store.close()

    sign_elevation_grid_pack(pack.pack_directory, private_key_path, "terrain-test-2026")
    with pytest.raises(ValueError, match="only an unsigned terrain grid pack"):
        sign_elevation_grid_pack(pack.pack_directory, private_key_path, "terrain-test-2026")

    unsigned_copy = tmp_path / "unsigned-copy"
    shutil.copytree(pack.pack_directory, unsigned_copy)
    (unsigned_copy / "manifest.ed25519").unlink()
    (unsigned_copy / "unexpected.txt").write_text("not part of the pack", encoding="utf-8")
    with pytest.raises(ValueError, match="only an unsigned terrain grid pack"):
        sign_elevation_grid_pack(unsigned_copy, private_key_path, "terrain-test-2026")


def test_signed_pack_verifier_checks_signature_manifest_and_database(tmp_path: Path) -> None:
    pack_directory, trusted_public_key = _create_signed_pack(tmp_path)

    verified_pack = verify_signed_terrain_pack(
        pack_directory,
        {"terrain-test-2026": trusted_public_key},
    )

    manifest_bytes = (pack_directory / "manifest.json").read_bytes()
    assert verified_pack.manifest["signatureStatus"] == "signed"
    assert verified_pack.manifest_bytes == manifest_bytes
    assert verified_pack.manifest_sha256 == hashlib.sha256(manifest_bytes).hexdigest()
    assert verified_pack.signature_bytes == (pack_directory / "manifest.ed25519").read_bytes()


def test_signed_pack_verifier_rejects_untrusted_and_wrong_signing_keys(tmp_path: Path) -> None:
    pack_directory, trusted_public_key = _create_signed_pack(tmp_path)
    wrong_key = Ed25519PrivateKey.generate().public_key().public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    )

    with pytest.raises(ValueError, match="not trusted"):
        verify_signed_terrain_pack(pack_directory, {})
    with pytest.raises(ValueError, match="signature verification failed"):
        verify_signed_terrain_pack(pack_directory, {"terrain-test-2026": wrong_key})
    with pytest.raises(ValueError, match="32 raw bytes"):
        verify_signed_terrain_pack(pack_directory, {"terrain-test-2026": b"short"})

    assert len(trusted_public_key) == 32


def test_signed_pack_verifier_rejects_manifest_signature_and_database_tampering(tmp_path: Path) -> None:
    pack_directory, trusted_public_key = _create_signed_pack(tmp_path)
    trusted_keys = {"terrain-test-2026": trusted_public_key}

    signature_path = pack_directory / "manifest.ed25519"
    original_signature = signature_path.read_bytes()
    signature_path.write_bytes(b"broken")
    with pytest.raises(ValueError, match="exactly 64 bytes"):
        verify_signed_terrain_pack(pack_directory, trusted_keys)

    signature_path.write_bytes(original_signature)
    tampered_manifest_directory = tmp_path / "tampered-manifest"
    shutil.copytree(pack_directory, tampered_manifest_directory)
    manifest_path = tampered_manifest_directory / "manifest.json"
    manifest = json.loads(manifest_path.read_bytes())
    manifest["packId"] = "tampered-pack-id"
    manifest_path.write_bytes(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    with pytest.raises(ValueError, match="signature verification failed"):
        verify_signed_terrain_pack(tampered_manifest_directory, trusted_keys)

    tampered_database_directory = tmp_path / "tampered-database"
    shutil.copytree(pack_directory, tampered_database_directory)
    database_path = tampered_database_directory / "terrain.sqlite"
    database_path.write_bytes(database_path.read_bytes() + b"tampered")
    with pytest.raises(ValueError, match="database size does not match"):
        verify_signed_terrain_pack(tampered_database_directory, trusted_keys)


def test_signed_pack_verifier_rejects_unexpected_files_and_symlinks(tmp_path: Path) -> None:
    pack_directory, trusted_public_key = _create_signed_pack(tmp_path)
    trusted_keys = {"terrain-test-2026": trusted_public_key}
    (pack_directory / "unexpected.txt").write_text("not in the signed pack", encoding="utf-8")
    with pytest.raises(ValueError, match="exactly three expected files"):
        verify_signed_terrain_pack(pack_directory, trusted_keys)
    (pack_directory / "unexpected.txt").unlink()

    manifest_path = pack_directory / "manifest.json"
    manifest_bytes_path = tmp_path / "manifest-copy.json"
    manifest_bytes_path.write_bytes(manifest_path.read_bytes())
    manifest_path.unlink()
    manifest_path.symlink_to(manifest_bytes_path)
    with pytest.raises(ValueError, match="regular files"):
        verify_signed_terrain_pack(pack_directory, trusted_keys)


def _create_signed_pack(tmp_path: Path) -> tuple[Path, bytes]:
    terrain_store = create_dataset(
        tmp_path / "source",
        [("signed-grid", 0, np.array([[-5, 0], [10, 15]], dtype=np.float32), None)],
    )
    signing_key = Ed25519PrivateKey.generate()
    private_key_path = tmp_path / "signing-key.pem"
    private_key_path.write_bytes(
        signing_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    private_key_path.chmod(0o600)
    pack_directory = tmp_path / "signed-pack"

    try:
        pack = build_elevation_grid_pack(
            terrain_store,
            pack_directory,
            "signed-grid",
            (0.49, 0.49, 1.51, 1.51),
        )
    finally:
        terrain_store.close()

    sign_elevation_grid_pack(pack.pack_directory, private_key_path, "terrain-test-2026")
    trusted_public_key = signing_key.public_key().public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    )
    return pack_directory, trusted_public_key


def _write_private_key(key_path: Path) -> Path:
    signing_key = Ed25519PrivateKey.generate()
    key_path.write_bytes(
        signing_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    key_path.chmod(0o600)
    return key_path
