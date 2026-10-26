from __future__ import annotations

import json
from pathlib import Path
import sqlite3
import struct

import numpy as np
import osmium
import pytest

from cyclecomp_terrain.grid_pack import build_elevation_grid_pack
from cyclecomp_terrain.pack_cli import main as build_pack_from_cli
from cyclecomp_terrain.road_graph import BICYCLE_ACCESS_POLICY_VERSION, _directional_bicycle_access_state
from cyclecomp_terrain.signing import _validate_road_graph_database
from cyclecomp_terrain.signing import sign_elevation_grid_pack
from test_raster_elevation import create_dataset


ROAD_BOUNDS = (0.49, 0.49, 1.51, 1.51)
OSM_SOURCE_URL = "https://example.invalid/osm-fixture.osm.pbf"
OSM_SNAPSHOT_AT = "2026-10-17T00:00:00Z"


def test_pbf_build_splits_shared_nodes_and_preserves_safe_direction_metadata(tmp_path: Path) -> None:
    pbf_path = _write_road_graph_fixture(tmp_path / "roads.osm.pbf")
    terrain_store = create_dataset(
        tmp_path / "source",
        [("road-graph", 0, np.array([[10, 20], [30, 40]], dtype=np.float32), None)],
    )
    try:
        pack = build_elevation_grid_pack(
            terrain_store,
            tmp_path / "packs" / "road-graph",
            "road-graph",
            ROAD_BOUNDS,
            osm_pbf_path=pbf_path,
            osm_source_url=OSM_SOURCE_URL,
            osm_snapshot_at=OSM_SNAPSHOT_AT,
            road_graph_buffer_meters=0,
        )
    finally:
        terrain_store.close()

    road_graph = pack.manifest["roadGraph"]
    assert pack.manifest["hasRoadGraph"] is True
    assert pack.manifest["hasRoadProfiles"] is True
    assert pack.manifest["minimumReaderVersion"] == 2
    assert road_graph["bicycleAccessPolicyVersion"] == BICYCLE_ACCESS_POLICY_VERSION
    assert pack.manifest["graphVersion"] == "osm-directed-v1"
    assert pack.manifest["profileAlgorithmVersion"] == "cyclecomp-route-elevation-v2"
    road_profiles = pack.manifest["roadProfiles"]
    assert road_profiles["profileAlgorithmVersion"] == pack.manifest["profileAlgorithmVersion"]
    assert road_profiles["directedEdgeCount"] == 24
    assert road_profiles["profiledEdgeCount"] > 0
    assert road_profiles["climbCompleteness"] == "edge_local_candidate"
    assert road_profiles["continuousCorridorsAvailable"] is False
    assert road_graph["hasElevationProfiles"] is True
    assert road_graph["coverageStatus"] == "pilot_partial"
    assert road_graph["sourceUrl"] == OSM_SOURCE_URL
    assert road_graph["snapshotAt"] == OSM_SNAPSHOT_AT
    assert road_graph["license"] == "ODbL-1.0"
    assert road_graph["attribution"] == "© OpenStreetMap contributors"
    assert road_graph["odblDatabaseDistributionRequired"] is True
    assert road_graph["physicalSegmentCount"] == 12
    assert road_graph["directedEdgeCount"] == 24
    assert road_graph["turnRestrictionCount"] == 1
    assert road_graph["skippedMissingLocationWayCount"] == 0
    assert road_graph["skippedDegenerateSegmentCount"] == 1

    database_path = pack.pack_directory / "terrain.sqlite"
    with sqlite3.connect(database_path) as database:
        assert database.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        shared_node_segments = database.execute(
            "SELECT osm_way_id, COUNT(*) FROM road_segments "
            "WHERE osm_way_id IN (100, 101) GROUP BY osm_way_id ORDER BY osm_way_id"
        ).fetchall()
        assert shared_node_segments == [(100, 2), (101, 2)]

        crossing_node_count = database.execute(
            "SELECT COUNT(*) FROM road_nodes WHERE abs(longitude - 1.0) < 0.000001 "
            "AND abs(latitude - 1.0) < 0.000001"
        ).fetchone()[0]
        assert crossing_node_count == 0

        one_way_edges = database.execute(
            """SELECT road_edges.direction, road_edges.direction_state,
                      road_edges.bicycle_access, matchable, predictable
               FROM road_edges JOIN road_segments USING(segment_id)
               WHERE osm_way_id = 104 ORDER BY direction DESC"""
        ).fetchall()
        assert one_way_edges == [
            (1, "allowed", "allowed", 1, 1),
            (-1, "prohibited", "allowed", 1, 0),
        ]

        contraflow_edges = database.execute(
            """SELECT direction_state, predictable FROM road_edges
               JOIN road_segments USING(segment_id) WHERE osm_way_id = 105
               ORDER BY direction"""
        ).fetchall()
        assert contraflow_edges == [("allowed", 1), ("allowed", 1)]

        conditionally_restricted_edges = database.execute(
            """SELECT road_edges.bicycle_access, predictable FROM road_edges
               JOIN road_segments USING(segment_id) WHERE osm_way_id = 106"""
        ).fetchall()
        assert conditionally_restricted_edges == [("conditional", 0), ("conditional", 0)]

        prohibited_edges = database.execute(
            """SELECT road_edges.bicycle_access, matchable, predictable FROM road_edges
               JOIN road_segments USING(segment_id) WHERE osm_way_id = 107"""
        ).fetchall()
        assert prohibited_edges == [("prohibited", 1, 0), ("prohibited", 1, 0)]

        barrier_tags = database.execute(
            "SELECT attributes_json FROM road_nodes WHERE node_id = 19"
        ).fetchone()
        assert barrier_tags is not None
        assert json.loads(barrier_tags[0]) == {"barrier": "gate"}
        barrier_segments = database.execute(
            "SELECT COUNT(*) FROM road_segments WHERE osm_way_id = 108"
        ).fetchone()[0]
        assert barrier_segments == 2
        degenerate_segments = database.execute(
            "SELECT COUNT(*) FROM road_segments WHERE osm_way_id = 109"
        ).fetchone()[0]
        assert degenerate_segments == 0

        restriction = database.execute(
            "SELECT restriction_value, interpretation_state, members_json "
            "FROM road_turn_restrictions WHERE relation_id = 500"
        ).fetchone()
        assert restriction is not None
        assert restriction[:2] == ("no_left_turn", "node_restriction_preserved")
        assert json.loads(restriction[2]) == [
            {"ref": 100, "role": "from", "type": "w"},
            {"ref": 2, "role": "via", "type": "n"},
            {"ref": 101, "role": "to", "type": "w"},
        ]

        geometry_bytes = database.execute(
            "SELECT geometry_wgs84_f64le FROM road_segments WHERE osm_way_id = 100 ORDER BY segment_index LIMIT 1"
        ).fetchone()[0]
        assert len(geometry_bytes) == 32
        assert list(struct.iter_unpack("<dd", geometry_bytes)) == [(0.6, 1.0), (1.005, 1.0)]

        pack_metadata = dict(database.execute("SELECT key, value FROM pack_metadata"))
        assert json.loads(pack_metadata["hasRoadGraph"]) is True
        assert json.loads(pack_metadata["hasRoadProfiles"]) is True
        profile_samples = database.execute("SELECT COUNT(*) FROM elevation_samples").fetchone()[0]
        assert profile_samples == road_profiles["sampleCount"]

        database.execute(
            "UPDATE road_edges SET bicycle_access = 'road_class_inferred', predictable = 1 "
            "WHERE segment_id IN (SELECT segment_id FROM road_segments WHERE osm_way_id = 107)"
        )
        with pytest.raises(ValueError, match="access provenance"):
            _validate_road_graph_database(database, pack.manifest)


