from __future__ import annotations

import json
import logging
import sqlite3
from dataclasses import dataclass
from typing import Any, Protocol

from cyclecomp_terrain.road_graph import _bicycle_access_state


MAX_CORRIDOR_EDGE_COUNT = 128
logger = logging.getLogger(__name__)


class RoadProfileKernel(Protocol):
    def analyze_profile(
        self,
        profile_id: int,
        profile_points: list[dict[str, object]],
        road_surface_supported: bool,
    ) -> dict[str, Any]: ...


@dataclass(frozen=True)
class DirectedRoadEdge:
    edge_id: int
    segment_id: int
    osm_way_id: int
    from_node_id: int
    to_node_id: int
    length_meters: float


@dataclass(frozen=True)
class RoadCorridor:
    corridor_id: int
    edge_ids: tuple[int, ...]
    start_boundary_state: str
    end_boundary_state: str


@dataclass(frozen=True)
class RoadCorridorBuildResult:
    corridor_count: int
    profiled_corridor_count: int
    continuous_corridor_count: int
    sample_count: int
    climb_candidate_count: int
    decision_boundary_count: int
    restriction_boundary_count: int
    dead_end_boundary_count: int
    merge_boundary_count: int
    edge_limit_boundary_count: int


def build_road_corridors(
    connection: sqlite3.Connection,
    profile_kernel: RoadProfileKernel,
) -> RoadCorridorBuildResult:
    _create_corridor_tables(connection)
    directed_edges = _load_predictable_edges(connection)
    if not directed_edges:
        return RoadCorridorBuildResult(0, 0, 0, 0, 0, 0, 0, 0, 0, 0)

    outgoing_edges: dict[int, list[DirectedRoadEdge]] = {}
    incoming_edges: dict[int, list[DirectedRoadEdge]] = {}
    for edge in directed_edges.values():
        outgoing_edges.setdefault(edge.from_node_id, []).append(edge)
        incoming_edges.setdefault(edge.to_node_id, []).append(edge)

    restricted_via_nodes, restricted_way_ids = _load_restriction_boundaries(connection)
    restricted_via_nodes.update(_load_access_boundaries(connection))
    successor_by_edge: dict[int, int] = {}
    end_boundary_by_edge: dict[int, str] = {}
    for edge in directed_edges.values():
        if edge.to_node_id in restricted_via_nodes or edge.osm_way_id in restricted_way_ids:
            end_boundary_by_edge[edge.edge_id] = "restriction"
            continue

        candidate_edges = [
            candidate
            for candidate in outgoing_edges.get(edge.to_node_id, [])
            if candidate.segment_id != edge.segment_id
        ]
        if any(candidate.osm_way_id in restricted_way_ids for candidate in candidate_edges):
            end_boundary_by_edge[edge.edge_id] = "restriction"
        elif not candidate_edges:
            end_boundary_by_edge[edge.edge_id] = "dead_end"
        elif len(candidate_edges) > 1:
            end_boundary_by_edge[edge.edge_id] = "decision"
        else:
            successor_by_edge[edge.edge_id] = candidate_edges[0].edge_id

    predecessors_by_edge: dict[int, list[int]] = {}
    for incoming_edge_id, successor_edge_id in successor_by_edge.items():
        predecessors_by_edge.setdefault(successor_edge_id, []).append(incoming_edge_id)

    for successor_edge_id, predecessor_edge_ids in predecessors_by_edge.items():
        if len(predecessor_edge_ids) > 1:
            for predecessor_edge_id in predecessor_edge_ids:
                successor_by_edge.pop(predecessor_edge_id, None)
                end_boundary_by_edge[predecessor_edge_id] = "merge"

    predecessors_by_edge = {}
    for incoming_edge_id, successor_edge_id in successor_by_edge.items():
        predecessors_by_edge.setdefault(successor_edge_id, []).append(incoming_edge_id)

    corridors: list[RoadCorridor] = []
    assigned_edge_ids: set[int] = set()
    start_edge_ids = sorted(
        edge_id for edge_id in directed_edges if edge_id not in predecessors_by_edge
    )
    for start_edge_id in start_edge_ids:
        if start_edge_id not in assigned_edge_ids:
            corridors.append(
                _follow_corridor(
                    start_edge_id,
                    _start_boundary_state(
                        directed_edges[start_edge_id],
                        incoming_edges,
                        end_boundary_by_edge,
                        restricted_via_nodes,
                        restricted_way_ids,
                    ),
                    successor_by_edge,
                    end_boundary_by_edge,
                    assigned_edge_ids,
                )
            )

    for start_edge_id in sorted(set(directed_edges) - assigned_edge_ids):
        corridors.append(
            _follow_corridor(
                start_edge_id,
                "cycle",
                successor_by_edge,
                end_boundary_by_edge,
                assigned_edge_ids,
            )
        )

    if assigned_edge_ids != set(directed_edges):
        raise ValueError("road corridor build did not assign every predictable road edge")

    counters = {
        "profiled_corridor_count": 0,
        "continuous_corridor_count": 0,
        "sample_count": 0,
        "climb_candidate_count": 0,
    }
    logger.info("Preparing profiles for %d road corridors", len(corridors))
    for corridor_index, corridor in enumerate(corridors, start=1):
        corridor_length_meters = sum(
            directed_edges[edge_id].length_meters for edge_id in corridor.edge_ids
        )
        _insert_corridor_record(
            connection,
            corridor,
            directed_edges,
            corridor_length_meters,
        )
        _write_corridor_edges(connection, corridor, directed_edges)
        profile_points = _load_corridor_profile_points(
            connection,
            corridor,
            directed_edges,
        )
        profile = profile_kernel.analyze_profile(corridor.corridor_id, profile_points, True)
        profiled_sample_count = _write_corridor_profile(
            connection,
            corridor.corridor_id,
            profile,
            corridor_length_meters,
        )
        _update_corridor_profile_quality(connection, corridor.corridor_id, profiled_sample_count)
        counters["sample_count"] += len(profile["samples"])
        counters["climb_candidate_count"] += len(profile["climbs"])
        if profiled_sample_count >= 2:
            counters["profiled_corridor_count"] += 1
            if len(corridor.edge_ids) > 1:
                counters["continuous_corridor_count"] += 1
        if corridor_index % 500 == 0 or corridor_index == len(corridors):
            logger.info(
                "Corridor profiles: %d/%d; %d climb candidates",
                corridor_index,
                len(corridors),
                counters["climb_candidate_count"],
            )

    boundary_states = [
        boundary_state
        for corridor in corridors
        for boundary_state in (corridor.start_boundary_state, corridor.end_boundary_state)
    ]
    return RoadCorridorBuildResult(
        corridor_count=len(corridors),
        profiled_corridor_count=counters["profiled_corridor_count"],
        continuous_corridor_count=counters["continuous_corridor_count"],
        sample_count=counters["sample_count"],
        climb_candidate_count=counters["climb_candidate_count"],
        decision_boundary_count=boundary_states.count("decision"),
        restriction_boundary_count=boundary_states.count("restriction"),
        dead_end_boundary_count=boundary_states.count("dead_end"),
        merge_boundary_count=boundary_states.count("merge"),
        edge_limit_boundary_count=boundary_states.count("edge_limit"),
    )


