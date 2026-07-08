# T23 report — Web render order + reorder plumbing

## Files touched

- `web/src/draw/features.service.ts` — stackKey computation, `stackFor`/`stackTopDown` accessors, `raise`/`lower`/`raiseToTop`/`lowerToBottom` reorder ops + `shiftBlock`/`moveBlockToEdge` pure helpers, overlay layer sort keys switched to `['get', 'stackKey']`.
- `web/src/draw/feature-palette.ts` — updated `TYPE_Z_ORDER` doc comment per D26 (heuristic-only, create-time).
- `web/src/draw/draw-tool.service.ts` — PageUp/PageDown/Home/End bindings in `onKeyDown` (D27), `reorderSelected()`.
- `web/tests/features.service.test.ts` — new coverage: stackKey (course-level rank 0 + hole ranks), `stackFor`/`stackTopDown` ordering, `shiftBlock`/`moveBlockToEdge` unit tests, reorder ops (persist, no-op at edge, mixed-group rejection, optimistic-patch-and-revert).
- `web/tests/analysis-tool.service.test.ts`, `web/tests/history.test.ts`, `web/tests/lie-map.test.ts`, `web/tests/plan-overlay.test.ts`, `web/tests/round-sg.test.ts`, `web/tests/svg-import.service.test.ts` — pre-existing `CourseFeature`/`CourseFeaturesApi` fixtures updated for T22's now-required `sortOrder` field and `reorder()` method (typecheck was already broken before this task touched them; see Deviations).

## Verification

```
$ tsc --noEmit                      # check:client — clean, no output
$ tsc -p tsconfig.test.json --noEmit  # check:test — clean, no output
$ bun test
 523 pass
 0 fail
 2733 expect() calls
Ran 523 tests across 37 files. [647.00ms]
```

## Deviations from the brief

- **`stackFor` is a plain method, not a `Computed`.** `Computed` in this codebase has no parameterized/memoized-per-key form (confirmed by reading `@basics/core`'s source), and the closest house precedent (`furniture.service.ts`'s `aimsForHole`/`teesForHole`) uses plain methods for per-key group derivations. `stackTopDown` (no-arg, global) is a real `Computed`.
- **Ghost-drag overlay preview layers in `draw-tool.service.ts` (~line 1487) still use `typeSortKeyExpression()`.** Out of the brief's specified line ranges (line 283 in `features.service.ts` only); the persistent overlay is the one that needed to switch to stack order for "shapes render by stack order live." Left as-is; flagged for reviewer.
- **Reorder is not integrated with undo/redo.** `draw/history.ts`'s `HistoryEntry`/`FeatureDiff` model is per-feature geometry/type/holeId snapshots, which doesn't fit a whole-group order rewrite. Per the brief's own fallback clause, noting here rather than forcing it in.
- **Fixed pre-existing test-fixture breakage in 6 unrelated test files.** T22 added a required `sortOrder` field to `CourseFeature` and a required `reorder()` method to `CourseFeaturesApi`, but only touched server code — `web/tests/` fixtures were never updated, so `check:test` was already red before T23 started. Fixing this was necessary to meet the "cd web && bun test green" done-criterion; changes were mechanical (add `sortOrder: 0` to fixtures, add/stub `reorder`) with no behavior change to those tests.

## Under-specified in the brief

- Whether `stackFor`/`stackTopDown` should be Computed vs. plain methods, given the engine's no-parameterized-Computed constraint (resolved above).
- Exact reorder-endpoint failure UX — followed `furniture.service.ts`'s `applySortOrder` pattern verbatim (optimistic patch, `reload()` revert on error).

## Open concerns for reviewer

- Ghost-drag preview overlay (draw-tool.service.ts ghost layers) still on `typeSortKeyExpression()` — confirm this is fine to leave for T27, since it's a transient drag preview, not the persisted stack.
- `reorderOp` rejects mixed-`holeId` selections as a no-op (returns `false` silently) rather than surfacing an error to the UI — no UI currently allows cross-group multi-select reorder, but worth a UX gut-check if that becomes possible.