@pytest.mark.parametrize(
    ("road_tags", "direction", "expected_access"),
    [
        ({"highway": "residential"}, 1, "road_class_inferred"),
        ({"highway": "primary"}, -1, "road_class_inferred"),
        ({"highway": "cycleway"}, 1, "road_class_inferred"),
        ({"highway": "service"}, 1, "unknown"),
        ({"highway": "path"}, 1, "unknown"),
        ({"highway": "track"}, 1, "unknown"),
        ({"highway": "footway"}, 1, "unknown"),
        ({"highway": "trunk"}, 1, "road_class_inferred"),
        ({"highway": "motorway"}, 1, "unknown"),
        ({"highway": "residential", "motorroad": "yes"}, 1, "unknown"),
        ({"highway": "residential", "access": "private"}, 1, "prohibited"),
        ({"highway": "residential", "access": "destination"}, 1, "unknown"),
        ({"highway": "residential", "bicycle": "dismount"}, 1, "dismount"),
        ({"highway": "residential", "bicycle:conditional": "yes @ (sunrise-sunset)"}, 1, "conditional"),
        ({"highway": "residential", "access:conditional": "no @ (Mo-Fr)"}, 1, "conditional"),
        ({"highway": "residential", "vehicle:forward": "no"}, 1, "prohibited"),
        ({"highway": "residential", "vehicle:forward": "no"}, -1, "road_class_inferred"),
        ({"highway": "residential", "access:backward:conditional": "yes @ (Su)"}, -1, "conditional"),
        ({"highway": "residential", "bicycle": "yes", "vehicle:forward": "no"}, 1, "allowed"),
        ({"highway": "residential", "bicycle:forward": "no", "bicycle": "yes"}, 1, "prohibited"),
        ({"highway": "motorway", "bicycle": "yes"}, 1, "allowed"),
    ],
)
def test_bicycle_access_policy_keeps_fallbacks_separate_from_explicit_access(
    road_tags: dict[str, str], direction: int, expected_access: str,
) -> None:
    assert _directional_bicycle_access_state(road_tags, direction) == expected_access


