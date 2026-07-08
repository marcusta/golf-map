# T25 report — Feature-stack panel (right dock)

A right-edge dock mirroring the existing left panel, hosting a scope-filtered,
topmost-first list of the current group's feature stack with click-to-select
and raise/lower/top/bottom reorder buttons over the T23 reorder ops.

## Files touched

- `web/src/editor/tool.ts` — new optional `sidePanel?: new () => Component` on
  `EditorTool`, doc'd alongside `panel` in the "## Panels" section: same
  contract/lifecycle, docked on the canvas's right edge, independent of
  `panel` (a tool can have either, both, or neither).
- `web/src/editor/toolbar.component.ts`
  - Added a second top-level `sidePanelHost` div to the toolbar's template
    (a DocumentFragment's top-level children all become siblings on mount, so
    this needed no restructuring of the existing single-root-looking template).
  - `.editor-tools-side` styles mirror `.editor-tools__panel` (same
    border/radius/background/shadow), positioned `right` instead of `left`,
    shown via its own `className` function (`mapSvc.ready` && `tool?.sidePanel`)
    rather than nesting inside `.editor-tools`, so it doesn't inherit the left
    bar's `pointer-events: none` container.
  - A second mount effect swaps `sidePanelChild` in/out on `activeTool()?.sidePanel`
    changes, mirroring the existing `panelChild` effect; both are destroyed on
    unmount.
- `web/src/draw/feature-stack-panel.component.ts` (new) —
  `FeatureStackPanelComponent`:
  - `scopeHoleId` Signal, defaults to `tool.drawHoleId.peek()`; a `<select>`
    (course level + one option per hole, rebuilt from `courseDetail.holes`)
    **filters** this signal on change — it does not assign a feature's holeId,
    unlike the draw panel's hole select (`draw-panel.component.ts:546`), which
    this component's header comment calls out explicitly to avoid confusion.
  - Rows via `$each` over `[...features.stackFor(scopeHoleId)].reverse()`
    (topmost-first, D27), keyed by feature id. Each row's swatch/label/point
    count are looked up live from `features.store.items` by id inside the
    template bindings (not the `$each`-captured item), since `$each` only
    remounts a row when its key changes — a reorder moves the existing node
    without remounting it, so a snapshot would go stale on a live type/geometry
    edit while the row persists.
  - Row click calls `features.select(id)`; `.selected` className reacts to
    `features.selectedIds`.
  - A "follow selection" effect: when `features.selected` is non-null, sets
    `scopeHoleId` to its group (`untrack`, to avoid cascading back into the
    effect that reads it) and `queueMicrotask`s a `scrollIntoView` on the
    matching row — deferred so it runs after `$each` has placed the row in the
    (possibly just-switched) scope's list.
  - Raise/Lower/Top/Bottom buttons call the T24-confirmed
    `features.raise/lower/raiseToTop/lowerToBottom(selectedIds)`, disabled when
    the selection is empty. Same ops as the T23 keyboard bindings
    (PageUp/PageDown/Home/End), reachable by mouse.
  - Per-feature visibility stays out of scope, per the brief (left panel's
    type eye toggles already own that).
  - `data-testid` hooks: `stack-panel`, `stack-panel-scope`,
    `stack-panel-rows`, `stack-row` (per row, plus a `data-feature-id` dataset
    attribute for targeting a specific row).
  - Drag-to-reorder was skipped (optional per the brief); the four buttons
    cover the reorder surface.
- `web/src/draw/draw-tool.ts` — `drawTool.sidePanel = FeatureStackPanelComponent`.
- `e2e/tests/08-feature-stack-panel.spec.ts` (new) — smoke test extending the
  T20 e2e pattern: draws two overlapping course-level squares (default draw
  type/scope, so no UI interaction needed to pick type/hole and the seed data
  has zero course-level features to collide with), asserts the panel lists
  them topmost-first by `sortOrder`, clicks a row to select it, clicks "Top"
  and asserts the row order flips, then clicks the map at the point covered by
  the now-topmost shape and asserts the map's own hit-test re-selects it and
  the panel highlight follows.

## Tests

```
cd web && bun run check:client                          # clean
cd web && bun test                                       # 529 pass, 0 fail (unchanged from T24 baseline)
bun run e2e -- e2e/tests/08-feature-stack-panel.spec.ts   # 2 passed (auth setup + spec)
```

No component-level unit/render test was added for `FeatureStackPanelComponent`
itself — per `TESTING.md`'s house convention ("no component-level specs for
web UI"), coverage lives in the e2e smoke test above, matching the brief's own
"done" bar (panel shows in draw mode; reorder + selection sync work live; e2e
smoke green).

## Notes / deviations

- Drag-to-reorder: skipped, as explicitly optional/skippable in the brief.
  The raise/lower/top/bottom buttons are the reorder surface for this task.
- The scope select's default-to-`drawHoleId` / follow-selection behavior means
  the panel's scope can diverge from the draw panel's own hole-assignment
  select at any time (by design — one filters, the other assigns); this is
  flagged in the component's own header/inline comments so it doesn't get
  "fixed" into an assignment control by mistake later.
- No new decisions opened; D23–D27 and the T24 stack API (`stackFor`, `raise`,
  `lower`, `raiseToTop`, `lowerToBottom`) were consumed as-is.
