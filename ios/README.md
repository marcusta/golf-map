# GolfMap iOS

SwiftUI app (iOS 17+, iPhone only). The Xcode project is **generated** — `project.yml` is the source of truth; `GolfMap.xcodeproj` and `GolfMap/Info.plist` are gitignored.

## Prerequisites

- Xcode 26+
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`)

## Regenerate the project

```sh
cd ios
xcodegen generate
```

Run this after cloning and whenever `project.yml` changes (targets, packages, Info.plist entries, build settings). Never edit the `.xcodeproj` or generated `Info.plist` directly.

## Open in Xcode

```sh
open ios/GolfMap.xcodeproj
```

First build resolves SPM packages (MapLibre downloads a ~100 MB xcframework — be patient).

## Build from the CLI

```sh
xcodebuild -project ios/GolfMap.xcodeproj -scheme GolfMap \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

## Run tests from the CLI

```sh
xcodebuild -project ios/GolfMap.xcodeproj -scheme GolfMap \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

## Structure

```
GolfMap/
  App/       @main entry + AppEnvironment (app-wide dependency container)
  API/       server API client (dev server: http://localhost:3000)
  Geo/       geometry/geodesy helpers
  Store/     on-device course bundle store (GRDB/SQLite)
  Map/       MapLibre map rendering
  Screens/   SwiftUI screens
GolfMapTests/  unit tests (XCTest, hosted by the app)
```

Notes:
- ATS allows **local networking only** (for the dev server); no arbitrary loads.
- Swift 6 language mode with strict concurrency = complete.
- MapLibre gotcha: never create an `MLNMapView` with a zero frame.
