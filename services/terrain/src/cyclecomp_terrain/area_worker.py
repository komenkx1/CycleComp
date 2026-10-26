from __future__ import annotations

import logging
import os
from pathlib import Path
import signal
import threading

from cryptography.hazmat.primitives import serialization

from cyclecomp_terrain.signing import _load_signing_key
from cyclecomp_terrain.terrain_area_build import TerrainAreaBuildManager


logger = logging.getLogger("cyclecomp_terrain.area_worker")


def main() -> None:
    logging.basicConfig(level=os.environ.get("CYCLECOMP_TERRAIN_LOG_LEVEL", "INFO"))
    region_config_path = _required_path("CYCLECOMP_TERRAIN_AREA_REGION_CONFIG")
    dataset_directory = _required_path("CYCLECOMP_TERRAIN_AREA_DATASET_DIR")
    distribution_directory = _required_path("CYCLECOMP_TERRAIN_DISTRIBUTION_DIR")
    jobs_directory = _required_path("CYCLECOMP_TERRAIN_AREA_JOBS_DIR")
    signing_key_path = _required_path("CYCLECOMP_TERRAIN_AREA_SIGNING_KEY")
    signature_key_id = os.environ.get("CYCLECOMP_TERRAIN_AREA_SIGNING_KEY_ID")
    if not signature_key_id:
        raise ValueError("CYCLECOMP_TERRAIN_AREA_SIGNING_KEY_ID is required")
    signing_key = _load_signing_key(signing_key_path)
    trusted_signing_keys = {
        signature_key_id: signing_key.public_key().public_bytes(
            serialization.Encoding.Raw,
            serialization.PublicFormat.Raw,
        ),
    }

    manager = TerrainAreaBuildManager(
        region_config_path=region_config_path,
        distribution_directory=distribution_directory,
        jobs_directory=jobs_directory,
        trusted_signing_keys=trusted_signing_keys,
        dataset_directory=dataset_directory,
        signing_key_path=signing_key_path,
        signature_key_id=signature_key_id,
        run_worker=True,
    )
    stopped = threading.Event()

    def stop_worker(_signal_number: int, _frame: object) -> None:
        stopped.set()

    signal.signal(signal.SIGTERM, stop_worker)
    signal.signal(signal.SIGINT, stop_worker)
    logger.info("On-demand terrain worker is ready")
    try:
        stopped.wait()
    finally:
        manager.close()


def _required_path(environment_name: str) -> Path:
    configured_value = os.environ.get(environment_name)
    if not configured_value:
        raise ValueError(f"{environment_name} is required")
    return Path(configured_value)


if __name__ == "__main__":
    main()
