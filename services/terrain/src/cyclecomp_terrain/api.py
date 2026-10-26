from __future__ import annotations

import base64
from collections.abc import Iterator
from contextlib import asynccontextmanager
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import stat
import threading
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from starlette.responses import StreamingResponse

from cyclecomp_terrain.distribution import (
    PublishedTerrainPack,
    TerrainCatalogError,
    TerrainPackDistribution,
    VerifiedTerrainCatalog,
)
from cyclecomp_terrain.raster_elevation import (
    ElevationReason,
    RasterElevationStore,
    TerrainDatasetError,
)
from cyclecomp_terrain.terrain_area_build import (
    TerrainAreaBuildManager,
    TerrainAreaLimitError,
    TerrainAreaQueueFullError,
    TerrainAreaRequestError,
)


MAX_BATCH_COORDINATES = 2_000
MAX_REQUEST_BODY_BYTES = 256 * 1024
MAX_CONCURRENT_BATCHES = 2
MAX_PUBLISHED_DATABASE_BYTES = 256 * 1024 * 1024
_BYTE_RANGE_PATTERN = re.compile(r"bytes=(\d*)-(\d*)$")
logger = logging.getLogger(__name__)


class ElevationCoordinate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    longitude: float = Field(ge=-180, le=180, allow_inf_nan=False)
    latitude: float = Field(ge=-90, le=90, allow_inf_nan=False)

    @field_validator("longitude", "latitude", mode="before")
    @classmethod
    def require_json_number(cls, coordinate: object) -> object:
        if isinstance(coordinate, bool) or not isinstance(coordinate, (int, float)):
            raise ValueError("coordinates must be JSON numbers")
        return coordinate


class ElevationBatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    coordinates: list[ElevationCoordinate] = Field(min_length=1, max_length=MAX_BATCH_COORDINATES)


class TerrainAreaBounds(BaseModel):
    model_config = ConfigDict(extra="forbid")

    west: float = Field(ge=-180, le=180, allow_inf_nan=False)
    south: float = Field(ge=-90, le=90, allow_inf_nan=False)
    east: float = Field(ge=-180, le=180, allow_inf_nan=False)
    north: float = Field(ge=-90, le=90, allow_inf_nan=False)

    @field_validator("west", "south", "east", "north", mode="before")
    @classmethod
    def require_json_number(cls, coordinate: object) -> object:
        if isinstance(coordinate, bool) or not isinstance(coordinate, (int, float)):
            raise ValueError("bounds coordinates must be JSON numbers")
        return coordinate

    @model_validator(mode="after")
    def require_ordered_bounds(self) -> TerrainAreaBounds:
        if self.west >= self.east or self.south >= self.north:
            raise ValueError("bounds must have west < east and south < north")
        return self


class TerrainAreaRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    areas: list[TerrainAreaBounds] = Field(min_length=1, max_length=16)


class ElevationSampleResponse(BaseModel):
    index: int
    elevationMeters: float | None
    reason: ElevationReason | None


class ElevationBatchResponse(BaseModel):
    requestId: str
    datasetVersion: str
    source: str
    sourceRelease: str
    sourceResolutionMeters: float
    verticalDatum: str
    samples: list[ElevationSampleResponse]


class RequestBodyLimitMiddleware:
    def __init__(self, app, maximum_body_bytes: int) -> None:
        self.app = app
        self.maximum_body_bytes = maximum_body_bytes

    async def __call__(self, scope, receive, send) -> None:
        if (
            scope["type"] != "http"
            or scope.get("method") != "POST"
            or scope.get("path") not in {"/v1/elevation/batch", "/v1/terrain/areas"}
        ):
            await self.app(scope, receive, send)
            return

        content_length = next(
            (value for name, value in scope.get("headers", []) if name.lower() == b"content-length"),
            None,
        )
        if content_length is not None:
            try:
                if int(content_length) > self.maximum_body_bytes:
                    await self._send_too_large(send)
                    return
            except ValueError:
                await self._send_too_large(send)
                return

        request_body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            request_body.extend(message.get("body", b""))
            if len(request_body) > self.maximum_body_bytes:
                await self._send_too_large(send)
                return
            if not message.get("more_body", False):
                break

        body_was_sent = False

        async def replay_body():
            nonlocal body_was_sent
            if body_was_sent:
                return {"type": "http.request", "body": b"", "more_body": False}
            body_was_sent = True
            return {"type": "http.request", "body": bytes(request_body), "more_body": False}

        await self.app(scope, replay_body, send)

    async def _send_too_large(self, send) -> None:
        response_body = json.dumps({"detail": "Request body exceeds the configured limit."}).encode("utf-8")
        response_headers = [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(response_body)).encode("ascii")),
        ]
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": response_headers,
            }
        )
        await send({"type": "http.response.body", "body": response_body})


