from __future__ import annotations

import base64
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import platform
import shutil
import subprocess
import threading
import time
import uuid

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
import numpy as np
import pytest

from cyclecomp_terrain.grid_pack import build_elevation_grid_pack
from cyclecomp_terrain.signing import sign_elevation_grid_pack
from test_raster_elevation import create_dataset


pytestmark = pytest.mark.skipif(
    platform.system() != "Darwin" or shutil.which("swiftc") is None,
    reason="the native downloader check requires the Apple Swift SDK",
)


@pytest.fixture(scope="module")
def native_downloader(tmp_path_factory):
    workspace = tmp_path_factory.mktemp("native-downloader")
    repository = Path(__file__).resolve().parents[3]
    executable = workspace / "download-recovery-check"
    subprocess.run([
        "swiftc", "-module-cache-path", str(workspace / "module-cache"),
        str(repository / "ios/CycleComp/TerrainGridPackReader.swift"),
        str(repository / "ios/CycleComp/TerrainGridPackStore.swift"),
        str(repository / "ios/Tests/TerrainDownloadRecoveryCheck.swift"),
        "-o", str(executable),
    ], check=True, capture_output=True, text=True)
    source = create_dataset(
        workspace / "source", [("download-grid", 0, np.ones((3, 3), dtype=np.float32), None)],
    )
    try:
        pack = build_elevation_grid_pack(
            source, workspace / "pack", "download-recovery-pack", (0.49, 0.49, 2.51, 2.51),
        )
    finally:
        source.close()
    signing_key = Ed25519PrivateKey.generate()
    private_key_path = workspace / "test-key.pem"
    private_key_path.write_bytes(signing_key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ))
    private_key_path.chmod(0o600)
    sign_elevation_grid_pack(pack.pack_directory, private_key_path, "recovery-test-key")
    public_key = base64.b64encode(signing_key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw,
    )).decode("ascii")
    manifest = json.loads((pack.pack_directory / "manifest.json").read_text())
    return executable, pack.pack_directory, public_key, manifest["files"][0]["sha256"]


@contextmanager
def terrain_server(pack_directory, *, delayed_manifest=False, break_database_once=False):
    requests = []
    range_requests = []

    class TerrainHandler(BaseHTTPRequestHandler):
        database_attempts = 0

        def log_message(self, *args):
            pass

        def do_GET(self):
            requests.append(self.path)
            filename = self.path.rsplit("/", 1)[-1]
            database_request = filename.endswith(".sqlite")
            if delayed_manifest and filename == "manifest.json":
                time.sleep(1)
            source = pack_directory / ("terrain.sqlite" if database_request else filename)
            contents = source.read_bytes()
            range_header = self.headers.get("Range")
            start_offset = 0
            if range_header:
                range_requests.append(range_header)
                start_offset = int(range_header.removeprefix("bytes=").split("-")[0])
            self.send_response(206 if range_header else 200)
            if range_header:
                self.send_header("Content-Range", f"bytes {start_offset}-{len(contents)-1}/{len(contents)}")
            self.send_header("Content-Length", str(len(contents) - start_offset))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("ETag", '"immutable-test-database"')
            self.send_header("Last-Modified", "Sat, 17 Oct 2026 00:00:00 GMT")
            self.end_headers()
            if database_request:
                TerrainHandler.database_attempts += 1
            try:
                for offset in range(start_offset, len(contents), 1024):
                    self.wfile.write(contents[offset:offset + 1024])
                    self.wfile.flush()
                    if database_request:
                        if break_database_once and TerrainHandler.database_attempts == 1:
                            self.connection.shutdown(2)
                            return
                        time.sleep(0.015)
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), TerrainHandler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", requests, range_requests
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)


def run_native(native_downloader, mode, store, base_url="http://127.0.0.1:1"):
    executable, pack, public_key, database_hash = native_downloader
    return subprocess.run([
        str(executable), mode, str(store), str(pack), public_key, base_url, database_hash,
    ], check=True, capture_output=True, text=True, timeout=35)


