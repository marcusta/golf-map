# Watch: shot-distance tracker + on-course distances

Watch companion app (`ios/GolfMapWatch`, target `GolfMapWatch`), embedded in
the iOS app for WatchConnectivity pairing but fully standalone during a round
(`WKRunsIndependentlyOfCompanionApp`) — the phone can be dead once a course is
synced.

## v2: course sync + green distances

- **Sync**: the phone queues a `WatchCourseBundle` (shared source in
  `ios/GolfMapWatchShared/`) on every course open (`CourseScreen.load` →
  `WatchSyncService`, WCSession `transferFile`, content-hash dedupe). Payload:
  per hole tee / green center / front / back / green outer ring — front/back +
  polygon synced from day one so the later views need no format change.
- **Watch storage**: `CourseLibrary` receives + persists bundles in
  Application Support; newest bundle is the active course, picker when several.
- **Hole detection**: `HoleSelector` (pure, unit-tested) — nearest hole by
  distance to the tee→green-center segment, 25 m hysteresis against flapping
  between parallel fairways, 35 m tee snap always wins and releases a manual
  override (chevrons).
- **On-course screen**: hole + par, big live center distance (planar EPSG:3006
  meters — same math as phone/web via shared `Geo` sources), F/B row when
  authored. Vertical pager: on-course on top, mark-shot below.

## v3: elevation + plays-like + mini green map

- **Elevation grids** (`GolfMapWatchShared/WatchElevation.swift`): two tiers
  per hole, axis-aligned EPSG:3006, int16 cm relative to a per-grid base
  (lossless — never JPEG: slope is a derivative, lossy block noise would
  turn into garbage gradients). Green tier: 1 m cells over polygon + 10 m
  apron (full lidar resolution). Corridor tier: 12 m cells within 40 m of
  the tee→aims→green line; cells beyond stay nodata. Nothing between holes.
  Built by `WatchElevationPatchBuilder` from the phone's terrain pyramid.
- **Plays-like on the watch**: `PlaysLike.segmentStats` (same shared source
  as phone/web) from player elevation (corridor/green tier) to green-center
  elevation (green tier). Row hides when either sample is off-grid —
  straight distance is never wrong, plays-like can be.
- **Mini green map** (`GreenMapView`, middle pager page): the phone
  pre-renders each green's slope shading (same ramp as the Green view,
  0.25 m/px, PNG, clipped to the polygon) via `WatchGreenImageRenderer`;
  the watch draws the bitmap + boundary + live player dot + F/C/B row.
  The watch computes nothing.
- **Dedupe fix**: the content hash now zeroes `builtAt` before hashing —
  previously every course open re-queued a transfer.
- Format stays v1 (all additive optional fields); older watch builds ignore
  the new keys.

## What it does

- **Mark shot** stores the current GPS fix as the shot position.
- The screen then shows a live meter readout: distance from the mark to the
  current fix, plus the fix's horizontal accuracy (±N m).
- **Re-mark** replaces the mark (next shot); **Clear** removes it.

Use case: hit into the rough → mark before walking off the tee is not needed;
mark where you hit, walk, and when the readout says ~220 m you're in the search
area.

## Design decisions

- **No continuous tracking.** Distance = `currentFix.distance(from: mark)`, so
  the app can suspend (wrist down) with no background-location mode; the number
  is correct again on wrist raise once a fresh fix lands.
- The mark persists in `UserDefaults`, so it survives an app relaunch mid-walk.
- Location via `CLLocationUpdate.liveUpdates(.fitness)` (async sequence, no
  delegate); prompts for when-in-use authorization on first use. Denied-state
  hint needs watchOS 11+ (`update.authorizationDenied`); on 10.x it's skipped.
- Deployment target watchOS 10.0, Swift 6 strict concurrency, same team /
  signing setup as the iOS app.

## Later (not in v1)

- Swing detection (Core Motion) to auto-mark instead of the button.
- Club + shot log; sync to the phone app / Tapscore.
- Yards/meters toggle.
