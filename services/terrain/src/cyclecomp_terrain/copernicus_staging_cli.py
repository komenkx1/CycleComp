from __future__ import annotations

import argparse
import json
from pathlib import Path

from cyclecomp_terrain.copernicus_staging import (
    DEFAULT_DOWNLOAD_WORKERS,
    DEFAULT_MINIMUM_DISK_HEADROOM_BYTES,
    stage_copernicus_dataset,
)


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Stage a hash-verified Copernicus DEM dataset without activating it."
    )
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--output-directory", required=True, type=Path)
    parser.add_argument("--dataset-version", required=True)
    parser.add_argument("--workers", type=int, default=DEFAULT_DOWNLOAD_WORKERS)
    parser.add_argument(
        "--minimum-free-bytes",
        type=int,
        default=DEFAULT_MINIMUM_DISK_HEADROOM_BYTES,
    )
    options = parser.parse_args(arguments)

    try:
        staging_report = stage_copernicus_dataset(
            options.inventory,
            options.output_directory,
            options.dataset_version,
            options.workers,
            options.minimum_free_bytes,
        )
    except (OSError, ValueError, json.JSONDecodeError) as error:
        parser.exit(2, f"Copernicus dataset staging failed: {error}\n")

    print(json.dumps(staging_report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
