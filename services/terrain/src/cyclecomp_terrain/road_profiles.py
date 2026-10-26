from __future__ import annotations

from dataclasses import dataclass
import json
import logging
import math
from pathlib import Path
import shutil
import sqlite3
import struct
import subprocess
import tempfile
from typing import Any

from geographiclib.geodesic import Geodesic

from cyclecomp_terrain.raster_elevation import RasterElevationStore, TerrainSource
from cyclecomp_terrain.road_corridors import (
    MAX_CORRIDOR_EDGE_COUNT,
    build_road_corridors,
)


PROFILE_SAMPLE_SPACING_METERS = 20.0
MIN_MEASURABLE_ROAD_LEG_LENGTH_METERS = 1e-6
MIN_MEASURABLE_ROAD_LENGTH_METERS = 0.01
PROFILE_ALGORITHM_VERSION = "cyclecomp-route-elevation-v2"
REQUIRED_NODE_VERSION = "v22.23.2"
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RoadProfileBuildResult:
    profile_algorithm_version: str
    edge_count: int
    profiled_edge_count: int
    sample_count: int
    valid_sample_count: int
    profiled_sample_count: int
    unknown_sample_count: int
    structure_edge_count: int
    climb_candidate_count: int
    corridor_count: int
    profiled_corridor_count: int
    continuous_corridor_count: int
    corridor_sample_count: int
    corridor_climb_candidate_count: int
    decision_boundary_count: int
    restriction_boundary_count: int
    dead_end_boundary_count: int
    merge_boundary_count: int
    edge_limit_boundary_count: int

    @property
    def has_road_profiles(self) -> bool:
        return self.profiled_edge_count > 0

    @property
    def coverage_status(self) -> str:
        if (
            self.edge_count > 0
            and self.profiled_edge_count == self.edge_count
            and self.unknown_sample_count == 0
            and self.structure_edge_count == 0
        ):
            return "complete"
        return "partial"

    def as_manifest_record(self, source: TerrainSource) -> dict[str, object]:
        return {
            "profileAlgorithmVersion": self.profile_algorithm_version,
            "sampleSpacingMeters": PROFILE_SAMPLE_SPACING_METERS,
            "sourceName": source.name,
            "sourceRelease": source.source_release,
            "sourceResolutionMeters": source.source_resolution_meters,
            "verticalDatum": source.vertical_datum,
            "directedEdgeCount": self.edge_count,
            "profiledEdgeCount": self.profiled_edge_count,
            "sampleCount": self.sample_count,
            "validSampleCount": self.valid_sample_count,
            "profiledSampleCount": self.profiled_sample_count,
            "unknownSampleCount": self.unknown_sample_count,
            "structureEdgeCount": self.structure_edge_count,
            "climbCandidateCount": self.climb_candidate_count,
            "corridorCount": self.corridor_count,
            "profiledCorridorCount": self.profiled_corridor_count,
            "continuousCorridorCount": self.continuous_corridor_count,
            "corridorSampleCount": self.corridor_sample_count,
            "corridorClimbCandidateCount": self.corridor_climb_candidate_count,
            "decisionBoundaryCount": self.decision_boundary_count,
            "restrictionBoundaryCount": self.restriction_boundary_count,
            "deadEndBoundaryCount": self.dead_end_boundary_count,
            "mergeBoundaryCount": self.merge_boundary_count,
            "edgeLimitBoundaryCount": self.edge_limit_boundary_count,
            "maximumCorridorEdgeCount": MAX_CORRIDOR_EDGE_COUNT,
            "climbCompleteness": "edge_local_candidate",
            "corridorClimbCompleteness": "corridor_local_candidate",
            "continuousCorridorsAvailable": self.continuous_corridor_count > 0,
            "coverageStatus": self.coverage_status,
        }

    def road_graph_metadata(self) -> dict[str, object]:
        return {
            "hasElevationProfiles": self.has_road_profiles,
            "profileAlgorithmVersion": self.profile_algorithm_version,
            "profiledEdgeCount": self.profiled_edge_count,
            "profiledSampleCount": self.profiled_sample_count,
            "unknownSampleCount": self.unknown_sample_count,
            "climbCandidateCount": self.climb_candidate_count,
            "corridorCount": self.corridor_count,
            "continuousCorridorCount": self.continuous_corridor_count,
            "profileCoverageStatus": self.coverage_status,
            "hasContinuousRoadProfiles": self.continuous_corridor_count > 0,
        }