def test_restores_legacy_promotion_crash_and_retains_valid_promoted_pack(native_downloader, tmp_path):
    assert "promotion recovery passed" in run_native(native_downloader, "promotion", tmp_path).stdout


def test_cancel_waits_for_task_to_settle_before_retry_is_allowed(native_downloader, tmp_path):
    with terrain_server(native_downloader[1], delayed_manifest=True) as (base_url, requests, _):
        assert "cancellation settled" in run_native(native_downloader, "cancel", tmp_path, base_url).stdout
        assert not any(path.endswith(".sqlite") for path in requests)


def test_recovers_persisted_download_after_process_death(native_downloader, tmp_path):
    executable, pack, public_key, database_hash = native_downloader
    with terrain_server(pack) as (base_url, requests, _):
        process = subprocess.Popen([
            str(executable), "start", str(tmp_path), str(pack), public_key, base_url, database_hash,
        ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                records = list((tmp_path / ".transfers").glob("*/download.json"))
                if records and json.loads(records[0].read_text())["state"] == "downloading":
                    break
                assert process.poll() is None, process.communicate()
                time.sleep(0.02)
            else:
                pytest.fail("The process did not persist its downloading state")
            process.kill()
            process.communicate(timeout=5)
            completed = run_native(native_downloader, "recover", tmp_path, base_url)
            assert "download verified and installed" in completed.stdout
            assert sum(path.endswith(".sqlite") for path in requests) >= 2
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=5)


def test_network_failure_can_retry_the_same_immutable_identity(native_downloader, tmp_path):
    with terrain_server(native_downloader[1], break_database_once=True) as (base_url, requests, _):
        assert "download verified and installed" in run_native(
            native_downloader, "retry", tmp_path, base_url,
        ).stdout
        assert sum(path.endswith(".sqlite") for path in requests) >= 2


def test_resumes_byte_range_and_installs_full_verified_database(native_downloader, tmp_path):
    with terrain_server(native_downloader[1]) as (base_url, _, range_requests):
        assert "download verified and installed" in run_native(
            native_downloader, "resume", tmp_path, base_url,
        ).stdout
        assert range_requests and all(header != "bytes=0-" for header in range_requests)


def test_recovered_install_rejects_a_changed_database_identity_before_promotion(native_downloader, tmp_path):
    _, pack, _, expected_database_hash = native_downloader
    operation_id = str(uuid.uuid4()).upper()
    operation_directory = tmp_path / ".transfers" / operation_id
    shutil.copytree(pack, operation_directory / "package")
    (operation_directory / "download.json").write_text(json.dumps({
        "operationID": operation_id, "baseURL": "http://127.0.0.1:1",
        "releaseID": "release-recovery-v1", "chunkID": "recovery-chunk",
        "databaseSha256": "a" * 64, "stage": "install", "state": "installing",
        "bytesWritten": 0, "totalBytes": 0,
    }))
    assert expected_database_hash != "a" * 64
    assert "mismatched recovery identity rejected" in run_native(
        native_downloader, "reject", tmp_path,
    ).stdout


def test_unusable_resume_record_restarts_its_immutable_database_url(native_downloader, tmp_path):
    _, pack, _, database_hash = native_downloader
    operation_id = str(uuid.uuid4()).upper()
    operation_directory = tmp_path / ".transfers" / operation_id
    shutil.copytree(pack, operation_directory / "package")
    (operation_directory / "package/terrain.sqlite").unlink()
    (operation_directory / "resume.data").write_bytes(b"invalid resume data")
    with terrain_server(pack) as (base_url, requests, _):
        (operation_directory / "download.json").write_text(json.dumps({
            "operationID": operation_id, "baseURL": base_url,
            "releaseID": "release-recovery-v1", "chunkID": "recovery-chunk",
            "databaseSha256": database_hash, "stage": "database", "state": "downloading",
            "bytesWritten": 4096, "totalBytes": (pack / "terrain.sqlite").stat().st_size,
        }))
        assert "download verified and installed" in run_native(
            native_downloader, "recover", tmp_path, base_url,
        ).stdout
        assert requests and all(path.endswith(f"/{database_hash}.sqlite") for path in requests)
