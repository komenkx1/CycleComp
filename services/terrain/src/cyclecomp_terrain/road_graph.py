from __future__ import annotations

from datetime import datetime
from dataclasses import dataclass
import hashlib
import json
import logging
import math
from pathlib import Path
import sqlite3
import shutil
import struct
import tempfile
from typing import Any
from urllib.parse import urlparse

from geographiclib.geodesic import Geodesic


_ROAD_HIGHWAY_VALUES = {
    "bridleway",
    "cycleway",
    "footway",
    "living_street",
    "motorway",
    "motorway_link",
    "path",
    "pedestrian",
    "primary",
    "primary_link",
    "residential",
    "road",
    "secondary",
    "secondary_link",
    "service",
    "steps",
    "tertiary",
    "tertiary_link",
    "track",
    "trunk",
    "trunk_link",
    "unclassified",
}
_OPPOSITE_CYCLEWAY_VALUES = {"opposite", "opposite_lane", "opposite_track"}
_ROAD_NODE_TAGS = {
    "access", "access:conditional", "barrier", "bicycle", "bicycle:conditional",
    "vehicle", "vehicle:conditional", "crossing", "ford", "highway", "traffic_calming",
}
BICYCLE_ACCESS_POLICY_VERSION = "cyclecomp-bicycle-access-v1"
_INFERRED_BICYCLE_ROAD_CLASSES = {
    "cycleway", "living_street", "primary", "primary_link", "residential",
    "secondary", "secondary_link", "tertiary", "tertiary_link", "trunk", "trunk_link", "unclassified",
}
MIN_MEASURABLE_SEGMENT_LENGTH_METERS = 0.01
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RoadGraphBuildResult:
    node_count: int
    segment_count: int
    directed_edge_count: int
    restriction_count: int
    skipped_missing_location_ways: int
    skipped_degenerate_segment_count: int
    pbf_sha256: str
    selected_bounds_wgs84: tuple[float, float, float, float]

    def as_manifest_record(
        self,
        source_url: str,
        snapshot_at: str,
        buffer_meters: float,
    ) -> dict[str, object]:
        return {
            "sourceUrl": source_url,
            "snapshotAt": snapshot_at,
            "pbfSha256": self.pbf_sha256,
            "selectedBoundsWgs84": list(self.selected_bounds_wgs84),
            "bufferMeters": buffer_meters,
            "nodeCount": self.node_count,
            "physicalSegmentCount": self.segment_count,
            "directedEdgeCount": self.directed_edge_count,
            "turnRestrictionCount": self.restriction_count,
            "skippedMissingLocationWayCount": self.skipped_missing_location_ways,
            "skippedDegenerateSegmentCount": self.skipped_degenerate_segment_count,
            "license": "ODbL-1.0",
            "attribution": "© OpenStreetMap contributors",
            "odblDatabaseDistributionRequired": True,
            "hasElevationProfiles": False,
            "coverageStatus": "pilot_partial",
            "bicycleAccessPolicyVersion": BICYCLE_ACCESS_POLICY_VERSION,
        }


