from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import tempfile

from cyclecomp_terrain.grid_region_config import create_grid_region_config


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Create small elevation-only chunks from the DEM tiles in a dataset manifest."
    )
    parser.add_argument("--dataset-manifest", required=True, type=Path)
    parser.add_argument("--release-id", required=True)
    parser.add_argument("--signature-key-id", required=True)
    parser.add_argument("--chunk-size-degrees", type=float, default=0.25)
    parser.add_argument(
        "--dataset-directory",
        type=Path,
        help="Skip chunks with no valid DEM cells after reading their source raster windows.",
    )
    parser.add_argument(
        "--exclude-tile-id",
        action="append",
        default=[],
        help="Skip one source tile already covered by a different installed package.",
    )
    parser.add_argument("--output", required=True, type=Path)
    options = parser.parse_args(arguments)

    try:
        region_config = create_grid_region_config(
            options.dataset_manifest,
            options.release_id,
            options.signature_key_id,
            options.chunk_size_degrees,
            set(options.exclude_tile_id),
            options.dataset_directory,
        )
        _write_json_atomically(options.output, region_config)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        parser.exit(2, f"terrain region config generation failed: {error}\n")

    print(json.dumps({"output": str(options.output), "regionCount": len(region_config["regions"])}))
    return 0


def _write_json_atomically(output_path: Path, contents: dict[str, object]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    file_descriptor, temporary_path_value = tempfile.mkstemp(
        prefix=f".{output_path.name}-",
        suffix=".tmp",
        dir=output_path.parent,
    )
    temporary_path = Path(temporary_path_value)
    try:
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as output_file:
            json.dump(contents, output_file, indent=2, sort_keys=True)
            output_file.write("\n")
            output_file.flush()
            os.fsync(output_file.fileno())
        os.replace(temporary_path, output_path)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise


if __name__ == "__main__":
    raise SystemExit(main())
