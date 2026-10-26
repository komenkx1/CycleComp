from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from cyclecomp_terrain.copernicus_staging import (
    CopernicusTile,
    _download_tile,
)


class FakeDownloadResponse:
    def __init__(self, payload: bytes, status: int, headers: dict[str, str]) -> None:
        self.payload = payload
        self.status = status
        self.headers = headers

    def __enter__(self) -> FakeDownloadResponse:
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def read(self, byte_count: int = -1) -> bytes:
        if byte_count < 0:
            payload, self.payload = self.payload, b""
            return payload
        payload, self.payload = self.payload[:byte_count], self.payload[byte_count:]
        return payload


def make_tile(payload: bytes) -> CopernicusTile:
    return CopernicusTile(
        "Copernicus_DSM_COG_10_S07_00_E107_00_DEM/Copernicus_DSM_COG_10_S07_00_E107_00_DEM.tif",
        len(payload),
        '"expected-etag"',
    )


def test_downloads_and_verifies_a_complete_s3_object(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = b"copernicus-dem-tile"
    tile = make_tile(payload)
    response = FakeDownloadResponse(
        payload,
        200,
        {"ETag": tile.expected_etag, "Content-Length": str(len(payload))},
    )
    monkeypatch.setattr(
        "cyclecomp_terrain.copernicus_staging.urlopen",
        lambda *_args, **_kwargs: response,
    )

    downloaded_bytes = _download_tile("https://copernicus-dem-30m.s3.amazonaws.com/", tile, tmp_path)

    staged_path = tmp_path / tile.filename
    assert downloaded_bytes == len(payload)
    assert staged_path.read_bytes() == payload
    assert hashlib.sha256(staged_path.read_bytes()).hexdigest() == hashlib.sha256(payload).hexdigest()
    assert not staged_path.with_name(f".{staged_path.name}.partial").exists()


def test_resumes_a_partial_tile_with_matching_etag_and_content_range(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = b"copernicus-dem-tile"
    tile = make_tile(payload)
    staged_path = tmp_path / tile.filename
    partial_path = staged_path.with_name(f".{staged_path.name}.partial")
    partial_path.write_bytes(payload[:8])
    response = FakeDownloadResponse(
        payload[8:],
        206,
        {
            "ETag": tile.expected_etag,
            "Content-Length": str(len(payload) - 8),
            "Content-Range": f"bytes 8-{len(payload) - 1}/{len(payload)}",
        },
    )
    monkeypatch.setattr(
        "cyclecomp_terrain.copernicus_staging.urlopen",
        lambda *_args, **_kwargs: response,
    )

    _download_tile("https://copernicus-dem-30m.s3.amazonaws.com/", tile, tmp_path)

    assert staged_path.read_bytes() == payload


def test_rejects_object_when_s3_etag_changed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = b"copernicus-dem-tile"
    tile = make_tile(payload)
    response = FakeDownloadResponse(
        payload,
        200,
        {"ETag": '"changed-etag"', "Content-Length": str(len(payload))},
    )
    monkeypatch.setattr(
        "cyclecomp_terrain.copernicus_staging.urlopen",
        lambda *_args, **_kwargs: response,
    )

    with pytest.raises(ValueError, match="ETag changed"):
        _download_tile("https://copernicus-dem-30m.s3.amazonaws.com/", tile, tmp_path)

    assert not (tmp_path / tile.filename).exists()
