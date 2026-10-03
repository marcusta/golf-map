# web — AGENTS

Vite + TS SPA on `@basics/core` client framework, MapLibre for maps. Course building (SVG/vector), strategy planning, follow-up analytics. Run with **cwd = `web/`**.

## Framework

`@basics/core/client` — DI container (`di.get`), signals/`effect` (push-based, eager — see below), `Router`, components. Conventions:
- `*.component.ts` — view components. `*.service.ts` — injectable state/logic (+ `*.tool.service.ts` for editor tools).
- Entry `src/main.ts` → `startApp(AppComponent, '#app')`. `src/api.ts` wires `shared/api/*.gen.ts` typed clients (base `/api`).

⚠️ Signals are eager/push-based; derived-geometry effects can fire on mixed intermediate state. Coalesce side effects with `queueMicrotask`.

⚠️ A component spawned inside a parent's `render()` runs its `onMount` while its host is still inside a **detached template clone** (`ownerDocument` = an inert `about:blank` document). Never hand such a host to a library that binds document-level listeners at construction — MapLibre puts a drag's mousemove/mouseup there, so the map's clicks work while every drag is silently dead. `MapService.init` waits for the host to join the live document; do the same for anything similar.

The package is a versioned tarball in `vendor/` — never edit `node_modules/@basics/core`, never repoint the dep string. See root [AGENTS.md](../AGENTS.md) for `fw:update` / `bun link`. After either, restart the dev server (`rm -rf node_modules/.vite` if you hit `does not provide an export named ...`). `bunfig.toml` preloads the package's own happy-dom adapter (`@basics/core/happy-dom`); there is no local shim.

## Styling — local recipes, semantic tokens

This is a **deliberate, assessed** divergence from the other `@basics/core` consumers. Do not "consolidate" it.

- **`src/css.ts` is the source of truth for component recipes** (Links & Loam). The only thing imported from `@basics/core/client/ui` anywhere in the repo is the `s` spacing scale. Core's `btn()`/`input()`/`card()` and its table / status-pill / empty-state components are **not** used — don't port `round-sg-table.ts` and friends onto them.
- Because the local recipes aren't core's, the recipe-ordering rule from the other consumer repos (recipe interpolation first in a block, overrides after) **does not apply here**.
- **`src/theme.ts` speaks full semantic token names** (`color-text-primary`, `color-surface-card`, …) through the typed `t()`. Theme-invariant layers (map/data/scale/type/motion) are raw `var()` reads from `design-tokens.css`. Keep theme edits on that vocabulary: do **not** reintroduce the legacy short-name aliases (`bg`/`primary`/`text`/…) — they were deliberately removed — and do **not** apply `bridgeLegacyControls` (that helper is for legacy-vocabulary themes like tapscore; it would be wrong here). There are zero direct `var(--btn-bg|btn-hover|radius|shadow|error|input-bg|primary)` reads — keep it that way.

## Layout (`src/`)

