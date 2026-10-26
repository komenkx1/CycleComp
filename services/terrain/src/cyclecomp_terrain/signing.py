from __future__ import annotations

import base64
from dataclasses import dataclass
from datetime import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import struct
import tempfile
from urllib.parse import urlparse

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from cyclecomp_terrain.road_corridors import MAX_CORRIDOR_EDGE_COUNT
from cyclecomp_terrain.road_graph import (
    BICYCLE_ACCESS_POLICY_VERSION,
    _bicycle_access_state,
    _directional_bicycle_access_state,
)


_PACK_FILE_NAMES = {"manifest.json", "terrain.sqlite"}
_SIGNATURE_FILE_NAME = "manifest.ed25519"
_SIGNATURE_KEY_ID_PATTERN = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}")
_PACK_ID_PATTERN = re.compile(r"[a-z0-9][a-z0-9._-]{0,95}")
_DATABASE_APPLICATION_ID = 1_129_927_500
_ROAD_PROFILE_ALGORITHM_VERSION = "cyclecomp-route-elevation-v2"
_MAX_SIGNED_MANIFEST_BYTES = 1024 * 1024
_MAX_PUBLISHED_DATABASE_BYTES = 256 * 1024 * 1024


@dataclass(frozen=True)
class TerrainPackSigningResult:
    manifest: dict[str, object]
    trusted_public_key_base64: str


@dataclass(frozen=True)
class VerifiedTerrainPack:
    manifest: dict[str, object]
    manifest_bytes: bytes
    signature_bytes: bytes
    manifest_sha256: str


def validate_signature_key_id(signature_key_id: str) -> None:
    if not _SIGNATURE_KEY_ID_PATTERN.fullmatch(signature_key_id):
        raise ValueError("signature key ID must be a lowercase identifier of at most 64 characters")


def sign_elevation_grid_pack(
    pack_directory: Path,
    signing_key_path: Path,
    signature_key_id: str,
) -> TerrainPackSigningResult:
    validate_signature_key_id(signature_key_id)

    package_path = pack_directory.absolute()
    _validate_pack_directory(package_path)
    signing_key = _load_signing_key(signing_key_path)
    manifest_path = package_path / "manifest.json"
    database_path = package_path / "terrain.sqlite"
    manifest_bytes = manifest_path.read_bytes()
    manifest = _decode_canonical_manifest(manifest_bytes)
    _validate_unsigned_manifest(manifest, database_path)
    _validate_grid_database(database_path, manifest)

    signed_manifest = dict(manifest)
    signed_manifest["signatureKeyId"] = signature_key_id
    signed_manifest["signatureStatus"] = "signed"
    signed_manifest_bytes = _canonical_manifest_bytes(signed_manifest)
    signature_bytes = signing_key.sign(signed_manifest_bytes)
    _write_signed_files(package_path, signed_manifest_bytes, signature_bytes)
    public_key_bytes = signing_key.public_key().public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    )
    return TerrainPackSigningResult(
        manifest=signed_manifest,
        trusted_public_key_base64=base64.b64encode(public_key_bytes).decode("ascii"),
    )


def verify_signed_terrain_pack(
    pack_directory: Path,
    trusted_signing_keys: dict[str, bytes],
    *,
    validate_database_integrity: bool = True,
) -> VerifiedTerrainPack:
    package_path = pack_directory.absolute()
    _validate_signed_pack_directory(package_path)

    manifest_bytes = _read_regular_file(
        package_path / "manifest.json",
        _MAX_SIGNED_MANIFEST_BYTES,
        "terrain pack manifest",
    )
    signature_bytes = _read_regular_file(
        package_path / _SIGNATURE_FILE_NAME,
        64,
        "terrain pack signature",
    )
    manifest = _decode_canonical_manifest(manifest_bytes)

    if len(signature_bytes) != 64:
        raise ValueError("terrain pack signature must contain exactly 64 bytes")
    if manifest.get("signatureStatus") != "signed":
        raise ValueError("terrain pack manifest is not signed")

    signature_key_id = manifest.get("signatureKeyId")
    if not isinstance(signature_key_id, str) or not _SIGNATURE_KEY_ID_PATTERN.fullmatch(signature_key_id):
        raise ValueError("terrain pack manifest has an invalid signature key ID")
    trusted_public_key_bytes = trusted_signing_keys.get(signature_key_id)
    if trusted_public_key_bytes is None:
        raise ValueError("terrain pack signature key is not trusted")
    if len(trusted_public_key_bytes) != 32:
        raise ValueError("trusted terrain signing keys must contain 32 raw bytes")

    try:
        Ed25519PublicKey.from_public_bytes(trusted_public_key_bytes).verify(signature_bytes, manifest_bytes)
    except (InvalidSignature, ValueError) as error:
        raise ValueError("terrain pack signature verification failed") from error

    database_path = package_path / "terrain.sqlite"
    _validate_pack_manifest_contents(manifest, database_path)
    database_status = database_path.stat()
    if database_status.st_size > _MAX_PUBLISHED_DATABASE_BYTES:
        raise ValueError("terrain pack database exceeds the iOS installation limit")
    if validate_database_integrity:
        _validate_grid_database(database_path, manifest)

    return VerifiedTerrainPack(
        manifest=manifest,
        manifest_bytes=manifest_bytes,
        signature_bytes=signature_bytes,
        manifest_sha256=hashlib.sha256(manifest_bytes).hexdigest(),
    )


def _validate_pack_directory(package_path: Path) -> None:
    try:
        package_mode = package_path.lstat().st_mode
    except OSError as error:
        raise ValueError("terrain pack directory is unavailable") from error
    if not stat.S_ISDIR(package_mode):
        raise ValueError("terrain pack path must be a regular directory")

    try:
        entries = {entry.name: entry.stat(follow_symlinks=False).st_mode for entry in package_path.iterdir()}
    except OSError as error:
        raise ValueError("terrain pack directory cannot be inspected") from error
    if entries.keys() != _PACK_FILE_NAMES:
        raise ValueError("only an unsigned terrain grid pack can be signed")
    if any(not stat.S_ISREG(mode) for mode in entries.values()):
        raise ValueError("terrain pack files must be regular files")


