# Create mode review, 2026-10-03

Scope: the `/course` builder (command bar, editor canvas, draw tool, docks, clean, terrain-edit, furniture, measure, import, SAM) plus the server paths it calls. Priority: interaction latency and steps per edit. Read-only review; nothing changed. Baseline: `check:client` 0 errors in 1.7 s, `bun test` 1253 pass in 12.6 s, `vite build` 2.42 MiB JS (652 KB gz on `/course`).

Reference course for numbers: Landeryd (26D37361), 689 hand-drawn + 3158 generated features, materialized `geojson` column 25.7 MB.

Each item: location, what happens, proposed change, effort (S/M/L). "Verified" means the mechanism was read in the code during this review. Magnitudes marked "profile" still need measurement.

## A. Per-edit cost (do first)

1. **List and update responses carry a 25 MB column nothing on the web reads.** Verified. `server/services/course-features.service.ts:403` parses `row.geojson` into every `CourseFeature` for `listByCourse` and the `update` echo. Zero reads of that field in `web/src`. iOS reads features through `/features.geojson` (`geojsonByCourse`), which reads the column directly. Change: drop `geojson` from the list/update mapper, keep the column and the geojson route. Landeryd list response shrinks from ~33 MB to ~8 MB. S.

2. **Every committed edit rebuilds the full hand-drawn FeatureCollection and sends it to the MapLibre worker twice.** Verified. `patchLocal` (`features.service.ts:435`) patches the store, the `geojson` Computed rebuilds, the overlay effect calls `setData`. Then `update` resolves through `store.mutate -> patch(serverRow)` (`entity-store.ts:63`); the echoed geometry is a fresh object, the flatten WeakMap misses, the collection rebuilds and sends again. The file's own comment prices one send at ~250 ms. Change (a): after the server reply, patch only server-owned fields (`version`, `sortOrder`) and keep the local geometry reference; have the overlay effect skip the send when no visible geometry identity changed. S. Change (b): per-feature commits through `GeoJSONSource.updateData({update:[...]})` (maplibre 5.x diff API, features already carry `id`); keep `setData` for load and visibility toggles. M, measure before/after.

3. **Multi-feature ops and undo/redo fan out N sequential requests, each with a full rebuild.** Verified. `draw-tool.service.ts:1193` (move), `:1490` (delete), `:1503` (duplicate), `:1550` (surround), `:1705` (retype), `:1719` (rehole), `:1805` (stamp); `history.ts:119-150` awaits one diff at a time with no local patch first. Each `create()` also writes the selection (`:424`), which re-lays out the selection line layers (~40 ms, `features.service.ts:663`). Change: `updateMany` / `createMany` / `removeMany` endpoints (one transaction, `reorder` shows the pattern), apply responses in one `batch()`, patch locally before awaiting on undo/redo, suppress the per-create selection write when the caller sets selection afterwards. M.

4. **No per-feature save queue; two quick commits on one feature 409 and trigger a 33 MB reload that drops history.** Verified mechanism (`entity-store.ts:63` reads the version at call time; `features.service.ts:455` reloads on failure; `draw-tool.service.ts:542` drops history on reload). Change: per-feature chain that coalesces a pending patch while one is in flight and sends it with the returned version; 100-200 ms trailing debounce on geometry patches. S/M.

5. **Click hit-testing flattens every visible feature per click with no bbox reject and no cache.** Verified structure, profile magnitude. `draw-tool.service.ts:287` `containingTopDown` -> `bezier.ts:317` `pointInGeometry` -> `flattenRing` allocates per feature per call; runs on mousedown and again on click, plus edge-insert `nearestOnRing` (`bezier.ts:234`, 33 samples + 24 ternary steps per segment) before the feature test. Marquee `featuresInRect` (`draw-state.ts:790`) does the same. Change: `WeakMap<FeatureGeometry, {flatOuter, flatHoles, bbox}>` shared by `pointInGeometry`, `ringBbox` and `nearestOnRing`; bbox test before ray cast; control-polygon bbox reject per segment in `nearestOnRing`. S.

6. **Draw-mode mousemove with an empty draft pushes an empty collection per event.** Verified. `draw-tool.service.ts:810` sets `cursor` on every move while armed; `previewGeojson` (`:2005`) produces one point and the effect still calls `updateOverlayData`. With a draft it re-flattens and re-projects the whole open path per event. Change: skip when `draft.length === 0`, dedupe unchanged SWEREF points, coalesce preview writes (cursor, ghost, marquee, trace) to one per animation frame. S.