def test_signer_validates_a_graph_pack_before_adding_its_signature(tmp_path: Path) -> None:
    pbf_path = _write_road_graph_fixture(tmp_path / "roads.osm.pbf")
    terrain_store = create_dataset(
        tmp_path / "source",
        [("road-graph", 0, np.array([[10, 20], [30, 40]], dtype=np.float32), None)],
    )
    try:
        pack = build_elevation_grid_pack(
            terrain_store,
            tmp_path / "packs" / "signed-road-graph",
            "signed-road-graph",
            ROAD_BOUNDS,
            osm_pbf_path=pbf_path,
            osm_source_url=OSM_SOURCE_URL,
            osm_snapshot_at=OSM_SNAPSHOT_AT,
            road_graph_buffer_meters=0,
        )
    finally:
        terrain_store.close()

    private_key_path = tmp_path / "signing-key.pem"
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    signing_key = Ed25519PrivateKey.generate()
    private_key_path.write_bytes(
        signing_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    private_key_path.chmod(0o600)

    signed_pack = sign_elevation_grid_pack(pack.pack_directory, private_key_path, "terrain-test-2026")
    assert signed_pack.manifest["hasRoadGraph"] is True
    assert (pack.pack_directory / "manifest.ed25519").is_file()


def test_pbf_build_rejects_partial_provenance_and_cleans_staging_pack(tmp_path: Path) -> None:
    terrain_store = create_dataset(
        tmp_path / "source",
        [("road-graph", 0, np.array([[10, 20], [30, 40]], dtype=np.float32), None)],
    )
    output_directory = tmp_path / "packs" / "incomplete-provenance"
    try:
        with pytest.raises(ValueError, match="PBF path, source URL, and snapshot timestamp"):
            build_elevation_grid_pack(
                terrain_store,
                output_directory,
                "incomplete-provenance",
                ROAD_BOUNDS,
                osm_pbf_path=tmp_path / "missing.osm.pbf",
            )
    finally:
        terrain_store.close()

    assert not output_directory.exists()
    assert not (tmp_path / "packs").exists()


def test_pack_cli_builds_unsigned_graph_pack_from_explicit_pbf_provenance(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    pbf_path = _write_road_graph_fixture(tmp_path / "roads.osm.pbf")
    terrain_store = create_dataset(
        tmp_path / "source",
        [("road-graph", 0, np.array([[10, 20], [30, 40]], dtype=np.float32), None)],
    )
    output_directory = tmp_path / "published" / "road-graph"
    try:
        exit_code = build_pack_from_cli(
            [
                "--dataset-dir",
                str(tmp_path / "source"),
                "--output-dir",
                str(output_directory),
                "--pack-id",
                "road-graph-cli",
                "--bounds",
                *[str(bound) for bound in ROAD_BOUNDS],
                "--osm-pbf",
                str(pbf_path),
                "--osm-source-url",
                OSM_SOURCE_URL,
                "--osm-snapshot-at",
                OSM_SNAPSHOT_AT,
                "--road-graph-buffer-meters",
                "0",
                "--unsigned-pilot",
            ]
        )
    finally:
        terrain_store.close()

    assert exit_code == 0
    cli_summary = json.loads(capsys.readouterr().out)
    assert cli_summary["hasRoadGraph"] is True
    assert cli_summary["hasRoadProfiles"] is True
    assert cli_summary["roadGraph"]["directedEdgeCount"] == 24
    assert cli_summary["roadProfiles"]["profiledEdgeCount"] > 0
    assert output_directory.is_dir()
    assert not list(output_directory.parent.glob(".road-graph.staging-*"))


def _write_road_graph_fixture(pbf_path: Path) -> Path:
    pbf_path.parent.mkdir(parents=True, exist_ok=True)
    locations = {
        1: (0.6, 1.0),
        2: (1.005, 1.0),
        3: (1.4, 1.0),
        4: (1.0, 0.6),
        5: (1.0, 1.4),
        6: (0.7, 0.7),
        7: (1.3, 1.3),
        8: (0.7, 1.3),
        9: (1.3, 0.7),
        10: (1.1, 1.1),
        11: (1.2, 1.2),
        12: (1.2, 1.1),
        13: (1.3, 1.2),
        14: (1.4, 1.1),
        15: (1.4, 1.2),
        16: (1.45, 1.1),
        17: (1.45, 1.2),
        18: (1.25, 1.3),
        19: (1.3, 1.3),
        20: (1.35, 1.3),
        21: (1.46, 1.15),
        22: (1.46, 1.15),
    }
    with osmium.SimpleWriter(pbf_path, overwrite=True) as writer:
        for node_id, location in locations.items():
            node_tags = {"barrier": "gate"} if node_id == 19 else {}
            writer.add_node(osmium.osm.mutable.Node(id=node_id, location=location, tags=node_tags))
        ways = (
            (100, [1, 2, 3], {"highway": "residential", "name": "Main Street", "access": "no"}),
            (101, [4, 2, 5], {"highway": "cycleway", "bicycle": "designated", "oneway": "yes"}),
            (102, [6, 7], {"highway": "service"}),
            (103, [8, 9], {"highway": "service"}),
            (104, [10, 11], {"highway": "primary", "oneway": "yes", "bicycle": "yes"}),
            (
                105,
                [12, 13],
                {"highway": "cycleway", "oneway": "yes", "oneway:bicycle": "no", "bicycle": "designated"},
            ),
            (
                106,
                [14, 15],
                {"highway": "residential", "bicycle": "yes", "bicycle:conditional": "no @ (Sa 00:00-12:00)"},
            ),
            (107, [16, 17], {"highway": "residential", "bicycle": "no"}),
            (109, [21, 22], {"highway": "service"}),
        )
        for way_id, node_ids, tags in ways:
            writer.add_way(osmium.osm.mutable.Way(id=way_id, nodes=node_ids, tags=tags))
        writer.add_way(
            osmium.osm.mutable.Way(
                id=108,
                nodes=[18, 19, 20],
                tags={"highway": "service"},
            )
        )
        writer.add_relation(
            osmium.osm.mutable.Relation(
                id=500,
                members=[("w", 100, "from"), ("n", 2, "via"), ("w", 101, "to")],
                tags={"type": "restriction", "restriction:bicycle": "no_left_turn"},
            )
        )
    return pbf_path
