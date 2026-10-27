<div align="center">

# CycleComp 🚴

### A cycling computer for iPhone

Plan a route, follow it on the road, and keep your ride recorded.

[![iOS](https://img.shields.io/badge/platform-iOS-111827?style=flat-square)](https://developer.apple.com/ios/)
[![React Native](https://img.shields.io/badge/React_Native-0.87-61DAFB?style=flat-square&logo=react&logoColor=111827)](https://reactnative.dev/)
[![License: MIT](https://img.shields.io/badge/license-MIT-16A34A?style=flat-square)](LICENSE)

</div>

---

CycleComp is an iOS-first cycling app built with React Native. It brings route previews, ride guidance, live ride metrics, and GPX recording together in one place.

## What you can do

| Routes | Ride tracking | Maps and elevation |
| --- | --- | --- |
| Import a GPX file or open a route from a supported map link. | Record, pause, resume, and export a ride as GPX. | Save offline map areas and view route elevation profiles. |
| Review the route before starting. | Keep track of distance, speed, elapsed time, and available sensor readings. | Follow route guidance and see upcoming turn or climb cues. |

## Project status

CycleComp is under active development. The iOS app remains the release reference; Android parity work is in progress on a separate branch and is not ready for release. Some guidance, sensor, background-tracking, and terrain behavior still needs broader physical-device validation; simulator results alone do not establish real-world GPS, sensor, or battery performance. See [Android parity status](docs/ANDROID_PARITY.md) for implemented areas and gaps.

## Run on iOS

You’ll need macOS, Xcode, CocoaPods, and Node.js 22.23.2 through NVM. The app requires iOS 18 or later.

```sh
source "$HOME/.nvm/nvm.sh"
nvm use
npm ci
cd ios
bundle install
bundle exec pod install
cd ..
npm start
```

In a second terminal, launch the app in the iOS Simulator:

```sh
source "$HOME/.nvm/nvm.sh"
nvm use
npm run ios
```

## Run the local map preview

The optional local map preview uses a small Jatiluwih extract. Prepare its source and assets, then start the local server:

```sh
source "$HOME/.nvm/nvm.sh"
nvm use
npm run maps:prepare
npm run maps:serve
```

Keep the server on a trusted local network. Map extracts, fonts, and sprites carry separate licensing and attribution requirements; see the notices in `dev/maps/assets` and the source provider’s terms.

## Checks

```sh
npm run lint
npx tsc --noEmit
npm test -- --runInBand
```

## Contributing

Start with a [bug report or feature request](https://github.com/komenkx1/CycleComp/issues/new/choose). Code changes go through a pull request to `main`; direct pushes to `main` are disabled. See [CONTRIBUTING.md](CONTRIBUTING.md) for the project’s review and validation expectations.

## License and credits

Original CycleComp source code is available under the [MIT License](LICENSE). Third-party dependencies, map data, and bundled assets retain their own licenses and attribution terms. The MIT License does not cover third-party materials.
