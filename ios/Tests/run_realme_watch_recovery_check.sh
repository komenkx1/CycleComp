#!/bin/sh
set -eu
project_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
check_dir=$(mktemp -d "${TMPDIR:-/tmp}/cyclecomp-watch-recovery.XXXXXX")
trap 'rm -r "$check_dir"' EXIT
cp "$project_root/ios/Tests/RealmeWatchRecoveryCheck.swift" "$check_dir/main.swift"
swiftc -emit-module -emit-library -module-name CoreBluetooth \
  "$project_root/ios/Tests/WatchRecoverySupport/CoreBluetooth.swift" -o "$check_dir/libCoreBluetooth.dylib"
swiftc -I "$check_dir" -L "$check_dir" -lCoreBluetooth \
  "$project_root/ios/CycleComp/RealmeWatchProtocol.swift" \
  "$project_root/ios/CycleComp/RealmeWatchHeartRate.swift" \
  "$check_dir/main.swift" -o "$check_dir/check"
DYLD_LIBRARY_PATH="$check_dir" "$check_dir/check"
