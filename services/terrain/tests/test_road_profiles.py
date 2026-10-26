from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sqlite3
import shutil

import numpy as np
import osmium
import rasterio
from affine import Affine

from cyclecomp_terrain.grid_pack import build_elevation_grid_pack
from cyclecomp_terrain.raster_elevation import RasterElevationStore
from cyclecomp_terrain.road_profiles import RoadProfileKernel, _sample_road_geometry
from cyclecomp_terrain.road_corridors import _load_access_boundaries
from cyclecomp_terrain.signing import TerrainPackSigningResult, sign_elevation_grid_pack


ROAD_BOUNDS = (0.0005, 0.0005, 0.0095, 0.0075)
OSM_SOURCE_URL = "https://example.invalid/profile-fixture.osm.pbf"
OSM_SNAPSHOT_AT = "2026-10-17T00:00:00Z"


def test_kernel_keeps_prepared_arc_distances_aligned_with_bridge_quality_flags() -> None:
    runner = Path(__file__).resolve().parents[1] / "tools" / "analyze_road_profiles.mts"
    profile_points = [
        {
            "longitude": index * 20 / 111319.49079327357, "latitude": 0,
            "distanceMeters": index * 100,
            "elevationMeters": None if index in {2, 3} else index * 10,
            "terrainElevationMeters": index * 10, "sourceReason": None,
            "qualityFlags": ["structure_surface_unknown"] if index in {2, 3} else [],
        }
        for index in range(6)
    ]
    with RoadProfileKernel(shutil.which("node") or "node", runner) as kernel:
        profile = kernel.analyze_profile(1, profile_points, True)
    assert profile["samples"][-1]["distanceMeters"] == 500
    assert any("structure_surface_unknown" in sample["qualityFlags"] for sample in profile["samples"])
    assert all(
        sample["profileElevationMeters"] is None and sample["gradePercent"] is None
        for sample in profile["samples"]
        if "structure_surface_unknown" in sample["qualityFlags"]
    )


def test_corridors_stop_at_unknown_node_access_and_conditional_branches() -> None:
    with sqlite3.connect(":memory:") as database:
        database.execute("CREATE TABLE road_nodes(node_id INTEGER, attributes_json TEXT)")
        node_attributes = {
            1: {"barrier": "gate"},
            2: {"barrier": "gate", "bicycle": "yes"},
            3: {"bicycle:conditional": "yes @ (sunrise-sunset)"},
            4: {"access": "private"},
            5: {"ford": "yes"},
            6: {"highway": "traffic_signals"},
            7: {"vehicle": "no", "bicycle": "yes"},
        }
        database.executemany(
            "INSERT INTO road_nodes VALUES (?, ?)",
            [(node_id, json.dumps(attributes)) for node_id, attributes in node_attributes.items()],
        )
        database.execute(
            "CREATE TABLE road_edges(from_node_id INTEGER, predictable INTEGER, "
            "direction_state TEXT, bicycle_access TEXT)"
        )
        database.executemany(
            "INSERT INTO road_edges VALUES (?, ?, ?, ?)",
            [
                (8, 0, "allowed", "conditional"),
                (9, 0, "allowed", "unknown"),
                (10, 0, "prohibited", "allowed"),
                (11, 0, "allowed", "prohibited"),
                (12, 1, "allowed", "road_class_inferred"),
            ],
        )
        assert _load_access_boundaries(database) == {1, 3, 4, 5, 8, 9}


def test_short_predictable_road_keeps_two_edge_and_corridor_samples(tmp_path: Path) -> None:
    terrain_store = _create_profile_terrain_store(tmp_path / "source")
    pbf_path = tmp_path / "short-road.osm.pbf"
    with osmium.SimpleWriter(pbf_path, overwrite=True) as writer:
        writer.add_node(osmium.osm.mutable.Node(id=1, location=(0.0015, 0.0015)))
        writer.add_node(osmium.osm.mutable.Node(id=2, location=(0.0015 + 0.02 / 111319.49, 0.0015)))
        writer.add_way(osmium.osm.mutable.Way(
            id=1, nodes=[1, 2], tags={"highway": "residential"},
        ))
    try:
        pack = build_elevation_grid_pack(
            terrain_store, tmp_path / "packs" / "short-road", "short-road", ROAD_BOUNDS,
            osm_pbf_path=pbf_path, osm_source_url=OSM_SOURCE_URL,
            osm_snapshot_at=OSM_SNAPSHOT_AT, road_graph_buffer_meters=0,
        )
    finally:
        terrain_store.close()
    with sqlite3.connect(pack.pack_directory / "terrain.sqlite") as database:
        assert database.execute(
            "SELECT COUNT(*) FROM elevation_samples GROUP BY edge_id"
        ).fetchall() == [(2,), (2,)]
        assert database.execute(
            "SELECT COUNT(*) FROM road_corridor_elevation_samples GROUP BY corridor_id"
        ).fetchall() == [(2,), (2,)]
        assert database.execute(
            "SELECT COUNT(*) FROM road_corridor_elevation_samples WHERE grade_percent IS NOT NULL"
        ).fetchone() == (0,)
    assert _sign_pack_with_generated_key(tmp_path, pack.pack_directory).manifest["signatureStatus"] == "signed"