def create_app(
    dataset_directory: Path | None = None,
    terrain_store: RasterElevationStore | None = None,
    maximum_concurrent_batches: int = MAX_CONCURRENT_BATCHES,
    maximum_body_bytes: int = MAX_REQUEST_BODY_BYTES,
    distribution_directory: Path | None = None,
    trusted_signing_keys: dict[str, bytes] | None = None,
) -> FastAPI:
    if maximum_concurrent_batches < 1:
        raise ValueError("maximum_concurrent_batches must be positive")
    if maximum_body_bytes < 1:
        raise ValueError("maximum_body_bytes must be positive")

    configured_directory = dataset_directory or Path(
        os.environ.get("CYCLECOMP_TERRAIN_DATASET_DIR", "/var/lib/cyclecomp/terrain/current")
    )
    configured_distribution = distribution_directory or (
        Path(os.environ["CYCLECOMP_TERRAIN_DISTRIBUTION_DIR"])
        if os.environ.get("CYCLECOMP_TERRAIN_DISTRIBUTION_DIR")
        else None
    )
    configured_signing_keys = (
        trusted_signing_keys if trusted_signing_keys is not None else _configured_signing_keys()
    )
    configured_area_region_config = _configured_path("CYCLECOMP_TERRAIN_AREA_REGION_CONFIG")
    configured_area_jobs = _configured_path("CYCLECOMP_TERRAIN_AREA_JOBS_DIR")
    configured_area_signing_key_id = os.environ.get("CYCLECOMP_TERRAIN_AREA_SIGNING_KEY_ID")
    owns_terrain_store = terrain_store is None
    batch_slots = threading.BoundedSemaphore(maximum_concurrent_batches)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.terrain_store = terrain_store
        app.state.terrain_distribution = (
            TerrainPackDistribution(configured_distribution, configured_signing_keys)
            if configured_distribution is not None and configured_signing_keys
            else None
        )
        app.state.terrain_area_build_manager = None
        if (
            configured_distribution is not None
            and configured_area_region_config is not None
            and configured_area_jobs is not None
            and configured_signing_keys
        ):
            try:
                app.state.terrain_area_build_manager = TerrainAreaBuildManager(
                    configured_area_region_config,
                    configured_distribution,
                    configured_area_jobs,
                    configured_signing_keys,
                    signature_key_id=configured_area_signing_key_id,
                )
            except (OSError, ValueError):
                logger.exception("On-demand terrain area preparation is unavailable")
        if app.state.terrain_store is None:
            try:
                app.state.terrain_store = RasterElevationStore(configured_directory)
            except (TerrainDatasetError, OSError):
                app.state.terrain_store = None
        try:
            yield
        finally:
            area_build_manager = app.state.terrain_area_build_manager
            if area_build_manager is not None:
                area_build_manager.close()
            if owns_terrain_store and app.state.terrain_store is not None:
                app.state.terrain_store.close()

    app = FastAPI(title="CycleComp Terrain Service", version="1", lifespan=lifespan)
    app.add_middleware(RequestBodyLimitMiddleware, maximum_body_bytes=maximum_body_bytes)

    @app.get("/healthz")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz")
    def readiness(request: Request) -> dict[str, str]:
        store = request.app.state.terrain_store
        if store is None or not store.is_ready:
            raise HTTPException(status_code=503, detail="Terrain dataset is not ready.")
        return {"status": "ready", "datasetVersion": store.source.dataset_version}

    @app.get("/v1/terrain/catalog.json")
    def terrain_catalog(request: Request) -> Response:
        distribution = _terrain_distribution(request)
        catalog = _current_catalog(distribution)
        etag = f'"{catalog.etag}"'
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "public, max-age=60"})
        return Response(
            content=catalog.catalog_bytes,
            media_type="application/json",
            headers={
                "ETag": etag,
                "Cache-Control": "public, max-age=60",
                "X-Content-Type-Options": "nosniff",
            },
        )

    @app.get("/v1/terrain/catalog.ed25519")
    def terrain_catalog_signature(request: Request) -> Response:
        catalog = _current_catalog(_terrain_distribution(request))
        return Response(
            content=catalog.signature_bytes,
            media_type="application/octet-stream",
            headers={
                "ETag": f'"{hashlib.sha256(catalog.signature_bytes).hexdigest()}"',
                "Cache-Control": "public, max-age=60",
                "X-Content-Type-Options": "nosniff",
            },
        )

    @app.post("/v1/terrain/areas")
    def prepare_terrain_areas(area_request: TerrainAreaRequest, request: Request) -> Response:
        build_manager: TerrainAreaBuildManager | None = request.app.state.terrain_area_build_manager
        if build_manager is None:
            raise HTTPException(status_code=503, detail="On-demand terrain preparation is not configured.")
        try:
            job = build_manager.submit([
                (area.west, area.south, area.east, area.north)
                for area in area_request.areas
            ])
        except TerrainAreaQueueFullError as error:
            raise HTTPException(
                status_code=503,
                detail=str(error),
                headers={"Retry-After": "10"},
            ) from None
        except TerrainAreaLimitError as error:
            raise HTTPException(status_code=413, detail=str(error)) from None
        except TerrainAreaRequestError as error:
            raise HTTPException(status_code=422, detail=str(error)) from None
        except (OSError, ValueError):
            logger.exception("On-demand terrain job could not be read safely")
            raise HTTPException(status_code=503, detail="Terrain area job is temporarily unavailable.") from None
        return Response(
            content=json.dumps(job, separators=(",", ":")),
            status_code=200 if job["status"] == "completed" else 202,
            media_type="application/json",
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        )

    @app.get("/v1/terrain/areas/{job_id}")
    def terrain_area_job(job_id: str, request: Request) -> dict[str, object]:
        build_manager: TerrainAreaBuildManager | None = request.app.state.terrain_area_build_manager
        if build_manager is None:
            raise HTTPException(status_code=503, detail="On-demand terrain preparation is not configured.")
        try:
            job = build_manager.get(job_id)
        except (OSError, ValueError):
            logger.exception("On-demand terrain job failed its publication check")
            raise HTTPException(status_code=503, detail="Terrain area job is temporarily unavailable.") from None
        if job is None:
            raise HTTPException(status_code=404, detail="Terrain area build job was not found.")
        return job

    @app.get("/v1/terrain/releases/{release_id}/{chunk_id}/manifest.json")
    def terrain_pack_manifest(release_id: str, chunk_id: str, request: Request) -> Response:
        published_pack = _published_pack(request, release_id, chunk_id)
        manifest = published_pack.verified_pack
        return Response(
            content=manifest.manifest_bytes,
            media_type="application/json",
            headers={
                "ETag": f'"{manifest.manifest_sha256}"',
                "Cache-Control": "public, max-age=31536000, immutable",
                "X-Content-Type-Options": "nosniff",
            },
        )

    @app.get("/v1/terrain/releases/{release_id}/{chunk_id}/manifest.ed25519")
    def terrain_pack_signature(release_id: str, chunk_id: str, request: Request) -> Response:
        published_pack = _published_pack(request, release_id, chunk_id)
        signature_bytes = published_pack.verified_pack.signature_bytes
        return Response(
            content=signature_bytes,
            media_type="application/octet-stream",
            headers={
                "ETag": f'"{hashlib.sha256(signature_bytes).hexdigest()}"',
                "Cache-Control": "public, max-age=31536000, immutable",
                "X-Content-Type-Options": "nosniff",
            },
        )

    @app.get("/v1/terrain/releases/{release_id}/{chunk_id}/{content_hash}.sqlite")
    def terrain_pack_database(
        release_id: str,
        chunk_id: str,
        content_hash: str,
        request: Request,
    ) -> Response:
        published_pack = _published_pack(request, release_id, chunk_id)
        manifest = published_pack.verified_pack.manifest
        database_record = manifest["files"][0]
        expected_hash = database_record["sha256"]
        expected_size = database_record["sizeBytes"]
        if content_hash != expected_hash:
            raise HTTPException(status_code=404, detail="Terrain artifact not found.")

        try:
            file_descriptor = os.open(published_pack.database_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        except OSError:
            raise HTTPException(status_code=503, detail="Terrain artifact is temporarily unavailable.") from None

        file_status = os.fstat(file_descriptor)
        if (
            not stat.S_ISREG(file_status.st_mode)
            or file_status.st_size != expected_size
            or file_status.st_size > MAX_PUBLISHED_DATABASE_BYTES
        ):
            os.close(file_descriptor)
            raise HTTPException(status_code=503, detail="Terrain artifact failed its published size check.")

        range_header = request.headers.get("range")
        byte_range = _parse_byte_range(range_header, file_status.st_size) if range_header else None
        if range_header and byte_range is None:
            os.close(file_descriptor)
            return Response(
                status_code=416,
                headers={"Content-Range": f"bytes */{file_status.st_size}", "Accept-Ranges": "bytes"},
            )

        if byte_range is None:
            start_byte, end_byte = 0, file_status.st_size - 1
            status_code = 200
        else:
            start_byte, end_byte = byte_range
            status_code = 206

        response_headers = {
            "Accept-Ranges": "bytes",
            "Content-Length": str(end_byte - start_byte + 1),
            "Content-Type": "application/vnd.sqlite3",
            "Content-Disposition": (
                f'attachment; filename="{manifest["packId"]}.sqlite'
            ),
            "ETag": f'"{expected_hash}"',
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
        }
        if byte_range is not None:
            response_headers["Content-Range"] = f"bytes {start_byte}-{end_byte}/{file_status.st_size}"

        return StreamingResponse(
            _file_descriptor_chunks(file_descriptor, start_byte, end_byte),
            status_code=status_code,
            headers=response_headers,
        )

    @app.post("/v1/elevation/batch", response_model=ElevationBatchResponse)
    def elevation_batch(batch: ElevationBatchRequest, request: Request) -> ElevationBatchResponse:
        store: RasterElevationStore | None = request.app.state.terrain_store
        if store is None:
            raise HTTPException(status_code=503, detail="Terrain dataset is not ready.")
        if not batch_slots.acquire(blocking=False):
            raise HTTPException(
                status_code=503,
                detail="Terrain lookup is at capacity.",
                headers={"Retry-After": "1"},
            )

        try:
            samples = store.sample_batch(
                [(coordinate.longitude, coordinate.latitude) for coordinate in batch.coordinates]
            )
        except (TerrainDatasetError, OSError):
            raise HTTPException(status_code=503, detail="Terrain data is temporarily unavailable.") from None
        finally:
            batch_slots.release()

        return ElevationBatchResponse(
            requestId=str(uuid4()),
            datasetVersion=store.source.dataset_version,
            source=store.source.name,
            sourceRelease=store.source.source_release,
            sourceResolutionMeters=store.source.source_resolution_meters,
            verticalDatum=store.source.vertical_datum,
            samples=[
                ElevationSampleResponse(
                    index=sample_index,
                    elevationMeters=sample.elevation_meters,
                    reason=sample.reason,
                )
                for sample_index, sample in enumerate(samples)
            ],
        )

    return app


def _configured_path(environment_name: str) -> Path | None:
    configured_value = os.environ.get(environment_name)
    return Path(configured_value) if configured_value else None


def _configured_signing_keys() -> dict[str, bytes]:
    encoded_keys_json = os.environ.get("CYCLECOMP_TERRAIN_TRUSTED_SIGNING_KEYS")
    if not encoded_keys_json:
        return {}
    try:
        encoded_keys = json.loads(encoded_keys_json)
        if not isinstance(encoded_keys, dict):
            return {}
        return {
            key_id: base64.b64decode(encoded_key, validate=True)
            for key_id, encoded_key in encoded_keys.items()
            if isinstance(key_id, str) and isinstance(encoded_key, str)
        }
    except (ValueError, TypeError, json.JSONDecodeError):
        return {}


def _terrain_distribution(request: Request) -> TerrainPackDistribution:
    distribution = request.app.state.terrain_distribution
    if distribution is None:
        raise HTTPException(status_code=503, detail="Terrain distribution is not configured.")
    return distribution


def _current_catalog(distribution: TerrainPackDistribution) -> VerifiedTerrainCatalog:
    try:
        return distribution.current_catalog()
    except TerrainCatalogError:
        raise HTTPException(status_code=503, detail="Terrain catalog is unavailable or failed verification.") from None


def _published_pack(request: Request, release_id: str, chunk_id: str) -> PublishedTerrainPack:
    distribution = _terrain_distribution(request)
    try:
        return distribution.pack(release_id, chunk_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Terrain pack not found.") from None
    except TerrainCatalogError:
        raise HTTPException(status_code=503, detail="Terrain catalog is unavailable or failed verification.") from None


def _parse_byte_range(range_header: str, file_size: int) -> tuple[int, int] | None:
    match = _BYTE_RANGE_PATTERN.fullmatch(range_header)
    if match is None or file_size <= 0:
        return None
    first_value, last_value = match.groups()
    if not first_value and not last_value:
        return None

    if not first_value:
        suffix_length = int(last_value)
        if suffix_length <= 0:
            return None
        return max(0, file_size - suffix_length), file_size - 1

    start_byte = int(first_value)
    end_byte = int(last_value) if last_value else file_size - 1
    if start_byte >= file_size or end_byte < start_byte:
        return None
    return start_byte, min(end_byte, file_size - 1)


def _file_descriptor_chunks(
    file_descriptor: int,
    start_byte: int,
    end_byte: int,
) -> Iterator[bytes]:
    remaining_bytes = end_byte - start_byte + 1
    with os.fdopen(file_descriptor, "rb") as artifact_file:
        artifact_file.seek(start_byte)
        while remaining_bytes > 0:
            chunk_bytes = artifact_file.read(min(1024 * 1024, remaining_bytes))
            if not chunk_bytes:
                break
            remaining_bytes -= len(chunk_bytes)
            yield chunk_bytes
