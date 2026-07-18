# T55b — Terrain-edit tool in the web editor

**Model:** Fable · **Date:** 2026-07-18 · **Status:** done

Web half of T55 (the "Web" paragraph). A dedicated `terrain-edit` editor tool: click-to-place
polygon drafting through its OWN `DrawState` instance, an own commit funnel that POSTs to the
T55a terrain-edits API (armed op/params, plain straight-segment EPSG:3006 rings), a dashed
violet activation-scoped overlay with per-edit op-glyph markers, and a dock panel with the
op/params controls, the site's edit list (enabled toggle / delete), and a disabled
"Apply to terrain" stub with one clearly-marked T56 seam. No pseudo-type was added to
`FEATURE_TYPES` and nothing routes through `features.create`.

## Files touched

- `web/src/terrain-edit/terrain-edit-tool.service.ts` (new) — `TerrainEditToolService`:
  own `DrawState`, site-scoped list/create/update/remove over the generated client
  (constructor seam for tests), click handling (click-near-first-point closes, draw-tool
  `CLOSE_RING_PX` semantics), microtask-coalesced overlay flushing, `TerrainEditRenderer`
  interface, and the **T56 SEAM** (`canApply` / `applyToTerrain()`, marked with a banner
  comment).
- `web/src/terrain-edit/terrain-edit-overlay.ts` (new) — `TerrainEditOverlayRenderer`
  (imports maplibre-gl, excluded from tests behind the renderer seam — analysis-tool
  pattern): dashed violet outline + faint fill per edit (dimmed when disabled), draft
  ring with a highlighted first-vertex close target, op-glyph pill per edit as DOM
  markers (`▱ plane` / `∿ smooth`, params in the tooltip) — the editor style has no
  glyphs endpoint, so symbol text layers cannot render text.
- `web/src/terrain-edit/terrain-edit-panel.component.ts` (new) — dock panel (hosted by the
  contextual right dock via the `EditorTool.panel` contract): op select, feather/radius/flat
  controls (radius only for smooth, flat only for plane), notice + saving lines, `$each`
  edit list with enabled (eye) toggle + delete, disabled "Apply to terrain" button with a
  T56 tooltip, usage hints.
- `web/src/terrain-edit/terrain-edit-tool.ts` (new) — `EditorTool` descriptor (id
  `terrain-edit`, order 60, help sections, one app-wide renderer instance).
- `web/src/editor/tools/index.ts` — one import + one registry entry (the command-bar
  sub-mode dropdown renders from this registry, so the command-bar entry comes for free).
- `web/src/api.ts` — wired `createTerrainEditsClient` as `api.terrainEdits`.
- `web/src/ui/icons.ts` — added the Lucide `mountain` monoline icon.
- `web/tests/terrain-edit-tool.service.test.ts` (new) — 19 tests: draft→create payload
  mapping (plane/flat, smooth/radius, param leakage, sub-minimum rings, no-site, mapKey
  fallback, failed create), click claim-gating + ESC, enabled/delete flows incl.
  version-conflict resync, overlay gating (render-after-activate, one-flush coalescing,
  map-death reset, deactivation clear, post-deactivation flush dropped), panel helpers,
  T56 stub.

## Tests / checks

- `bun test` (from `web/`): **800 pass, 0 fail, 7381 expect() calls** across 60 files.
- New file alone: 19 pass, 0 fail.
- `bun run check:client` and `bun run check:test` (tsc): clean, no errors.

## Decisions where the brief under-specified

- **Renderer seam instead of drawing inline in the service.** The brief points at
  `editor-canvas.component.ts` for rendering; in the current code overlays are owned by the
  tool via `ctx.map.addOverlayLayer` during the activation span (measure/analysis precedent),
  which also gives "hidden outside the tool" for free. The op glyph needs `maplibregl.Marker`
  (no glyphs endpoint in the editor style), and modules importing maplibre-gl can't load under
  bun test — so the rendering lives behind a `TerrainEditRenderer` interface exactly like the
  analysis tool. `editor-canvas.component.ts` itself needed no changes.
- **siteId resolution.** The map-build UI resolves the site as the loaded course's `siteId`
  (`set-map-area.component.ts` / `tileset.service.ts`); `map-build.service.ts` itself only
  passes courseId to the server. I used `courseDetail.course.siteId`, falling back to
  `tileset.mapKey` (which IS the site id per the map-style contract) before the course record
  lands; no site at all → panel notice, nothing posted.
- **Panel hosting.** "Dock or popover" — used the dock: declaring `EditorTool.panel` gets the
  collapsible contextual dock hosting for free (`feature-dock.component.ts`), no new primitive.
- **Draft gesture.** Click places a point, click near the first point (12 px, draw-tool
  constant) closes + saves, ESC discards the outline but keeps the tool armed (second ESC
  deactivates via the toolbar chain); chain-draw retained after a save (DrawState contract).
  No corner/b-spline semantics: `addPoint` is always called cornerless and the commit strips
  anchors to plain `{x, y}` — terrain edits are straight-segment by design (T55a storage).
- **Reactive-cascade gotcha.** Closing a draft writes `draft` and `edits` back-to-back;
  the overlay effect only *subscribes*, and the actual render is coalesced onto a
  `queueMicrotask` flush that peeks the settled state (planner `refreshStrategy` pattern).
  Pinned by a test (three synchronous writes → exactly one render).

## Open concerns for the reviewer

- **Overlay/panel visuals are untested by eye.** Per the task constraints no dev server or
  browser was run; the overlay/panel follow the measure/analysis/sam patterns verbatim, but
  the violet + dash styling and glyph-pill placement should get one manual look on a real
  course before T56 builds on the tool.
- **Concurrent-session edits.** `web/src/api.ts` and `web/src/editor/tools/index.ts` were
  concurrently touched by another in-flight session (ortho-patches / `cleanTool`, T55-clean).
  Only this task's lines are staged in this commit; the full suite passes with both present.
- **`closeDraft` with no site consumes the outline.** The ring is popped from the DrawState
  before the site check, so a missing site discards the drawn points (with a notice). Rare
  (the tool warns on activation) but worth knowing.
