from __future__ import annotations

import base64
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor, as_completed
import fcntl
import hashlib
import json
import logging
import os
from pathlib import Path
import queue
import re
import shutil
import tempfile
import threading
from typing import Any

from cryptography.hazmat.primitives import serialization

from cyclecomp_terrain.catalog_publish import _require_real_directory, _sync_directory, publish_signed_terrain_catalog
from cyclecomp_terrain.distribution import TerrainPackDistribution
from cyclecomp_terrain.grid_pack import build_elevation_grid_pack
from cyclecomp_terrain.raster_elevation import RasterElevationStore
from cyclecomp_terrain.regional_pipeline import MINIMUM_HEADROOM_BYTES, check_disk_headroom
from cyclecomp_terrain.signing import (
    _load_signing_key,
    sign_elevation_grid_pack,
    validate_signature_key_id,
    verify_signed_terrain_pack,
)


logger = logging.getLogger(__name__)
_IDENTIFIER_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,95}$")
_AREA_JOB_PATTERN = re.compile(r"^area-[0-9a-f]{32}$")
MAX_AREA_BOUNDS = 16
MAX_AREA_CHUNKS = 64
MAX_QUEUED_AREA_BUILDS = 8
MAX_PARALLEL_AREA_CHUNK_BUILDS = 2


class TerrainAreaRequestError(ValueError):
    pass


class TerrainAreaLimitError(TerrainAreaRequestError):
    pass


class TerrainAreaQueueFullError(TerrainAreaRequestError):
    pass


