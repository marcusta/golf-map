# web — AGENTS

Vite + TS SPA on the `@basics/core` client framework, MapLibre for maps. Course building (SVG/vector), strategy planning, follow-up analytics. Run with **cwd = `web/`**; commands are `package.json` scripts (`dev` proxies `/api` and `/tiles` to the server, which must run).

## Pointers

- Layout of `src/` (one folder per feature): `ls src`; per-folder notes: [docs/web-features.md](../docs/web-features.md).
- Vegetation zones (zone-type panel, selection-panel sections, tree species areas, Vegetation mode, Plant vegetation): [docs/feature-vegetation-zones.md](../docs/feature-vegetation-zones.md) section 13.
- Roads and paths (centerline editing, kerb fillets): [docs/feature-roads-centerline.md](../docs/feature-roads-centerline.md).
- Reference photos, Rules lines in Furniture, Roughs-layer eye, map performance control, `/dev/vegetation` test scene: [docs/web-features.md](../docs/web-features.md).
- Verify UI changes with the `preview_*` tools. Tests (`bun test`, happy-dom, mirrors in `tests/`): integration-first, no mocks, units for hard algorithms; see root [TESTING.md](../TESTING.md).
- `fw:update` / `bun link`: root [AGENTS.md](../AGENTS.md); restart the dev server after either (`rm -rf node_modules/.vite` on `does not provide an export named ...`).

## Framework

`@basics/core/client`: DI container (`di.get`), signals/`effect`, `Router`, components. `*.component.ts` view components; `*.service.ts` injectable state/logic (`*.tool.service.ts` for editor tools). Entry `src/main.ts` runs `startApp(AppComponent, '#app')`; `src/api.ts` wires the typed `shared/api/*.gen.ts` clients (base `/api`).

- **Signals are eager and push-based.** Derived-geometry effects fire on mixed intermediate state; coalesce side effects with `queueMicrotask`.
- **Detached template clone.** A component spawned inside a parent's `render()` runs `onMount` while its host sits in an inert `about:blank` document. A library that binds document-level listeners at construction (MapLibre: drag mousemove/mouseup) then gets clicks working and every drag dead. Wait for the host to join the live document, as `MapService.init` does, before handing it to such a library.
- **Vendored framework.** The package is a versioned tarball in `vendor/`; edits go through `fw:update`, leaving `node_modules/@basics/core` and the dep string as they are. `bunfig.toml` preloads the package's own happy-dom adapter (`@basics/core/happy-dom`).

## Styling: local recipes, semantic tokens

A deliberate, assessed divergence from the other `@basics/core` consumers; keep it.

- **`src/css.ts` is the source of truth for component recipes** (Links & Loam). Import only the `s` spacing scale from `@basics/core/client/ui`; core's `btn()`/`input()`/`card()` and its table, status-pill and empty-state components stay unused (so `round-sg-table.ts` and friends keep their local recipes).
- The recipe-ordering rule of the other consumer repos (recipe interpolation first in a block, overrides after) applies to core's recipes only; here ordering is free.
- **`src/theme.ts` speaks full semantic token names** (`color-text-primary`, `color-surface-card`, ...) through the typed `t()`; theme-invariant layers (map/data/scale/type/motion) are raw `var()` reads from `design-tokens.css`. Write theme edits in that vocabulary. The legacy short aliases (`bg`/`primary`/`text`/...) were removed on purpose, `bridgeLegacyControls` is for legacy-vocabulary themes like tapscore, and there are zero direct `var(--btn-bg|btn-hover|radius|shadow|error|input-bg|primary)` reads; keep it that way.