7. **Hover scan projects every anchor and handle per mousemove; cursor-over-nothing is the worst case.** Verified. `draw-tool.service.ts:1852-1909`. Change: cache projected screen points per (geometry identity, camera state) in Float64Arrays, recompute on `move`, screen-space bbox reject before the loop. M. Also feeds snapping (item 20).

8. **Per-frame drag geometry deep-copies every point.** Verified. `draw-state.ts:222` `cloneGeometry` spreads every ring and point; `moveAnchor` / `moveHandle` / `setSymmetricHandles` call it per mousemove, so the ghost re-projects and re-flattens all segments. Change: structural sharing (copy the ring array, replace one point object), then key per-point lng/lat and per-segment flattening caches on `AnchorPoint` identity. S for sharing, M for the segment cache.

9. **Selection highlight is a layer filter and re-lays out two line layers per select.** Verified mechanism, profile. `features.service.ts:663-669`. Change: feature-state `selected` driving `line-opacity`, as the overlay already does for `dragging` (`:545`, `:715`). Trade: the selection layer holds all geometry permanently. S/M.

10. **Nice-mode `resolveSurfaceStack` runs whole-course polygon clipping on the main thread on every draw deactivate.** Verified trigger (`features.service.ts:522`, `draw-tool.service.ts:679`); the file comment in `shared/render/resolved-surface-stack.ts:11` says ~50 s for a full course, unmeasured here. Switching Draw -> Measure after one edit pays the resolve plus a full send; switching back pays another. Change: keep Create on the raw collection and resolve only for Plan and viewers, or make the resolve incremental by bbox intersection, or move it to a Worker. M.

11. **`WaterLayer.setData` stringifies every water geometry on every features push, outside the latest-wins queue.** Verified (`map.service.ts:681`, `water-layer.ts:50`). Change: key on geometry object identity, rebuild only the changed mesh. S.

12. **Drape repair does a full `freeRtt()` after every moveend/zoomend, and the per-tile free runs for the draw preview on every mousemove while drawing.** Verified (`map.service.ts:268`, `:750-786`, `:795-814`). Change: set a flag in `pumpOverlayData` when a `setData` happened during a gesture and repair only then; skip the per-tile path for overlays with no draped layers. S.

13. **Non-draped circle layers sit between draped layers, splitting the terrain RTT stack while a feature is selected.** Verified order, profile. Draw preview has 4 circle layers that `keepOnTop` raises above the furniture circles and draped lines. The project's own note: two or more stacks re-render every draped tile every frame. Change: order all draped layers before all circle/symbol layers; `addOverlayLayer` takes `draped: false` for the top group. S.

## B. Sibling tools

14. **Clean clone-stamp live stroke re-renders the whole 512x512 surface, PNG-encodes it and removes/re-adds the overlay on every mousemove.** Verified (`clean-tool.service.ts:656`, `:914`, `:932`); Shift-click lines push 64 points through the same path. No sequence token, so a stale encode can land last. Change: incremental dabs onto a persistent canvas through a `CanvasSource`, one render per animation frame, monotonic token. M.

15. **Furniture hit-test uses terrain-aware `map.project` per marker per click and mousedown; drag rebuilds the full furniture geojson per move.** Verified (`furniture-tool.service.ts:545`, `:233-298`). Change: flat `locationToScreenPoint`; a one-feature drag overlay with the full rebuild on mouseup. S + M.

16. **Measure re-samples the whole profile serially after each point, with no stale guard.** Verified (`measure-tool.service.ts:275-309`). Change: per-segment sample cache, `Promise.all`, request token. S.

17. **Terrain-edit overlay recreates every glyph Marker and re-projects every ring per draft click; the re-terrain poll outlives the tool and completion re-inits the whole map.** Verified (`terrain-edit-overlay.ts:154`, `terrain-edit-tool.service.ts:255-313`). Change: cache WGS84 rings per edit, diff markers by id, `AbortSignal` on the poll, refresh only the terrain source. S/M.

18. **Shared helpers missing.** `screenDist` is copy-pasted in four tools (`terrain-edit-tool.service.ts:376`, `measure-tool.service.ts:372`, `draw-tool.service.ts:1960`, `furniture-tool.service.ts:553`); raw mousedown/mouseup drag binding with `dragPan` toggling and click suppression is duplicated three ways with inconsistent Cmd/Ctrl pan escape; cursor and "re-add overlay when map ready" effects repeat per tool; tile-crop composite and sidecar health UI are duplicated between clean and SAM; panel CSS recipes repeat across eight panels. Change: `editor/screen-point.ts`, `editor/drag-binding.ts`, `ctx.map.ownedOverlay(id, spec)`, `imaging/crop-source.ts`, one `SidecarHealth` service, `editor/panel-recipes.css.ts`. S each, M together.

