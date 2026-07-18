# T41 report — Surround chains + merged surrounds

## Summary

Auto-surround used to be a single fixed step: clone each selected feature's
outline, expanded by its `SURROUND_PAIRINGS` amount. T41 extends it two ways:

- **Chain (Shift-click)** — Shift on the selection panel's surround button
  walks `SURROUND_PAIRINGS` to exhaustion: green → fairway(+0.5) →
  semi_rough(+1) → rough(+5) → deep_rough(+8), each ring offset from the
  PREVIOUS ring by that step's `expandAmount`. All rings land as **ONE
  history entry** (single ⌘Z removes the whole chain) and the selection
  moves to all new rings, mirroring `duplicateSelection`. If a step's
  offset collapses (`offsetGeometry` → null, or an empty merge), that
  branch truncates cleanly — earlier rings are kept. The button label now
  shows the chain terminal ("… · ⇧ chain to Deep rough") whenever the
  target type itself has a further pairing.
- **Merge (multi-select)** — when ≥2 selected features share a surround
  `targetType` (e.g. two overlapping fairways → semi_rough), they now
  produce ONE merged surround instead of N overlapping clones: outlines
  are flattened via `flattenRing` (so bezier/bspline curves participate
  exactly), unioned with `polygon-clipping` (existing dep, same pattern as
  `shared/render/resolved-surface-stack.ts`), and every ring of the union
  is offset with `offsetRingPoints` (interior rings the OPPOSITE way,
  mirroring `offsetGeometry`'s hole semantics). Output rings are
  RDP-simplified and rebuilt as **straight-segment bezier rings** (plain
  corner anchors, no handles, no `curveType` — the geojson-import
  convention; deliberately NOT T40's bspline fitter, per the brief). Union
  MultiPolygon → one feature per disjoint polygon; interior rings become
  holes; `holeId` = the group's common source holeId, else null.

Chain + merge compose: merging happens per ring level, so two fairways
Shift-surround into ONE semi_rough which then chains outward as a single
branch. No server/iOS changes.

## Files touched

- `web/src/draw/draw-state.ts`
  - `rdpSimplifyClosed` — the closed-ring RDP (split at the two most
    distant points) extracted from `simplifyGeometry`, which now delegates
    to it; reused by the merge path.
  - New `mergedSurroundGeometries(geometries, distance)` — the pure merge:
    flatten → union → per-ring offset (outer `+d`, holes `−d`) → closed-ring
    RDP (0.25 m) → straight-segment `FeatureGeometry` per disjoint polygon.
    Degenerate inputs/outputs (< `MIN_RING_POINTS`) are dropped; an empty
    result is the merge-path collapse signal.
- `web/src/draw/draw-tool.service.ts`
  - New exported pure planner `planSurrounds(sources, chain, offset?)` +
    `SurroundSource` — one `SURROUND_PAIRINGS` level per pass (groups by
    `targetType`; lone source → `offsetGeometry`, group → merge), repeated
    on each level's output while `chain`. `offset` is injectable so the
    truncation contract is unit-testable.
  - `autoSurroundSelection(chain = false)` now plans first, then creates —
    ONE history entry across all levels, selection = all new rings; returns
    a `Promise` (was fire-and-forget `void`) so tests can await it. The
    no-op notice distinguishes "no pairing" from "surround collapsed".
  - `selectionSurroundPairing()` return gains `chainEnd` — the terminal
    type a Shift-chain reaches (equals `targetType` when the target has no
    further pairing).
- `web/src/draw/selection-panel.component.ts` — `surroundBtn` passes
  `shiftKey` through to `autoSurroundSelection`; label appends
  "· ⇧ chain to <terminal>" when a chain hint applies.
- `web/tests/draw-surround.test.ts` — new colocated test file (14 tests):
  chain type sequence/holeId + per-step bbox growth, one-level plan,
  mid-chain collapse truncation (injected failing offset), first-step
  collapse, merge of overlapping outlines (single straight-segment ring,
  exact expanded bbox), disjoint → two geometries, holes survive and
  shrink, degenerate sources, and the service end-to-end suite on the
  draw-stamp fake-API harness (ONE undo removes the whole chain, merged
  semi_rough from two fairways, mixed holeIds → null, chain+merge
  composition, no-pairing notice, `chainEnd` in the pairing).
- `docs/reports/T41-report.md` — this report.

## Test results

`cd web && bun test`:

```text
714 pass
0 fail
6782 expect() calls
Ran 714 tests across 55 files.
```

Baseline before this task was 700 pass / 0 fail; net **+14**, all in the
new `draw-surround.test.ts`. `bun run check:client` and `bun run check:test`
(tsc --noEmit) both pass clean.

## Deviations / interpretations

- **Mixed expand amounts inside one merge group take the group max.** The
  brief's merge spec (union → offset each output ring) assumes one
  `expandAmount`, but a group can mix them (tee +0.5 and fairway +1 both
  target semi_rough). One ring can only be offset by one distance; the max
  keeps the surround outside every source's own pairing distance.
- **`planSurrounds` takes an injectable `offset`** (default
  `offsetGeometry`). `canOffsetGeometry` never rejects positive distances
  on healthy geometry, so the brief's "collapse mid-chain truncates
  cleanly" contract is pinned by injecting an offset that fails at step 2 —
  the same DI-stand-in style the harness uses elsewhere.
- **Merged output omits `curveType`** (absent = bezier) with plain anchors
  and no `corner` flags — exactly `polygonToGeometry`'s straight-segment
  convention in `web/src/import/geojson-parse.ts` (the `corner` flag is
  only meaningful for bsplines per its doc in `geo/bezier.ts`).
- **`autoSurroundSelection` now returns a Promise.** The panel call site
  wraps it in `void` like `convertSelectedToBezier`; behavior for plain
  clicks is unchanged.
- Brief file:line refs were verified against current code first — T38–T42
  had shifted them (e.g. `autoSurroundSelection` was at ~:1385,
  `offsetGeometry` at draw-state.ts:671, the surround button at
  selection-panel.component.ts:272-280). No stale ref was relied on.
- Not verified in the embedded preview pane: MapLibre never boots there
  (rAF throttling, see project memory); the interaction surface is covered
  by the service-level tests on the fake-API harness.