def test_road_profile_builder_keeps_signed_elevation_and_breaks_unknown_gaps(
    tmp_path: Path,
) -> None:
    terrain_store = _create_profile_terrain_store(tmp_path / "source")
    pbf_path = _write_profile_fixture(tmp_path / "roads.osm.pbf")
    try:
        pack = build_elevation_grid_pack(
            terrain_store,
            tmp_path / "packs" / "profiles",
            "profiles",
            ROAD_BOUNDS,
            osm_pbf_path=pbf_path,
            osm_source_url=OSM_SOURCE_URL,
            osm_snapshot_at=OSM_SNAPSHOT_AT,
            road_graph_buffer_meters=0,
        )
    finally:
        terrain_store.close()

    assert pack.manifest["hasRoadProfiles"] is True
    assert pack.manifest["profileAlgorithmVersion"] == "cyclecomp-route-elevation-v2"
    profile_summary = pack.manifest["roadProfiles"]
    assert profile_summary["continuousCorridorsAvailable"] is False
    assert profile_summary["unknownSampleCount"] > 0
    assert profile_summary["structureEdgeCount"] == 2

    with sqlite3.connect(pack.pack_directory / "terrain.sqlite") as database:
        edge_ids_by_way_and_direction = {
            (osm_way_id, direction): edge_id
            for edge_id, osm_way_id, direction in database.execute(
                """SELECT road_edges.edge_id, road_segments.osm_way_id, road_edges.direction
                   FROM road_edges JOIN road_segments USING(segment_id)"""
            )
        }
        forward_ramp_edge = edge_ids_by_way_and_direction[(100, 1)]
        reverse_ramp_edge = edge_ids_by_way_and_direction[(100, -1)]
        bridge_edge = edge_ids_by_way_and_direction[(101, 1)]

        forward_samples = database.execute(
            """SELECT distance_meters, terrain_elevation_meters, profile_elevation_meters,
                      grade_percent, source_reason
               FROM elevation_samples WHERE edge_id = ? ORDER BY sample_index""",
            (forward_ramp_edge,),
        ).fetchall()
        assert min(sample[1] for sample in forward_samples if sample[1] is not None) < 0
        assert max(sample[1] for sample in forward_samples if sample[1] is not None) > 0
        assert any(sample[3] is not None and sample[3] > 3 for sample in forward_samples)
        unknown_distances = [sample[0] for sample in forward_samples if sample[4] == "nodata"]
        assert unknown_distances

        climbs = database.execute(
            """SELECT start_distance_meters, end_distance_meters, net_rise_meters,
                      ascent_meters, descent_meters, average_grade_percent
               FROM climb_segments WHERE edge_id = ?""",
            (forward_ramp_edge,),
        ).fetchall()
        assert climbs
        assert all(climb[2] > 0 and climb[3] > 0 and climb[5] >= 3 for climb in climbs)
        assert all(
            not climb[0] <= unknown_distance <= climb[1]
            for climb in climbs
            for unknown_distance in unknown_distances
        )

        reverse_grade_values = [
            sample[0]
            for sample in database.execute(
                "SELECT grade_percent FROM elevation_samples WHERE edge_id = ?",
                (reverse_ramp_edge,),
            )
            if sample[0] is not None
        ]
        assert reverse_grade_values
        assert max(reverse_grade_values) < -3
        assert database.execute(
            "SELECT COUNT(*) FROM climb_segments WHERE edge_id = ?",
            (reverse_ramp_edge,),
        ).fetchone()[0] == 0

        bridge_samples = database.execute(
            """SELECT terrain_elevation_meters, profile_elevation_meters, grade_percent,
                      quality_flags_json
               FROM elevation_samples WHERE edge_id = ?""",
            (bridge_edge,),
        ).fetchall()
        assert any(sample[0] is not None for sample in bridge_samples)
        assert all(sample[1] is None and sample[2] is None for sample in bridge_samples)
        assert all("structure_surface_unknown" in json.loads(sample[3]) for sample in bridge_samples)

    signed_pack = _sign_pack_with_generated_key(tmp_path, pack.pack_directory)
    assert signed_pack.manifest["hasRoadProfiles"] is True
    assert signed_pack.manifest["roadProfiles"]["unknownSampleCount"] > 0


