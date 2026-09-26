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

`app/` shell · `auth/` login+guard · `courses/` list · `course-detail/` · `editor/` (toolbar + `tools/`) · `draw/` (SVG feature drawing, history/undo) · `import/` (SVG orthophoto trace import) · `export/` (GSPro/OPCD export panel: SVG, inner/outer orthophoto JPEGs, inner/outer DEM GeoTIFFs over the two terrain squares, and GreenKeeper's .GKD into the course's GSPro folder; long explanations go behind `ui/info-tip.ts` (i) tips, only what the operator must act on stays in view) · `measure/` · `analysis/` (green slope) · `planner/` (strategy: overlay, gates, plan service) · `player/` (club config) · `map/` (MapLibre style/tiles/interaction; `tree-renderer.ts` is the three.js tree drawing shared with the vegetation scene) · `geo/` (bezier, bspline, transform) · `furniture/` · `vegetation/` (dev-only tree test scene).

## Vegetation zones (docs/feature-vegetation-zones.md, wave 1)

`zones/` — `ZoneTypesService` (the course's zone-type legend, loaded with the
features in `editor/toolbar.component.ts`) and `ZoneTypesPanelComponent` (the
table editor: colour, the VSPro item bindings of the type's "Default" mix, and
its named variants, each with its own bindings; item inputs autocomplete from
a `<datalist>` of every item name in the table). No mask texture/channel
inputs: the export gives every bound item its own channel. "Add variant"
creates `New variant` under a key slugged once and made unique in the type
(`uniqueVariantKey`) — renaming later changes the name only, so zones stay
bound. The panel is spawned by `CourseDetailComponent` and opened from the
command bar's ⋯ menu, like the GSPro export panel.

