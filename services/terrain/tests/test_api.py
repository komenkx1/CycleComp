from __future__ import annotations

from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient

from cyclecomp_terrain.api import create_app
from test_raster_elevation import create_dataset


def test_health_readiness_and_bounded_elevation_batch(tmp_path: Path) -> None:
    terrain_store = create_dataset(
        tmp_path / "dataset",
        [("flat", 115, np.array([[0, -2], [4, 6]], dtype=np.float32), None)],
    )
    app = create_app(terrain_store=terrain_store)

    try:
        with TestClient(app) as client:
            assert client.get("/healthz").json() == {"status": "ok"}
            assert client.get("/readyz").json() == {"status": "ready", "datasetVersion": "test-dem-1"}
            response = client.post(
                "/v1/elevation/batch",
                json={
                    "coordinates": [
                        {"longitude": 115.5, "latitude": 1.5},
                        {"longitude": 118, "latitude": 1},
                    ]
                },
            )

        assert response.status_code == 200
        body = response.json()
        assert body["datasetVersion"] == "test-dem-1"
        assert body["verticalDatum"] == "fixture datum"
        assert body["samples"] == [
            {"index": 0, "elevationMeters": 0, "reason": None},
            {"index": 1, "elevationMeters": None, "reason": "out_of_coverage"},
        ]
    finally:
        terrain_store.close()


def test_batch_rejects_more_than_two_thousand_coordinates(tmp_path: Path) -> None:
    terrain_store = create_dataset(
        tmp_path / "dataset",
        [("flat", 115, np.array([[0, 1], [2, 3]], dtype=np.float32), None)],
    )
    app = create_app(terrain_store=terrain_store)
    try:
        with TestClient(app) as client:
            response = client.post(
                "/v1/elevation/batch",
                json={"coordinates": [{"longitude": 115.5, "latitude": 1.5}] * 2_001},
            )
        assert response.status_code == 422
    finally:
        terrain_store.close()


def test_batch_rejects_oversized_body_before_json_parsing(tmp_path: Path) -> None:
    terrain_store = create_dataset(
        tmp_path / "dataset",
        [("flat", 115, np.array([[0, 1], [2, 3]], dtype=np.float32), None)],
    )
    app = create_app(terrain_store=terrain_store)
    try:
        with TestClient(app) as client:
            response = client.post(
                "/v1/elevation/batch",
                content=b"{" + b" " * (256 * 1024),
                headers={"content-type": "application/json"},
            )
        assert response.status_code == 413
    finally:
        terrain_store.close()


def test_health_stays_available_when_dataset_is_missing(tmp_path: Path) -> None:
    app = create_app(dataset_directory=tmp_path / "missing-release")

    with TestClient(app) as client:
        assert client.get("/healthz").status_code == 200
        assert client.get("/readyz").status_code == 503
        assert client.post(
            "/v1/elevation/batch",
            json={"coordinates": [{"longitude": 115.5, "latitude": 1.5}]},
        ).status_code == 503