def _validate_signed_pack_directory(package_path: Path) -> None:
    try:
        package_mode = package_path.lstat().st_mode
    except OSError as error:
        raise ValueError("terrain pack directory is unavailable") from error
    if not stat.S_ISDIR(package_mode):
        raise ValueError("terrain pack path must be a regular directory")

    try:
        entries = {entry.name: entry.stat(follow_symlinks=False).st_mode for entry in package_path.iterdir()}
    except OSError as error:
        raise ValueError("terrain pack directory cannot be inspected") from error
    if entries.keys() != _PACK_FILE_NAMES | {_SIGNATURE_FILE_NAME}:
        raise ValueError("signed terrain pack must contain exactly three expected files")
    if any(not stat.S_ISREG(mode) for mode in entries.values()):
        raise ValueError("terrain pack files must be regular files")


def _read_regular_file(file_path: Path, maximum_bytes: int, file_description: str) -> bytes:
    open_flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        open_flags |= os.O_NOFOLLOW

    try:
        file_descriptor = os.open(file_path, open_flags)
    except OSError as error:
        raise ValueError(f"{file_description} must be a readable, non-symlink file") from error

    try:
        file_status = os.fstat(file_descriptor)
        if not stat.S_ISREG(file_status.st_mode):
            raise ValueError(f"{file_description} must be a regular file")
        if file_status.st_size > maximum_bytes:
            raise ValueError(f"{file_description} is too large")

        with os.fdopen(file_descriptor, "rb") as input_file:
            file_bytes = input_file.read(maximum_bytes + 1)
    except Exception:
        try:
            os.close(file_descriptor)
        except OSError:
            pass
        raise

    if len(file_bytes) > maximum_bytes:
        raise ValueError(f"{file_description} is too large")
    return file_bytes


def _load_signing_key(signing_key_path: Path) -> Ed25519PrivateKey:
    open_flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        open_flags |= os.O_NOFOLLOW

    try:
        key_descriptor = os.open(signing_key_path, open_flags)
    except OSError as error:
        raise ValueError("signing key must be a readable, non-symlink file") from error

    try:
        key_file_status = os.fstat(key_descriptor)
        if not stat.S_ISREG(key_file_status.st_mode):
            raise ValueError("signing key must be a regular file")
        if stat.S_IMODE(key_file_status.st_mode) not in {0o400, 0o600}:
            raise ValueError("signing key permissions must be 0400 or 0600")
        if key_file_status.st_size > 16_384:
            raise ValueError("signing key file is too large")

        with os.fdopen(key_descriptor, "rb") as key_file:
            key_contents = key_file.read(16_385)
    except Exception:
        try:
            os.close(key_descriptor)
        except OSError:
            pass
        raise

    try:
        signing_key = serialization.load_pem_private_key(key_contents, password=None)
    except (TypeError, ValueError) as error:
        raise ValueError("signing key must be an unencrypted Ed25519 PKCS#8 PEM file") from error
    if not isinstance(signing_key, Ed25519PrivateKey):
        raise ValueError("signing key must be an Ed25519 private key")
    return signing_key


