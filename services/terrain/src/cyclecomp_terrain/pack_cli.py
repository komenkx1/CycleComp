from __future__ import annotations

import argparse
from dataclasses import replace
import json
import logging
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile

from cyclecomp_terrain.grid_pack import build_elevation_grid_pack
from cyclecomp_terrain.raster_elevation import RasterElevationStore, TerrainDatasetError
from cyclecomp_terrain.signing import (
    TerrainPackSigningResult,
    sign_elevation_grid_pack,
    validate_signature_key_id,
)


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build and validate a regional elevation-grid pack.")
    parser.add_argument("--dataset-dir", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--pack-id", required=True)
    parser.add_argument("--osm-pbf", type=Path)
    parser.add_argument("--osm-source-url")
    parser.add_argument("--osm-snapshot-at", help="ISO 8601 timestamp for the source extract")
    parser.add_argument("--road-graph-buffer-meters", type=float, default=1_000)
    signing_mode = parser.add_mutually_exclusive_group(required=True)
    signing_mode.add_argument("--unsigned-pilot", action="store_true")
    signing_mode.add_argument("--signing-key", type=Path)
    parser.add_argument("--signature-key-id")
    parser.add_argument(
        "--bounds",
        required=True,
        nargs=4,
        type=float,
        metavar=("WEST", "SOUTH", "EAST", "NORTH"),
        help="requested WGS84 bounds in degrees",
    )
    options = parser.parse_args(arguments)
    if options.signing_key is None and options.signature_key_id is not None:
        parser.error("--signature-key-id requires --signing-key")
    if options.signing_key is not None and options.signature_key_id is None:
        parser.error("--signing-key requires --signature-key-id")
    if options.signature_key_id is not None:
        try:
            validate_signature_key_id(options.signature_key_id)
        except ValueError as error:
            parser.error(str(error))
    graph_arguments = (options.osm_pbf, options.osm_source_url, options.osm_snapshot_at)
    if any(value is not None for value in graph_arguments) and not all(
        value is not None for value in graph_arguments
    ):
        parser.error("--osm-pbf requires --osm-source-url and --osm-snapshot-at")

    output_directory = options.output_dir.expanduser().absolute()
    if not output_directory.name:
        parser.error("--output-dir must name a new pack directory")
    if output_directory.exists() or output_directory.is_symlink():
        parser.error("--output-dir must not already exist")

    staging_root: Path | None = None
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")

    try:
        output_directory.parent.mkdir(parents=True, exist_ok=True)
        staging_root = Path(
            tempfile.mkdtemp(prefix=f".{output_directory.name}.staging-", dir=output_directory.parent)
        )
        terrain_store = RasterElevationStore(options.dataset_dir)
        logging.info("Building terrain pack %s", options.pack_id)
        try:
            pack = build_elevation_grid_pack(
                terrain_store,
                staging_root / output_directory.name,
                options.pack_id,
                tuple(options.bounds),
                osm_pbf_path=options.osm_pbf,
                osm_source_url=options.osm_source_url,
                osm_snapshot_at=options.osm_snapshot_at,
                road_graph_buffer_meters=options.road_graph_buffer_meters,
            )
        finally:
            terrain_store.close()

        manifest = pack.manifest
        trusted_public_key_base64: str | None = None
        if options.signing_key is not None:
            logging.info("Validating and signing terrain pack")
            signing_result: TerrainPackSigningResult = sign_elevation_grid_pack(
                pack.pack_directory,
                options.signing_key,
                options.signature_key_id,
            )
            manifest = signing_result.manifest
            trusted_public_key_base64 = signing_result.trusted_public_key_base64

        if output_directory.exists() or output_directory.is_symlink():
            raise FileExistsError("terrain pack output appeared while the pack was being built")
        pack.pack_directory.rename(output_directory)
        logging.info("Terrain pack built and promoted to %s", output_directory.name)
        pack = replace(pack, pack_directory=output_directory, manifest=manifest)
    except (OSError, ValueError, sqlite3.Error, TerrainDatasetError) as error:
        parser.exit(2, f"terrain pack build failed: {error}\n")
    finally:
        if staging_root is not None:
            shutil.rmtree(staging_root, ignore_errors=True)

    print(json.dumps({
        "packDirectory": str(pack.pack_directory),
        "coverage": pack.manifest["coverage"],
        "signatureStatus": pack.manifest["signatureStatus"],
        "signatureKeyId": pack.manifest["signatureKeyId"],
        "hasRoadGraph": pack.manifest["hasRoadGraph"],
        "hasRoadProfiles": pack.manifest["hasRoadProfiles"],
        "roadGraph": pack.manifest["roadGraph"],
        "roadProfiles": pack.manifest["roadProfiles"],
        "trustedPublicKeyBase64": trusted_public_key_base64,
    }, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