def add_osm_road_graph(
    database_path: Path,
    osm_pbf_path: Path,
    requested_bounds_wgs84: tuple[float, float, float, float],
    source_url: str,
    snapshot_at: str,
    buffer_meters: float = 1_000,
) -> RoadGraphBuildResult:
    if not isinstance(source_url, str) or not isinstance(snapshot_at, str):
        raise ValueError("OSM provenance requires a source URL and snapshot timestamp")
    try:
        import osmium
    except ImportError as error:
        raise ValueError("building an OSM road graph requires the pinned osmium dependency") from error

    selected_bounds = _bounds_with_buffer(requested_bounds_wgs84, buffer_meters)
    requested_pbf_path = osm_pbf_path.expanduser()
    if requested_pbf_path.is_symlink():
        raise ValueError("OSM PBF input must be a regular, non-symlink file")
    pbf_path = requested_pbf_path.resolve(strict=True)
    if not pbf_path.is_file():
        raise ValueError("OSM PBF input must be a regular, non-symlink file")
    try:
        parsed_snapshot = datetime.fromisoformat(snapshot_at.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("OSM snapshot timestamp must be ISO 8601") from error
    parsed_source_url = urlparse(source_url)
    if (
        parsed_source_url.scheme != "https"
        or not parsed_source_url.hostname
        or parsed_source_url.username is not None
        or parsed_source_url.password is not None
        or not snapshot_at.strip()
        or parsed_snapshot.tzinfo is None
    ):
        raise ValueError("OSM provenance requires an HTTPS source URL and snapshot timestamp")

    pbf_sha256 = _file_sha256(pbf_path)
    connection = sqlite3.connect(database_path)
    connection.execute("PRAGMA foreign_keys = ON")
    staging_directory = Path(
        tempfile.mkdtemp(prefix="cyclecomp-osm-locations-", dir=database_path.parent)
    )
    location_index_path = staging_directory / "node-locations"

    try:
        _create_staging_tables(connection)

        class RoadPbfHandler(osmium.SimpleHandler):
            skipped_missing_location_ways = 0
            visited_node_count = 0
            visited_way_count = 0

            def node(self, node: Any) -> None:
                self.visited_node_count += 1
                if self.visited_node_count % 1_000_000 == 0:
                    logger.info("OSM input: %d nodes read", self.visited_node_count)
                if not node.location.valid():
                    return
                if not _coordinate_is_inside_bounds(node.lon, node.lat, selected_bounds):
                    return
                node_tags = {tag.k: tag.v for tag in node.tags if tag.k in _ROAD_NODE_TAGS}
                if not node_tags:
                    return
                connection.execute(
                    """INSERT OR REPLACE INTO osm_road_node_attributes(
                           node_id, longitude, latitude, tags_json
                       ) VALUES (?, ?, ?, ?)""",
                    (node.id, node.lon, node.lat, _canonical_json(node_tags)),
                )

            def way(self, way: Any) -> None:
                self.visited_way_count += 1
                if self.visited_way_count % 50_000 == 0:
                    logger.info("OSM input: %d ways read", self.visited_way_count)
                tags = {tag.k: tag.v for tag in way.tags}
                if tags.get("highway") not in _ROAD_HIGHWAY_VALUES:
                    return

                way_nodes: list[tuple[int, float, float]] = []
                for node in way.nodes:
                    if not node.location.valid():
                        self.skipped_missing_location_ways += 1
                        return
                    way_nodes.append((node.ref, node.lon, node.lat))

                if len(way_nodes) < 2 or not _way_intersects_bounds(way_nodes, selected_bounds):
                    return

                connection.execute(
                    "INSERT INTO osm_road_ways(way_id, tags_json) VALUES (?, ?)",
                    (way.id, _canonical_json(tags)),
                )
                connection.executemany(
                    """INSERT INTO osm_road_way_nodes(
                           way_id, ordinal, node_id, longitude, latitude
                       ) VALUES (?, ?, ?, ?, ?)""",
                    [
                        (way.id, ordinal, node_id, longitude, latitude)
                        for ordinal, (node_id, longitude, latitude) in enumerate(way_nodes)
                    ],
                )
                connection.executemany(
                    "INSERT OR IGNORE INTO osm_road_node_ways(node_id, way_id) VALUES (?, ?)",
                    [(node_id, way.id) for node_id, _, _ in way_nodes],
                )

            def relation(self, relation: Any) -> None:
                tags = {tag.k: tag.v for tag in relation.tags}
                if tags.get("type") != "restriction":
                    return

                members = [
                    {"type": member.type, "ref": member.ref, "role": member.role}
                    for member in relation.members
                ]
                restriction_value = tags.get("restriction") or tags.get("restriction:bicycle")
                conditional_value = tags.get("restriction:conditional") or tags.get(
                    "restriction:bicycle:conditional"
                )
                from_to_way_ids = [
                    member["ref"]
                    for member in members
                    if member["type"] == "w" and member["role"] in {"from", "to"}
                ]
                via_node_ids = [
                    member["ref"]
                    for member in members
                    if member["type"] == "n" and member["role"] == "via"
                ]
                road_relation_touches_area = any(
                    connection.execute(
                        "SELECT 1 FROM osm_road_ways WHERE way_id = ? LIMIT 1",
                        (way_id,),
                    ).fetchone()
                    is not None
                    for way_id in from_to_way_ids
                ) or any(
                    connection.execute(
                        "SELECT 1 FROM osm_road_way_nodes WHERE node_id = ? LIMIT 1",
                        (node_id,),
                    ).fetchone()
                    is not None
                    for node_id in via_node_ids
                )
                if not road_relation_touches_area:
                    return
                connection.execute(
                    """INSERT INTO osm_turn_restrictions(
                           relation_id, restriction_value, conditional_value, tags_json, members_json
                       ) VALUES (?, ?, ?, ?, ?)""",
                    (
                        relation.id,
                        restriction_value,
                        conditional_value,
                        _canonical_json(tags),
                        _canonical_json(members),
                    ),
                )

        handler = RoadPbfHandler()
        connection.execute("BEGIN")
        logger.info("Reading OSM PBF: %s (%d bytes)", pbf_path.name, pbf_path.stat().st_size)
        try:
            handler.apply_file(
                pbf_path,
                locations=True,
                idx=f"sparse_file_array,{location_index_path}",
            )
        except Exception as error:
            raise ValueError("OSM PBF could not be parsed with a persistent node-location index") from error
        connection.commit()
        selected_way_count = connection.execute("SELECT COUNT(*) FROM osm_road_ways").fetchone()[0]
        logger.info("OSM input read; building graph from %d selected ways", selected_way_count)

        road_graph = _write_graph_tables(
            connection,
            pbf_sha256,
            source_url,
            snapshot_at,
            selected_bounds,
            buffer_meters,
            handler.skipped_missing_location_ways,
        )
        connection.commit()
        integrity_result = connection.execute("PRAGMA integrity_check").fetchone()
        if integrity_result != ("ok",):
            raise ValueError("terrain pack SQLite integrity check failed after adding the road graph")
        foreign_key_error = connection.execute("PRAGMA foreign_key_check").fetchone()
        if foreign_key_error is not None:
            raise ValueError("terrain pack road graph contains an invalid relationship")
        if road_graph.directed_edge_count == 0:
            raise ValueError("OSM PBF contains no supported road segments inside the selected area")
        logger.info(
            "Road graph ready: %d edges; %d degenerate segments excluded",
            road_graph.directed_edge_count,
            road_graph.skipped_degenerate_segment_count,
        )
        return road_graph
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()
        shutil.rmtree(staging_directory, ignore_errors=True)


def _create_staging_tables(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE osm_road_ways (
            way_id INTEGER PRIMARY KEY,
            tags_json TEXT NOT NULL
        ) WITHOUT ROWID;
        CREATE TABLE osm_road_way_nodes (
            way_id INTEGER NOT NULL REFERENCES osm_road_ways(way_id),
            ordinal INTEGER NOT NULL,
            node_id INTEGER NOT NULL,
            longitude REAL NOT NULL,
            latitude REAL NOT NULL,
            PRIMARY KEY (way_id, ordinal)
        ) WITHOUT ROWID;
        CREATE INDEX osm_road_way_nodes_by_node ON osm_road_way_nodes(node_id);
        CREATE TABLE osm_road_node_ways (
            node_id INTEGER NOT NULL,
            way_id INTEGER NOT NULL REFERENCES osm_road_ways(way_id),
            PRIMARY KEY (node_id, way_id)
        ) WITHOUT ROWID;
        CREATE TABLE osm_road_node_attributes (
            node_id INTEGER PRIMARY KEY,
            longitude REAL NOT NULL,
            latitude REAL NOT NULL,
            tags_json TEXT NOT NULL
        ) WITHOUT ROWID;
        CREATE TABLE osm_turn_restrictions (
            relation_id INTEGER PRIMARY KEY,
            restriction_value TEXT,
            conditional_value TEXT,
            tags_json TEXT NOT NULL,
            members_json TEXT NOT NULL
        ) WITHOUT ROWID;
        """
    )


def _write_graph_tables(
    connection: sqlite3.Connection,
    pbf_sha256: str,
    source_url: str,
    snapshot_at: str,
    selected_bounds: tuple[float, float, float, float],
    buffer_meters: float,
    skipped_missing_location_ways: int,
) -> RoadGraphBuildResult:
    connection.executescript(
        """
        CREATE TABLE road_graph_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        ) WITHOUT ROWID;
        CREATE TABLE road_nodes (
            node_id INTEGER PRIMARY KEY,
            longitude REAL NOT NULL CHECK(longitude BETWEEN -180 AND 180),
            latitude REAL NOT NULL CHECK(latitude BETWEEN -90 AND 90),
            attributes_json TEXT NOT NULL
        );
        CREATE TABLE road_segments (
            segment_id INTEGER PRIMARY KEY,
            osm_way_id INTEGER NOT NULL,
            segment_index INTEGER NOT NULL,
            from_node_id INTEGER NOT NULL REFERENCES road_nodes(node_id),
            to_node_id INTEGER NOT NULL REFERENCES road_nodes(node_id),
            length_meters REAL NOT NULL CHECK(length_meters >= 0),
            highway TEXT NOT NULL,
            name TEXT,
            surface TEXT,
            bicycle_access TEXT NOT NULL,
            oneway_state TEXT NOT NULL,
            bridge TEXT,
            tunnel TEXT,
            layer TEXT,
            geometry_wgs84_f64le BLOB NOT NULL,
            tags_json TEXT NOT NULL,
            UNIQUE(osm_way_id, segment_index)
        );
        CREATE INDEX road_segments_by_way ON road_segments(osm_way_id);
        CREATE TABLE road_edges (
            edge_id INTEGER PRIMARY KEY,
            segment_id INTEGER NOT NULL REFERENCES road_segments(segment_id),
            from_node_id INTEGER NOT NULL REFERENCES road_nodes(node_id),
            to_node_id INTEGER NOT NULL REFERENCES road_nodes(node_id),
            direction INTEGER NOT NULL CHECK(direction IN (-1, 1)),
            direction_state TEXT NOT NULL,
            bicycle_access TEXT NOT NULL,
            matchable INTEGER NOT NULL CHECK(matchable IN (0, 1)),
            predictable INTEGER NOT NULL CHECK(predictable IN (0, 1)),
            UNIQUE(segment_id, direction)
        );
        CREATE INDEX road_edges_by_from_node ON road_edges(from_node_id);
        CREATE VIRTUAL TABLE road_edge_index USING rtree(
            edge_id, minimum_longitude, maximum_longitude, minimum_latitude, maximum_latitude
        );
        CREATE TABLE road_turn_restrictions (
            relation_id INTEGER PRIMARY KEY,
            restriction_value TEXT,
            conditional_value TEXT,
            from_way_ids_json TEXT NOT NULL,
            to_way_ids_json TEXT NOT NULL,
            via_node_ids_json TEXT NOT NULL,
            via_way_ids_json TEXT NOT NULL,
            members_json TEXT NOT NULL,
            tags_json TEXT NOT NULL,
            interpretation_state TEXT NOT NULL
        ) WITHOUT ROWID;
        """
    )

    connection.execute(
        "CREATE TABLE osm_node_usage AS SELECT node_id, COUNT(*) AS way_count "
        "FROM osm_road_node_ways GROUP BY node_id"
    )
    connection.execute("CREATE UNIQUE INDEX osm_node_usage_by_id ON osm_node_usage(node_id)")

    segment_count = 0
    directed_edge_count = 0
    skipped_degenerate_segment_count = 0
    next_segment_id = 0
    next_edge_id = 0
    current_way_id: int | None = None
    current_tags: dict[str, str] = {}
    way_nodes: list[tuple[int, float, float, int, str]] = []
    cursor = connection.execute(
        """SELECT way.way_id, way.tags_json, point.ordinal, point.node_id,
                  point.longitude, point.latitude, COALESCE(usage.way_count, 0),
                  COALESCE(attributes.tags_json, '{}')
           FROM osm_road_ways AS way
           JOIN osm_road_way_nodes AS point ON point.way_id = way.way_id
           LEFT JOIN osm_node_usage AS usage ON usage.node_id = point.node_id
           LEFT JOIN osm_road_node_attributes AS attributes ON attributes.node_id = point.node_id
           ORDER BY way.way_id, point.ordinal"""
    )

    for row in cursor:
        way_id, tags_json, ordinal, node_id, longitude, latitude, way_count, node_tags_json = row
        if current_way_id is None:
            current_way_id = way_id
            current_tags = json.loads(tags_json)
        elif way_id != current_way_id:
            way_segment_count, way_edge_count, skipped_degenerate_way_segments = _write_way_segments(
                connection,
                current_way_id,
                current_tags,
                way_nodes,
                next_segment_id,
                next_edge_id,
            )
            segment_count += way_segment_count
            directed_edge_count += way_edge_count
            skipped_degenerate_segment_count += skipped_degenerate_way_segments
            next_segment_id += way_segment_count
            next_edge_id += way_edge_count
            current_way_id = way_id
            current_tags = json.loads(tags_json)
            way_nodes = []
        way_nodes.append((node_id, longitude, latitude, way_count, node_tags_json))

    if current_way_id is not None:
        way_segment_count, way_edge_count, skipped_degenerate_way_segments = _write_way_segments(
            connection,
            current_way_id,
            current_tags,
            way_nodes,
            next_segment_id,
            next_edge_id,
        )
        segment_count += way_segment_count
        directed_edge_count += way_edge_count
        skipped_degenerate_segment_count += skipped_degenerate_way_segments

    _write_turn_restrictions(connection)
    restriction_count = connection.execute("SELECT COUNT(*) FROM road_turn_restrictions").fetchone()[0]
    node_count = connection.execute("SELECT COUNT(*) FROM road_nodes").fetchone()[0]
    connection.execute("DROP TABLE osm_node_usage")
    connection.execute("DROP TABLE osm_road_node_ways")
    connection.execute("DROP TABLE osm_road_way_nodes")
    connection.execute("DROP TABLE osm_road_node_attributes")
    connection.execute("DROP TABLE osm_road_ways")
    connection.execute("DROP TABLE osm_turn_restrictions")

    metadata = {
        "pbfSha256": pbf_sha256,
        "sourceUrl": source_url,
        "snapshotAt": snapshot_at,
        "selectedBoundsWgs84": list(selected_bounds),
        "bufferMeters": buffer_meters,
        "nodeCount": node_count,
        "physicalSegmentCount": segment_count,
        "directedEdgeCount": directed_edge_count,
        "turnRestrictionCount": restriction_count,
        "skippedMissingLocationWayCount": skipped_missing_location_ways,
        "skippedDegenerateSegmentCount": skipped_degenerate_segment_count,
        "license": "ODbL-1.0",
        "attribution": "© OpenStreetMap contributors",
        "odblDatabaseDistributionRequired": True,
        "hasElevationProfiles": False,
        "coverageStatus": "pilot_partial",
        "bicycleAccessPolicyVersion": BICYCLE_ACCESS_POLICY_VERSION,
    }
    connection.executemany(
        "INSERT INTO road_graph_metadata(key, value) VALUES (?, ?)",
        [(key, _canonical_json(value)) for key, value in metadata.items()],
    )
    connection.executemany(
        "INSERT OR REPLACE INTO pack_metadata(key, value) VALUES (?, ?)",
        [
            ("graphVersion", _canonical_json("osm-directed-v1")),
            ("hasRoadGraph", _canonical_json(True)),
            ("hasRoadProfiles", _canonical_json(False)),
        ],
    )
    return RoadGraphBuildResult(
        node_count=node_count,
        segment_count=segment_count,
        directed_edge_count=directed_edge_count,
        restriction_count=restriction_count,
        skipped_missing_location_ways=skipped_missing_location_ways,
        skipped_degenerate_segment_count=skipped_degenerate_segment_count,
        pbf_sha256=pbf_sha256,
        selected_bounds_wgs84=selected_bounds,
    )


def _write_way_segments(
    connection: sqlite3.Connection,
    way_id: int,
    tags: dict[str, str],
    way_nodes: list[tuple[int, float, float, int, str]],
    first_segment_id: int,
    first_edge_id: int,
) -> tuple[int, int, int]:
    if len(way_nodes) < 2:
        return 0, 0, 0

    split_indices = [0]
    seen_node_ids: set[int] = {way_nodes[0][0]}
    for node_index in range(1, len(way_nodes) - 1):
        node_id, _, _, way_count, node_tags_json = way_nodes[node_index]
        is_repeated_node = node_id in seen_node_ids
        seen_node_ids.add(node_id)
        if way_count > 1 or is_repeated_node or node_tags_json != "{}":
            split_indices.append(node_index)
    split_indices.append(len(way_nodes) - 1)
    split_indices = sorted(set(split_indices))

    access_state = _bicycle_access_state(tags)
    oneway_state = _bicycle_oneway_state(tags)
    segment_count = 0
    edge_count = 0
    skipped_degenerate_segment_count = 0

    for segment_index, (start_index, end_index) in enumerate(zip(split_indices, split_indices[1:])):
        segment_nodes = way_nodes[start_index : end_index + 1]
        if len(segment_nodes) < 2:
            continue

        coordinates = [(longitude, latitude) for _, longitude, latitude, _, _ in segment_nodes]
        length_meters = _geodesic_length_meters(coordinates)
        if length_meters <= MIN_MEASURABLE_SEGMENT_LENGTH_METERS:
            skipped_degenerate_segment_count += 1
            continue
        segment_id = first_segment_id + segment_count
        start_node = segment_nodes[0]
        end_node = segment_nodes[-1]
        connection_rows = [
            (start_node[0], start_node[1], start_node[2], start_node[4]),
            (end_node[0], end_node[1], end_node[2], end_node[4]),
        ]
        connection.executemany(
            """INSERT OR IGNORE INTO road_nodes(
                   node_id, longitude, latitude, attributes_json
               ) VALUES (?, ?, ?, ?)""",
            connection_rows,
        )
        connection.execute(
            """INSERT INTO road_segments(
                   segment_id, osm_way_id, segment_index, from_node_id, to_node_id,
                   length_meters, highway, name, surface, bicycle_access, oneway_state,
                   bridge, tunnel, layer, geometry_wgs84_f64le, tags_json
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                segment_id,
                way_id,
                segment_index,
                start_node[0],
                end_node[0],
                length_meters,
                tags["highway"],
                tags.get("name"),
                tags.get("surface"),
                access_state,
                oneway_state,
                tags.get("bridge"),
                tags.get("tunnel"),
                tags.get("layer"),
                _encode_geometry(coordinates),
                _canonical_json(tags),
            ),
        )

        allowed_direction_ids = _allowed_bicycle_directions(oneway_state)
        for direction, from_node, to_node, direction_coordinates in (
            (1, start_node, end_node, coordinates),
            (-1, end_node, start_node, list(reversed(coordinates))),
        ):
            direction_access_state = _directional_bicycle_access_state(tags, direction)
            direction_state = _direction_state(direction, allowed_direction_ids, oneway_state)
            predictable = direction_state == "allowed" and direction_access_state in {
                "allowed", "road_class_inferred",
            }
            edge_id = first_edge_id + edge_count
            connection.execute(
                """INSERT INTO road_edges(
                       edge_id, segment_id, from_node_id, to_node_id, direction,
                       direction_state, bicycle_access, matchable, predictable
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)""",
                (
                    edge_id,
                    segment_id,
                    from_node[0],
                    to_node[0],
                    direction,
                    direction_state,
                    direction_access_state,
                    int(predictable),
                ),
            )
            connection.execute(
                """INSERT INTO road_edge_index(
                       edge_id, minimum_longitude, maximum_longitude,
                       minimum_latitude, maximum_latitude
                   ) VALUES (?, ?, ?, ?, ?)""",
                (
                    edge_id,
                    min(longitude for longitude, _ in direction_coordinates),
                    max(longitude for longitude, _ in direction_coordinates),
                    min(latitude for _, latitude in direction_coordinates),
                    max(latitude for _, latitude in direction_coordinates),
                ),
            )
            edge_count += 1

        segment_count += 1

    return segment_count, edge_count, skipped_degenerate_segment_count


