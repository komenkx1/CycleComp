# Android parity

The `fix/android-parity` branch ports CycleComp using the iOS app as the behavioral reference. Android remains in development and is not yet ready for release.

## Available in this branch

- The shared ride, route, map, and settings screens use Android icon and switch counterparts.
- The location foreground service records GPS points, resumes interrupted rides, and writes GPX files atomically. Manual and automatic pauses create separate track segments.
- Pressure and motion sensors feed live elevation, speed, and grade where valid readings are available. GPS is used as a fallback. Optional sensor diagnostics stay in local storage and can be shared by the rider.
- Signed terrain packages can be downloaded, validated, installed, and sampled to enrich routes. Package signatures and database hashes must pass verification before installation.
- The realme Watch 5 protocol, Bluetooth permissions, HR recording, and GPX HR extensions have Android implementations. The implementation has not been tested with a physical watch.

## Remaining differences and validation

- Live road-graph matching and road-profile climb guidance have not been ported. A terrain grid does not by itself provide road guidance.
- Android package downloads do not resume automatically after the app process is killed. SQLite spatial-index validation uses an Android-specific reader and has a different implementation from iOS.
- Android does not have the iOS motion-activity classification. Auto-pause uses the GPS evidence policy, with position and speed accuracy checks.
- Material icons are visual counterparts, not identical SF Symbols. System fonts and controls can differ by OS.
- Emulator and automated tests do not prove physical GPS quality, Bluetooth behavior, vendor-specific background reliability, pressure-sensor accuracy, or battery use. Device validation remains necessary before release.

## Checks

Use Node 22.23.2 through NVM. Run `npm test -- --runInBand` and `npx tsc --noEmit` from the repository root. Build with JDK 17 and the Android SDK using `cd android && ./gradlew app:assembleDebug app:assembleDebugAndroidTest`. The Android instrumentation runner checks signed terrain grids, corrupted packages, ride pause and recovery, auto-pause, and simulated HR export. Record the Android version, emulator or device model, permission choice, and which results came from a physical device.