def test_road_geometry_sampling_keeps_regular_spacing_across_short_osm_legs() -> None:
    longitude_per_twenty_meters = 20 / 111_319.49079327357
    sampled_locations = _sample_road_geometry(
        [
            (0, 0),
            (longitude_per_twenty_meters * 0.4, 0),
            (longitude_per_twenty_meters * 1.2, 0),
            (longitude_per_twenty_meters * 2.3, 0),
        ]
    )

    sample_distances = [sample[0] for sample in sampled_locations]
    assert sample_distances[0] == 0
    assert sample_distances[-1] > 45
    assert all(next_distance > distance for distance, next_distance in zip(sample_distances, sample_distances[1:]))


def test_road_geometry_sampling_keeps_both_endpoints_for_short_edges() -> None:
    longitude_per_meter = 1 / 111_319.49079327357
    sampled_locations = _sample_road_geometry(
        [(0, 0), (longitude_per_meter * 0.3, 0)]
    )

    assert len(sampled_locations) == 2
    assert sampled_locations[0][0] == 0
    assert 0.29 <= sampled_locations[-1][0] <= 0.31


def test_road_corridor_stitches_climb_across_connected_osm_ways(tmp_path: Path) -> None:
    terrain_store = _create_profile_terrain_store(tmp_path / "source", include_nodata=False)
    pbf_path = _write_connected_profile_fixture(tmp_path / "connected-roads.osm.pbf")
    try:
        pack = build_elevation_grid_pack(
            terrain_store,
            tmp_path / "packs" / "connected",
            "connected",
            ROAD_BOUNDS,
            osm_pbf_path=pbf_path,
            osm_source_url=OSM_SOURCE_URL,
            osm_snapshot_at=OSM_SNAPSHOT_AT,
            road_graph_buffer_meters=0,
        )
    finally:
        terrain_store.close()

    profile_summary = pack.manifest["roadProfiles"]
    assert profile_summary["continuousCorridorsAvailable"] is True
    assert profile_summary["continuousCorridorCount"] == 2

    with sqlite3.connect(pack.pack_directory / "terrain.sqlite") as database:
        edge_ids_by_way_and_direction = {
            (osm_way_id, direction): edge_id
            for edge_id, osm_way_id, direction in database.execute(
                """SELECT road_edges.edge_id, road_segments.osm_way_id, road_edges.direction
                   FROM road_edges JOIN road_segments USING(segment_id)"""
            )
        }
        forward_edge_ids = [
            edge_ids_by_way_and_direction[(way_id, 1)]
            for way_id in (200, 201)
        ]
        corridor_id = database.execute(
            "SELECT corridor_id FROM road_corridor_edges WHERE edge_id = ? AND edge_order = 0",
            (forward_edge_ids[0],),
        ).fetchone()[0]
        corridor_edge_ids = [
            row[0]
            for row in database.execute(
                "SELECT edge_id FROM road_corridor_edges WHERE corridor_id = ? ORDER BY edge_order",
                (corridor_id,),
            )
        ]
        assert corridor_edge_ids == forward_edge_ids

        corridor_climbs = database.execute(
            """SELECT start_distance_meters, end_distance_meters, net_rise_meters,
                      ascent_meters, average_grade_percent, completeness
               FROM road_corridor_climbs WHERE corridor_id = ?""",
            (corridor_id,),
        ).fetchall()
        assert len(corridor_climbs) == 1
        climb = corridor_climbs[0]
        assert climb[1] - climb[0] > 700
        assert climb[2] > 15
        assert climb[3] > 0
        assert 3 <= climb[4] <= 8
        assert climb[5] == "corridor_local_candidate"

    _sign_pack_with_generated_key(tmp_path, pack.pack_directory)