`app/` shell · `auth/` login+guard · `courses/` list · `sites/` (site setup page `/sites`, builder only: rename sites and courses, add a course on an existing site, detach, delete an empty site; `SitesService` also backs the new-course wizard's New site / Existing site step) · `course-detail/` · `editor/` (toolbar + `tools/`) · `draw/` (SVG feature drawing, history/undo) · `import/` (SVG orthophoto trace import) · `measure/` · `analysis/` (green slope) · `planner/` (strategy: overlay, gates, plan service) · `player/` (club config) · `map/` (MapLibre style/tiles/interaction; `tree-renderer.ts` is the three.js tree drawing shared with the vegetation scene) · `geo/` (bezier, bspline, transform) · `furniture/` · `vegetation/` (dev-only tree test scene).

## Commands (cwd `web/`)

```sh
bun run dev          # vite dev server :5173, proxies /api + /tiles → :3000 (server must run)
bun test             # tests (happy-dom); mirrors in tests/
bun run check:client # typecheck
```

Prefer the `preview_*` tools to verify UI changes over asking the user to check.

Testing: integration-first, no mocks, units only for hard algorithms. See root [TESTING.md](../TESTING.md).

## Dev loop: what hot-swaps

Vite HMR stops only at a module that calls the literal `import.meta.hot.accept(` (an alias of `import.meta.hot` is not detected). Without one, an edit reloads the page and MapLibre rebuilds the map and refetches tiles.

- `src/draw/draw-tool.service.ts` self-accepts. An edit swaps the prototype of the live `DrawToolService` to the new class and registers it under the new class key too (`hotSwapDrawTool`). The instance keeps its identity because the docks and the command bar hold it in fields. If Draw is active, `EditorModeService.restartTool` deactivates it with the old code, releases and re-takes the claim, and activates it with the new code. Feature selection, undo history, draw type and the type preferences survive; an open draft is dropped. `attach` does not re-run; an edit there applies on the next canvas mount.
- The swap is refused and the page reloads when the new class declares an instance field the live object lacks, or when a stateful import changed identity (`DRAW_TOOL_HOT_DEPS`: draw-state, history, screen-cache, the confirm dialog, features.service, editor/tool.ts). A dependency edit reaches this module only through those imports, so it reloads.
- Everything else reloads the page as before, including `map/map.service.ts`, `draw/features.service.ts`, `draw/draw-tool.ts`, the panels and the other tool services. `map.service.ts` reaches draw-tool.service.ts only through type imports, so it is never part of the swap.
- The Draw tool's pointer, hover, keys, render and frame code lives in `draw/draw-pointer.ts`, `draw/draw-hover.ts`, `draw/draw-keys.ts`, `draw/draw-render.ts` and `draw/draw-frame.ts`. Only draw-tool.service.ts imports them (siblings import each other for types only), so an edit to any of them propagates to the service and hot-swaps like an edit to the service. These modules must not import draw-tool.service.ts: a cycle back into the accepting module breaks the boundary.
- The modules reach the service's private state through a host object. The service caches it in a module-level `WeakMap`, so each re-execution of draw-tool.service.ts builds a fresh host whose shape matches the new code. Listeners bound in `activate` hold the old host until `restartTool` deactivates and re-activates.
- `FrameBatch` and `FrameSignal` (`draw/draw-frame.ts`) are swapped only for instances created after the edit; the live instance keeps its existing ones.

## Unused code checks

`tsconfig.json` sets `noUnusedLocals` and `noUnusedParameters`, so `bun run check:client` fails on unused locals, imports and parameters. Prefix a parameter with `_` when an interface or callback fixes the signature. `tsconfig.test.json` does not set these flags. `src/reports/diagrams.ts` has no importer in `src`. It is the vendored ATDD report engine, referenced by the atdd skill for the visual test report. Keep it and do not delete it as dead code.

## Map performance measurement

The map's top-right `FPS` control has a water shader toggle, live map renders per second, and a 10-second benchmark. Benchmarking requests continuous renders in both water modes and retains the last on/off results. Keep the same camera and loaded course data between runs. Moving the camera, hiding the tab, changing water mode, or closing the panel cancels a run. Average FPS and p95 frame intervals measure map render cadence, not GPU execution time. The live rate includes idle time; a still map can report zero. The water toggle lasts for the map service session and defaults to on after a reload.

The same control is available in `/dev/water.html`, a synthetic pond and creek preview. Its results do not represent full-course performance.

## Vegetation test scene (dev only)

URL: `http://localhost:5173/dev/vegetation` (vite dev; `dev/vegetation.html`, entry `src/vegetation/main.ts`). Plain three.js, no MapLibre, no login. Not in the production build unless `WEB_DEV_PAGES=1`.

Contents (`src/vegetation/vegetation-stems.ts`): 400 x 400 m ground with a generated grass tile (`grass-texture.ts`); a lineup at y = 0 of every species x variant (broadleaf, spruce, pine x 4) at 15 m plus one shrub; a size ladder at y = 40 (broadleaf and spruce at 2, 5, 10, 20, 30 m); a 200-stem mixed stand at 8 to 25 m north of the ladder, with the layer's `adjustStand`; a strip of 30 shrubs south of the lineup. Conifers use connected branch meshes and three folded surfaces per needle spray; medium LOD keeps two surfaces at every attachment. Each species has four forms batched separately. Conifers use a deterministic 70% pine / 30% spruce mix. Shrubs use woody stems and folded leaf meshes, with a reduced mesh beyond 45 m. The panel has a form inspector, a hide-controls button, camera presets (3/10/40/150/600 m), sun azimuth/elevation with three time-of-day presets (the first matches the ortho-derived layer default), forced LOD band, sway, wireframe, HTML name tags over the lineup and ladder stems, a 1:1 atlas viewer and frame stats. Controls persist in localStorage (`vegetation-scene`); `?lod=`, `?preset=<m>`, `?sway=0` and `?labels=0` override them.

- Add an asset type to the lineup: append to `lineupEntries()` in `vegetation-stems.ts` (species/variant pair, or a height under 4 m for a shrub); `tests/vegetation-stems.test.ts` counts the entries.
- Regenerate the tree textures: `bun scripts/gen-tree-textures.ts` (writes `public/trees/`; `--only <name>` for one atlas). The impostor atlas is baked at runtime from those textures.
- The map layer accepts `?treeLod=<fullM>[,<halfM>]` on the planner URL in dev builds to pull the LOD bands in; `e2e/tests/30-individual-trees.spec.ts` uses it on SwiftShader. `e2e/tests/31-vegetation-scene.spec.ts` cycles the presets and writes screenshots to `docs/validation/vegetation/`.

## E2E

`bun run e2e` (repo root) boots an isolated API and web server on 3100/5273 and runs `e2e/tests/`; set `E2E_API_PORT=3200 E2E_WEB_PORT=5474` when those are busy. `bun run e2e:create` runs the Create-mode specs only (01, 07, 08, 09, 17, 19, 24, 25, 28, 32) through the same config, so the setup project and ports are unchanged.

Every run also writes the Playwright json report to `e2e/results/results.json` (gitignored). `bun run e2e:durations` reads it and prints spec file, status, test title and duration in ms, slowest first, plus the total.
