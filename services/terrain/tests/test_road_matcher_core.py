from __future__ import annotations

from pathlib import Path
import shutil
import subprocess

import pytest


@pytest.mark.skipif(shutil.which("clang++") is None, reason="the road matcher core check requires clang++")
def test_native_road_matcher_replay_regressions(tmp_path: Path) -> None:
    repository_root = Path(__file__).resolve().parents[3]
    include_directory = repository_root / "core" / "terrain" / "include"
    matcher_source = repository_root / "core" / "terrain" / "src" / "road_matcher.cpp"
    replay_source = repository_root / "core" / "terrain" / "tests" / "road_matcher_test.cpp"
    replay_binary = tmp_path / "road-matcher-check"

    subprocess.run(
        [
            shutil.which("clang++") or "clang++",
            "-std=c++20",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-pedantic",
            "-I",
            str(include_directory),
            str(matcher_source),
            str(replay_source),
            "-o",
            str(replay_binary),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    replay = subprocess.run(
        [str(replay_binary)],
        check=True,
        capture_output=True,
        text=True,
    )

    assert replay.stdout.strip() == "RoadMatcher checks passed"