def test_road_corridor_stops_at_ambiguous_branch(tmp_path: Path) -> None:
    terrain_store = _create_profile_terrain_store(tmp_path / "source", include_nodata=False)
    pbf_path = _write_branch_profile_fixture(tmp_path / "branch-roads.osm.pbf")
    try:
        pack = build_elevation_grid_pack(
            terrain_store,
            tmp_path / "packs" / "branch",
            "branch",
            ROAD_BOUNDS,
            osm_pbf_path=pbf_path,
            osm_source_url=OSM_SOURCE_URL,
            osm_snapshot_at=OSM_SNAPSHOT_AT,
            road_graph_buffer_meters=0,
        )
    finally:
        terrain_store.close()

    profile_summary = pack.manifest["roadProfiles"]
    assert profile_summary["continuousCorridorsAvailable"] is False
    assert profile_summary["decisionBoundaryCount"] > 0
    assert profile_summary["restrictionBoundaryCount"] == 0

    with sqlite3.connect(pack.pack_directory / "terrain.sqlite") as database:
        edge_ids_by_way_and_direction = {
            (osm_way_id, direction): edge_id
            for edge_id, osm_way_id, direction in database.execute(
                """SELECT road_edges.edge_id, road_segments.osm_way_id, road_edges.direction
                   FROM road_edges JOIN road_segments USING(segment_id)"""
            )
        }
        incoming_edge_id = edge_ids_by_way_and_direction[(300, 1)]
        outgoing_edge_id = edge_ids_by_way_and_direction[(301, 1)]
        incoming_corridor = database.execute(
            """SELECT road_corridors.corridor_id, road_corridors.end_node_id,
                      road_corridors.end_boundary_state
               FROM road_corridor_edges
               JOIN road_corridors USING(corridor_id)
               WHERE road_corridor_edges.edge_id = ?""",
            (incoming_edge_id,),
        ).fetchone()
        outgoing_corridor = database.execute(
            """SELECT road_corridors.corridor_id, road_corridors.start_node_id,
                      road_corridors.start_boundary_state
               FROM road_corridor_edges
               JOIN road_corridors USING(corridor_id)
               WHERE road_corridor_edges.edge_id = ?""",
            (outgoing_edge_id,),
        ).fetchone()
        assert incoming_corridor[1:] == (2, "decision")
        assert outgoing_corridor[1:] == (2, "decision")
        assert incoming_corridor[0] != outgoing_corridor[0]


def test_road_corridor_stops_at_turn_restriction(tmp_path: Path) -> None:
    terrain_store = _create_profile_terrain_store(tmp_path / "source", include_nodata=False)
    pbf_path = _write_connected_profile_fixture(
        tmp_path / "restricted-roads.osm.pbf",
        include_restriction=True,
    )
    try:
        pack = build_elevation_grid_pack(
            terrain_store,
            tmp_path / "packs" / "restricted",
            "restricted",
            ROAD_BOUNDS,
            osm_pbf_path=pbf_path,
            osm_source_url=OSM_SOURCE_URL,
            osm_snapshot_at=OSM_SNAPSHOT_AT,
            road_graph_buffer_meters=0,
        )
    finally:
        terrain_store.close()

    profile_summary = pack.manifest["roadProfiles"]
    assert profile_summary["continuousCorridorsAvailable"] is False
    assert profile_summary["restrictionBoundaryCount"] > 0

    with sqlite3.connect(pack.pack_directory / "terrain.sqlite") as database:
        edge_ids_by_way_and_direction = {
            (osm_way_id, direction): edge_id
            for edge_id, osm_way_id, direction in database.execute(
                """SELECT road_edges.edge_id, road_segments.osm_way_id, road_edges.direction
                   FROM road_edges JOIN road_segments USING(segment_id)"""
            )
        }
        forward_way_edge_ids = [
            edge_ids_by_way_and_direction[(way_id, 1)] for way_id in (200, 201)
        ]
        corridor_ids = [
            database.execute(
                "SELECT corridor_id FROM road_corridor_edges WHERE edge_id = ?",
                (edge_id,),
            ).fetchone()[0]
            for edge_id in forward_way_edge_ids
        ]
        assert corridor_ids[0] != corridor_ids[1]