def _decode_canonical_manifest(manifest_bytes: bytes) -> dict[str, object]:
    try:
        decoded_manifest = json.loads(
            manifest_bytes.decode("utf-8"),
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_non_finite_json_number,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise ValueError("terrain pack manifest is not valid canonical JSON") from error

    if not isinstance(decoded_manifest, dict):
        raise ValueError("terrain pack manifest must be a JSON object")
    if _canonical_manifest_bytes(decoded_manifest) != manifest_bytes:
        raise ValueError("terrain pack manifest is not in canonical form")
    return decoded_manifest


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    decoded_object: dict[str, object] = {}
    for key, value in pairs:
        if key in decoded_object:
            raise ValueError("terrain pack manifest contains a duplicate field")
        decoded_object[key] = value
    return decoded_object


def _reject_non_finite_json_number(value: str) -> None:
    raise ValueError(f"terrain pack manifest contains a non-finite number: {value}")


def _canonical_manifest_bytes(manifest: dict[str, object]) -> bytes:
    return json.dumps(
        manifest,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _validate_unsigned_manifest(manifest: dict[str, object], database_path: Path) -> None:
    if manifest.get("signatureStatus") != "unsigned_pilot" or manifest.get("signatureKeyId") is not None:
        raise ValueError("only unsigned pilot packs can be signed")
    _validate_pack_manifest_contents(manifest, database_path)


def _validate_pack_manifest_contents(manifest: dict[str, object], database_path: Path) -> None:
    pack_id = manifest.get("packId")
    if not isinstance(pack_id, str) or not _PACK_ID_PATTERN.fullmatch(pack_id):
        raise ValueError("terrain pack manifest has an invalid pack ID")
    if (
        type(manifest.get("schemaVersion")) is not int
        or manifest.get("schemaVersion") != 1
        or manifest.get("hasElevationGrid") is not True
        or type(manifest.get("hasRoadGraph")) is not bool
        or type(manifest.get("hasRoadProfiles")) is not bool
        or type(manifest.get("minimumReaderVersion")) is not int
        or not 1 <= manifest["minimumReaderVersion"] <= 2
    ):
        raise ValueError("terrain pack manifest has an unsupported grid schema")
    if manifest["hasRoadGraph"]:
        road_graph = manifest.get("roadGraph")
        road_profiles = manifest.get("roadProfiles")
        profile_algorithm_version = manifest.get("profileAlgorithmVersion")
        if (
            not isinstance(road_graph, dict)
            or manifest.get("graphVersion") != "osm-directed-v1"
            or road_graph.get("hasElevationProfiles") is not manifest["hasRoadProfiles"]
            or not isinstance(road_profiles, dict)
            or profile_algorithm_version != _ROAD_PROFILE_ALGORITHM_VERSION
            or road_profiles.get("profileAlgorithmVersion") != profile_algorithm_version
            or road_profiles.get("directedEdgeCount") != road_graph.get("directedEdgeCount")
            or road_profiles.get("climbCompleteness") != "edge_local_candidate"
            or road_profiles.get("corridorClimbCompleteness") != "corridor_local_candidate"
            or type(road_profiles.get("continuousCorridorsAvailable")) is not bool
            or type(road_profiles.get("continuousCorridorCount")) is not int
            or road_profiles.get("continuousCorridorsAvailable")
            is not (road_profiles.get("continuousCorridorCount", 0) > 0)
            or road_graph.get("hasContinuousRoadProfiles")
            is not road_profiles.get("continuousCorridorsAvailable")
        ):
            raise ValueError("terrain pack manifest has incomplete road profile metadata")
    elif (
        manifest.get("roadGraph") is not None
        or manifest.get("roadProfiles") is not None
        or manifest.get("hasRoadProfiles") is not False
        or manifest.get("profileAlgorithmVersion") is not None
    ):
        raise ValueError("terrain pack manifest contains road profile data without graph capability")

    file_records = manifest.get("files")
    if not isinstance(file_records, list) or len(file_records) != 1:
        raise ValueError("terrain pack manifest must contain exactly one SQLite file")
    file_record = file_records[0]
    if not isinstance(file_record, dict) or file_record.get("path") != database_path.name:
        raise ValueError("terrain pack manifest does not identify terrain.sqlite")

    expected_size = file_record.get("sizeBytes")
    expected_hash = file_record.get("sha256")
    if type(expected_size) is not int or expected_size < 0:
        raise ValueError("terrain pack manifest contains an invalid database size")
    if not isinstance(expected_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_hash):
        raise ValueError("terrain pack manifest contains an invalid database hash")

    database_status = database_path.stat()
    if database_status.st_size != expected_size:
        raise ValueError("terrain pack database size does not match its manifest")
    if _file_sha256(database_path) != expected_hash:
        raise ValueError("terrain pack database hash does not match its manifest")


def _validate_grid_database(database_path: Path, manifest: dict[str, object]) -> None:
    database_uri = f"{database_path.as_uri()}?mode=ro&immutable=1"
    try:
        connection = sqlite3.connect(database_uri, uri=True)
        try:
            integrity_check = connection.execute("PRAGMA integrity_check").fetchone()
            if integrity_check != ("ok",):
                raise ValueError("terrain pack SQLite integrity check failed")

            application_id = connection.execute("PRAGMA application_id").fetchone()
            schema_version = connection.execute("PRAGMA user_version").fetchone()
            if application_id != (_DATABASE_APPLICATION_ID,) or schema_version != (manifest["schemaVersion"],):
                raise ValueError("terrain pack SQLite identifiers do not match its manifest")

            metadata_rows = connection.execute("SELECT key, value FROM pack_metadata").fetchall()
            pack_metadata = {key: json.loads(value) for key, value in metadata_rows}
            if pack_metadata.get("packId") != manifest["packId"]:
                raise ValueError("terrain pack SQLite ID does not match its manifest")
            if pack_metadata.get("schemaVersion") != manifest["schemaVersion"]:
                raise ValueError("terrain pack SQLite schema does not match its manifest")
            if (
                pack_metadata.get("hasRoadGraph", False) is not manifest["hasRoadGraph"]
                or pack_metadata.get("hasRoadProfiles", False) is not manifest.get("hasRoadProfiles", False)
                or pack_metadata.get("profileAlgorithmVersion") != manifest.get("profileAlgorithmVersion")
                or pack_metadata.get("roadProfileSummary") != manifest.get("roadProfiles")
            ):
                raise ValueError("terrain pack SQLite graph capabilities do not match its manifest")
            if manifest["hasRoadGraph"] and pack_metadata.get("graphVersion") != "osm-directed-v1":
                raise ValueError("terrain pack SQLite graph version does not match its manifest")

            block_count = connection.execute("SELECT COUNT(*) FROM elevation_grid_blocks").fetchone()
            index_count = connection.execute("SELECT COUNT(*) FROM elevation_grid_block_index").fetchone()
            if block_count is None or index_count is None or block_count[0] == 0 or block_count != index_count:
                raise ValueError("terrain pack SQLite grid index is incomplete")

            foreign_key_error = connection.execute("PRAGMA foreign_key_check").fetchone()
            if foreign_key_error is not None:
                raise ValueError("terrain pack SQLite contains an invalid grid relationship")

            if manifest["hasRoadGraph"]:
                _validate_road_graph_database(connection, manifest)
                _validate_road_profile_database(connection, manifest)
        finally:
            connection.close()
    except sqlite3.Error as error:
        raise ValueError("terrain pack SQLite database is invalid") from error


def _validate_road_graph_database(
    connection: sqlite3.Connection,
    manifest: dict[str, object],
) -> None:
    road_graph = manifest["roadGraph"]
    if not isinstance(road_graph, dict):
        raise ValueError("terrain pack manifest has invalid road graph metadata")
    access_policy_version = road_graph.get("bicycleAccessPolicyVersion")
    if access_policy_version is not None and (
        access_policy_version != BICYCLE_ACCESS_POLICY_VERSION
        or manifest["minimumReaderVersion"] < 2
    ):
        raise ValueError("terrain pack has an unsupported bicycle access policy")

    source_url = road_graph.get("sourceUrl")
    pbf_sha256 = road_graph.get("pbfSha256")
    snapshot_at = road_graph.get("snapshotAt")
    selected_bounds = road_graph.get("selectedBoundsWgs84")
    buffer_meters = road_graph.get("bufferMeters")
    parsed_source_url = urlparse(source_url) if isinstance(source_url, str) else None
    if (
        not isinstance(source_url, str)
        or parsed_source_url is None
        or parsed_source_url.scheme != "https"
        or not parsed_source_url.hostname
        or parsed_source_url.username is not None
        or parsed_source_url.password is not None
        or not isinstance(pbf_sha256, str)
        or not re.fullmatch(r"[0-9a-f]{64}", pbf_sha256)
        or not isinstance(snapshot_at, str)
        or not _is_timezone_aware_iso8601(snapshot_at)
        or not isinstance(selected_bounds, list)
        or len(selected_bounds) != 4
        or any(type(bound) not in {int, float} or not math.isfinite(bound) for bound in selected_bounds)
        or not (-180 <= selected_bounds[0] < selected_bounds[2] <= 180)
        or not (-90 <= selected_bounds[1] < selected_bounds[3] <= 90)
        or not isinstance(buffer_meters, (int, float))
        or not math.isfinite(buffer_meters)
        or not 0 <= buffer_meters <= 100_000
        or road_graph.get("hasElevationProfiles") is not manifest.get("hasRoadProfiles")
    ):
        raise ValueError("terrain pack manifest has invalid road graph provenance")

    graph_metadata_rows = connection.execute("SELECT key, value FROM road_graph_metadata").fetchall()
    graph_metadata = {key: json.loads(value) for key, value in graph_metadata_rows}
    for metadata_key, manifest_value in road_graph.items():
        if graph_metadata.get(metadata_key) != manifest_value:
            raise ValueError("terrain pack road graph metadata does not match its manifest")

    expected_counts = {
        "nodeCount": "road_nodes",
        "physicalSegmentCount": "road_segments",
        "directedEdgeCount": "road_edges",
        "turnRestrictionCount": "road_turn_restrictions",
    }
    for manifest_count_key, table_name in expected_counts.items():
        expected_count = road_graph.get(manifest_count_key)
        minimum_count = 0 if manifest_count_key == "turnRestrictionCount" else 1
        if type(expected_count) is not int or expected_count < minimum_count:
            raise ValueError("terrain pack road graph contains an invalid entity count")
        row_count = connection.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()
        if row_count is None or row_count[0] != expected_count:
            raise ValueError("terrain pack road graph count does not match its manifest")

    edge_index_count = connection.execute("SELECT COUNT(*) FROM road_edge_index").fetchone()
    directed_edge_count = road_graph["directedEdgeCount"]
    if edge_index_count is None or edge_index_count[0] != directed_edge_count:
        raise ValueError("terrain pack road graph spatial index is incomplete")

    duplicate_direction = connection.execute(
        "SELECT segment_id FROM road_edges GROUP BY segment_id HAVING COUNT(*) != 2 LIMIT 1"
    ).fetchone()
    if duplicate_direction is not None:
        raise ValueError("terrain pack road graph segment directions are incomplete")

    invalid_direction_state = connection.execute(
        """SELECT edge_id FROM road_edges WHERE direction_state NOT IN (
                 'allowed', 'prohibited', 'conditional', 'unknown'
             ) OR bicycle_access NOT IN (
                 'allowed', 'prohibited', 'conditional', 'dismount', 'unknown', 'road_class_inferred'
             ) OR (predictable = 1 AND (matchable != 1 OR direction_state != 'allowed'
                       OR bicycle_access NOT IN ('allowed', 'road_class_inferred'))) LIMIT 1"""
    ).fetchone()
    if invalid_direction_state is not None:
        raise ValueError("terrain pack road graph contains an invalid direction or access state")

    if access_policy_version is None:
        if connection.execute(
            "SELECT 1 FROM road_edges WHERE bicycle_access = 'road_class_inferred' LIMIT 1"
        ).fetchone():
            raise ValueError("terrain pack inferred access requires a versioned bicycle access policy")
    else:
        for tags_json, segment_access, direction, edge_access in connection.execute(
            """SELECT segment.tags_json, segment.bicycle_access, edge.direction, edge.bicycle_access
               FROM road_edges AS edge JOIN road_segments AS segment USING(segment_id)"""
        ):
            road_tags = json.loads(tags_json)
            if (
                not isinstance(road_tags, dict)
                or any(not isinstance(tag_value, str) for tag_value in road_tags.values())
                or _bicycle_access_state(road_tags) != segment_access
                or _directional_bicycle_access_state(road_tags, direction) != edge_access
            ):
                raise ValueError("terrain pack access provenance does not match its bicycle access policy")

    for (
        segment_id,
        from_node_id,
        to_node_id,
        geometry_bytes,
    ) in connection.execute(
        "SELECT segment_id, from_node_id, to_node_id, geometry_wgs84_f64le FROM road_segments"
    ):
        if len(geometry_bytes) < 32 or len(geometry_bytes) % 16 != 0:
            raise ValueError("terrain pack road graph contains invalid geometry bytes")
        coordinates = list(struct.iter_unpack("<dd", geometry_bytes))
        if any(
            not math.isfinite(longitude)
            or not math.isfinite(latitude)
            or not -180 <= longitude <= 180
            or not -90 <= latitude <= 90
            for longitude, latitude in coordinates
        ):
            raise ValueError("terrain pack road graph contains invalid coordinates")
        endpoint_nodes = connection.execute(
            """SELECT node_id, longitude, latitude FROM road_nodes
               WHERE node_id IN (?, ?)""",
            (from_node_id, to_node_id),
        ).fetchall()
        node_coordinates = {node_id: (longitude, latitude) for node_id, longitude, latitude in endpoint_nodes}
        if (
            node_coordinates.get(from_node_id) != coordinates[0]
            or node_coordinates.get(to_node_id) != coordinates[-1]
        ):
            raise ValueError("terrain pack road graph geometry endpoints do not match topology")
        for edge_id, in connection.execute(
            "SELECT edge_id FROM road_edges WHERE segment_id = ?",
            (segment_id,),
        ):
            index_bounds = connection.execute(
                """SELECT minimum_longitude, maximum_longitude,
                          minimum_latitude, maximum_latitude
                   FROM road_edge_index WHERE edge_id = ?""",
                (edge_id,),
            ).fetchone()
            if (
                index_bounds is None
                or index_bounds[0] > min(longitude for longitude, _ in coordinates)
                or index_bounds[1] < max(longitude for longitude, _ in coordinates)
                or index_bounds[2] > min(latitude for _, latitude in coordinates)
                or index_bounds[3] < max(latitude for _, latitude in coordinates)
            ):
                raise ValueError("terrain pack road graph spatial index does not cover its geometry")

        directions = connection.execute(
            """SELECT direction, from_node_id, to_node_id FROM road_edges
               WHERE segment_id = ?""",
            (segment_id,),
        ).fetchall()
        if {(direction, edge_from, edge_to) for direction, edge_from, edge_to in directions} != {
            (1, from_node_id, to_node_id),
            (-1, to_node_id, from_node_id),
        }:
            raise ValueError("terrain pack road graph direction endpoints are invalid")

    for members_json in connection.execute(
        "SELECT members_json FROM road_turn_restrictions"
    ).fetchall():
        members = json.loads(members_json[0])
        if not isinstance(members, list) or any(
            not isinstance(member, dict)
            or member.get("type") not in {"n", "w", "r"}
            or type(member.get("ref")) is not int
            or not isinstance(member.get("role"), str)
            for member in members
        ):
            raise ValueError("terrain pack contains an invalid turn restriction")


def _validate_road_profile_database(
    connection: sqlite3.Connection,
    manifest: dict[str, object],
) -> None:
    road_profiles = manifest.get("roadProfiles")
    source = manifest.get("source")
    road_graph = manifest.get("roadGraph")
    if not isinstance(road_profiles, dict) or not isinstance(source, dict) or not isinstance(road_graph, dict):
        raise ValueError("terrain pack manifest has invalid road profile metadata")

    profile_metadata_rows = connection.execute(
        "SELECT key, value FROM road_profile_metadata"
    ).fetchall()
    profile_metadata = {key: json.loads(value) for key, value in profile_metadata_rows}
    if profile_metadata != road_profiles:
        raise ValueError("terrain pack road profile metadata does not match its manifest")

    expected_summary_fields = {
        "profileAlgorithmVersion": _ROAD_PROFILE_ALGORITHM_VERSION,
        "sourceName": source.get("name"),
        "sourceRelease": source.get("release"),
        "sourceResolutionMeters": source.get("resolutionMeters"),
        "verticalDatum": source.get("verticalDatum"),
        "directedEdgeCount": road_graph.get("directedEdgeCount"),
        "climbCompleteness": "edge_local_candidate",
        "corridorClimbCompleteness": "corridor_local_candidate",
        "maximumCorridorEdgeCount": MAX_CORRIDOR_EDGE_COUNT,
        "corridorCount": road_graph.get("corridorCount"),
        "continuousCorridorCount": road_graph.get("continuousCorridorCount"),
    }
    if any(road_profiles.get(key) != expected_value for key, expected_value in expected_summary_fields.items()):
        raise ValueError("terrain pack road profile provenance is inconsistent")

    sample_count = 0
    valid_sample_count = 0
    profiled_sample_count = 0
    unknown_sample_count = 0
    profiled_edge_sample_counts: dict[int, int] = {}
    previous_distances: dict[int, float] = {}
    structure_edge_ids: set[int] = set()
    for row in connection.execute(
        """SELECT edge_id, sample_index, distance_meters, longitude, latitude,
                  terrain_elevation_meters, profile_elevation_meters, grade_percent,
                  source_reason, elevation_source, source_name, source_release,
                  source_resolution_meters, vertical_datum, quality_flags_json
           FROM elevation_samples ORDER BY edge_id, sample_index"""
    ):
        (
            edge_id,
            sample_index,
            distance_meters,
            longitude,
            latitude,
            terrain_elevation_meters,
            profile_elevation_meters,
            grade_percent,
            source_reason,
            elevation_source,
            source_name,
            source_release,
            source_resolution_meters,
            vertical_datum,
            quality_flags_json,
        ) = row
        if (
            type(edge_id) is not int
            or type(sample_index) is not int
            or sample_index < 0
            or not _is_finite_number(distance_meters)
            or distance_meters < 0
            or not _is_finite_number(longitude)
            or not -180 <= longitude <= 180
            or not _is_finite_number(latitude)
            or not -90 <= latitude <= 90
            or elevation_source != "offline_dem"
            or source_name != source.get("name")
            or source_release != source.get("release")
            or not _is_finite_number(source_resolution_meters)
            or source_resolution_meters <= 0
            or vertical_datum != source.get("verticalDatum")
            or source_reason not in {None, "out_of_coverage", "nodata", "incomplete_neighborhood"}
            or any(
                elevation is not None and not _is_finite_number(elevation)
                for elevation in (
                    terrain_elevation_meters,
                    profile_elevation_meters,
                    grade_percent,
                )
            )
            or (profile_elevation_meters is None and grade_percent is not None)
            or (
                terrain_elevation_meters is None
                and profile_elevation_meters is None
                and source_reason is None
            )
        ):
            raise ValueError("terrain pack contains an invalid road elevation sample")

        prior_distance = previous_distances.get(edge_id)
        if prior_distance is not None and distance_meters <= prior_distance:
            raise ValueError("terrain pack road elevation samples are not ordered by distance")
        previous_distances[edge_id] = distance_meters
        try:
            quality_flags = json.loads(quality_flags_json)
        except (TypeError, json.JSONDecodeError) as error:
            raise ValueError("terrain pack road elevation sample has invalid quality flags") from error
        if not isinstance(quality_flags, list) or any(not isinstance(flag, str) for flag in quality_flags):
            raise ValueError("terrain pack road elevation sample has invalid quality flags")
        if "structure_surface_unknown" in quality_flags:
            structure_edge_ids.add(edge_id)
            if profile_elevation_meters is not None or grade_percent is not None:
                raise ValueError("terrain pack assigns road elevations to an unknown structure surface")

        sample_count += 1
        if terrain_elevation_meters is None:
            unknown_sample_count += 1
        else:
            valid_sample_count += 1
        if profile_elevation_meters is not None:
            profiled_sample_count += 1
            profiled_edge_sample_counts[edge_id] = profiled_edge_sample_counts.get(edge_id, 0) + 1

    profiled_edge_count = sum(
        sample_total >= 2 for sample_total in profiled_edge_sample_counts.values()
    )
    structure_edge_count = len(structure_edge_ids)
    climb_candidate_count = connection.execute("SELECT COUNT(*) FROM climb_segments").fetchone()[0]
    expected_counts = {
        "directedEdgeCount": road_graph.get("directedEdgeCount"),
        "profiledEdgeCount": profiled_edge_count,
        "sampleCount": sample_count,
        "validSampleCount": valid_sample_count,
        "profiledSampleCount": profiled_sample_count,
        "unknownSampleCount": unknown_sample_count,
        "structureEdgeCount": structure_edge_count,
        "climbCandidateCount": climb_candidate_count,
    }
    if any(
        type(road_profiles.get(key)) is not int or road_profiles.get(key) != expected_value
        for key, expected_value in expected_counts.items()
    ):
        raise ValueError("terrain pack road profile counts do not match its database")

    for row in connection.execute(
        """SELECT edge_id, start_distance_meters, end_distance_meters, distance_meters,
                  net_rise_meters, ascent_meters, descent_meters, average_grade_percent,
                  max_grade_percent, start_elevation_meters, end_elevation_meters, completeness
           FROM climb_segments"""
    ):
        (
            edge_id,
            start_distance_meters,
            end_distance_meters,
            distance_meters,
            net_rise_meters,
            ascent_meters,
            descent_meters,
            average_grade_percent,
            max_grade_percent,
            start_elevation_meters,
            end_elevation_meters,
            completeness,
        ) = row
        climb_values = (
            start_distance_meters,
            end_distance_meters,
            distance_meters,
            net_rise_meters,
            ascent_meters,
            descent_meters,
            average_grade_percent,
            max_grade_percent,
            start_elevation_meters,
            end_elevation_meters,
        )
        if (
            not all(_is_finite_number(value) for value in climb_values)
            or start_distance_meters < 0
            or end_distance_meters < start_distance_meters
            or distance_meters <= 0
            or ascent_meters < 0
            or descent_meters < 0
            or edge_id in structure_edge_ids
            or completeness != "edge_local_candidate"
        ):
            raise ValueError("terrain pack contains an invalid climb candidate")

    if manifest.get("hasRoadProfiles") is not (profiled_edge_count > 0):
        raise ValueError("terrain pack road profile capability does not match its database")

    _validate_road_corridor_database(connection, road_profiles, road_graph)


def _validate_road_corridor_database(
    connection: sqlite3.Connection,
    road_profiles: dict[str, object],
    road_graph: dict[str, object],
) -> None:
    corridor_records: dict[int, dict[str, object]] = {}
    allowed_boundary_states = {
        "decision",
        "dead_end",
        "restriction",
        "merge",
        "cycle",
        "edge_limit",
        "network_boundary",
    }
    for row in connection.execute(
        """SELECT corridor_id, start_edge_id, end_edge_id, start_node_id, end_node_id,
                  edge_count, length_meters, profile_quality, start_boundary_state,
                  end_boundary_state
           FROM road_corridors ORDER BY corridor_id"""
    ):
        (
            corridor_id,
            start_edge_id,
            end_edge_id,
            start_node_id,
            end_node_id,
            edge_count,
            length_meters,
            profile_quality,
            start_boundary_state,
            end_boundary_state,
        ) = row
        if (
            type(corridor_id) is not int
            or type(start_edge_id) is not int
            or type(end_edge_id) is not int
            or type(start_node_id) is not int
            or type(end_node_id) is not int
            or type(edge_count) is not int
            or edge_count < 1
            or edge_count > MAX_CORRIDOR_EDGE_COUNT
            or not _is_finite_number(length_meters)
            or length_meters <= 0
            or profile_quality not in {"complete", "partial", "unavailable"}
            or start_boundary_state not in allowed_boundary_states
            or end_boundary_state not in allowed_boundary_states
        ):
            raise ValueError("terrain pack contains invalid road corridor metadata")
        corridor_records[corridor_id] = {
            "startEdgeId": start_edge_id,
            "endEdgeId": end_edge_id,
            "startNodeId": start_node_id,
            "endNodeId": end_node_id,
            "edgeCount": edge_count,
            "lengthMeters": length_meters,
            "profileQuality": profile_quality,
            "startBoundaryState": start_boundary_state,
            "endBoundaryState": end_boundary_state,
        }

    corridor_edges: dict[int, list[tuple[int, int, int, float, float, int, int, float]]] = {
        corridor_id: [] for corridor_id in corridor_records
    }
    assigned_edge_ids: set[int] = set()
    for row in connection.execute(
        """SELECT corridor_edge.corridor_id, corridor_edge.edge_order, corridor_edge.edge_id,
                  corridor_edge.start_distance_meters, corridor_edge.end_distance_meters,
                  edge.from_node_id, edge.to_node_id, segment.length_meters
           FROM road_corridor_edges AS corridor_edge
           JOIN road_edges AS edge ON edge.edge_id = corridor_edge.edge_id
           JOIN road_segments AS segment ON segment.segment_id = edge.segment_id
           ORDER BY corridor_edge.corridor_id, corridor_edge.edge_order"""
    ):
        (
            corridor_id,
            edge_order,
            edge_id,
            start_distance_meters,
            end_distance_meters,
            from_node_id,
            to_node_id,
            edge_length_meters,
        ) = row
        if (
            corridor_id not in corridor_edges
            or type(edge_order) is not int
            or type(edge_id) is not int
            or edge_id in assigned_edge_ids
            or not _is_finite_number(start_distance_meters)
            or not _is_finite_number(end_distance_meters)
            or not _is_finite_number(edge_length_meters)
            or edge_length_meters <= 0
            or end_distance_meters <= start_distance_meters
            or abs((end_distance_meters - start_distance_meters) - edge_length_meters) > 0.1
        ):
            raise ValueError("terrain pack contains invalid road corridor edges")
        assigned_edge_ids.add(edge_id)
        corridor_edges[corridor_id].append(
            (
                edge_order,
                edge_id,
                from_node_id,
                start_distance_meters,
                end_distance_meters,
                to_node_id,
                edge_length_meters,
                corridor_id,
            )
        )

    predictable_edge_ids = {
        edge_id
        for (edge_id,) in connection.execute(
            "SELECT edge_id FROM road_edges WHERE predictable = 1"
        )
    }
    if assigned_edge_ids != predictable_edge_ids:
        raise ValueError("terrain pack road corridors do not cover each predictable edge once")

    for corridor_id, corridor_record in corridor_records.items():
        corridor_edge_records = corridor_edges[corridor_id]
        if len(corridor_edge_records) != corridor_record["edgeCount"]:
            raise ValueError("terrain pack road corridor edge count is inconsistent")
        expected_start_distance_meters = 0.0
        prior_to_node_id: int | None = None
        for expected_edge_order, edge_record in enumerate(corridor_edge_records):
            (
                edge_order,
                edge_id,
                from_node_id,
                start_distance_meters,
                end_distance_meters,
                to_node_id,
                edge_length_meters,
                _,
            ) = edge_record
            if (
                edge_order != expected_edge_order
                or abs(start_distance_meters - expected_start_distance_meters) > 0.1
                or (prior_to_node_id is not None and from_node_id != prior_to_node_id)
                or (expected_edge_order == 0 and edge_id != corridor_record["startEdgeId"])
                or (expected_edge_order == 0 and from_node_id != corridor_record["startNodeId"])
            ):
                raise ValueError("terrain pack road corridor order is inconsistent")
            expected_start_distance_meters = end_distance_meters
            prior_to_node_id = to_node_id
        if (
            not corridor_edge_records
            or corridor_edge_records[-1][1] != corridor_record["endEdgeId"]
            or corridor_edge_records[-1][5] != corridor_record["endNodeId"]
            or abs(expected_start_distance_meters - corridor_record["lengthMeters"]) > 0.1
        ):
            raise ValueError("terrain pack road corridor endpoints are inconsistent")

    corridor_sample_counts: dict[int, int] = {}
    profiled_sample_counts: dict[int, int] = {}
    unknown_distances_by_corridor: dict[int, list[float]] = {}
    previous_sample_indexes: dict[int, int] = {}
    previous_sample_distances: dict[int, float] = {}
    corridor_sample_count = 0
    for row in connection.execute(
        """SELECT corridor_id, sample_index, distance_meters, longitude, latitude,
                  terrain_elevation_meters, profile_elevation_meters, grade_percent,
                  source_reason, quality_flags_json
           FROM road_corridor_elevation_samples ORDER BY corridor_id, sample_index"""
    ):
        (
            corridor_id,
            sample_index,
            distance_meters,
            longitude,
            latitude,
            terrain_elevation_meters,
            profile_elevation_meters,
            grade_percent,
            source_reason,
            quality_flags_json,
        ) = row
        expected_sample_index = previous_sample_indexes.get(corridor_id, -1) + 1
        prior_distance_meters = previous_sample_distances.get(corridor_id)
        if (
            corridor_id not in corridor_records
            or type(sample_index) is not int
            or sample_index != expected_sample_index
            or not _is_finite_number(distance_meters)
            or distance_meters < 0
            or (prior_distance_meters is not None and distance_meters <= prior_distance_meters)
            or not _is_finite_number(longitude)
            or not -180 <= longitude <= 180
            or not _is_finite_number(latitude)
            or not -90 <= latitude <= 90
            or distance_meters > corridor_records[corridor_id]["lengthMeters"] + 0.1
            or (sample_index == 0 and distance_meters > 0.1)
            or any(
                elevation is not None and not _is_finite_number(elevation)
                for elevation in (terrain_elevation_meters, profile_elevation_meters, grade_percent)
            )
            or (profile_elevation_meters is None and grade_percent is not None)
            or source_reason not in {None, "out_of_coverage", "nodata", "incomplete_neighborhood"}
        ):
            raise ValueError("terrain pack contains an invalid road corridor elevation sample")
        try:
            quality_flags = json.loads(quality_flags_json)
        except (TypeError, json.JSONDecodeError) as error:
            raise ValueError("terrain pack road corridor sample has invalid quality flags") from error
        if not isinstance(quality_flags, list) or any(not isinstance(flag, str) for flag in quality_flags):
            raise ValueError("terrain pack road corridor sample has invalid quality flags")
        if "structure_surface_unknown" in quality_flags and (
            profile_elevation_meters is not None or grade_percent is not None
        ):
            raise ValueError("terrain pack assigns an elevation to an unknown corridor surface")
        if profile_elevation_meters is None:
            unknown_distances_by_corridor.setdefault(corridor_id, []).append(distance_meters)
        else:
            profiled_sample_counts[corridor_id] = profiled_sample_counts.get(corridor_id, 0) + 1
        previous_sample_indexes[corridor_id] = sample_index
        previous_sample_distances[corridor_id] = distance_meters
        corridor_sample_counts[corridor_id] = corridor_sample_counts.get(corridor_id, 0) + 1
        corridor_sample_count += 1

    profiled_corridor_count = sum(count >= 2 for count in profiled_sample_counts.values())
    continuous_corridor_count = sum(
        corridor_record["edgeCount"] > 1 and profiled_sample_counts.get(corridor_id, 0) >= 2
        for corridor_id, corridor_record in corridor_records.items()
    )
    for corridor_id, corridor_record in corridor_records.items():
        corridor_sample_total = corridor_sample_counts.get(corridor_id, 0)
        profiled_sample_count = profiled_sample_counts.get(corridor_id, 0)
        expected_profile_quality = (
            "unavailable"
            if profiled_sample_count == 0
            else "complete"
            if corridor_sample_total == profiled_sample_count
            else "partial"
        )
        if (
            corridor_sample_total < 2
            or corridor_record["profileQuality"] != expected_profile_quality
        ):
            raise ValueError("terrain pack road corridor profile quality is inconsistent")

    corridor_climb_candidate_count = 0
    for row in connection.execute(
        """SELECT corridor_id, start_distance_meters, end_distance_meters, distance_meters,
                  net_rise_meters, ascent_meters, descent_meters, average_grade_percent,
                  max_grade_percent, start_elevation_meters, end_elevation_meters, completeness
           FROM road_corridor_climbs"""
    ):
        (
            corridor_id,
            start_distance_meters,
            end_distance_meters,
            distance_meters,
            net_rise_meters,
            ascent_meters,
            descent_meters,
            average_grade_percent,
            max_grade_percent,
            start_elevation_meters,
            end_elevation_meters,
            completeness,
        ) = row
        climb_values = (
            start_distance_meters,
            end_distance_meters,
            distance_meters,
            net_rise_meters,
            ascent_meters,
            descent_meters,
            average_grade_percent,
            max_grade_percent,
            start_elevation_meters,
            end_elevation_meters,
        )
        corridor_length_meters = corridor_records.get(corridor_id, {}).get("lengthMeters")
        if (
            corridor_id not in corridor_records
            or not all(_is_finite_number(value) for value in climb_values)
            or start_distance_meters < 0
            or end_distance_meters < start_distance_meters
            or distance_meters <= 0
            or end_distance_meters > corridor_length_meters + 0.1
            or ascent_meters < 0
            or descent_meters < 0
            or completeness != "corridor_local_candidate"
            or any(
                start_distance_meters <= unknown_distance <= end_distance_meters
                for unknown_distance in unknown_distances_by_corridor.get(corridor_id, [])
            )
        ):
            raise ValueError("terrain pack contains an invalid corridor climb candidate")
        corridor_climb_candidate_count += 1

    boundary_states = [
        boundary_state
        for corridor_record in corridor_records.values()
        for boundary_state in (
            corridor_record["startBoundaryState"],
            corridor_record["endBoundaryState"],
        )
    ]
    expected_corridor_counts = {
        "corridorCount": len(corridor_records),
        "profiledCorridorCount": profiled_corridor_count,
        "continuousCorridorCount": continuous_corridor_count,
        "corridorSampleCount": corridor_sample_count,
        "corridorClimbCandidateCount": corridor_climb_candidate_count,
        "decisionBoundaryCount": boundary_states.count("decision"),
        "restrictionBoundaryCount": boundary_states.count("restriction"),
        "deadEndBoundaryCount": boundary_states.count("dead_end"),
        "mergeBoundaryCount": boundary_states.count("merge"),
        "edgeLimitBoundaryCount": boundary_states.count("edge_limit"),
    }
    if any(
        type(road_profiles.get(key)) is not int or road_profiles.get(key) != expected_value
        for key, expected_value in expected_corridor_counts.items()
    ):
        raise ValueError("terrain pack road corridor counts do not match its database")
    if (
        road_profiles.get("continuousCorridorsAvailable") is not (continuous_corridor_count > 0)
        or road_graph.get("hasContinuousRoadProfiles") is not (continuous_corridor_count > 0)
    ):
        raise ValueError("terrain pack continuous road profile capability does not match its database")


def _is_finite_number(value: object) -> bool:
    return type(value) in {int, float} and math.isfinite(value)


def _is_timezone_aware_iso8601(value: str) -> bool:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is not None
    except ValueError:
        return False


def _write_signed_files(package_path: Path, manifest_bytes: bytes, signature_bytes: bytes) -> None:
    manifest_path = package_path / "manifest.json"
    signature_path = package_path / _SIGNATURE_FILE_NAME
    manifest_permissions = stat.S_IMODE(manifest_path.stat().st_mode)
    temporary_files: list[Path] = []

    try:
        temporary_manifest = _write_temporary_file(package_path, manifest_bytes, manifest_permissions)
        temporary_files.append(temporary_manifest)
        temporary_signature = _write_temporary_file(package_path, signature_bytes, 0o644)
        temporary_files.append(temporary_signature)
        os.replace(temporary_signature, signature_path)
        os.replace(temporary_manifest, manifest_path)
        _sync_directory(package_path)
    except OSError as error:
        try:
            signature_path.unlink(missing_ok=True)
            _sync_directory(package_path)
        except OSError:
            pass
        raise ValueError("signed terrain pack could not be written atomically") from error
    finally:
        for temporary_file in temporary_files:
            temporary_file.unlink(missing_ok=True)


def _write_temporary_file(directory: Path, contents: bytes, permissions: int) -> Path:
    file_descriptor, temporary_path_string = tempfile.mkstemp(prefix=".terrain-signing-", dir=directory)
    temporary_path = Path(temporary_path_string)
    try:
        os.fchmod(file_descriptor, permissions)
        with os.fdopen(file_descriptor, "wb") as output_file:
            output_file.write(contents)
            output_file.flush()
            os.fsync(output_file.fileno())
    except Exception:
        try:
            os.close(file_descriptor)
        except OSError:
            pass
        temporary_path.unlink(missing_ok=True)
        raise
    return temporary_path


def _sync_directory(directory: Path) -> None:
    directory_descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(directory_descriptor)
    finally:
        os.close(directory_descriptor)


def _file_sha256(file_path: Path) -> str:
    file_hash = hashlib.sha256()
    with file_path.open("rb") as pack_file:
        for chunk in iter(lambda: pack_file.read(1024 * 1024), b""):
            file_hash.update(chunk)
    return file_hash.hexdigest()