def _create_corridor_tables(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE road_corridors (
            corridor_id INTEGER PRIMARY KEY,
            start_edge_id INTEGER NOT NULL REFERENCES road_edges(edge_id),
            end_edge_id INTEGER NOT NULL REFERENCES road_edges(edge_id),
            start_node_id INTEGER NOT NULL REFERENCES road_nodes(node_id),
            end_node_id INTEGER NOT NULL REFERENCES road_nodes(node_id),
            edge_count INTEGER NOT NULL CHECK(edge_count > 0),
            length_meters REAL NOT NULL CHECK(length_meters > 0),
            profile_quality TEXT NOT NULL CHECK(profile_quality IN ('complete', 'partial', 'unavailable')),
            start_boundary_state TEXT NOT NULL,
            end_boundary_state TEXT NOT NULL
        );
        CREATE INDEX road_corridors_by_start_node ON road_corridors(start_node_id);
        CREATE TABLE road_corridor_edges (
            corridor_id INTEGER NOT NULL REFERENCES road_corridors(corridor_id),
            edge_order INTEGER NOT NULL CHECK(edge_order >= 0),
            edge_id INTEGER NOT NULL UNIQUE REFERENCES road_edges(edge_id),
            start_distance_meters REAL NOT NULL CHECK(start_distance_meters >= 0),
            end_distance_meters REAL NOT NULL CHECK(end_distance_meters > start_distance_meters),
            PRIMARY KEY(corridor_id, edge_order)
        ) WITHOUT ROWID;
        CREATE INDEX road_corridor_edges_by_edge ON road_corridor_edges(edge_id);
        CREATE TABLE road_corridor_elevation_samples (
            corridor_id INTEGER NOT NULL REFERENCES road_corridors(corridor_id),
            sample_index INTEGER NOT NULL CHECK(sample_index >= 0),
            distance_meters REAL NOT NULL CHECK(distance_meters >= 0),
            longitude REAL NOT NULL CHECK(longitude BETWEEN -180 AND 180),
            latitude REAL NOT NULL CHECK(latitude BETWEEN -90 AND 90),
            terrain_elevation_meters REAL,
            profile_elevation_meters REAL,
            grade_percent REAL,
            source_reason TEXT,
            quality_flags_json TEXT NOT NULL,
            PRIMARY KEY(corridor_id, sample_index),
            CHECK(profile_elevation_meters IS NOT NULL OR grade_percent IS NULL)
        ) WITHOUT ROWID;
        CREATE INDEX road_corridor_samples_by_distance
            ON road_corridor_elevation_samples(corridor_id, distance_meters);
        CREATE TABLE road_corridor_climbs (
            corridor_id INTEGER NOT NULL REFERENCES road_corridors(corridor_id),
            climb_index INTEGER NOT NULL CHECK(climb_index > 0),
            start_distance_meters REAL NOT NULL CHECK(start_distance_meters >= 0),
            end_distance_meters REAL NOT NULL CHECK(end_distance_meters >= start_distance_meters),
            distance_meters REAL NOT NULL CHECK(distance_meters > 0),
            net_rise_meters REAL NOT NULL,
            ascent_meters REAL NOT NULL CHECK(ascent_meters >= 0),
            descent_meters REAL NOT NULL CHECK(descent_meters >= 0),
            average_grade_percent REAL NOT NULL,
            max_grade_percent REAL NOT NULL,
            start_elevation_meters REAL NOT NULL,
            end_elevation_meters REAL NOT NULL,
            completeness TEXT NOT NULL CHECK(completeness = 'corridor_local_candidate'),
            PRIMARY KEY(corridor_id, climb_index)
        ) WITHOUT ROWID;
        """
    )


def _load_predictable_edges(connection: sqlite3.Connection) -> dict[int, DirectedRoadEdge]:
    directed_edges: dict[int, DirectedRoadEdge] = {}
    for (
        edge_id,
        segment_id,
        osm_way_id,
        from_node_id,
        to_node_id,
        length_meters,
    ) in connection.execute(
        """SELECT edge.edge_id, edge.segment_id, segment.osm_way_id,
                  edge.from_node_id, edge.to_node_id, segment.length_meters
           FROM road_edges AS edge
           JOIN road_segments AS segment ON segment.segment_id = edge.segment_id
           WHERE edge.predictable = 1
           ORDER BY edge.edge_id"""
    ):
        directed_edges[edge_id] = DirectedRoadEdge(
            edge_id,
            segment_id,
            osm_way_id,
            from_node_id,
            to_node_id,
            length_meters,
        )
    return directed_edges


def _load_restriction_boundaries(
    connection: sqlite3.Connection,
) -> tuple[set[int], set[int]]:
    restricted_via_nodes: set[int] = set()
    restricted_way_ids: set[int] = set()
    for (
        conditional_value,
        from_way_ids_json,
        to_way_ids_json,
        via_node_ids_json,
        via_way_ids_json,
        interpretation_state,
    ) in connection.execute(
        """SELECT conditional_value, from_way_ids_json, to_way_ids_json,
                  via_node_ids_json, via_way_ids_json, interpretation_state
           FROM road_turn_restrictions"""
    ):
        from_way_ids = json.loads(from_way_ids_json)
        to_way_ids = json.loads(to_way_ids_json)
        via_node_ids = json.loads(via_node_ids_json)
        via_way_ids = json.loads(via_way_ids_json)
        restricted_via_nodes.update(via_node_ids)
        if conditional_value or via_way_ids or interpretation_state != "node_restriction_preserved":
            restricted_way_ids.update(from_way_ids)
            restricted_way_ids.update(to_way_ids)
            restricted_way_ids.update(via_way_ids)
    return restricted_via_nodes, restricted_way_ids


def _load_access_boundaries(connection: sqlite3.Connection) -> set[int]:
    boundary_node_ids: set[int] = set()
    for node_id, attributes_json in connection.execute(
        "SELECT node_id, attributes_json FROM road_nodes WHERE attributes_json != '{}'"
    ):
        node_tags = json.loads(attributes_json)
        has_access_tags = any(
            node_tags.get(tag_key, "").strip()
            for tag_key in ("bicycle", "vehicle", "access", "bicycle:conditional", "vehicle:conditional", "access:conditional")
        )
        has_physical_boundary = any(
            node_tags.get(tag_key, "no").strip().lower() not in {"", "no", "false", "0"}
            for tag_key in ("barrier", "ford")
        )
        if (has_access_tags or has_physical_boundary) and _bicycle_access_state(node_tags) != "allowed":
            boundary_node_ids.add(node_id)

    boundary_node_ids.update(
        node_id
        for node_id, in connection.execute(
            """SELECT DISTINCT from_node_id FROM road_edges
               WHERE predictable = 0 AND direction_state != 'prohibited'
                 AND bicycle_access NOT IN ('prohibited', 'dismount')"""
        )
    )
    return boundary_node_ids


def _start_boundary_state(
    edge: DirectedRoadEdge,
    incoming_edges: dict[int, list[DirectedRoadEdge]],
    end_boundary_by_edge: dict[int, str],
    restricted_via_nodes: set[int],
    restricted_way_ids: set[int],
) -> str:
    if edge.from_node_id in restricted_via_nodes or edge.osm_way_id in restricted_way_ids:
        return "restriction"
    incoming_boundary_states = [
        end_boundary_by_edge[incoming_edge.edge_id]
        for incoming_edge in incoming_edges.get(edge.from_node_id, [])
        if incoming_edge.segment_id != edge.segment_id
        and incoming_edge.edge_id in end_boundary_by_edge
    ]
    for boundary_state in ("restriction", "decision", "merge", "dead_end"):
        if boundary_state in incoming_boundary_states:
            return boundary_state
    return "network_boundary"


def _follow_corridor(
    start_edge_id: int,
    start_boundary_state: str,
    successor_by_edge: dict[int, int],
    end_boundary_by_edge: dict[int, str],
    assigned_edge_ids: set[int],
) -> RoadCorridor:
    edge_ids: list[int] = []
    edge_id = start_edge_id
    end_boundary_state = "network_boundary"
    while True:
        if edge_id in edge_ids:
            end_boundary_state = "cycle"
            break
        if edge_id in assigned_edge_ids:
            end_boundary_state = "merge"
            break

        edge_ids.append(edge_id)
        assigned_edge_ids.add(edge_id)
        next_edge_id = successor_by_edge.get(edge_id)
        if next_edge_id is None:
            end_boundary_state = end_boundary_by_edge.get(edge_id, "network_boundary")
            break
        if next_edge_id == start_edge_id:
            end_boundary_state = "cycle"
            break
        if len(edge_ids) >= MAX_CORRIDOR_EDGE_COUNT:
            end_boundary_state = "edge_limit"
            break
        edge_id = next_edge_id

    return RoadCorridor(
        corridor_id=start_edge_id,
        edge_ids=tuple(edge_ids),
        start_boundary_state=start_boundary_state,
        end_boundary_state=end_boundary_state,
    )


def _write_corridor_edges(
    connection: sqlite3.Connection,
    corridor: RoadCorridor,
    directed_edges: dict[int, DirectedRoadEdge],
) -> None:
    distance_along_corridor_meters = 0.0
    for edge_order, edge_id in enumerate(corridor.edge_ids):
        edge_length_meters = directed_edges[edge_id].length_meters
        connection.execute(
            """INSERT INTO road_corridor_edges(
                   corridor_id, edge_order, edge_id, start_distance_meters, end_distance_meters
               ) VALUES (?, ?, ?, ?, ?)""",
            (
                corridor.corridor_id,
                edge_order,
                edge_id,
                distance_along_corridor_meters,
                distance_along_corridor_meters + edge_length_meters,
            ),
        )
        distance_along_corridor_meters += edge_length_meters


def _load_corridor_profile_points(
    connection: sqlite3.Connection,
    corridor: RoadCorridor,
    directed_edges: dict[int, DirectedRoadEdge],
) -> list[dict[str, object]]:
    profile_points: list[dict[str, object]] = []
    distance_along_corridor_meters = 0.0
    for edge_order, edge_id in enumerate(corridor.edge_ids):
        for (
            sample_index,
            distance_meters,
            longitude,
            latitude,
            terrain_elevation_meters,
            profile_elevation_meters,
            source_reason,
            quality_flags_json,
        ) in connection.execute(
            """SELECT sample_index, distance_meters, longitude, latitude,
                      terrain_elevation_meters, profile_elevation_meters, source_reason,
                      quality_flags_json
               FROM elevation_samples WHERE edge_id = ? ORDER BY sample_index""",
            (edge_id,),
        ):
            if edge_order > 0 and sample_index == 0:
                continue
            profile_points.append(
                {
                    "longitude": longitude,
                    "latitude": latitude,
                    "distanceMeters": distance_along_corridor_meters + distance_meters,
                    "elevationMeters": profile_elevation_meters,
                    "terrainElevationMeters": terrain_elevation_meters,
                    "sourceReason": source_reason,
                    "qualityFlags": json.loads(quality_flags_json),
                }
            )
        distance_along_corridor_meters += directed_edges[edge_id].length_meters
    if len(profile_points) < 2:
        raise ValueError("road corridor profile has fewer than two elevation samples")
    return profile_points


def _write_corridor_profile(
    connection: sqlite3.Connection,
    corridor_id: int,
    profile: dict[str, Any],
    corridor_length_meters: float,
) -> int:
    profile_samples = profile.get("samples")
    climb_candidates = profile.get("climbs")
    if profile.get("profileId") != corridor_id or not isinstance(profile_samples, list) or not isinstance(climb_candidates, list):
        raise ValueError("CycleComp returned an incompatible road corridor profile")

    connection.executemany(
        """INSERT INTO road_corridor_elevation_samples(
               corridor_id, sample_index, distance_meters, longitude, latitude,
               terrain_elevation_meters, profile_elevation_meters, grade_percent,
               source_reason, quality_flags_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        [
            (
                corridor_id,
                sample_index,
                profile_sample["distanceMeters"],
                profile_sample["longitude"],
                profile_sample["latitude"],
                profile_sample["terrainElevationMeters"],
                profile_sample["profileElevationMeters"],
                profile_sample["gradePercent"],
                profile_sample["sourceReason"],
                json.dumps(profile_sample["qualityFlags"], ensure_ascii=False, separators=(",", ":")),
            )
            for sample_index, profile_sample in enumerate(profile_samples)
        ],
    )
    normalized_climb_records = []
    for climb in climb_candidates:
        start_distance_meters = min(
            corridor_length_meters,
            max(0.0, float(climb["startDistanceMeters"])),
        )
        end_distance_meters = min(
            corridor_length_meters,
            max(start_distance_meters, float(climb["endDistanceMeters"])),
        )
        normalized_climb_records.append(
            (
                corridor_id,
                climb["climbIndex"],
                start_distance_meters,
                end_distance_meters,
                end_distance_meters - start_distance_meters,
                climb["netRiseMeters"],
                climb["ascentMeters"],
                climb["descentMeters"],
                climb["averageGradePercent"],
                climb["maxGradePercent"],
                climb["startElevationMeters"],
                climb["endElevationMeters"],
            )
        )
    connection.executemany(
        """INSERT INTO road_corridor_climbs(
               corridor_id, climb_index, start_distance_meters, end_distance_meters,
               distance_meters, net_rise_meters, ascent_meters, descent_meters,
               average_grade_percent, max_grade_percent, start_elevation_meters,
               end_elevation_meters, completeness
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'corridor_local_candidate')""",
        normalized_climb_records,
    )
    return sum(sample["profileElevationMeters"] is not None for sample in profile_samples)


def _insert_corridor_record(
    connection: sqlite3.Connection,
    corridor: RoadCorridor,
    directed_edges: dict[int, DirectedRoadEdge],
    corridor_length_meters: float,
) -> None:
    first_edge = directed_edges[corridor.edge_ids[0]]
    last_edge = directed_edges[corridor.edge_ids[-1]]
    connection.execute(
        """INSERT INTO road_corridors(
               corridor_id, start_edge_id, end_edge_id, start_node_id, end_node_id,
               edge_count, length_meters, profile_quality, start_boundary_state,
               end_boundary_state
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unavailable', ?, ?)""",
        (
            corridor.corridor_id,
            corridor.edge_ids[0],
            corridor.edge_ids[-1],
            first_edge.from_node_id,
            last_edge.to_node_id,
            len(corridor.edge_ids),
            corridor_length_meters,
            corridor.start_boundary_state,
            corridor.end_boundary_state,
        ),
    )


def _update_corridor_profile_quality(
    connection: sqlite3.Connection,
    corridor_id: int,
    profiled_sample_count: int,
) -> None:
    if profiled_sample_count == 0:
        profile_quality = "unavailable"
    elif profiled_sample_count == _corridor_profile_sample_count(connection, corridor_id):
        profile_quality = "complete"
    else:
        profile_quality = "partial"
    connection.execute(
        "UPDATE road_corridors SET profile_quality = ? WHERE corridor_id = ?",
        (profile_quality, corridor_id),
    )


def _corridor_profile_sample_count(connection: sqlite3.Connection, corridor_id: int) -> int:
    return connection.execute(
        "SELECT COUNT(*) FROM road_corridor_elevation_samples WHERE corridor_id = ?",
        (corridor_id,),
    ).fetchone()[0]
