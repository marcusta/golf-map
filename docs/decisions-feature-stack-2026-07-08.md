# Feature-stack decisions — 2026-07-08 (D23–D27)

**Scope:** per-feature draw ordering ("layering") for course features — the SVG document-order
model. Decided with Fable 2026-07-08; binding for tasks T22–T27
([delegation-briefs-feature-stack.md](delegation-briefs-feature-stack.md)). **D23 amends D17**
of [decisions-strategy-2026-07-06.md](decisions-strategy-2026-07-06.md) — that file stays
untouched per its own protocol; this register supersedes it where they conflict. Implementing
models must not re-open these decisions.

## Mental model

A hole is the equivalent of an SVG `<g>` group; `holeId: null` is the course-level group. Each
group holds an ordered feature stack (SVG document order: later = painted on top). Rendering,
click hit-testing, and lie classification all read the SAME stack — topmost containing feature
wins. Feature type never decides priority; it only suggests where a NEW shape is inserted.
Motivating case: a rough island drawn inside a fairway just sits above the fairway in the stack —
no type special-casing.

## Current state (verified 2026-07-08, for context)

- Rendering: one fill+line layer pair with `fill-sort-key`/`line-sort-key` from the fixed
  `TYPE_Z_ORDER` (web `draw/feature-palette.ts:56`, applied `draw/features.service.ts:283`;
  ported to iOS `Map/FeaturePalette.swift`). Type is absolute z.
- Hit-testing: smallest-outer-ring-area containing feature
  (`draw/draw-tool.service.ts:1177 hitFeature`, `analysis/analysis-tool.service.ts:210 hitGreen`).
- Lie classification: smallest-area per old D17 (`planner/lie-map.ts`, and `shared/strategy/aim.ts`
  re-sorts surfaces by area internally at line ~116).
- **Render and lie/hit therefore disagree today**: a rough patch inside a fairway classifies as
  rough but renders invisibly UNDER the fairway. The stack model is a bug fix, not just UI.
- No order column: `course_features` reads in `created_at` order
  (`server/services/course-features.service.ts:156`). Web GeoJSON is built client-side
  (`draw/features.service.ts:110`); the server also emits GeoJSON for the iOS bundle
  (`geojsonByCourse`).

## Decisions

**D23. Explicit stack order is truth (amends D17).** `course_features.sort_order` (integer) is
the canonical z-order, scoped per group `(course_id, hole_id|null)`, contiguous `0..n-1` within
the group (house pattern — tees/aim-points/clubs rewrite the whole scope on reorder). Higher
`sort_order` = later in document = on top. Rendering, editor hit-testing, `hitGreen`, and lie
classification for the optimiser all resolve overlaps by topmost-in-stack, replacing
smallest-area. Unchanged from D17: the no-containing-feature fallback is still `rough`, and bbox
pre-reject before point-in-ring stays. `shared/strategy/aim.ts` stops re-sorting `surfaces` by
area — the caller's array order IS priority order (first hit wins ⇒ callers pass topmost-first);
this is a documented contract change on `optimizeAim`. (No Swift impact yet: only `Putting` is
mirrored as of today; note it for the eventual T17 aim mirror.)

**D24. Global composition order.** Paint/hit order across groups: course-level group at the
BOTTOM, then hole groups by ascending hole number, each group internally by `sort_order`. The
combined global key (`stackKey`) is `groupRank * 4096 + sort_order` where `groupRank` = 0 for
course-level and the hole's `number` otherwise. The server emits `stackKey` (and `sortOrder`) in
GeoJSON properties; the web client computes the identical key for its live-edit GeoJSON.
*Known coarseness, accepted:* features cannot interleave across groups — e.g. a course-level
shared pond always loses to an overlapping hole-assigned fairway. Mitigation is data-side
(assign the pond to a hole, or keep that area's features course-level), not model-side. Revisit
only with evidence from real course data.

**D25. Backfill preserves lie semantics, not render quirks.** Migration backfills `sort_order`
within each group by outer-ring area DESCENDING (largest at bottom), ties by `TYPE_Z_ORDER`
index, then `created_at`. Area may be approximated by the shoelace formula over outer-ring
control points (ordering-quality only; no curve flattening in the migration). Rationale:
smallest-area-wins was the OLD lie/hit truth, so area-descending keeps optimiser lies stable for
nested features; where render output changes (rough island becomes visible), that is the fix
working. Cross-group containment conflicts (D24 coarseness) must be REPORTED by the migration
task, not silently reordered.

**D26. Type-based insertion default.** On create, the server inserts the new feature into its
group by scanning the stack top→bottom and placing it directly ABOVE the first feature whose
`TYPE_Z_ORDER` rank is ≤ the new feature's rank; if none, at the bottom (index 0). So a new
fairway lands above roughs but below existing bunkers/water/greens; a new path lands on top.
`TYPE_Z_ORDER` survives only as this heuristic (and legacy iOS rendering until T27); it is no
longer consulted at render/hit/lie time. After insertion the user's explicit order always wins.

**D27. Interaction conventions.** The feature-stack panel lists topmost-first (editing
ergonomics; label the ends "top"/"bottom"). Reorder verbs: raise / lower / raise-to-top /
lower-to-bottom, implemented client-side over the house `reorder(scope, orderedIds)` endpoint.
Keyboard (Inkscape bindings — NOT `[`/`]`, which need AltGr on Swedish layouts):
**PageUp/PageDown** raise/lower, **Home/End** to top/bottom, **Alt/Option+click** selects through
the hit stack under the cursor (cycles downward, wrapping), **?** opens contextual help. All
draw-mode shortcut documentation moves to a contextual help modal (prior art:
`golf-map-2/webapp/frontend/src/editor/HelpModal.tsx`); the panel keyboard-manual block dies.

## Cross-cutting acceptance scenarios

1. **Rough island (the motivating case).** Fairway + smaller rough polygon inside it, rough above
   fairway in the stack: the rough renders on top, plain click at its center selects it, and
   `classifyLie` there returns `rough`. Lower the rough below the fairway: all three flip to
   fairway together. One scenario, three subsystems, must be a single test (T24) + e2e (T25).
2. **Backfill stability.** On a real course DB, old-vs-new `classifyLie` sampled over the course
   bbox agrees everywhere except (a) cross-group conflicts per D24 (reported) and (b) same-area
   ties. T22 ships a throwaway comparison script and includes its output in the report.
3. **Cross-group.** Course-level feature overlapping a hole-assigned feature: the hole's feature
   wins regardless of area or type (D24 documented coarseness).
4. **Insertion.** With group stack bottom→top `[rough, fairway, bunker, water]`: new fairway
   lands above `fairway` (below `bunker`); new green lands above `fairway`; new path lands
   above `water` (D26 examples — encode as unit tests).
