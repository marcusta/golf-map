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

`app/` shell · `auth/` login+guard · `courses/` list · `course-detail/` · `editor/` (toolbar + `tools/`) · `draw/` (SVG feature drawing, history/undo) · `import/` (SVG orthophoto trace import) · `measure/` · `analysis/` (green slope) · `planner/` (strategy: overlay, gates, plan service) · `player/` (club config) · `map/` (MapLibre style/tiles/interaction; `tree-renderer.ts` is the three.js tree drawing shared with the vegetation scene) · `geo/` (bezier, bspline, transform) · `furniture/` · `vegetation/` (dev-only tree test scene).

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
