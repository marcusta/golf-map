# web — AGENTS

Vite + TS SPA on the `@basics/core` client framework, MapLibre for maps. Course building (SVG/vector), strategy planning, follow-up analytics. Run with **cwd = `web/`**; commands are `package.json` scripts (`dev` proxies `/api` and `/tiles` to the server, which must run).

## Pointers

- Layout of `src/` (one folder per feature): `ls src`; per-folder notes: [docs/web-features.md](../docs/web-features.md).
- Vegetation zones (zone-type panel, selection-panel sections, tree species areas, Vegetation mode, Plant vegetation): [docs/feature-vegetation-zones.md](../docs/feature-vegetation-zones.md) section 13.
- Roads and paths (centerline editing, kerb fillets): [docs/feature-roads-centerline.md](../docs/feature-roads-centerline.md).
- Reference photos, Clean tool External edit, Rules lines in Furniture, Roughs-layer eye, map performance control, `/dev/vegetation` test scene: [docs/web-features.md](../docs/web-features.md).
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

## Dev loop: what hot-swaps

Vite HMR stops only at a module that calls the literal `import.meta.hot.accept(` (an alias of `import.meta.hot` is not detected). Without one, an edit reloads the page and MapLibre rebuilds the map and refetches tiles.

- `src/draw/draw-tool.service.ts` self-accepts. An edit swaps the prototype of the live `DrawToolService` to the new class and registers it under the new class key too (`hotSwapDrawTool`). The instance keeps its identity because the docks and the command bar hold it in fields. If the engine is running (Draw, or Furniture/Vegetation hosting it in their scope), `EditorModeService.restartTool` deactivates it with the old code, releases and re-takes the claim, and activates it with the new code. Feature selection, undo history, draw type and the type preferences survive; an open draft is dropped. `attach` does not re-run; an edit there applies on the next canvas mount.
- The swap is refused and the page reloads when the new class declares an instance field the live object lacks, or when a stateful import changed identity (`DRAW_TOOL_HOT_DEPS`: draw-state, history, screen-cache, the confirm dialog, features.service, zones/zone-types.service, editor/tool.ts). A dependency edit reaches this module only through those imports, so it reloads.
- Everything else reloads the page as before, including `map/map.service.ts`, `draw/features.service.ts`, `draw/draw-tool.ts`, the panels and the other tool services. `map.service.ts` reaches draw-tool.service.ts only through type imports, so it is never part of the swap.
- The Draw tool's pointer, hover, keys, render and frame code lives in `draw/draw-pointer.ts`, `draw/draw-hover.ts`, `draw/draw-keys.ts`, `draw/draw-render.ts` and `draw/draw-frame.ts`. Only draw-tool.service.ts imports them (siblings import each other for types only), so an edit to any of them propagates to the service and hot-swaps like an edit to the service. These modules must not import draw-tool.service.ts: a cycle back into the accepting module breaks the boundary.
- The modules reach the service's private state through a host object. The service caches it in a module-level `WeakMap`, so each re-execution of draw-tool.service.ts builds a fresh host whose shape matches the new code. Listeners bound in `activate` hold the old host until `restartTool` deactivates and re-activates.
- `FrameBatch` and `FrameSignal` (`draw/draw-frame.ts`) are swapped only for instances created after the edit; the live instance keeps its existing ones.

## Unused code checks

`tsconfig.json` sets `noUnusedLocals` and `noUnusedParameters`, so `bun run check:client` fails on unused locals, imports and parameters. Prefix a parameter with `_` when an interface or callback fixes the signature. `tsconfig.test.json` does not set these flags. `src/reports/diagrams.ts` has no importer in `src`. It is the vendored ATDD report engine, referenced by the atdd skill for the visual test report. Keep it and do not delete it as dead code.

## E2E

`bun run e2e` (repo root) boots an isolated API and web server on 3100/5273 and runs `e2e/tests/`; set `E2E_API_PORT=3200 E2E_WEB_PORT=5474` when those are busy. `bun run e2e:create` runs the Create-mode specs only (01, 07, 08, 09, 17, 19, 24, 25, 28, 32) through the same config, so the setup project and ports are unchanged.

Every run also writes the Playwright json report to `e2e/results/results.json` (gitignored). `bun run e2e:durations` reads it and prints spec file, status, test title and duration in ms, slowest first, plus the total.
