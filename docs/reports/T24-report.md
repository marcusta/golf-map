# T24 report — Hit-testing + lie unification (D23)

The semantic core: one rule — **topmost-in-stack containing feature wins** —
now drives render, editor hit-testing, `hitGreen`, and optimiser lie
classification, replacing four independent smallest-area implementations.

## Files touched

- `web/src/draw/draw-tool.service.ts`
  - `hitFeature` rewritten to walk the D23 stack (`stackTopDown`, topmost-first)
    instead of smallest outer-ring area; it's now just the first element of the
    new `hitStack(p)`, which returns ALL visible containing features top-down.
  - **Alt/Option+click cycling (D27):** repeated alt-clicks at the same point
    step DOWN the hit stack, wrapping; the first alt-click (or any plain click)
    selects the topmost. Cycle state (`altCycle`) lives in the tool and is
    reset **imperatively** — on a plain/meta click and on pointer-move — never
    via a reactive effect on the selection (that would cascade off our own
    alt-`select()` and clear the cycle every step; the reactive-cascade gotcha).
  - Drag ghosts now carry the original feature's `stackKey` (via the new
    `FeaturesService.stackKeyForId`) and the `draw-ghost-fill` layer sorts on
    `['get', 'stackKey']` instead of `typeSortKeyExpression()` (T23-review
    carry-over). The `typeSortKeyExpression` and `outerRingArea` imports here
    are now gone.
  - Two pure, exported helpers so the map-coupled logic is testable:
    `containingTopDown(stack, hidden, p)` (the shared hit rule) and
    `advanceAltCycle(prev, ids)` (the cycle-advance).
- `web/src/draw/features.service.ts` — new public `stackKeyForId(id)` (D24 key
  by feature id, for the drag ghosts).
- `web/src/analysis/analysis-tool.service.ts` — `hitGreen` walks the stack
  top-down for the first containing GREEN (same rule; greens rarely overlap but
  consistency avoids a second code path). Dropped the `outerRingArea` import.
- `web/src/planner/lie-map.ts` — `buildLieMap` sorts features **topmost-first
  by the D24 global stack key** (`groupRank * GROUP_RANK_SPAN + sortOrder`)
  instead of area-ascending; keeps the bbox pre-reject and `rough` fallback.
  New optional `holeNumberById` param supplies the group rank (course-level =
  rank 0). `GROUP_RANK_SPAN` is duplicated (not imported) to keep the
  planner→draw dependency direction, same convention as `LIE_MAP_TOLERANCE_M`.
  Header comment rewritten to cite D23/D24.
- `web/src/planner/planner-tool.service.ts` — the `lieMap` Computed now passes
  a `holeId → number` map built from `CourseDetailService.holes`.
- `web/src/rounds/round-sg.ts` — `RoundSgHoleContext` gains an optional
  `holeNumberById`; `buildRoundForSg` builds it from `holesByNumber` and threads
  it into each hole's lie map.
- `shared/strategy/aim.ts` — **contract change on `optimizeAim`:** deleted the
  internal `classified.sort(areaM2)`; `surfaces` is now used in the caller's
  order, which IS priority order (topmost-first, D23). Removed the now-unused
  `areaM2`/`twiceArea` from `classifiable`/`ClassifiedRing`. Doc comments on the
  file header, the `surfaces` param, and the classifier updated to D23.

## Tests

- `web/tests/hit-lie-stack.test.ts` (new):
  - **Acceptance scenario 1 as ONE test** — a fairway with a smaller rough
    island above it drives the render sort key (`FeaturesService.geojson`
    `stackKey` + `stackTopDown`), the editor hit (`containingTopDown`, what
    `hitFeature`/`hitStack` call), and the lie (`buildLieMap.classifyLie`) from
    the same fixture: all three say "rough" at the island centre and all three
    flip to "fairway" together when the rough is lowered below the fairway.
  - Hidden types drop out of the hit stack.
  - `advanceAltCycle`: topmost → deeper → wrap; a changed stack resets to top.
- `web/tests/lie-map.test.ts` — nesting fixtures reworded/reworked for explicit
  stack order (bunker above fairway via `sortOrder`), an inverse "lower flips to
  fairway" case, and **scenario 3 (cross-group precedence)**: a hole-assigned
  water outranks an overlapping, larger course-level fairway by the D24 group
  key. Added a `sortOrder`/`holeId` option to the `squareFeature` builder.
- `shared/strategy/aim.test.ts` — the old "smallest-area-first (D17)" nesting
  test is now two tests proving the D23 contract: caller order IS priority
  (bunker-first → sand; the exact-inverse fairway-first → fairway).

## Verification

```
cd web && bun run check:client   # clean
cd web && bun run check:test     # clean
cd web && bun test               # 529 pass, 0 fail (38 files)
bun test shared/                 # 231 pass, 0 fail (20 files)
```

## Notes / deviations

- **`hitFeature`/`hitStack`/alt-cycle are tested via extracted pure helpers,
  not the live tool.** `DrawToolService` is map-coupled (needs a MapLibre map +
  `ToolContext`) and has no existing unit harness, so — following the house
  pattern already used for `shiftBlock`/`moveBlockToEdge` and `draw-state.ts` —
  the decision logic is pulled into pure exported functions the tool calls. The
  test drives those exact functions; the tool is a thin wrapper.
- **`optimizeAim` has a second caller besides `lie-map.ts`:**
  `shared/strategy/caddy/rules/par5-attack.ts` passes
  `surfaces = [greenPoly, ...hazards]`. With the area re-sort gone, its order is
  now authoritative: the green wins where it overlaps a hazard (green-on-top),
  and hazards keep `hazardRings()`' topmost-first order. This is a sensible
  topmost-first reading (and arguably better than the old "tiny bunker beats the
  green" smallest-area result); left as-is — reordering the caddy's surface
  construction is out of T24's scope. Flagging for the reviewer.
- **`buildLieMap`'s `holeNumberById` is optional.** Both production callers
  (planner, round-SG) pass the real map. Omitting it ranks every feature 0, i.e.
  the stack collapses to `sortOrder` order — correct for a single group, which
  is all the remaining test/utility callers use. Made optional to avoid churning
  ~15 single-arg test call sites for a value they don't exercise.
- **Reorder/undo and the transient drag-ghost were T23 items;** the only
  T23-review carry-over folded in here is the ghost `fill-sort-key` switch
  (explicitly assigned to T24 in the brief), now done.
- `typeSortKeyExpression`/`TYPE_Z_ORDER` remain exported (no web consumer left)
  pending T27, per the T23/T24 briefs.
