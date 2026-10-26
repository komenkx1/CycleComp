# CycleComp implementation instructions

Read the planning documents in `../outputs/` before changing product behavior:

1. `PRODUCT_REQUIREMENTS.md`
2. `TECHNICAL_DESIGN.md`
3. `DELIVERY_PLAN.md`

## Toolchain

- Run `nvm use` before every Node, npm, npx, Metro, or React Native command.
- Keep `.nvmrc`, `package-lock.json`, and native lockfiles committed.
- Use bare React Native New Architecture with strict TypeScript.
- The iOS deployment target is 18.0.

## Architecture

- Keep navigation, elevation, route, and ride domain logic independent from React, React Native, MapLibre, Swift, and Kotlin.
- Native `RideTracking` owns platform location and sensor sessions. React component lifecycle must not start or stop an active ride implicitly.
- Keep high-frequency samples in native storage and publish throttled typed snapshots to JavaScript.
- MapLibre renders prepared state. It does not own navigation decisions.
- Android is planned after the iOS MVP. Do not claim Android support until its device tests pass.

## Naming and code shape

- Prefer names that describe cycling or navigation purpose, such as `candidateRouteSegments`, `matchedRouteDistance`, and `upcomingNavigationCue`.
- Avoid vague names such as `data`, `result`, `payload`, `temp`, or `items` where a specific name is available.
- Keep functions small and control flow explicit.
- Do not refactor unrelated code.
- Comments explain business rules or framework limitations, not obvious syntax.

## Product boundaries

- Never bulk-download from `tile.openstreetmap.org`.
- Geometry-derived cues are not full turn-by-turn routing.
- Route-ahead climb warnings come from a stored elevation profile, not the live barometer.
- BLE and Realme Watch support are post-MVP.
- Do not add accounts, cloud sync, social features, HealthKit, or free routing without an explicit scope change.

## Verification

- Unit-test domain algorithms and replay route traces deterministically.
- Simulator results do not prove background tracking, Core Motion, haptics, audio, or battery behavior.
- Test release builds on a physical iPhone for every location, sensor, background, or energy change.
- Report whether work was implemented, simulated, or verified on a physical device.