def build_road_elevation_profiles(
    database_path: Path,
    terrain_store: RasterElevationStore,
) -> RoadProfileBuildResult:
    node_executable = shutil.which("node")
    if node_executable is None:
        raise ValueError("road profiles require Node.js 22.23.2; run nvm use before building the pack")
    _validate_node_version(node_executable)
    kernel_runner_path = (
        Path(__file__).resolve().parents[4]
        / "services"
        / "terrain"
        / "tools"
        / "analyze_road_profiles.mts"
    )
    if not kernel_runner_path.is_file():
        raise ValueError("the CycleComp route-elevation kernel runner is missing")

    connection = sqlite3.connect(database_path)
    connection.execute("PRAGMA foreign_keys = ON")
    _create_profile_tables(connection)
    connection.commit()
    graph_edge_count = connection.execute("SELECT COUNT(*) FROM road_edges").fetchone()[0]
    logger.info("Preparing elevation profiles for %d directed road edges", graph_edge_count)
    summary_counts = {
        "edge_count": 0,
        "profiled_edge_count": 0,
        "sample_count": 0,
        "valid_sample_count": 0,
        "profiled_sample_count": 0,
        "unknown_sample_count": 0,
        "structure_edge_count": 0,
        "climb_candidate_count": 0,
    }

    try:
        with RoadProfileKernel(node_executable, kernel_runner_path) as profile_kernel:
            edge_cursor = connection.execute(
                """SELECT edge.edge_id, edge.direction, segment.geometry_wgs84_f64le,
                          segment.bridge, segment.tunnel
                   FROM road_edges AS edge
                   JOIN road_segments AS segment ON segment.segment_id = edge.segment_id
                   ORDER BY edge.edge_id"""
            )
            with connection:
                for edge_id, direction, geometry_bytes, bridge, tunnel in edge_cursor:
                    road_coordinates = list(struct.iter_unpack("<dd", geometry_bytes))
                    if direction == -1:
                        road_coordinates.reverse()
                    sample_locations = _sample_road_geometry(road_coordinates)
                    terrain_samples = terrain_store.sample_batch(
                        [(longitude, latitude) for _, longitude, latitude in sample_locations]
                    )
                    road_surface_supported = not _is_road_structure(bridge, tunnel)
                    profile_points = [
                        {
                            "longitude": longitude,
                            "latitude": latitude,
                            "distanceMeters": distance_meters,
                            "elevationMeters": elevation_sample.elevation_meters,
                            "terrainElevationMeters": elevation_sample.elevation_meters,
                            "sourceReason": elevation_sample.reason,
                            "qualityFlags": (
                                [] if road_surface_supported else ["structure_surface_unknown"]
                            ),
                        }
                        for (distance_meters, longitude, latitude), elevation_sample in zip(
                            sample_locations,
                            terrain_samples,
                            strict=True,
                        )
                    ]
                    profile = profile_kernel.analyze_profile(
                        edge_id,
                        profile_points,
                        road_surface_supported,
                    )
                    _write_profile_result(
                        connection,
                        profile,
                        terrain_store.source,
                        road_surface_supported,
                    )
                    _accumulate_profile_counts(summary_counts, profile, road_surface_supported)
                    if summary_counts["edge_count"] % 500 == 0 or summary_counts["edge_count"] == graph_edge_count:
                        logger.info(
                            "Road profiles: %d/%d edges; %d elevation samples",
                            summary_counts["edge_count"],
                            graph_edge_count,
                            summary_counts["sample_count"],
                        )
            corridor_summary = build_road_corridors(connection, profile_kernel)

        if graph_edge_count != summary_counts["edge_count"]:
            raise ValueError("road profile build did not process every directed graph edge")

        build_result = RoadProfileBuildResult(
            profile_algorithm_version=PROFILE_ALGORITHM_VERSION,
            edge_count=summary_counts["edge_count"],
            profiled_edge_count=summary_counts["profiled_edge_count"],
            sample_count=summary_counts["sample_count"],
            valid_sample_count=summary_counts["valid_sample_count"],
            profiled_sample_count=summary_counts["profiled_sample_count"],
            unknown_sample_count=summary_counts["unknown_sample_count"],
            structure_edge_count=summary_counts["structure_edge_count"],
            climb_candidate_count=summary_counts["climb_candidate_count"],
            corridor_count=corridor_summary.corridor_count,
            profiled_corridor_count=corridor_summary.profiled_corridor_count,
            continuous_corridor_count=corridor_summary.continuous_corridor_count,
            corridor_sample_count=corridor_summary.sample_count,
            corridor_climb_candidate_count=corridor_summary.climb_candidate_count,
            decision_boundary_count=corridor_summary.decision_boundary_count,
            restriction_boundary_count=corridor_summary.restriction_boundary_count,
            dead_end_boundary_count=corridor_summary.dead_end_boundary_count,
            merge_boundary_count=corridor_summary.merge_boundary_count,
            edge_limit_boundary_count=corridor_summary.edge_limit_boundary_count,
        )
        _write_profile_metadata(connection, build_result, terrain_store.source)
        connection.commit()

        integrity_result = connection.execute("PRAGMA integrity_check").fetchone()
        if integrity_result != ("ok",):
            raise ValueError("terrain pack SQLite integrity check failed after adding road profiles")
        foreign_key_error = connection.execute("PRAGMA foreign_key_check").fetchone()
        if foreign_key_error is not None:
            raise ValueError("terrain pack road profiles contain an invalid graph relationship")
        return build_result
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def _create_profile_tables(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE elevation_samples (
            edge_id INTEGER NOT NULL REFERENCES road_edges(edge_id),
            sample_index INTEGER NOT NULL CHECK(sample_index >= 0),
            distance_meters REAL NOT NULL CHECK(distance_meters >= 0),
            longitude REAL NOT NULL CHECK(longitude BETWEEN -180 AND 180),
            latitude REAL NOT NULL CHECK(latitude BETWEEN -90 AND 90),
            terrain_elevation_meters REAL,
            profile_elevation_meters REAL,
            grade_percent REAL,
            source_reason TEXT,
            elevation_source TEXT NOT NULL CHECK(elevation_source = 'offline_dem'),
            source_name TEXT NOT NULL,
            source_release TEXT NOT NULL,
            source_resolution_meters REAL NOT NULL CHECK(source_resolution_meters > 0),
            vertical_datum TEXT NOT NULL,
            quality_flags_json TEXT NOT NULL,
            PRIMARY KEY(edge_id, sample_index)
        ) WITHOUT ROWID;
        CREATE INDEX elevation_samples_by_edge_distance
            ON elevation_samples(edge_id, distance_meters);

        CREATE TABLE climb_segments (
            climb_id INTEGER PRIMARY KEY,
            edge_id INTEGER NOT NULL REFERENCES road_edges(edge_id),
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
            completeness TEXT NOT NULL CHECK(completeness = 'edge_local_candidate'),
            UNIQUE(edge_id, climb_index)
        );

        CREATE TABLE road_profile_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        ) WITHOUT ROWID;
        """
    )


def _write_profile_result(
    connection: sqlite3.Connection,
    profile: dict[str, Any],
    source: TerrainSource,
    road_surface_supported: bool,
) -> None:
    profile_samples = profile.get("samples")
    climb_candidates = profile.get("climbs")
    if (
        profile.get("profileAlgorithmVersion") != PROFILE_ALGORITHM_VERSION
        or not isinstance(profile.get("profileId"), int)
        or not isinstance(profile_samples, list)
        or not isinstance(climb_candidates, list)
    ):
        raise ValueError("CycleComp returned an incompatible road profile result")

    connection.executemany(
        """INSERT INTO elevation_samples(
               edge_id, sample_index, distance_meters, longitude, latitude,
               terrain_elevation_meters, profile_elevation_meters, grade_percent,
               source_reason, elevation_source, source_name, source_release,
               source_resolution_meters, vertical_datum, quality_flags_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'offline_dem', ?, ?, ?, ?, ?)""",
        [
            (
                profile["profileId"],
                sample_index,
                profile_sample["distanceMeters"],
                profile_sample["longitude"],
                profile_sample["latitude"],
                profile_sample["terrainElevationMeters"],
                profile_sample["profileElevationMeters"] if road_surface_supported else None,
                profile_sample["gradePercent"] if road_surface_supported else None,
                profile_sample["sourceReason"],
                source.name,
                source.source_release,
                source.source_resolution_meters,
                source.vertical_datum,
                json.dumps(profile_sample["qualityFlags"], ensure_ascii=False, separators=(",", ":")),
            )
            for sample_index, profile_sample in enumerate(profile_samples)
        ],
    )

    if road_surface_supported:
        connection.executemany(
            """INSERT INTO climb_segments(
                   edge_id, climb_index, start_distance_meters, end_distance_meters,
                   distance_meters, net_rise_meters, ascent_meters, descent_meters,
                   average_grade_percent, max_grade_percent, start_elevation_meters,
                   end_elevation_meters, completeness
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'edge_local_candidate')""",
            [
                (
                    profile["profileId"],
                    climb["climbIndex"],
                    climb["startDistanceMeters"],
                    climb["endDistanceMeters"],
                    climb["distanceMeters"],
                    climb["netRiseMeters"],
                    climb["ascentMeters"],
                    climb["descentMeters"],
                    climb["averageGradePercent"],
                    climb["maxGradePercent"],
                    climb["startElevationMeters"],
                    climb["endElevationMeters"],
                )
                for climb in climb_candidates
            ],
        )


def _accumulate_profile_counts(
    summary_counts: dict[str, int],
    profile: dict[str, Any],
    road_surface_supported: bool,
) -> None:
    profile_samples = profile["samples"]
    summary_counts["edge_count"] += 1
    summary_counts["sample_count"] += len(profile_samples)
    valid_sample_count = sum(
        sample["terrainElevationMeters"] is not None for sample in profile_samples
    )
    summary_counts["valid_sample_count"] += valid_sample_count
    summary_counts["unknown_sample_count"] += sum(
        sample["terrainElevationMeters"] is None for sample in profile_samples
    )
    summary_counts["climb_candidate_count"] += len(profile["climbs"])
    if not road_surface_supported:
        summary_counts["structure_edge_count"] += 1
        return

    profiled_sample_count = sum(
        sample["profileElevationMeters"] is not None for sample in profile_samples
    )
    summary_counts["profiled_sample_count"] += profiled_sample_count
    if profiled_sample_count >= 2:
        summary_counts["profiled_edge_count"] += 1


def _write_profile_metadata(
    connection: sqlite3.Connection,
    build_result: RoadProfileBuildResult,
    source: TerrainSource,
) -> None:
    road_profile_record = build_result.as_manifest_record(source)
    graph_metadata = build_result.road_graph_metadata()
    for key, value in graph_metadata.items():
        connection.execute(
            "INSERT OR REPLACE INTO road_graph_metadata(key, value) VALUES (?, ?)",
            (key, _canonical_json(value)),
        )

    connection.executemany(
        "INSERT INTO road_profile_metadata(key, value) VALUES (?, ?)",
        [(key, _canonical_json(value)) for key, value in road_profile_record.items()],
    )
    connection.executemany(
        "INSERT OR REPLACE INTO pack_metadata(key, value) VALUES (?, ?)",
        [
            ("hasRoadProfiles", _canonical_json(build_result.has_road_profiles)),
            ("profileAlgorithmVersion", _canonical_json(build_result.profile_algorithm_version)),
            ("roadProfileSummary", _canonical_json(road_profile_record)),
        ],
    )


def _sample_road_geometry(
    road_coordinates: list[tuple[float, float]],
) -> list[tuple[float, float, float]]:
    if len(road_coordinates) < 2:
        raise ValueError("road segment geometry must contain at least two coordinates")

    first_longitude, first_latitude = road_coordinates[0]
    profile_locations = [(0.0, first_longitude, first_latitude)]
    distance_along_road_meters = 0.0
    next_regular_sample_meters = PROFILE_SAMPLE_SPACING_METERS

    for (start_longitude, start_latitude), (end_longitude, end_latitude) in zip(
        road_coordinates,
        road_coordinates[1:],
    ):
        inverse = Geodesic.WGS84.Inverse(
            start_latitude,
            start_longitude,
            end_latitude,
            end_longitude,
        )
        leg_length_meters = inverse["s12"]
        if leg_length_meters <= MIN_MEASURABLE_ROAD_LEG_LENGTH_METERS:
            continue

        leg_end_distance_meters = distance_along_road_meters + leg_length_meters
        while next_regular_sample_meters < leg_end_distance_meters - 0.01:
            location = Geodesic.WGS84.Direct(
                start_latitude,
                start_longitude,
                inverse["azi1"],
                next_regular_sample_meters - distance_along_road_meters,
            )
            profile_locations.append(
                (
                    next_regular_sample_meters,
                    location["lon2"],
                    location["lat2"],
                )
            )
            next_regular_sample_meters += PROFILE_SAMPLE_SPACING_METERS

        if leg_end_distance_meters - profile_locations[-1][0] > 0.5:
            profile_locations.append((leg_end_distance_meters, end_longitude, end_latitude))
        if next_regular_sample_meters <= leg_end_distance_meters + 0.01:
            next_regular_sample_meters += PROFILE_SAMPLE_SPACING_METERS
        distance_along_road_meters = leg_end_distance_meters

    if distance_along_road_meters <= MIN_MEASURABLE_ROAD_LENGTH_METERS:
        raise ValueError("road segment geometry has no measurable horizontal length")
    if distance_along_road_meters - profile_locations[-1][0] > MIN_MEASURABLE_ROAD_LENGTH_METERS:
        final_longitude, final_latitude = road_coordinates[-1]
        profile_locations.append((distance_along_road_meters, final_longitude, final_latitude))
    return profile_locations


def _is_road_structure(bridge: str | None, tunnel: str | None) -> bool:
    return any(
        tag_value is not None and tag_value.strip().lower() not in {"", "no", "false", "0"}
        for tag_value in (bridge, tunnel)
    )


def _validate_node_version(node_executable: str) -> None:
    try:
        version_result = subprocess.run(
            [node_executable, "--version"],
            capture_output=True,
            check=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise ValueError("Node.js could not be started; run nvm use before building road profiles") from error
    if version_result.stdout.strip() != REQUIRED_NODE_VERSION:
        raise ValueError(
            f"road profiles require Node.js {REQUIRED_NODE_VERSION}; "
            "run nvm use to activate the project toolchain"
        )


class RoadProfileKernel:
    def __init__(self, node_executable: str, runner_path: Path) -> None:
        self.node_executable = node_executable
        self.runner_path = runner_path
        self.process: subprocess.Popen[str] | None = None
        self.stderr_file: Any | None = None

    def __enter__(self) -> RoadProfileKernel:
        self.stderr_file = tempfile.TemporaryFile(mode="w+t", encoding="utf-8")
        try:
            self.process = subprocess.Popen(
                [self.node_executable, str(self.runner_path)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=self.stderr_file,
                text=True,
                encoding="utf-8",
                bufsize=1,
            )
        except OSError as error:
            self.stderr_file.close()
            self.stderr_file = None
            raise ValueError("CycleComp's TypeScript road profile kernel could not start") from error
        return self

    def analyze_profile(
        self,
        profile_id: int,
        profile_points: list[dict[str, object]],
        road_surface_supported: bool,
    ) -> dict[str, Any]:
        process = self.process
        if process is None or process.stdin is None or process.stdout is None:
            raise ValueError("CycleComp's TypeScript road profile kernel is not running")

        request_line = _canonical_json(
            {
                "profileId": profile_id,
                "points": profile_points,
                "roadSurfaceSupported": road_surface_supported,
            }
        )
        process.stdin.write(request_line + "\n")
        process.stdin.flush()
        response_line = process.stdout.readline()
        if not response_line:
            raise self._kernel_failure("CycleComp's TypeScript road profile kernel stopped unexpectedly")

        try:
            response = json.loads(response_line)
        except json.JSONDecodeError as error:
            raise self._kernel_failure("CycleComp's TypeScript road profile kernel returned invalid JSON") from error
        if not isinstance(response, dict) or response.get("profileId") != profile_id:
            raise ValueError("CycleComp's TypeScript road profile kernel returned the wrong profile")
        return response

    def __exit__(self, exception_type: object, exception: object, traceback: object) -> None:
        process = self.process
        if process is not None:
            if process.stdin is not None:
                process.stdin.close()
            process.wait(timeout=10)
            if exception is None and process.returncode != 0:
                raise self._kernel_failure("CycleComp's TypeScript road profile kernel exited with an error")
        if self.stderr_file is not None:
            self.stderr_file.close()

    def _kernel_failure(self, message: str) -> ValueError:
        process = self.process
        if process is not None and process.poll() is None:
            process.kill()
            process.wait(timeout=10)
        if self.stderr_file is None:
            return ValueError(message)
        self.stderr_file.flush()
        self.stderr_file.seek(0)
        diagnostic = self.stderr_file.read().strip()
        if diagnostic:
            message = f"{message}: {diagnostic[-800:]}"
        return ValueError(message)


def _canonical_json(value: object) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )
