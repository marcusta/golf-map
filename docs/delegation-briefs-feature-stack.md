# Delegation briefs — feature stack (T22–T27)

**Written 2026-07-08.** Implements the SVG document-order feature-stack model decided in
[decisions-feature-stack-2026-07-08.md](decisions-feature-stack-2026-07-08.md) (D23–D27 — read it
FIRST; it also amends D17). T21 was the spec itself (done, Fable). Same delegation scheme as
[delegation-briefs.md](delegation-briefs.md): **Opus** for taste-bound work users see, **Sonnet**
for spec-driven composition over existing patterns.

**Kickoff prompt (paste into a fresh session, fill in the task number):**

> Read docs/decisions-feature-stack-2026-07-08.md, then implement task T\<n\> from
> docs/delegation-briefs-feature-stack.md. Follow its standing constraints and reporting
> protocol exactly: one commit starting `T<n>:`, write docs/reports/T\<n\>-report.md, do not
> re-open decisions D1–D27, do not spawn sub-agents, and stop when the report is written — no
> adjacent work.

**Standing constraints (all tasks):**
- Match house style: 4-space indent, single quotes, convention-documenting header comments,
  colocated `*.test.ts` (`bun:test`).
- Server work follows the descriptor pattern (`api/*.api.ts` + `services/*.service.ts` + numbered
  migration in `server/db/migrations/` + `bun run generate` to regen `shared/api/` clients).
- Run web tests from the `web/` dir (`cd web && bun test`) — the DOM preload only loads there;
  from the repo root you get false DOMParser failures.
- Respect the reactive-cascade gotcha: @basics/core signals are push-based eager; coalesce
  derived-geometry side effects via `queueMicrotask`.
- E2E harness exists (T20): `bun run e2e`, Playwright, `data-testid` instrumentation.
- **No sub-agents.** Reporting protocol as in [delegation-briefs.md](delegation-briefs.md)
  ("Reporting protocol" section), with "decision register" meaning BOTH decision docs.

## Sequencing

```
T22 (server: column + backfill + reorder)   — first, blocks everything
T23 (web: render order + reorder plumbing)  — after T22
T24 (hit/lie unification)                   — after T23
T25 (feature-stack panel)                   — after T23 (T24 not required)
T26 (contextual help modal)                 — independent, any time
T27 (iOS mirror)                            — after T22, independent of web tasks
```

---

### T22 · `sort_order` column, backfill, reorder endpoint — **Sonnet**

