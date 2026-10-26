from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import threading
from dataclasses import dataclass

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from cyclecomp_terrain.signing import VerifiedTerrainPack, verify_signed_terrain_pack


_CATALOG_SIGNATURE_NAME = "catalog.ed25519"
_CATALOG_FILE_NAME = "catalog.json"
_CATALOG_POINTER_NAME = "current.json"
_CATALOGS_DIRECTORY_NAME = "catalogs"
_MAX_CATALOG_BYTES = 4 * 1024 * 1024
_MAX_CATALOG_CHUNKS = 10_000
_IDENTIFIER_PATTERN = re.compile(r"[a-z0-9][a-z0-9._-]{0,95}")
_KEY_ID_PATTERN = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}")


@dataclass(frozen=True)
class PublishedTerrainPack:
    release_id: str
    chunk_id: str
    verified_pack: VerifiedTerrainPack
    database_path: Path


@dataclass(frozen=True)
class VerifiedTerrainCatalog:
    catalog: dict[str, object]
    catalog_bytes: bytes
    signature_bytes: bytes
    etag: str
    packs_by_route: dict[tuple[str, str], PublishedTerrainPack]


class TerrainCatalogError(ValueError):
    pass


class TerrainPackDistribution:
    def __init__(self, distribution_directory: Path, trusted_signing_keys: dict[str, bytes]) -> None:
        self.distribution_directory = distribution_directory.absolute()
        self.trusted_signing_keys = trusted_signing_keys
        self._lock = threading.RLock()
        self._verified_catalog: VerifiedTerrainCatalog | None = None
        self._historical_catalogs_by_release: dict[str, VerifiedTerrainCatalog] = {}

    def current_catalog(self) -> VerifiedTerrainCatalog:
        with self._lock:
            try:
                distribution_mode = self.distribution_directory.lstat().st_mode
            except OSError as error:
                raise TerrainCatalogError("terrain distribution is unavailable") from error
            if not stat.S_ISDIR(distribution_mode):
                raise TerrainCatalogError("terrain distribution must be a regular directory")

            pointer_bytes = self._read_regular_file(
                self.distribution_directory / _CATALOG_POINTER_NAME,
                256,
                "terrain catalog pointer",
            )
            pointer = self._decode_canonical_json(pointer_bytes, "terrain catalog pointer")
            catalog_digest = pointer.get("catalogDigest")
            if not isinstance(catalog_digest, str) or not re.fullmatch(r"[0-9a-f]{64}", catalog_digest):
                raise TerrainCatalogError("terrain catalog pointer has an invalid digest")
            catalog_directory = self.distribution_directory / _CATALOGS_DIRECTORY_NAME / catalog_digest
            for directory in (self.distribution_directory / _CATALOGS_DIRECTORY_NAME, catalog_directory):
                try:
                    directory_mode = directory.lstat().st_mode
                except OSError as error:
                    raise TerrainCatalogError("terrain catalog version is unavailable") from error
                if not stat.S_ISDIR(directory_mode):
                    raise TerrainCatalogError("terrain catalog versions cannot be symlinks")

            catalog_bytes = self._read_regular_file(
                catalog_directory / _CATALOG_FILE_NAME,
                _MAX_CATALOG_BYTES,
                "terrain catalog",
            )
            signature_bytes = self._read_regular_file(
                catalog_directory / _CATALOG_SIGNATURE_NAME,
                64,
                "terrain catalog signature",
            )
            actual_catalog_digest = hashlib.sha256(catalog_bytes + signature_bytes).hexdigest()
            if actual_catalog_digest != catalog_digest:
                raise TerrainCatalogError("terrain catalog version does not match its pointer")
            if self._verified_catalog is not None and self._verified_catalog.etag == actual_catalog_digest:
                return self._verified_catalog

            verified_catalog = self._verify_catalog(catalog_bytes, signature_bytes, actual_catalog_digest)
            self._verified_catalog = verified_catalog
            return verified_catalog

    def pack(self, release_id: str, chunk_id: str) -> PublishedTerrainPack:
        self._validate_identifier(release_id, "release ID")
        self._validate_identifier(chunk_id, "chunk ID")
        with self._lock:
            route_key = (release_id, chunk_id)
            verified_catalog = self.current_catalog()
            published_pack = verified_catalog.packs_by_route.get(route_key)
            if published_pack is not None:
                return published_pack

            historical_catalog = self._historical_catalogs_by_release.get(release_id)
            if historical_catalog is not None:
                published_pack = historical_catalog.packs_by_route.get(route_key)
                if published_pack is not None:
                    return published_pack

            # A download started with an older catalog must keep its immutable URLs after publication.
            catalogs_directory = self.distribution_directory / _CATALOGS_DIRECTORY_NAME
            for version_directory in catalogs_directory.iterdir():
                if not re.fullmatch(r"[0-9a-f]{64}", version_directory.name):
                    continue
                if not stat.S_ISDIR(version_directory.lstat().st_mode):
                    continue
                catalog_bytes = self._read_regular_file(
                    version_directory / _CATALOG_FILE_NAME, _MAX_CATALOG_BYTES, "historical terrain catalog"
                )
                catalog = self._decode_canonical_json(catalog_bytes, "historical terrain catalog")
                if catalog.get("releaseId") != release_id:
                    continue
                signature_bytes = self._read_regular_file(
                    version_directory / _CATALOG_SIGNATURE_NAME, 64, "historical terrain catalog signature"
                )
                catalog_digest = hashlib.sha256(catalog_bytes + signature_bytes).hexdigest()
                if catalog_digest != version_directory.name:
                    raise TerrainCatalogError("historical terrain catalog does not match its digest")
                historical_catalog = self._verify_catalog(catalog_bytes, signature_bytes, catalog_digest)
                published_pack = historical_catalog.packs_by_route.get(route_key)
                if published_pack is not None:
                    if len(self._historical_catalogs_by_release) >= 8:
                        oldest_cached_release = next(iter(self._historical_catalogs_by_release))
                        del self._historical_catalogs_by_release[oldest_cached_release]
                    self._historical_catalogs_by_release[release_id] = historical_catalog
                    return published_pack
            raise KeyError(route_key)

    def _verify_catalog(
        self,
        catalog_bytes: bytes,
        signature_bytes: bytes,
        catalog_digest: str,
    ) -> VerifiedTerrainCatalog:
        catalog = self._decode_canonical_json(catalog_bytes, "terrain catalog")
        if len(signature_bytes) != 64:
            raise TerrainCatalogError("terrain catalog signature must contain exactly 64 bytes")
        if type(catalog.get("schemaVersion")) is not int or catalog["schemaVersion"] != 1:
            raise TerrainCatalogError("terrain catalog schema is not supported")

        signature_key_id = catalog.get("signatureKeyId")
        if not isinstance(signature_key_id, str) or not _KEY_ID_PATTERN.fullmatch(signature_key_id):
            raise TerrainCatalogError("terrain catalog has an invalid signature key ID")
        trusted_key = self.trusted_signing_keys.get(signature_key_id)
        if trusted_key is None or len(trusted_key) != 32:
            raise TerrainCatalogError("terrain catalog signing key is not trusted")
        try:
            Ed25519PublicKey.from_public_bytes(trusted_key).verify(signature_bytes, catalog_bytes)
        except (InvalidSignature, ValueError) as error:
            raise TerrainCatalogError("terrain catalog signature verification failed") from error

        release_id = catalog.get("releaseId")
        if not isinstance(release_id, str) or not _IDENTIFIER_PATTERN.fullmatch(release_id):
            raise TerrainCatalogError("terrain catalog has an invalid release ID")
        chunk_records = catalog.get("chunks")
        if not isinstance(chunk_records, list) or len(chunk_records) > _MAX_CATALOG_CHUNKS:
            raise TerrainCatalogError("terrain catalog has an invalid chunk list")

        published_packs: dict[tuple[str, str], PublishedTerrainPack] = {}
        for chunk_record in chunk_records:
            if not isinstance(chunk_record, dict):
                raise TerrainCatalogError("terrain catalog contains an invalid chunk record")
            chunk_id = chunk_record.get("chunkId")
            pack_id = chunk_record.get("packId")
            manifest_hash = chunk_record.get("manifestSha256")
            if (
                not isinstance(chunk_id, str)
                or not _IDENTIFIER_PATTERN.fullmatch(chunk_id)
                or not isinstance(pack_id, str)
                or not _IDENTIFIER_PATTERN.fullmatch(pack_id)
                or not isinstance(manifest_hash, str)
                or not re.fullmatch(r"[0-9a-f]{64}", manifest_hash)
            ):
                raise TerrainCatalogError("terrain catalog contains invalid chunk metadata")
            database_hash = chunk_record.get("databaseSha256")
            database_size = chunk_record.get("databaseSizeBytes")
            if (
                not isinstance(database_hash, str)
                or not re.fullmatch(r"[0-9a-f]{64}", database_hash)
                or type(database_size) is not int
                or not 0 < database_size <= 256 * 1024 * 1024
            ):
                raise TerrainCatalogError("terrain catalog contains invalid artifact metadata")

            route_key = (release_id, chunk_id)
            if route_key in published_packs:
                raise TerrainCatalogError("terrain catalog contains duplicate chunk IDs")

            pack_directory = self._published_pack_directory(release_id, chunk_id)
            try:
                # The publisher already checked SQLite structure before atomically exposing this immutable release.
                verified_pack = verify_signed_terrain_pack(
                    pack_directory,
                    self.trusted_signing_keys,
                    validate_database_integrity=False,
                )
            except (OSError, ValueError) as error:
                raise TerrainCatalogError(f"published terrain pack {chunk_id} failed verification") from error
            if verified_pack.manifest.get("packId") != pack_id:
                raise TerrainCatalogError(f"published terrain pack {chunk_id} does not match its catalog ID")
            if verified_pack.manifest_sha256 != manifest_hash:
                raise TerrainCatalogError(f"published terrain pack {chunk_id} manifest hash does not match")

            database_record = verified_pack.manifest["files"][0]
            if (
                database_record["sha256"] != database_hash
                or database_record["sizeBytes"] != database_size
            ):
                raise TerrainCatalogError(f"published terrain pack {chunk_id} artifact metadata does not match")
            database_path = pack_directory / "terrain.sqlite"
            published_packs[route_key] = PublishedTerrainPack(
                release_id=release_id,
                chunk_id=chunk_id,
                verified_pack=verified_pack,
                database_path=database_path,
            )

        return VerifiedTerrainCatalog(
            catalog=catalog,
            catalog_bytes=catalog_bytes,
            signature_bytes=signature_bytes,
            etag=catalog_digest,
            packs_by_route=published_packs,
        )

    def _published_pack_directory(self, release_id: str, chunk_id: str) -> Path:
        releases_directory = self.distribution_directory / "releases"
        pack_directory = releases_directory / release_id / chunk_id
        directories_to_check = (
            self.distribution_directory,
            releases_directory,
            releases_directory / release_id,
            pack_directory,
        )
        for directory in directories_to_check:
            try:
                mode = directory.lstat().st_mode
            except OSError as error:
                raise TerrainCatalogError("published terrain pack is unavailable") from error
            if not stat.S_ISDIR(mode):
                raise TerrainCatalogError("published terrain pack directories cannot be symlinks")
        return pack_directory

    @staticmethod
    def _read_regular_file(file_path: Path, maximum_bytes: int, description: str) -> bytes:
        open_flags = os.O_RDONLY
        if hasattr(os, "O_NOFOLLOW"):
            open_flags |= os.O_NOFOLLOW
        try:
            file_descriptor = os.open(file_path, open_flags)
        except OSError as error:
            raise TerrainCatalogError(f"{description} is unavailable") from error

        try:
            file_status = os.fstat(file_descriptor)
            if not stat.S_ISREG(file_status.st_mode) or file_status.st_size > maximum_bytes:
                raise TerrainCatalogError(f"{description} is not a bounded regular file")
            with os.fdopen(file_descriptor, "rb") as input_file:
                file_bytes = input_file.read(maximum_bytes + 1)
        except Exception:
            try:
                os.close(file_descriptor)
            except OSError:
                pass
            raise
        if len(file_bytes) > maximum_bytes:
            raise TerrainCatalogError(f"{description} is too large")
        return file_bytes

    @classmethod
    def _canonical_json(cls, catalog: dict[str, object]) -> bytes:
        return json.dumps(
            catalog,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")

    @classmethod
    def _decode_canonical_json(cls, contents: bytes, description: str) -> dict[str, object]:
        try:
            decoded_value = json.loads(
                contents.decode("utf-8"),
                object_pairs_hook=cls._reject_duplicate_keys,
                parse_constant=cls._reject_non_finite_number,
            )
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            raise TerrainCatalogError(f"{description} is not valid canonical JSON") from error
        if not isinstance(decoded_value, dict) or cls._canonical_json(decoded_value) != contents:
            raise TerrainCatalogError(f"{description} is not in canonical form")
        return decoded_value

    @staticmethod
    def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
        catalog_fields: dict[str, object] = {}
        for key, value in pairs:
            if key in catalog_fields:
                raise ValueError("terrain catalog contains a duplicate field")
            catalog_fields[key] = value
        return catalog_fields

    @staticmethod
    def _reject_non_finite_number(value: str) -> None:
        raise ValueError(f"terrain catalog contains a non-finite number: {value}")

    @staticmethod
    def _validate_identifier(identifier: str, description: str) -> None:
        if not _IDENTIFIER_PATTERN.fullmatch(identifier):
            raise KeyError(description)