def test_road_corridor_preserves_bridge_gap_without_extending_climbs(tmp_path: Path) -> None:
    terrain_store = _create_profile_terrain_store(tmp_path / "source", include_nodata=False)
    pbf_path = _write_bridge_corridor_fixture(tmp_path / "bridge-roads.osm.pbf")
    try:
        pack = build_elevation_grid_pack(
            terrain_store,
            tmp_path / "packs" / "bridge",
            "bridge",
            ROAD_BOUNDS,
            osm_pbf_path=pbf_path,
            osm_source_url=OSM_SOURCE_URL,
            osm_snapshot_at=OSM_SNAPSHOT_AT,
            road_graph_buffer_meters=0,
        )
    finally:
        terrain_store.close()

    with sqlite3.connect(pack.pack_directory / "terrain.sqlite") as database:
        edge_ids_by_way_and_direction = {
            (osm_way_id, direction): edge_id
            for edge_id, osm_way_id, direction in database.execute(
                """SELECT road_edges.edge_id, road_segments.osm_way_id, road_edges.direction
                   FROM road_edges JOIN road_segments USING(segment_id)"""
            )
        }
        forward_edge_ids = [
            edge_ids_by_way_and_direction[(way_id, 1)] for way_id in (210, 211, 212)
        ]
        corridor_id = database.execute(
            "SELECT corridor_id FROM road_corridor_edges WHERE edge_id = ? AND edge_order = 0",
            (forward_edge_ids[0],),
        ).fetchone()[0]
        assert [
            row[0]
            for row in database.execute(
                "SELECT edge_id FROM road_corridor_edges WHERE corridor_id = ? ORDER BY edge_order",
                (corridor_id,),
            )
        ] == forward_edge_ids
        corridor_quality = database.execute(
            "SELECT profile_quality FROM road_corridors WHERE corridor_id = ?",
            (corridor_id,),
        ).fetchone()[0]
        assert corridor_quality == "partial"

        bridge_samples = database.execute(
            """SELECT terrain_elevation_meters, profile_elevation_meters, grade_percent,
                      quality_flags_json, distance_meters
               FROM road_corridor_elevation_samples
               WHERE corridor_id = ? AND quality_flags_json LIKE '%structure_surface_unknown%'""",
            (corridor_id,),
        ).fetchall()
        assert bridge_samples
        assert all(sample[0] is not None for sample in bridge_samples)
        assert all(sample[1] is None and sample[2] is None for sample in bridge_samples)

        corridor_climbs = database.execute(
            """SELECT start_distance_meters, end_distance_meters
               FROM road_corridor_climbs WHERE corridor_id = ?""",
            (corridor_id,),
        ).fetchall()
        assert all(
            not climb_start <= bridge_sample[4] <= climb_end
            for climb_start, climb_end in corridor_climbs
            for bridge_sample in bridge_samples
        )


def _create_profile_terrain_store(
    dataset_directory: Path,
    include_nodata: bool = True,
) -> RasterElevationStore:
    tile_directory = dataset_directory / "tiles"
    tile_directory.mkdir(parents=True)
    tile_path = tile_directory / "rising-surface.tif"
    pixel_size_degrees = 0.00002
    raster_nodata = -9999.0
    elevation_columns = -40 + np.arange(500, dtype=np.float32) * np.float32(0.11)
    elevation_grid = np.repeat(elevation_columns[np.newaxis, :], 500, axis=0)
    if include_nodata:
        elevation_grid[:, 300:321] = raster_nodata
    with rasterio.open(
        tile_path,
        "w",
        driver="GTiff",
        width=500,
        height=500,
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=Affine.translation(0, 0.01) @ Affine.scale(pixel_size_degrees, -pixel_size_degrees),
        nodata=raster_nodata,
    ) as raster:
        raster.write(elevation_grid, 1)

    with rasterio.open(tile_path) as raster:
        tile_bounds = [raster.bounds.left, raster.bounds.bottom, raster.bounds.right, raster.bounds.top]
    dataset_manifest = {
        "schemaVersion": 1,
        "datasetVersion": "profile-fixture-1",
        "source": {
            "name": "Synthetic rising surface",
            "release": "fixture-1",
            "verticalDatum": "fixture datum",
            "resolutionMeters": 30,
            "attribution": "Test fixture",
        },
        "tiles": [
            {
                "id": "rising-surface",
                "file": "tiles/rising-surface.tif",
                "sha256": hashlib.sha256(tile_path.read_bytes()).hexdigest(),
                "bounds": tile_bounds,
            }
        ],
    }
    (dataset_directory / "manifest.json").write_text(json.dumps(dataset_manifest), encoding="utf-8")
    return RasterElevationStore(dataset_directory)