`vegetation_zone` is a normal drawable feature type in `draw/feature-palette.ts`
(no digit shortcut; mirrored by hand into `mobile/course/feature-colors.ts`).
Its attributes (`zoneType`, `zoneVariant`, `weight`, `feather`, `noise`) are
edited in the selection panel's "Vegetation zone" section and saved through
`features.update(id, { attributes })`, which replaces the whole object — the
section always sends all five keys. The Variant select (`zone-variant-select`:
"Default" = `''` plus the type's variants) is hidden while the type has none;
changing the zone type also resets `zoneVariant` to `''`. `FeaturesService.create`
fills in the zone defaults (first zone type, Default variant, weight 1, feather
2 m, noise 0) for any zone that reaches it without a `zoneType`, so freshly
drawn, duplicated, stamped and retyped zones are all valid server-side;
duplicate/paste copy attributes generically, variant included. The overlay fill
uses `featureFillColorExpression`, which paints a zone in its zone type's own
colour (`properties.zoneColor`; variants share it, `properties.zoneVariant`
carries the key) and everything else from the palette.

## Roads and paths are centerlines

A `path` drawn in path mode (`P`) or imported from Fetch roads is a
**centerline feature**: `geometry.centerline` (`points`, with `corner` flags,
and `widthM`) is the shape, and `geometry.rings` is the corridor derived from
it by `shared/features/centerline.ts` (Catmull-Rom curve through the points,
buffered with round joins/caps). The server re-derives the rings on every
write, so every ring consumer (render, lie, surface stack, GSPro SVG, iOS) is
unchanged. In the draw tool the vertex ops run on an **edit view**
(`draw-state` `editViewOf` / `applyVertexEdit` / `fromEditView`): the control
points as one open b-spline-flavoured ring, mapped back with the corridor
re-derived. Move/offset/simplify act on the line (offset = width), the
selection panel's Width field sets `widthM`, and the terrain tool's Grade
roads grades these lines. Old polygon paths stay polygons. Path mode draws by
clicks + Enter or by a freehand press-drag (thinned to a few points); `N`
draws a plain area (a paved yard is a `path` polygon, graded as a plane).

Kerb fillets where centerline roads meet, and width tapers where a road ends
in a narrower one (`shared/features/road-junctions.ts`), are derived, never
edited: `FeaturesService.junctionFeatures` computes them
live into the map collection (not selectable), and the server's stored copies
(generated, source `road-junctions`, for export/iOS) are dropped on load.
Per road, the selection panel's "Round kerbs at junctions" box sets the
`kerbFillets` attribute (`false` = off, absent = on); a corner is rounded only
when both roads meeting there have it on. Tapers ignore it.

## Rules lines live in Furniture

The penalty areas and OOB (`RULES_TYPES` in `draw/feature-palette.ts`) are
drawn and edited in Furniture mode, not Draw. There is one polygon engine:
`FurnitureToolService` runs `DrawToolService` in its `rules` scope
(`activate(ctx, { scope: 'rules', toolId, yieldTo })`), which hit-tests and
creates only those types (OOB by its line, not its inside), keeps nice
rendering with the penalty outlines stroked, has its own undo history, and
leaves presses on furniture markers (and everything while a placement is
armed) to the Furniture tool. Draw (`surfaces` scope) puts them in
`FeaturesService.modeHiddenTypes`: off the map, out of hit tests, the type
picker and the stack panel. `resolveSurfaceStack` passes them through like
OOB, so a higher shape never trims them away.

## Hiding the Roughs layer is editor-only

The stack panel's "Roughs layer" eye (`FeaturesService.roughsLayerHidden`)
drops every `layer: 'roughs'` feature from the overlay and hit tests, but only
while the editor owns the overlay (`attachOverlay(map, { editor: true })`,
from `editor/toolbar.component.ts`). The planner attaches without the flag, so
it always draws the roughs; the GSPro SVG export reads stored features on the
server. Session-only, never persisted.

## Commands (cwd `web/`)

```sh
bun run dev          # vite dev server :5173, proxies /api + /tiles → :3000 (server must run)
bun test             # tests (happy-dom); mirrors in tests/
bun run check:client # typecheck
```

Prefer the `preview_*` tools to verify UI changes over asking the user to check.

Testing: integration-first, no mocks, units only for hard algorithms. See root [TESTING.md](../TESTING.md).

## Vegetation test scene (dev only)

URL: `http://localhost:5173/dev/vegetation` (vite dev; `dev/vegetation.html`, entry `src/vegetation/main.ts`). Plain three.js, no MapLibre, no login. Not in the production build unless `WEB_DEV_PAGES=1`.

Contents (`src/vegetation/vegetation-stems.ts`): 400 x 400 m ground with a generated grass tile (`grass-texture.ts`); a lineup at y = 0 of every species x variant (broadleaf, spruce, pine x 4) at 15 m plus one shrub; a size ladder at y = 40 (broadleaf and spruce at 2, 5, 10, 20, 30 m); a 200-stem mixed stand at 8 to 25 m north of the ladder, with the layer's `adjustStand`; a strip of 30 shrubs south of the lineup. The panel has camera presets (3/10/40/150/600 m), sun azimuth/elevation with three time-of-day presets (the first matches the ortho-derived layer default), forced LOD band, sway, wireframe, HTML name tags over the lineup and ladder stems, a 1:1 atlas viewer and frame stats. Controls persist in localStorage (`vegetation-scene`); `?lod=`, `?preset=<m>`, `?sway=0` and `?labels=0` override them.

- Add an asset type to the lineup: append to `lineupEntries()` in `vegetation-stems.ts` (species/variant pair, or a height under 4 m for a shrub); `tests/vegetation-stems.test.ts` counts the entries.
- Regenerate the tree textures: `bun scripts/gen-tree-textures.ts` (writes `public/trees/`; `--only <name>` for one atlas). The impostor atlas is baked at runtime from those textures.
- The map layer accepts `?treeLod=<fullM>[,<halfM>]` on the planner URL in dev builds to pull the LOD bands in; `e2e/tests/30-individual-trees.spec.ts` uses it on SwiftShader. `e2e/tests/31-vegetation-scene.spec.ts` cycles the presets and writes screenshots to `docs/validation/vegetation/`.
