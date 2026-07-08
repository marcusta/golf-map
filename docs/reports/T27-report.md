# T27 report — iOS mirror

iOS render parity for the D23/D24 stack model: the fill/outline layers now
sort by the server-assigned `stackKey` GeoJSON property, falling back to the
existing fixed type order for bundles built before T22 (no `stackKey`
property present). No reorder UI — render parity only, per the brief.

## Files touched

- `ios/GolfMap/Map/FeaturePalette.swift` — new
  `FeaturePalette.stackSortKeyExpression()`: a MapLibre `["coalesce", ["get",
  "stackKey"], typeSortKeyExpression()]` expression. `typeSortKeyExpression()`
  kept as-is (still used as the fallback branch and, per D26, as the
  server's insertion heuristic) but its doc comment updated to say it's
  superseded at render time.
- `ios/GolfMap/Map/MapStyleBuilder.swift` — `featuresFillLayer` /
  `featuresOutlineLayer` `layout` now call `stackSortKeyExpression()` instead
  of `typeSortKeyExpression()` for `fill-sort-key`/`line-sort-key`.
- `ios/GolfMapTests/Map/FeaturePaletteTests.swift` — new
  `testStackSortKeyExpressionCoalescesStackKeyOverTypeOrder`.
- `ios/GolfMapTests/Map/MapStyleBuilderTests.swift` — updated
  `testFeatureFillLayerIsSemiTransparentWithSortKey` to assert the
  `coalesce`/`stackKey` shape instead of just non-nil; added
  `testOutlineLayerUsesSameStackSortKeyAsFill` (fill and outline layers must
  share the identical sort-key expression, not just both be "some array").

## `ios/GolfMap/API/Models.swift` — not touched (verified per brief)

Traced both feature-consumption paths in `GolfAPIClient`:

- `featuresGeoJSONData(courseId:)` returns the raw `Data` from
  `/api/features.geojson` untouched. `SyncService` is the only caller, and it
  writes that raw `Data` straight into the bundle for
  `MapStyleBuilder.styleDictionary` to embed as the features source — the
  render path never decodes into `CourseFeature`, so it already sees
  `stackKey` via the coalesce expression above with no model changes needed.
- `features(courseId:) -> [CourseFeature]` decodes via
  `CourseFeatureCollection` (rings + `type`/`courseId`/`holeId` only, per its
  header comment, for future distance-math consumers) but has **no current
  callers** anywhere in `GolfMap/` — dead convenience API today. Since
  nothing reads `sortOrder`/`stackKey` off `CourseFeature`, and the brief's
  escape hatch is "if the model never sees features [for rendering], touch
  only the style builder," left it alone rather than adding unused fields
  speculatively.

## Tests / verification

```
cd ios && xcodegen generate
xcodebuild -project GolfMap.xcodeproj -scheme GolfMap \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

```
Test Suite 'All tests' passed at 2026-07-08 18:55:48.051.
	 Executed 462 tests, with 2 tests skipped and 0 failures (0 unexpected) in 9.307 (9.456) seconds
```

(2 skipped are pre-existing, unrelated to this change.)

Fallback behavior (old bundles without `stackKey`) is exercised directly by
`testStackSortKeyExpressionCoalescesStackKeyOverTypeOrder` — MapLibre's
`coalesce` evaluates to its second argument when `get` returns `null`
(property absent), which is exactly `typeSortKeyExpression()`. Did not spin
up a real stale on-disk bundle in the simulator (no such fixture bundle
exists in the repo); the expression-level test plus `coalesce`'s documented
style-spec semantics cover it.

## Notes / deviations

- No deviation from the brief. D23/D24/D26 consumed as written; did not
  re-open either decision doc.
- The brief's phrase "old bundles still render (fallback)" is satisfied at
  the style-JSON level (this is where `fill-sort-key`/`line-sort-key` live);
  did not additionally hand-build a stale sample bundle for an end-to-end
  simulator check, since `MapStyleBuilderTests` already builds real style
  dictionaries from literal GeoJSON and MapLibre's `coalesce` null-handling
  is standard style-spec behavior, not app-specific logic to re-verify live.
- No Swift-side reorder UI added — out of scope per brief ("no reorder UI on
  iOS — render parity only").