19. **Terrain-edit and measure have no rubber-band segment and no mid-draw undo; measure's keydown handler is empty.** Verified. Change: match draw's key map (Backspace point undo, Cmd/Ctrl+Z, Enter finish) and add a cursor feature to the existing overlay. S.

## C. Steps per edit (UX)

20. **Esc with nothing to cancel deactivates Draw silently.** Verified (`toolbar.component.ts:95-101`, `draw-tool.service.ts:722` returns false; auto-activate at `:77` runs once). Keys and map clicks then do nothing while the sub-mode trigger still reads "Draw". Change: Draw's `onEscape` returns true as the default tool, or the toolbar re-activates Draw when deactivate leaves no tool. S. Highest frequency item in this list.

21. **No keyboard route for sub-mode, hole prev/next, fit, or dock collapse; popovers have no arrow keys.** Verified. Change: single keys for sub-modes (D, M, F, A, T; C and B are taken), `,` / `.` for prev/next hole (avoid `[` `]`, Swedish AltGr), Shift+F fit hole / F fit course, Cmd+\ docks. Register in one shortcut service so they survive tool deactivation. M.

22. **Hole switch does not frame the camera in Create.** Verified; the only hole framing is inside the furniture tool (`furniture-tool.service.ts:138`). Change: lift `attachHoleFraming` to the editor canvas behind a persisted "follow hole" toggle; `fitBounds` on tee..green is enough as a first step. M.

23. **Delete needs a confirm dialog every time** although undo exists. `draw-tool.service.ts:~1475`. Change: delete without confirm, show "Deleted N, Cmd+Z to undo" in the dock footer; keep the dialog above a multi-select threshold. S.

24. **Edge click inserts a vertex but does not start dragging it; a multi-vertex selection cannot be moved; `C` acts on the hovered vertex while Delete and `I` act on the selection.** Verified (`draw-tool.service.ts:779`, `:953`, `:1327`). Change: run edge-insert in mousedown and seed the drag; translate all selected anchors when the grabbed one is selected; arrow-key nudge (1 px, Shift 10 px); `C` over the vertex selection. M + M + S.

25. **No snapping to neighbouring features' anchors or edges while drawing or dragging.** Boundary alignment between adjacent surfaces is then manual. Change: snap to anchors within ~8 px using the projected cache from item 7, then to nearest edge with the bbox prefilter from item 5; Cmd/Ctrl disables; snap marker in the preview overlay. L. Needs a short design decision on edge snap for splines.

26. **Autosave failure is invisible outside the expanded Draw dock**, and `reload()` then silently reverts the edit. Change: save-state pill in the command bar bound to `saving` / `saveError`, toast on transition to failed. S.

27. **Layer visibility toggles cost 2 clicks, are hover-only, and are not persisted.** Change: Shift+digit toggles the type, Alt+click an eye solos, H hides selected / Shift+H shows all; persist `hiddenTypes` per course in localStorage; eyes always visible at low opacity. S/M.

28. **Feature stack panel: O(N) `find` per binding on the whole items signal (5 per row), panels destroyed and rebuilt on every sub-mode switch, no multi-select, search or type filter; selection panel rebuilds the hole dropdown per selection change.** Verified (`feature-stack-panel.component.ts:377-423`, `feature-dock.component.ts:280-298`, `selection-panel.component.ts:360-391`). Change: per-entity `store.item(id)` signals and one `Computed` group-count map; keep Draw panels mounted and toggle `display`; Shift/Cmd-click rows through `setSelection` / `toggleSelected`; build dropdown options once per holes list. S/M.

29. **Digit type keys and chain policy are undiscoverable; the feature-type menu shows no key hints.** Change: render `keyHint` next to each type and sub-mode entry; show the chain policy in the draw-target chip. S.

30. **Actions menu fetches publish state and lidar info at command-bar mount.** `command-bar.component.ts:1041`, `:1125`. Change: build the panel and fetch on first open. S.

31. **Esc ordering between layers popover, help modal, popovers and the tool chain depends on listener registration order.** Change: short term `stopPropagation` in the canvas popover handler; longer term one document keydown dispatcher with an explicit layer stack. S / M.

## D. Load and dev loop

