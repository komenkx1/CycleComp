from __future__ import annotations

import base64
from pathlib import Path
import platform
import os
import shutil
import subprocess

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
import numpy as np
import osmium
import pytest

from cyclecomp_terrain.grid_pack import build_elevation_grid_pack
from cyclecomp_terrain.signing import sign_elevation_grid_pack
from test_raster_elevation import create_dataset
from test_road_graph import OSM_SNAPSHOT_AT, OSM_SOURCE_URL, ROAD_BOUNDS, _write_road_graph_fixture


@pytest.mark.skipif(
    platform.system() != "Darwin" or shutil.which("swiftc") is None or shutil.which("clang++") is None,
    reason="the native terrain reader check requires the Apple Swift SDK",
)
def test_swift_grid_reader_and_store_verify_and_sample_generated_packs(tmp_path: Path) -> None:
    repository_root = Path(__file__).resolve().parents[3]
    reader_source = repository_root / "ios" / "CycleComp" / "TerrainGridPackReader.swift"
    store_source = repository_root / "ios" / "CycleComp" / "TerrainGridPackStore.swift"
    guidance_source = repository_root / "ios" / "CycleComp" / "TerrainRoadGuidanceRuntime.swift"
    matcher_bridge_source = repository_root / "ios" / "CycleComp" / "TerrainRoadMatcherBridge.mm"
    matcher_core_source = repository_root / "core" / "terrain" / "src" / "road_matcher.cpp"
    matcher_include_directory = repository_root / "core" / "terrain" / "include"
    matcher_bridging_header = repository_root / "ios" / "CycleComp" / "CycleComp-Bridging-Header.h"
    check_source = repository_root / "ios" / "Tests" / "TerrainGridPackReaderCheck.swift"
    native_check_binary = tmp_path / "terrain-grid-reader-check"
    matcher_bridge_object = tmp_path / "terrain-road-matcher-bridge.o"
    matcher_core_object = tmp_path / "terrain-road-matcher-core.o"
    subprocess.run(
        [
            shutil.which("clang++") or "clang++",
            "-std=c++20",
            "-fobjc-arc",
            "-I",
            str(matcher_include_directory),
            "-c",
            str(matcher_bridge_source),
            "-o",
            str(matcher_bridge_object),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        [
            shutil.which("clang++") or "clang++",
            "-std=c++20",
            "-I",
            str(matcher_include_directory),
            "-c",
            str(matcher_core_source),
            "-o",
            str(matcher_core_object),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        [
            shutil.which("swiftc") or "swiftc",
            "-D",
            "DEBUG",
            "-import-objc-header",
            str(matcher_bridging_header),
            str(reader_source),
            str(store_source),
            str(guidance_source),
            str(check_source),
            str(matcher_bridge_object),
            str(matcher_core_object),
            "-framework",
            "Foundation",
            "-framework",
            "CoreLocation",
            "-lc++",
            "-o",
            str(native_check_binary),
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    signed_elevation_surface = np.array(
        [[-5, 0, 5], [10, 15, 20], [-9999, 40, 50]],
        dtype=np.float32,
    )
    signed_dataset = create_dataset(
        tmp_path / "signed-source",
        [("signed-grid", 0, signed_elevation_surface, -9999)],
    )
    try:
        signed_pack = build_elevation_grid_pack(
            signed_dataset,
            tmp_path / "packs" / "signed-grid",
            "signed-grid",
            (0.49, 0.49, 2.51, 2.51),
        )
    finally:
        signed_dataset.close()

    subprocess.run(
        [str(native_check_binary), str(signed_pack.pack_directory), "samples"],
        check=True,
        capture_output=True,
        text=True,
    )

    python_signed_pack_directory = tmp_path / "packs" / "python-signed-grid"
    shutil.copytree(signed_pack.pack_directory, python_signed_pack_directory)
    python_signing_key = Ed25519PrivateKey.generate()
    python_private_key_path = tmp_path / "python-signing-key.pem"
    python_private_key_path.write_bytes(
        python_signing_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    python_private_key_path.chmod(0o600)
    sign_elevation_grid_pack(
        python_signed_pack_directory,
        python_private_key_path,
        "terrain-test-2026",
    )
    trusted_public_key_base64 = base64.b64encode(
        python_signing_key.public_key().public_bytes(
            serialization.Encoding.Raw,
            serialization.PublicFormat.Raw,
        )
    ).decode("ascii")
    subprocess.run(
        [
            str(native_check_binary),
            str(python_signed_pack_directory),
            "external-signed",
            trusted_public_key_base64,
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    road_graph_source = create_dataset(
        tmp_path / "road-graph-source",
        [("road-graph", 0, np.array([[0, 7_000], [0, 7_000]], dtype=np.float32), None)],
    )
    road_graph_pbf = _write_road_graph_fixture(tmp_path / "road-graph.osm.pbf")
    zero_indexed_road_pbf = _write_zero_indexed_road_fixture(
        tmp_path / "zero-indexed-road.osm.pbf"
    )
    inferred_access_road_pbf = _write_zero_indexed_road_fixture(
        tmp_path / "inferred-road.osm.pbf", inferred_continuation=True
    )
    try:
        road_graph_pack = build_elevation_grid_pack(
            road_graph_source,
            tmp_path / "packs" / "road-graph-grid-reader",
            "road-graph-grid-reader",
            ROAD_BOUNDS,
            osm_pbf_path=road_graph_pbf,
            osm_source_url=OSM_SOURCE_URL,
            osm_snapshot_at=OSM_SNAPSHOT_AT,
            road_graph_buffer_meters=0,
        )
        zero_indexed_road_pack = build_elevation_grid_pack(
            road_graph_source,
            tmp_path / "packs" / "zero-indexed-road-grid-reader",
            "zero-indexed-road-grid-reader",
            ROAD_BOUNDS,
            osm_pbf_path=zero_indexed_road_pbf,
            osm_source_url=OSM_SOURCE_URL,
            osm_snapshot_at=OSM_SNAPSHOT_AT,
            road_graph_buffer_meters=0,
        )
        inferred_access_road_pack = build_elevation_grid_pack(
            road_graph_source,
            tmp_path / "packs" / "inferred-access-road-grid-reader",
            "inferred-access-road-grid-reader",
            ROAD_BOUNDS,
            osm_pbf_path=inferred_access_road_pbf,
            osm_source_url=OSM_SOURCE_URL,
            osm_snapshot_at=OSM_SNAPSHOT_AT,
            road_graph_buffer_meters=0,
        )
    finally:
        road_graph_source.close()

    sign_elevation_grid_pack(
        road_graph_pack.pack_directory,
        python_private_key_path,
        "terrain-test-2026",
    )
    subprocess.run(
        [
            str(native_check_binary),
            str(road_graph_pack.pack_directory),
            "external-signed-graph",
            trusted_public_key_base64,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    sign_elevation_grid_pack(
        zero_indexed_road_pack.pack_directory,
        python_private_key_path,
        "terrain-test-2026",
    )
    subprocess.run(
        [
            str(native_check_binary),
            str(zero_indexed_road_pack.pack_directory),
            "external-signed-zero-corridor",
            trusted_public_key_base64,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    sign_elevation_grid_pack(
        inferred_access_road_pack.pack_directory,
        python_private_key_path,
        "terrain-test-2026",
    )
    subprocess.run(
        [
            str(native_check_binary),
            str(inferred_access_road_pack.pack_directory),
            "external-signed-inferred",
            trusted_public_key_base64,
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    column_elevations = np.tile(np.arange(63, dtype=np.float32), (63, 1))
    seam_dataset = create_dataset(
        tmp_path / "seam-source",
        [("seam-grid", 0, column_elevations, None)],
    )
    try:
        seam_pack = build_elevation_grid_pack(
            seam_dataset,
            tmp_path / "packs" / "seam-grid",
            "seam-grid",
            (0, 0, 63, 63),
        )
    finally:
        seam_dataset.close()

    subprocess.run(
        [str(native_check_binary), str(seam_pack.pack_directory), "seam"],
        check=True,
        capture_output=True,
        text=True,
    )

    signed_pack_directory = tmp_path / "packs" / "signed-release-check"
    shutil.copytree(signed_pack.pack_directory, signed_pack_directory)
    subprocess.run(
        [str(native_check_binary), str(signed_pack_directory), "signed"],
        check=True,
        capture_output=True,
        text=True,
    )

    store_pack_directory = tmp_path / "packs" / "store-grid"
    shutil.copytree(signed_pack.pack_directory, store_pack_directory)
    subprocess.run(
        [str(native_check_binary), str(store_pack_directory), "store"],
        check=True,
        capture_output=True,
        text=True,
    )

    corrupted_pack = tmp_path / "packs" / "corrupted-grid"
    shutil.copytree(signed_pack.pack_directory, corrupted_pack)
    with (corrupted_pack / "terrain.sqlite").open("r+b") as database_file:
        first_byte = database_file.read(1)
        database_file.seek(0)
        database_file.write(bytes([first_byte[0] ^ 0x01]))
    subprocess.run(
        [str(native_check_binary), str(corrupted_pack), "corrupt"],
        check=True,
        capture_output=True,
        text=True,
    )

    symlink_pack = tmp_path / "packs" / "symlink-grid"
    shutil.copytree(signed_pack.pack_directory, symlink_pack)
    linked_database = symlink_pack / "terrain.sqlite"
    linked_database.unlink()
    os.symlink(signed_pack.pack_directory / "terrain.sqlite", linked_database)
    subprocess.run(
        [str(native_check_binary), str(symlink_pack), "symlink"],
        check=True,
        capture_output=True,
        text=True,
    )


def _write_zero_indexed_road_fixture(
    pbf_path: Path, inferred_continuation: bool = False,
) -> Path:
    pbf_path.parent.mkdir(parents=True, exist_ok=True)
    with osmium.SimpleWriter(pbf_path, overwrite=True) as writer:
        writer.add_node(osmium.osm.mutable.Node(id=1, location=(1.1, 1.1)))
        writer.add_node(osmium.osm.mutable.Node(id=2, location=(1.2, 1.2)))
        if inferred_continuation:
            writer.add_node(osmium.osm.mutable.Node(id=3, location=(1.17, 1.17)))
        writer.add_way(
            osmium.osm.mutable.Way(
                id=1,
                nodes=[1, 3] if inferred_continuation else [1, 2],
                tags={"highway": "residential", "bicycle": "yes"},
            )
        )
        if inferred_continuation:
            writer.add_way(
                osmium.osm.mutable.Way(
                    id=2, nodes=[3, 2], tags={"highway": "residential"},
                )
            )
    return pbf_path
