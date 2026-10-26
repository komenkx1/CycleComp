from __future__ import annotations

import argparse
import json
from pathlib import Path

from cyclecomp_terrain.catalog_publish import publish_signed_terrain_catalog


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Verify immutable terrain packs and atomically publish a signed catalog pointer."
    )
    parser.add_argument("--distribution-dir", required=True, type=Path)
    parser.add_argument("--release-id", required=True)
    parser.add_argument("--signing-key", required=True, type=Path)
    parser.add_argument("--signature-key-id", required=True)
    options = parser.parse_args(arguments)

    try:
        publication = publish_signed_terrain_catalog(
            options.distribution_dir,
            options.release_id,
            options.signing_key,
            options.signature_key_id,
        )
    except (OSError, ValueError) as error:
        parser.exit(2, f"terrain catalog publication failed: {error}\n")

    print(json.dumps(publication, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