def _write_turn_restrictions(connection: sqlite3.Connection) -> None:
    for relation_id, restriction_value, conditional_value, tags_json, members_json in connection.execute(
        "SELECT relation_id, restriction_value, conditional_value, tags_json, members_json "
        "FROM osm_turn_restrictions ORDER BY relation_id"
    ):
        members = json.loads(members_json)
        from_way_ids = [member["ref"] for member in members if member["type"] == "w" and member["role"] == "from"]
        to_way_ids = [member["ref"] for member in members if member["type"] == "w" and member["role"] == "to"]
        via_node_ids = [member["ref"] for member in members if member["type"] == "n" and member["role"] == "via"]
        via_way_ids = [member["ref"] for member in members if member["type"] == "w" and member["role"] == "via"]
        if conditional_value:
            interpretation_state = "conditional_unknown"
        elif len(from_way_ids) == 1 and len(to_way_ids) == 1 and len(via_node_ids) == 1 and not via_way_ids:
            interpretation_state = "node_restriction_preserved"
        elif len(from_way_ids) == 1 and len(to_way_ids) == 1 and via_way_ids:
            interpretation_state = "via_way_restriction_preserved"
        else:
            interpretation_state = "unsupported_members_preserved"
        connection.execute(
            """INSERT INTO road_turn_restrictions(
                   relation_id, restriction_value, conditional_value,
                   from_way_ids_json, to_way_ids_json, via_node_ids_json, via_way_ids_json,
                   members_json, tags_json, interpretation_state
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                relation_id,
                restriction_value,
                conditional_value,
                _canonical_json(from_way_ids),
                _canonical_json(to_way_ids),
                _canonical_json(via_node_ids),
                _canonical_json(via_way_ids),
                members_json,
                tags_json,
                interpretation_state,
            ),
        )


def _bicycle_access_state(tags: dict[str, str]) -> str:
    return _access_state_for_direction(tags, None)


def _access_state_for_direction(tags: dict[str, str], direction: int | None) -> str:
    direction_name = "forward" if direction == 1 else "backward"
    for access_key in ("bicycle", "vehicle", "access"):
        access_keys = [f"{access_key}:{direction_name}", access_key] if direction else [access_key]
        for tag_key in access_keys:
            if tags.get(f"{tag_key}:conditional", "").strip():
                return "conditional"
            if tags.get(tag_key, "").strip():
                return _classify_access_value(tags[tag_key])

    # Consumer fallback, not surveyed access: keep its provenance distinct from an explicit yes.
    if (
        tags.get("highway") in _INFERRED_BICYCLE_ROAD_CLASSES
        and tags.get("motorroad", "no").strip().lower() in {"no", "false", "0"}
    ):
        return "road_class_inferred"
    return "unknown"


def _directional_bicycle_access_state(tags: dict[str, str], direction: int) -> str:
    return _access_state_for_direction(tags, direction)


def _classify_access_value(value: str) -> str:
    normalized_value = value.strip().lower()
    if normalized_value in {"no", "private", "use_sidepath"}:
        return "prohibited"
    if normalized_value == "dismount":
        return "dismount"
    if normalized_value in {"yes", "designated", "permissive"}:
        return "allowed"
    return "unknown"


def _bicycle_oneway_state(tags: dict[str, str]) -> str:
    if tags.get("oneway:bicycle:conditional"):
        return "conditional"

    bicycle_oneway = tags.get("oneway:bicycle", "").strip().lower()
    if bicycle_oneway:
        return _parse_oneway_value(bicycle_oneway)
    if tags.get("oneway:conditional"):
        return "conditional"

    general_oneway = tags.get("oneway", "").strip().lower()
    if general_oneway:
        general_state = _parse_oneway_value(general_oneway)
    elif tags.get("junction", "").lower() == "roundabout" or tags.get("highway") in {
        "motorway",
        "motorway_link",
    }:
        general_state = "forward"
    else:
        general_state = "both"

    if general_state in {"forward", "reverse"} and _has_opposite_cycleway(tags):
        return "both"
    return general_state


def _parse_oneway_value(value: str) -> str:
    if value in {"yes", "1", "true"}:
        return "forward"
    if value == "-1":
        return "reverse"
    if value in {"no", "0", "false"}:
        return "both"
    if value in {"conditional"} or ":" in value:
        return "conditional"
    return "unknown"


def _has_opposite_cycleway(tags: dict[str, str]) -> bool:
    return any(
        tags.get(key, "").strip().lower() in _OPPOSITE_CYCLEWAY_VALUES
        for key in ("cycleway", "cycleway:left", "cycleway:right", "cycleway:both")
    )


def _allowed_bicycle_directions(oneway_state: str) -> set[int]:
    if oneway_state == "both":
        return {-1, 1}
    if oneway_state == "forward":
        return {1}
    if oneway_state == "reverse":
        return {-1}
    return set()


def _direction_state(direction: int, allowed_directions: set[int], oneway_state: str) -> str:
    if direction in allowed_directions:
        return "allowed"
    if oneway_state == "conditional":
        return "conditional"
    if oneway_state == "unknown":
        return "unknown"
    return "prohibited"


def _bounds_with_buffer(
    bounds: tuple[float, float, float, float],
    buffer_meters: float,
) -> tuple[float, float, float, float]:
    west, south, east, north = bounds
    if (
        not all(math.isfinite(value) for value in bounds)
        or west < -180
        or east > 180
        or south < -90
        or north > 90
        or west >= east
        or south >= north
        or not math.isfinite(buffer_meters)
        or buffer_meters < 0
        or buffer_meters > 100_000
    ):
        raise ValueError("road graph bounds or buffer distance are invalid")

    middle_latitude = (south + north) / 2
    latitude_buffer = buffer_meters / 111_320
    longitude_scale = max(math.cos(math.radians(middle_latitude)), 0.01)
    longitude_buffer = latitude_buffer / longitude_scale
    return (
        max(-180, west - longitude_buffer),
        max(-90, south - latitude_buffer),
        min(180, east + longitude_buffer),
        min(90, north + latitude_buffer),
    )


def _way_intersects_bounds(
    way_nodes: list[tuple[int, float, float]],
    bounds: tuple[float, float, float, float],
) -> bool:
    west, south, east, north = bounds
    coordinates = [(longitude, latitude) for _, longitude, latitude in way_nodes]
    if any(west <= longitude <= east and south <= latitude <= north for longitude, latitude in coordinates):
        return True
    for start, end in zip(coordinates, coordinates[1:]):
        if _segment_intersects_bounds(start, end, bounds):
            return True
    return False


def _segment_intersects_bounds(
    start: tuple[float, float],
    end: tuple[float, float],
    bounds: tuple[float, float, float, float],
) -> bool:
    west, south, east, north = bounds
    minimum_x, maximum_x = sorted((start[0], end[0]))
    minimum_y, maximum_y = sorted((start[1], end[1]))
    if maximum_x < west or minimum_x > east or maximum_y < south or minimum_y > north:
        return False

    dx = end[0] - start[0]
    dy = end[1] - start[1]
    lower = 0.0
    upper = 1.0
    for direction, distance in ((-dx, start[0] - west), (dx, east - start[0]), (-dy, start[1] - south), (dy, north - start[1])):
        if direction == 0:
            if distance < 0:
                return False
            continue
        ratio = distance / direction
        if direction < 0:
            lower = max(lower, ratio)
        else:
            upper = min(upper, ratio)
        if lower > upper:
            return False
    return True


def _geodesic_length_meters(coordinates: list[tuple[float, float]]) -> float:
    return sum(
        Geodesic.WGS84.Inverse(start_latitude, start_longitude, end_latitude, end_longitude)["s12"]
        for (start_longitude, start_latitude), (end_longitude, end_latitude) in zip(
            coordinates,
            coordinates[1:],
        )
    )


def _encode_geometry(coordinates: list[tuple[float, float]]) -> bytes:
    return b"".join(
        struct.pack("<dd", longitude, latitude)
        for longitude, latitude in coordinates
    )


def _coordinate_is_inside_bounds(
    longitude: float,
    latitude: float,
    bounds: tuple[float, float, float, float],
) -> bool:
    west, south, east, north = bounds
    return west <= longitude <= east and south <= latitude <= north


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _file_sha256(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as source_file:
        for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