Server-only. Migration `008_feature_sort_order.ts`: add `sort_order` integer NOT NULL DEFAULT 0
to `course_features`, then backfill per **D25** (per-group `(course_id, hole_id|null)`, area
DESC via shoelace over outer-ring control points, ties by `TYPE_Z_ORDER` index then
`created_at`; the type list is duplicated in the migration — migrations don't import services).
In `course-features.service.ts`: add `sortOrder` to the `CourseFeature` output type and row
mapping; order `byCourse`/`byHole` by `sort_order` (grouping stays client-side); `create()`
computes insertion position per **D26** (shift the group's higher rows by +1 in one transaction);
`geojsonByCourse()` emits `sortOrder` and `stackKey` per **D24** in properties (join `holes` for
the number; course-level rank 0). New `reorder(courseId, holeId | null, orderedIds)` following
`tees.service.ts:164` exactly: validate the id set matches the scope's rows, rewrite
`sort_order = index`, single transaction; wire a `POST /course-features/reorder` route in the
descriptor API beside the existing routes, then `bun run generate`. Also write the **throwaway**
old-vs-new lie comparison script per acceptance scenario 2 (run against `data/app.sqlite`, grid
over the course bbox, old = smallest-area, new = stack; paste its summary in the report; commit
the script under `server/scripts/` marked one-shot). Tests: D26 insertion examples (acceptance
scenario 4), reorder validation errors, backfill ordering on a synthetic nested fixture.
**Done:** migration + endpoint + regenerated clients; tests green; comparison-script output in
the report.

### T23 · Web render order + reorder plumbing — **Sonnet**

After T22. In `web/src/draw/`: the generated `CourseFeature` now carries `sortOrder`. In
`features.service.ts`: compute the client-side `stackKey` (D24 formula; hole number from
`CourseDetailService.holes`) as a property in the `geojson` Computed (line ~110), and replace
both `typeSortKeyExpression()` layout keys (line ~283) with `['get', 'stackKey']`. Add ordered
accessors: `stackFor(holeId: string | null): CourseFeature[]` (group's features by `sortOrder`
ascending) and a course-global topmost-first list for hit-testing (`stackTopDown()`), both
Computed. Add reorder ops `raise/lower/raiseToTop/lowerToBottom(ids)` as client-side
list manipulation over the selected features' group calling the new reorder endpoint, with
optimistic local `sortOrder` patching mirroring `furniture.service.ts:571 applySortOrder` (revert
via `reload()` on error, matching house error handling). Wire **PageUp/PageDown/Home/End** into
`draw-tool.service.ts` `onKeyDown` (line 746) per **D27** — guard `isMyClaim()` and input targets
as the existing keys do, `preventDefault` (the map claims arrow-ish keys). Reorder does NOT need
undo-history integration; if it falls out cheaply from `draw/history.ts`, take it, otherwise note
in the report. `TYPE_Z_ORDER`/`typeSortKeyExpression` stay exported until T27 removes the last
consumer — update the feature-palette doc comment (lines 48–55) to say heuristic-only per D26.
Tests: stackKey computation incl. course-level rank 0; reorder ops produce the right orderedIds;
optimistic patch + revert. **Done:** shapes render by stack order live; keyboard reorder works;
`cd web && bun test` green.

### T24 · Hit-testing + lie unification — **Opus**

After T23. The semantic core — one rule everywhere (D23). (1) `draw-tool.service.ts:1177
hitFeature`: replace smallest-area with a walk of `stackTopDown()` (skip hidden types, first
containing feature wins). Add `hitStack(p)` returning ALL visible containing features top-down,
and **Alt/Option+click** cycling per D27: repeated alt-clicks at the same point step down the
stack, wrapping; plain click resets to topmost. Cycle state lives in the tool, cleared on
pointer-move/selection change — mind the reactive-cascade gotcha. (2)
`analysis/analysis-tool.service.ts:210 hitGreen`: same rule (greens rarely overlap; consistency
anyway). (3) `planner/lie-map.ts`: sort `classified` by global stack position DESCENDING
(topmost first) instead of `areaM2` ascending — it scans the whole course, so use the D24 global
key; keep bbox pre-reject and the `rough` fallback; rewrite the header comment (it documents D17
smallest-area — cite D23). (4) `shared/strategy/aim.ts`: delete the internal
`classified.sort(areaM2)` (line ~116) and document on `optimizeAim`'s `surfaces` param that array
order IS priority order, topmost-first (D23 contract change); `lie-map.ts` is the only production
caller and now supplies that order; fix any test fixtures that relied on area re-sorting. Tests:
acceptance scenario 1 as ONE test driving render-key, hit, and lie from the same fixture;
alt-click cycle incl. wrap; lie-map cross-group precedence (scenario 3). **Done:** all four sites
share stack semantics; strategy + web tests green (`cd web && bun test`, `bun test shared/`).

### T25 · Feature-stack panel (right dock) — **Sonnet first; escalate to Opus only if the ergonomics come back clunky**

After T23. New right-edge dock in the editor, mirroring the left one:
`editor/toolbar.component.ts` renders panels for the active tool (left dock `editor-tools__panel`,
240px, line 76); add an optional `sidePanel` to the `EditorTool` interface (`editor/tool.ts`) and
a right-edge host with the same show/claim lifecycle, then give the draw tool
(`draw/draw-tool.ts`) a `FeatureStackPanel` (`draw/feature-stack-panel.component.ts`). Panel:
scope selector at top (`Course level`, `Hole N (par P)` — same option builder as
`draw-panel.component.ts:546`, but this one FILTERS the list rather than assigning), defaulting
to the draw target (`tool.drawHoleId`) and following selection (selecting a shape on the map
switches scope to its group and scroll-highlights its row). Rows topmost-first (D27): type swatch
(`FEATURE_STYLES`), label, point count; click row = select shape (bidirectional with
`features.selectedIds`); raise/lower/top/bottom buttons calling T23's ops (also reachable via the
T23 keyboard bindings). Per-feature visibility is OUT OF SCOPE (visibility stays per-type in the
left panel). Drag-to-reorder is OPTIONAL — only if it stays small; buttons + keys are the
contract. Add `data-testid` hooks and an e2e smoke: draw two overlapping shapes, reorder via
panel, assert row order + selection sync (extend the T20 suite pattern). **Done:** panel shows in
draw mode; reorder + selection sync work live; e2e smoke green.

### T26 · Contextual help modal — **Sonnet**

Independent. The draw panel carries a keyboard-shortcut manual block
(`draw/draw-panel.component.ts`) — move ALL shortcut documentation into a help modal opened by
**?** (guard input targets) and a small `?` button in both docks' panel headers. Modal content is
per-tool (active tool decides the section shown; draw mode lists the D27 bindings + existing
draw keys from `draw-tool.service.ts:746 onKeyDown`). Prior art to borrow structure from (React,
concepts only): `golf-map-2/webapp/frontend/src/editor/HelpModal.tsx`. House modal conventions:
follow an existing overlay/dialog component in `web/src/` if one exists; otherwise a simple
fixed-position card, ESC closes (register BEFORE the toolbar's ESC handler so help-close wins —
see `toolbar.component.ts:167`). Include the T23/T24 bindings (PageUp/PageDown/Home/End,
Alt+click) — coordinate wording with those briefs' final state, not this doc. **Done:** manual
block gone from the draw panel; `?` opens contextual help in draw + at least one other tool;
`cd web && bun test` green.

### T27 · iOS mirror — **Sonnet**

After T22 (needs `stackKey` in bundle GeoJSON). iOS agents SERIALIZE on xcodegen/xcodebuild —
do not run alongside other iOS work. `ios/GolfMap/Map/FeaturePalette.swift` ports web
`TYPE_Z_ORDER` as a fixed `fill-sort-key`/`line-sort-key` (line ~57); switch the sort-key
expression in `MapStyleBuilder.swift` to read the feature's `stackKey` property (fallback to the
type-order expression when the property is missing, i.e. stale bundles). Add
`sortOrder`/`stackKey` to the course-feature model in `ios/GolfMap/API/Models.swift` if features
are decoded there (rendering may be pure-GeoJSON — verify; if the model never sees features,
say so in the report and touch only the style builder). No reorder UI on iOS — render parity
only. Test with an updated bundle (re-download in simulator; DEBUG launch args in project docs).
**Done:** overlapping features render in the same order as web on a fresh bundle; old bundles
still render (fallback); iOS tests green.

---

## Review gate

After each task lands: fresh session, "review T\<n\>" → Fable reads the brief, the report, and
the diff. T24 gets a careful read; the rest a skim. Do not merge T24 without the acceptance
scenario 1 test in the diff.
