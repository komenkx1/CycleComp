#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
replay_binary="${TMPDIR:-/tmp}/cyclecomp-ride-sensor-replay"

swiftc \
  "$project_dir/ios/CycleComp/RideAutoPausePolicy.swift" \
  "$project_dir/ios/CycleComp/RideMeasurement.swift" \
  "$project_dir/ios/CycleComp/RideSensorTrace.swift" \
  "$project_dir/ios/Tests/RideSensorTraceReplay.swift" \
  -o "$replay_binary"

"$replay_binary" "$@"