32. **Every edit to a Create module remounts the app and rebuilds the MapLibre map.** Verified: no `import.meta.hot.accept` in `web/src`; `startApp` self-accepts at the root; `EditorCanvas` unmount calls `mapSvc.destroy()` (`editor-canvas.component.ts:624`). The DI container keys singletons by constructor identity and is never reset, so the stale `DrawToolService` stays registered. Change: a self-accepting boundary in `draw-tool.service.ts` that re-registers the new class with `di.set` and re-runs `attach`/`activate` with the previous `ToolContext`; keep `map.service.ts` out of the accepted set. M. This is the single biggest dev-loop win.

33. **One eager bundle: three.js, water and tree layers, polygon-clipping, planner, wizard, sites load on every route.** Verified: zero `import(` in `web/src`; `map.service.ts:6` and `:25` import the three.js layers statically; `app.component.ts:9-16` imports every route component. Change: `import()` the water and tree layers behind their toggles, lazy route components for `/planner`, `/new`, `/set-area`, `/sites`, `manualChunks: { maplibre: ['maplibre-gl'] }` for a stable vendor hash. Expected `/course` initial load 2.43 MB -> ~1.7 MB raw, 652 -> ~450 KB gz. M.

34. **Map init waits on two sequential requests** (`tileset.service.ts:203-209`, course then assets) and the tile route does sync `existsSync` + `statSync` per candidate (`tiles.ts:146`). Change: return the tile manifest from the course GET; `Bun.file().exists()` on the known candidate. S.

35. **Terrain smoothing protocol decodes up to 9 tiles, blurs and PNG-encodes on the main thread per terrain tile at z14+**, then MapLibre decodes again (`terrain-smoothing-protocol.ts:37-96`). Profile. Change: bake smoothed tiles in the pipeline, or run the body in a Worker. M.

36. **Flattening density is fixed at 0.25 m chords regardless of curvature** (`bezier.ts:126`, mirrored in server `geo.ts:405`), which sets the ~20 MB collection size. Change: chord-error subdivision in shared code used by both sides. M, measure the vertex reduction first.

## E. Tests and hygiene

37. **The overlay queue has no test**; all ten draw test files stub `updateOverlayData`. `map.service.ts:721-760`, `:789`. Change: fake `GeoJSONSource` with on-demand resolve; assert 3 rapid updates -> 2 sends, drain after resolve, 3 s fallback, `destroy()` clears pending. S. Add before touching items 2, 6, 12.

38. **Hover gate and one-push-per-edit are untested.** Change: pointer-event integration test counting hit-tests with `buttons=1` vs `0`; extend `generated-features.test.ts:209`'s counting context to a hand-drawn drag plus undo/redo. S each.

39. **`draw-tool.service.ts` is 2273 lines, 55 methods, 6 effects**, and is the HMR and review unit. Change after 37 and 38 pin behaviour: split into pointer, hover, render and keys modules behind the same service. L.

40. **No linter; `noUnusedLocals` / `noUnusedParameters` off**; 12 dead exports in draw/editor (`generatedSourceLabel`, `DRAW_OVERLAY_ID`, `DUPLICATE_OFFSET_M`, `TRACE_TOLERANCE_M`, several types). `web/src/reports/diagrams.ts` has no importer in src; it is the vendored ATDD report engine, so leave it and document that, do not delete. Change: turn on the two tsconfig flags, drop the dead exports. S.

41. **No recorded e2e durations and no Create subset.** Change: add the json reporter and a `grep` script `e2e:create` over the 12 Create specs. S.

42. **`bun run test` fails without the sibling framework checkout** (`web/package.json` test script). Change: guard the `assert-not-linked` step with a file-exists check. S.

## Suggested order

Wave 1 (one or two days, all S, measurable): 1, 2a, 20, 5, 6, 11, 12, 37, 30, 42.
Wave 2 (the edit loop): 3, 4, 9, 2b, 8, 7, 13, 38.
Wave 3 (steps per edit): 21, 22, 23, 24, 26, 27, 28, 29, 31.
Wave 4 (sibling tools and helpers): 18 first, then 14, 15, 16, 17, 19.
Wave 5 (load, dev loop, structure): 32, 33, 34, 10, 35, 36, 39, 40, 41.
Wave 6: 25 (snapping) after 5 and 7 exist.

Measure before and after each perf item with the existing FPS control for render cadence and `performance.now()` around the commit path for the setData work; the ~250 ms figure in `features.service.ts` is the only measured per-send number on record and predates the generated-features split.
