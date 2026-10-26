# Contributing to CycleComp

Thanks for helping improve CycleComp. Changes are reviewed through GitHub pull requests.

## Report a bug or propose a feature

Use the bug report or feature request form in GitHub Issues. Include the app version, iOS version, steps to reproduce, and what you expected to happen. Do not attach ride GPX files, logs, screenshots, or other files that contain private location or device information unless the maintainers specifically request them.

## Make a change

1. Fork the repository and create a focused branch from `main`.
2. Follow the existing code style and keep unrelated refactors out of the change.
3. Run the relevant checks from the README.
4. Open a pull request against `main` and explain the user-visible change and verification performed.

The `main` branch is protected. Changes must go through a pull request; maintainers review and merge contributions.

## Scope and platform evidence

CycleComp is currently iOS-first. Clearly distinguish code changes, simulator checks, and physical-device checks. A simulator does not establish real GPS, sensor, background, or battery behavior. Android support is not considered complete until device validation is documented.

## Third-party content

Do not add map extracts, route recordings, credentials, signing material, or device logs to pull requests. Preserve third-party license and attribution notices when changing dependencies or assets.
