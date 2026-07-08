# ios — AGENTS

SwiftUI app (iOS 17+, iPhone only, portrait). On-course use: GPS, distances, plays-like, light planning. **No course building.** MapLibre + GRDB.

## Project is generated

`project.yml` is the source of truth (XcodeGen). `GolfMap.xcodeproj` and `GolfMap/Info.plist` are **gitignored — never edit directly**. After cloning or changing `project.yml`:

```sh
cd ios && xcodegen generate
```

Info.plist entries, SPM deps (MapLibre, GRDB), targets, build settings → edit `project.yml`.

## Layout (`GolfMap/`)

`App/` @main + `AppEnvironment` (DI container) + Keychain + `SyncService` · `API/` server client (`GolfAPIClient` is an `actor`; cookie session + auto re-login on 401; dev server `http://localhost:3000`) · `Geo/` geodesy (LatLon, Sweref99TM, PlaysLike, WebMercatorTiles) · `Store/` on-device course bundle store (GRDB/SQLite, tile enumerator, sync planner) · `Map/` MapLibre rendering + overlays · `Measure/` · `Analysis/` green analysis · `Motion/` IMU spot level · `Scan/` LiDAR corridor scan (pure fit math + ARKit capture + `ScannedSurface`) · `Screens/` SwiftUI screens · `Profile/`.

## Build / test (CLI)

```sh
xcodebuild -project ios/GolfMap.xcodeproj -scheme GolfMap \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build   # or: test
```

First build resolves SPM (MapLibre ~100 MB xcframework). Needs Xcode 26+, `brew install xcodegen`.