def _write_profile_fixture(pbf_path: Path) -> Path:
    pbf_path.parent.mkdir(parents=True, exist_ok=True)
    with osmium.SimpleWriter(pbf_path, overwrite=True) as writer:
        for node_id, location in {
            1: (0.001, 0.005),
            2: (0.009, 0.005),
            3: (0.001, 0.007),
            4: (0.009, 0.007),
        }.items():
            writer.add_node(osmium.osm.mutable.Node(id=node_id, location=location))
        writer.add_way(
            osmium.osm.mutable.Way(
                id=100,
                nodes=[1, 2],
                tags={"highway": "residential", "bicycle": "yes", "name": "Rising road"},
            )
        )
        writer.add_way(
            osmium.osm.mutable.Way(
                id=101,
                nodes=[3, 4],
                tags={
                    "highway": "residential",
                    "bicycle": "yes",
                    "bridge": "yes",
                    "name": "Bridge",
                },
            )
        )
    return pbf_path


def _write_connected_profile_fixture(pbf_path: Path, include_restriction: bool = False) -> Path:
    pbf_path.parent.mkdir(parents=True, exist_ok=True)
    with osmium.SimpleWriter(pbf_path, overwrite=True) as writer:
        for node_id, longitude in {1: 0.001, 2: 0.0048, 3: 0.0086}.items():
            writer.add_node(osmium.osm.mutable.Node(id=node_id, location=(longitude, 0.005)))
        writer.add_way(
            osmium.osm.mutable.Way(
                id=200,
                nodes=[1, 2],
                tags={"highway": "residential", "bicycle": "yes", "name": "Connected ramp"},
            )
        )
        if include_restriction:
            writer.add_relation(
                osmium.osm.mutable.Relation(
                    id=500,
                    members=[("w", 200, "from"), ("n", 2, "via"), ("w", 201, "to")],
                    tags={"type": "restriction", "restriction:bicycle": "no_straight_on"},
                )
            )
        writer.add_way(
            osmium.osm.mutable.Way(
                id=201,
                nodes=[2, 3],
                tags={"highway": "residential", "bicycle": "yes", "name": "Connected ramp"},
            )
        )
    return pbf_path


def _write_branch_profile_fixture(pbf_path: Path) -> Path:
    pbf_path.parent.mkdir(parents=True, exist_ok=True)
    with osmium.SimpleWriter(pbf_path, overwrite=True) as writer:
        for node_id, location in {
            1: (0.001, 0.005),
            2: (0.005, 0.005),
            3: (0.009, 0.005),
            4: (0.005, 0.007),
        }.items():
            writer.add_node(osmium.osm.mutable.Node(id=node_id, location=location))
        for way_id, way_nodes in ((300, [1, 2]), (301, [2, 3]), (302, [2, 4])):
            writer.add_way(
                osmium.osm.mutable.Way(
                    id=way_id,
                    nodes=way_nodes,
                    tags={"highway": "residential", "bicycle": "yes", "name": "Branch road"},
                )
            )
    return pbf_path


def _write_bridge_corridor_fixture(pbf_path: Path) -> Path:
    pbf_path.parent.mkdir(parents=True, exist_ok=True)
    with osmium.SimpleWriter(pbf_path, overwrite=True) as writer:
        for node_id, longitude in {
            1: 0.001,
            2: 0.0038,
            3: 0.0065,
            4: 0.0092,
        }.items():
            writer.add_node(osmium.osm.mutable.Node(id=node_id, location=(longitude, 0.005)))
        for way_id, way_nodes, structure_tags in (
            (210, [1, 2], {}),
            (211, [2, 3], {"bridge": "yes"}),
            (212, [3, 4], {}),
        ):
            writer.add_way(
                osmium.osm.mutable.Way(
                    id=way_id,
                    nodes=way_nodes,
                    tags={
                        "highway": "residential",
                        "bicycle": "yes",
                        "name": "Bridge corridor",
                        **structure_tags,
                    },
                )
            )
    return pbf_path


def _sign_pack_with_generated_key(
    tmp_path: Path,
    pack_directory: Path,
) -> TerrainPackSigningResult:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    signing_key_path = tmp_path / "terrain-signing-key.pem"
    signing_key_path.write_bytes(
        Ed25519PrivateKey.generate().private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    signing_key_path.chmod(0o600)
    return sign_elevation_grid_pack(pack_directory, signing_key_path, "profile-fixture")