class TerrainAreaBuildManager:
    def __init__(
        self,
        region_config_path: Path,
        distribution_directory: Path,
        jobs_directory: Path,
        trusted_signing_keys: dict[str, bytes],
        dataset_directory: Path | None = None,
        signing_key_path: Path | None = None,
        signature_key_id: str | None = None,
        run_worker: bool = False,
    ) -> None:
        self.region_config_path = region_config_path
        self.dataset_directory = dataset_directory
        self.distribution_directory = distribution_directory.absolute()
        self.signing_key_path = signing_key_path
        self.region_config = self._load_region_config(region_config_path)
        if not trusted_signing_keys:
            raise ValueError("terrain area catalog verification keys are not configured")
        self.trusted_signing_keys = trusted_signing_keys
        configured_key_id = signature_key_id or self.region_config.get("signatureKeyId")
        if not isinstance(configured_key_id, str):
            raise ValueError("terrain area signing key ID is not configured")
        validate_signature_key_id(configured_key_id)
        trusted_public_key = trusted_signing_keys.get(configured_key_id)
        if not isinstance(trusted_public_key, bytes) or len(trusted_public_key) != 32:
            raise ValueError("terrain area signing key ID has no trusted public key")
        self.signature_key_id = configured_key_id
        if run_worker:
            if self.dataset_directory is None or self.signing_key_path is None:
                raise ValueError("terrain area worker data and signing key are not configured")
            signing_key = _load_signing_key(self.signing_key_path)
            public_key = signing_key.public_key().public_bytes(
                serialization.Encoding.Raw,
                serialization.PublicFormat.Raw,
            )
            if self.trusted_signing_keys.get(configured_key_id) != public_key:
                raise ValueError("terrain area signing key is not trusted by the configured key set")
        self.regions_by_id = {
            str(region["chunkId"]): region for region in self.region_config["regions"]
        }
        self.jobs_directory = jobs_directory.absolute()
        self.jobs_directory.mkdir(parents=True, exist_ok=True)
        _require_real_directory(self.jobs_directory, "terrain area job directory")
        self._jobs: dict[str, dict[str, Any]] = {}
        self._jobs_lock = threading.RLock()
        self._build_queue: queue.Queue[str | None] = queue.Queue()
        self._stopping = threading.Event()
        self._worker: threading.Thread | None = None
        self._recover_jobs(requeue=run_worker)
        if run_worker:
            self._worker = threading.Thread(
                target=self._run_build_queue,
                name="cyclecomp-terrain-area-builder",
                daemon=True,
            )
            self._worker.start()

    def close(self) -> None:
        self._stopping.set()
        if self._worker is not None:
            self._build_queue.put(None)
            self._worker.join()

    def submit(self, requested_bounds: Sequence[tuple[float, float, float, float]]) -> dict[str, Any]:
        if not requested_bounds or len(requested_bounds) > MAX_AREA_BOUNDS:
            raise TerrainAreaLimitError(f"Request between 1 and {MAX_AREA_BOUNDS} offline map areas.")

        selected_regions = select_terrain_regions(self.region_config["regions"], requested_bounds)
        if not selected_regions:
            raise TerrainAreaRequestError("No elevation data is available for the saved offline map area.")
        if len(selected_regions) > MAX_AREA_CHUNKS:
            raise TerrainAreaLimitError(
                f"This offline map area needs {len(selected_regions)} terrain chunks; request at most {MAX_AREA_CHUNKS} at a time."
            )

        chunk_ids = sorted(str(region["chunkId"]) for region in selected_regions)
        job_id = self._job_id(chunk_ids)
        with self._jobs_lock:
            existing_job = self._read_job_state(job_id)
            if existing_job and existing_job["status"] in {"queued", "building"}:
                return self._public_job_state(existing_job)
            if existing_job and existing_job["status"] == "completed" and isinstance(existing_job.get("catalog"), dict):
                return self._public_job_state(existing_job)

            queued_job_count = self._queued_job_count()
            if queued_job_count >= MAX_QUEUED_AREA_BUILDS:
                raise TerrainAreaQueueFullError("Terrain preparation is busy. Try again shortly.")

            job_state = {
                "jobId": job_id,
                "status": "queued",
                "chunkIds": chunk_ids,
                "completedChunks": 0,
                "totalChunks": len(chunk_ids),
                "releaseId": None,
                "catalogDigest": None,
                "catalog": None,
                "catalogSignatureBase64": None,
                "error": None,
            }
            self._jobs[job_id] = job_state
            self._write_job_state(job_state)
            if self._worker is not None:
                self._build_queue.put(job_id)
            return self._public_job_state(job_state)

    def get(self, job_id: str) -> dict[str, Any] | None:
        if not _AREA_JOB_PATTERN.fullmatch(job_id):
            return None
        with self._jobs_lock:
            job_state = self._read_job_state(job_id)
            if job_state is None:
                return None
            return self._public_job_state(job_state)

    def _run_build_queue(self) -> None:
        while not self._stopping.is_set():
            from_local_queue = True
            try:
                job_id = self._build_queue.get(timeout=1)
            except queue.Empty:
                from_local_queue = False
                job_id = self._next_queued_job()
                if job_id is None:
                    continue
            try:
                if job_id is None:
                    return
                self._build_job(job_id)
            finally:
                if from_local_queue:
                    self._build_queue.task_done()

    def _build_job(self, job_id: str) -> None:
        with self._jobs_lock:
            job_state = self._read_job_state(job_id)
            if job_state is None:
                return
            chunk_ids = job_state.get("chunkIds")
            if (
                not isinstance(chunk_ids, list)
                or not 1 <= len(chunk_ids) <= MAX_AREA_CHUNKS
                or any(not isinstance(chunk_id, str) or chunk_id not in self.regions_by_id for chunk_id in chunk_ids)
                or sorted(set(chunk_ids)) != chunk_ids
                or self._job_id(chunk_ids) != job_id
            ):
                job_state["status"] = "failed"
                job_state["error"] = "Terrain data could not be prepared. Try again later."
                self._write_job_state(job_state)
                return
            job_state["status"] = "building"
            job_state["error"] = None
            self._write_job_state(job_state)
            regions = [self.regions_by_id[chunk_id] for chunk_id in chunk_ids]

        try:
            if self.dataset_directory is None or self.signing_key_path is None:
                raise ValueError("terrain area worker is missing its data or signing key")
            publication = build_terrain_area_release(
                regions=regions,
                source_release_id=str(self.region_config["releaseId"]),
                dataset_directory=self.dataset_directory,
                distribution_directory=self.distribution_directory,
                signing_key_path=self.signing_key_path,
                signature_key_id=self.signature_key_id,
                on_chunk_ready=lambda completed: self._record_chunk_progress(job_id, completed),
            )
            catalog, catalog_signature = self._read_published_catalog(str(publication["catalogDigest"]))
        except Exception as error:
            logger.exception("Terrain area build %s failed", job_id)
            with self._jobs_lock:
                job_state = self._jobs[job_id]
                job_state["status"] = "failed"
                job_state["error"] = "Terrain data could not be prepared. Try again later."
                self._write_job_state(job_state)
            return

        with self._jobs_lock:
            job_state = self._jobs[job_id]
            job_state["status"] = "completed"
            job_state["completedChunks"] = job_state["totalChunks"]
            job_state["catalogDigest"] = publication["catalogDigest"]
            job_state["releaseId"] = publication["releaseId"]
            job_state["catalog"] = catalog
            job_state["catalogSignatureBase64"] = catalog_signature
            self._write_job_state(job_state)

    def _record_chunk_progress(self, job_id: str, completed_chunks: int) -> None:
        with self._jobs_lock:
            job_state = self._jobs[job_id]
            job_state["completedChunks"] = completed_chunks
            self._write_job_state(job_state)

    def _public_job_state(self, job_state: dict[str, Any]) -> dict[str, Any]:
        if job_state["status"] == "completed":
            catalog, catalog_signature = self._read_published_catalog(job_state["catalogDigest"])
            if (
                catalog != job_state["catalog"]
                or catalog_signature != job_state["catalogSignatureBase64"]
                or catalog.get("releaseId") != job_state["releaseId"]
                or catalog.get("signatureKeyId") != self.signature_key_id
            ):
                raise ValueError("completed terrain area job does not match its signed catalog")
        public_state = {
            key: job_state[key]
            for key in (
                "jobId", "status", "completedChunks", "totalChunks", "releaseId", "error",
                "catalog", "catalogSignatureBase64", "catalogDigest",
            )
        }
        return public_state

    def _read_job_state(self, job_id: str) -> dict[str, Any] | None:
        job_path = self.jobs_directory / f"{job_id}.json"
        if job_path.is_symlink() or not job_path.is_file():
            return None
        try:
            if job_path.stat().st_size > 4 * 1024 * 1024:
                return None
            job_state = json.loads(job_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not self._is_valid_job_state(job_id, job_state):
            return None
        self._jobs[job_id] = job_state
        return job_state

    def _is_valid_job_state(self, job_id: str, job_state: object) -> bool:
        if not isinstance(job_state, dict) or job_state.get("jobId") != job_id:
            return False
        chunk_ids = job_state.get("chunkIds")
        status = job_state.get("status")
        completed_chunks = job_state.get("completedChunks")
        total_chunks = job_state.get("totalChunks")
        if (
            not isinstance(status, str)
            or status not in {"queued", "building", "completed", "failed"}
            or not isinstance(chunk_ids, list)
            or not 1 <= len(chunk_ids) <= MAX_AREA_CHUNKS
            or any(not isinstance(chunk_id, str) or chunk_id not in self.regions_by_id for chunk_id in chunk_ids)
            or sorted(set(chunk_ids)) != chunk_ids
            or self._job_id(chunk_ids) != job_id
            or type(completed_chunks) is not int
            or type(total_chunks) is not int
            or total_chunks != len(chunk_ids)
            or not 0 <= completed_chunks <= total_chunks
            or not (job_state.get("releaseId") is None or isinstance(job_state.get("releaseId"), str))
            or not (job_state.get("error") is None or isinstance(job_state.get("error"), str))
            or not (job_state.get("catalog") is None or isinstance(job_state.get("catalog"), dict))
            or not (
                job_state.get("catalogSignatureBase64") is None
                or isinstance(job_state.get("catalogSignatureBase64"), str)
            )
            or not (
                job_state.get("catalogDigest") is None
                or isinstance(job_state.get("catalogDigest"), str)
                and re.fullmatch(r"[0-9a-f]{64}", job_state["catalogDigest"]) is not None
            )
        ):
            return False
        if status == "completed":
            try:
                signature = base64.b64decode(job_state["catalogSignatureBase64"], validate=True)
            except (KeyError, ValueError, TypeError):
                return False
            return (
                job_state["releaseId"] is not None
                and isinstance(job_state["catalog"], dict)
                and len(signature) == 64
                and job_state["catalogDigest"] is not None
                and completed_chunks == total_chunks
            )
        return True

    def _next_queued_job(self) -> str | None:
        with self._jobs_lock:
            for job_path in sorted(self.jobs_directory.glob("area-*.json")):
                if job_path.is_symlink() or not job_path.is_file():
                    continue
                job_id = job_path.stem
                job_state = self._read_job_state(job_id)
                if job_state is not None and job_state.get("status") == "queued":
                    return job_id
        return None

    def _queued_job_count(self) -> int:
        queued_count = 0
        for job_path in self.jobs_directory.glob("area-*.json"):
            if job_path.is_symlink() or not job_path.is_file():
                continue
            job_state = self._read_job_state(job_path.stem)
            if job_state is not None and job_state.get("status") == "queued":
                queued_count += 1
        return queued_count

    def _read_published_catalog(self, catalog_digest: str) -> tuple[dict[str, Any], str]:
        if not re.fullmatch(r"[0-9a-f]{64}", catalog_digest):
            raise ValueError("area catalog has an invalid digest")
        catalog_directory = self.distribution_directory / "catalogs" / catalog_digest
        _require_real_directory(catalog_directory, "terrain area catalog")
        catalog_bytes = (catalog_directory / "catalog.json").read_bytes()
        signature_bytes = (catalog_directory / "catalog.ed25519").read_bytes()
        if hashlib.sha256(catalog_bytes + signature_bytes).hexdigest() != catalog_digest:
            raise ValueError("area catalog digest does not match its contents")
        verified_catalog = TerrainPackDistribution(
            self.distribution_directory,
            self.trusted_signing_keys,
        )._verify_catalog(catalog_bytes, signature_bytes, catalog_digest)
        return verified_catalog.catalog, base64.b64encode(signature_bytes).decode("ascii")

    def _job_id(self, chunk_ids: list[str]) -> str:
        release_identity = {
            "chunkIds": chunk_ids,
            "releaseId": self.region_config["releaseId"],
            "signatureKeyId": self.signature_key_id,
        }
        release_hash = hashlib.sha256(_canonical_json(release_identity)).hexdigest()[:32]
        return f"area-{release_hash}"

    def _write_job_state(self, job_state: dict[str, Any]) -> None:
        job_path = self.jobs_directory / f"{job_state['jobId']}.json"
        file_descriptor, temporary_path_value = tempfile.mkstemp(
            prefix=f".{job_state['jobId']}-",
            suffix=".tmp",
            dir=self.jobs_directory,
        )
        temporary_path = Path(temporary_path_value)
        try:
            os.fchmod(file_descriptor, 0o660)
            with os.fdopen(file_descriptor, "wb") as job_file:
                job_file.write(_canonical_json(job_state))
                job_file.flush()
                os.fsync(job_file.fileno())
            os.replace(temporary_path, job_path)
            _sync_directory(self.jobs_directory)
        except Exception:
            temporary_path.unlink(missing_ok=True)
            raise

    def _recover_jobs(self, requeue: bool) -> None:
        for job_path in sorted(self.jobs_directory.glob("area-*.json")):
            if job_path.is_symlink() or not job_path.is_file():
                continue
            try:
                if job_path.stat().st_size > 4 * 1024 * 1024:
                    continue
                job_state = json.loads(job_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(job_state, dict):
                continue
            job_id = job_state.get("jobId")
            if not isinstance(job_id, str) or not _AREA_JOB_PATTERN.fullmatch(job_id):
                continue
            if not self._is_valid_job_state(job_id, job_state):
                continue
            self._jobs[job_id] = job_state
            if job_state.get("status") in {"queued", "building"}:
                if requeue:
                    job_state["status"] = "queued"
                    self._write_job_state(job_state)
                    self._build_queue.put(job_id)

    @staticmethod
    def _load_region_config(config_path: Path) -> dict[str, Any]:
        config = json.loads(config_path.read_text(encoding="utf-8"))
        release_id = config.get("releaseId")
        signature_key_id = config.get("signatureKeyId")
        regions = config.get("regions")
        if (
            not isinstance(release_id, str)
            or not _IDENTIFIER_PATTERN.fullmatch(release_id)
            or not isinstance(signature_key_id, str)
            or not isinstance(regions, list)
            or not regions
        ):
            raise ValueError("terrain region config is invalid")
        for region in regions:
            if (
                not isinstance(region, dict)
                or not isinstance(region.get("chunkId"), str)
                or not _IDENTIFIER_PATTERN.fullmatch(region["chunkId"])
                or not isinstance(region.get("packId"), str)
                or not _IDENTIFIER_PATTERN.fullmatch(region["packId"])
            ):
                raise ValueError("terrain region config contains an invalid region")
            bounds = region.get("bounds")
            if not isinstance(bounds, list) or len(bounds) != 4:
                raise ValueError("terrain region config contains invalid WGS84 bounds")
            _validate_area_chunk_identity(
                region["chunkId"],
                region["packId"],
                tuple(float(value) for value in bounds),
            )
        return config


def select_terrain_regions(
    configured_regions: Sequence[dict[str, Any]],
    requested_bounds: Sequence[tuple[float, float, float, float]],
) -> list[dict[str, Any]]:
    selected_regions: dict[str, dict[str, Any]] = {}
    for region in configured_regions:
        west, south, east, north = (float(value) for value in region["bounds"])
        if any(
            west < area_east and east > area_west and south < area_north and north > area_south
            for area_west, area_south, area_east, area_north in requested_bounds
        ):
            selected_regions[str(region["chunkId"])] = region
    return [selected_regions[chunk_id] for chunk_id in sorted(selected_regions)]


def build_terrain_area_release(
    regions: Sequence[dict[str, Any]],
    source_release_id: str,
    dataset_directory: Path,
    distribution_directory: Path,
    signing_key_path: Path,
    signature_key_id: str,
    on_chunk_ready: Callable[[int], None] | None = None,
) -> dict[str, object]:
    if not regions or len(regions) > MAX_AREA_CHUNKS:
        raise TerrainAreaLimitError("terrain area has an unsupported number of chunks")
    validate_signature_key_id(signature_key_id)
    distribution_path = distribution_directory.absolute()
    distribution_path.mkdir(parents=True, exist_ok=True)
    lock_path = distribution_path / ".area-build.lock"
    with lock_path.open("a+b") as build_lock:
        fcntl.flock(build_lock.fileno(), fcntl.LOCK_EX)
        return _build_terrain_area_release_locked(
            regions,
            source_release_id,
            dataset_directory,
            distribution_path,
            signing_key_path,
            signature_key_id,
            on_chunk_ready,
        )


def _build_terrain_area_release_locked(
    regions: Sequence[dict[str, Any]],
    source_release_id: str,
    dataset_directory: Path,
    distribution_path: Path,
    signing_key_path: Path,
    signature_key_id: str,
    on_chunk_ready: Callable[[int], None] | None,
) -> dict[str, object]:
    signing_key = _load_signing_key(signing_key_path)
    public_key = signing_key.public_key().public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    )
    trusted_keys = {signature_key_id: public_key}
    terrain_store = RasterElevationStore(dataset_directory)
    try:
        dataset_version = terrain_store.source.dataset_version
    finally:
        terrain_store.close()

    cache_version = hashlib.sha256(
        f"{source_release_id}:{dataset_version}".encode("utf-8")
    ).hexdigest()[:16]
    chunk_cache_root = distribution_path / ".chunk-cache" / cache_version / signature_key_id
    chunk_cache_root.mkdir(parents=True, exist_ok=True)
    _require_real_directory(chunk_cache_root, "terrain chunk cache")
    checked_cache: dict[str, Path] = {}
    regions_to_build: list[tuple[dict[str, Any], Path, str, tuple[float, float, float, float]]] = []

    for region in regions:
        chunk_id = str(region["chunkId"])
        pack_id = str(region["packId"])
        bounds = tuple(float(value) for value in region["bounds"])
        _validate_area_chunk_identity(chunk_id, pack_id, bounds)
        cache_directory = chunk_cache_root / chunk_id
        if cache_directory.exists() or cache_directory.is_symlink():
            _verify_area_chunk(cache_directory, pack_id, bounds, dataset_version, trusted_keys)
            checked_cache[chunk_id] = cache_directory
        else:
            check_disk_headroom(distribution_path, MINIMUM_HEADROOM_BYTES)
            regions_to_build.append((region, cache_directory, pack_id, bounds))

    completed_count = len(checked_cache)
    if completed_count and on_chunk_ready is not None:
        on_chunk_ready(completed_count)

    worker_local = threading.local()
    worker_store_lock = threading.Lock()
    worker_stores: list[RasterElevationStore] = []

    def initialize_chunk_worker() -> None:
        worker_store = RasterElevationStore(dataset_directory)
        worker_local.terrain_store = worker_store
        with worker_store_lock:
            worker_stores.append(worker_store)

    def build_chunk(
        region: dict[str, Any],
        cache_directory: Path,
        pack_id: str,
        bounds: tuple[float, float, float, float],
    ) -> str:
        _build_cached_area_chunk(
            worker_local.terrain_store,
            cache_directory,
            pack_id,
            bounds,
            signing_key_path,
            signature_key_id,
            trusted_keys,
            dataset_version,
        )
        return str(region["chunkId"])

    try:
        if regions_to_build:
            with ThreadPoolExecutor(
                max_workers=min(MAX_PARALLEL_AREA_CHUNK_BUILDS, len(regions_to_build)),
                initializer=initialize_chunk_worker,
                thread_name_prefix="cyclecomp-terrain-chunk",
            ) as executor:
                futures = {
                    executor.submit(build_chunk, region, cache_directory, pack_id, bounds): (
                        str(region["chunkId"]),
                        cache_directory,
                    )
                    for region, cache_directory, pack_id, bounds in regions_to_build
                }
                for future in as_completed(futures):
                    chunk_id = future.result()
                    _, cache_directory = futures[future]
                    checked_cache[chunk_id] = cache_directory
                    completed_count += 1
                    if on_chunk_ready is not None:
                        on_chunk_ready(completed_count)
    finally:
        for worker_store in worker_stores:
            worker_store.close()

    release_id = _area_release_id(source_release_id, signature_key_id, dataset_version, regions)
    release_directory = distribution_path / "releases" / release_id
    release_directory.parent.mkdir(parents=True, exist_ok=True)
    _require_real_directory(release_directory.parent, "terrain releases directory")
    expected_chunk_ids = {str(region["chunkId"]) for region in regions}
    if release_directory.exists() or release_directory.is_symlink():
        _verify_area_release(release_directory, regions, dataset_version, trusted_keys)
    else:
        _publish_hardlinked_area_release(
            release_directory,
            checked_cache,
            expected_chunk_ids,
            distribution_path,
        )

    publication = publish_signed_terrain_catalog(
        distribution_path,
        release_id,
        signing_key_path,
        signature_key_id,
        update_current=False,
    )
    return publication


def _build_cached_area_chunk(
    terrain_store: RasterElevationStore,
    cache_directory: Path,
    pack_id: str,
    bounds: tuple[float, float, float, float],
    signing_key_path: Path,
    signature_key_id: str,
    trusted_keys: dict[str, bytes],
    dataset_version: str,
) -> None:
    cache_parent = cache_directory.parent
    staging_directory = Path(tempfile.mkdtemp(prefix=f".staging-{cache_directory.name}-", dir=cache_parent))
    package_directory = staging_directory / cache_directory.name
    try:
        build_elevation_grid_pack(terrain_store, package_directory, pack_id, bounds)
        sign_elevation_grid_pack(package_directory, signing_key_path, signature_key_id)
        _verify_area_chunk(package_directory, pack_id, bounds, dataset_version, trusted_keys)
        for package_file in package_directory.iterdir():
            if not package_file.is_file() or package_file.is_symlink():
                raise ValueError("terrain area package contains an unsupported file")
            package_file.chmod(0o444)
        os.replace(package_directory, cache_directory)
        cache_directory.chmod(0o555)
        staging_directory.rmdir()
        _sync_directory(cache_parent)
    except Exception:
        shutil.rmtree(staging_directory, ignore_errors=True)
        raise


def _verify_area_chunk(
    package_directory: Path,
    pack_id: str,
    bounds: tuple[float, float, float, float],
    dataset_version: str,
    trusted_keys: dict[str, bytes],
) -> None:
    _require_real_directory(package_directory, "terrain cached package")
    verified_pack = verify_signed_terrain_pack(package_directory, trusted_keys)
    manifest = verified_pack.manifest
    if (
        manifest.get("packId") != pack_id
        or manifest.get("requestedBoundsWgs84") != list(bounds)
        or manifest.get("datasetVersion") != dataset_version
    ):
        raise ValueError(f"cached terrain chunk {package_directory.name} does not match its source region")


def _publish_hardlinked_area_release(
    release_directory: Path,
    cached_chunks: dict[str, Path],
    expected_chunk_ids: set[str],
    distribution_directory: Path,
) -> None:
    staging_parent = distribution_directory / ".area-staging"
    staging_parent.mkdir(exist_ok=True)
    _require_real_directory(staging_parent, "terrain area staging directory")
    staging_release = Path(tempfile.mkdtemp(prefix=f".staging-{release_directory.name}-", dir=staging_parent))
    try:
        for chunk_id in sorted(expected_chunk_ids):
            cached_directory = cached_chunks[chunk_id]
            release_chunk = staging_release / chunk_id
            release_chunk.mkdir()
            for filename in ("manifest.json", "manifest.ed25519", "terrain.sqlite"):
                os.link(cached_directory / filename, release_chunk / filename, follow_symlinks=False)
            release_chunk.chmod(0o555)
        releases_directory = release_directory.parent
        os.replace(staging_release, release_directory)
        release_directory.chmod(0o555)
        _sync_directory(releases_directory)
    except Exception:
        staging_release.chmod(0o755)
        shutil.rmtree(staging_release, ignore_errors=True)
        raise


def _verify_area_release(
    release_directory: Path,
    regions: Sequence[dict[str, Any]],
    dataset_version: str,
    trusted_keys: dict[str, bytes],
) -> None:
    _require_real_directory(release_directory, "terrain area release")
    expected_regions = {str(region["chunkId"]): region for region in regions}
    if {entry.name for entry in release_directory.iterdir()} != set(expected_regions):
        raise ValueError("existing terrain area release is immutable and has a different chunk set")
    for chunk_id, region in expected_regions.items():
        _verify_area_chunk(
            release_directory / chunk_id,
            str(region["packId"]),
            tuple(float(value) for value in region["bounds"]),
            dataset_version,
            trusted_keys,
        )


def _validate_area_chunk_identity(
    chunk_id: str,
    pack_id: str,
    bounds: tuple[float, float, float, float],
) -> None:
    if not _IDENTIFIER_PATTERN.fullmatch(chunk_id) or not _IDENTIFIER_PATTERN.fullmatch(pack_id):
        raise ValueError("terrain area config contains an invalid chunk identifier")
    west, south, east, north = bounds
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise ValueError("terrain area config contains invalid WGS84 bounds")


def _area_release_id(
    source_release_id: str,
    signature_key_id: str,
    dataset_version: str,
    regions: Sequence[dict[str, Any]],
) -> str:
    identity = {
        "chunkIds": sorted(str(region["chunkId"]) for region in regions),
        "datasetVersion": dataset_version,
        "signatureKeyId": signature_key_id,
        "sourceReleaseId": source_release_id,
    }
    return f"area-{hashlib.sha256(_canonical_json(identity)).hexdigest()[:32]}"


def _canonical_json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
