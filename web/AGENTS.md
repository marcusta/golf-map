# web — AGENTS

Vite + TS SPA on `@basics/core` client framework, MapLibre for maps. Course building (SVG/vector), strategy planning, follow-up analytics. Run with **cwd = `web/`**.

## Framework

`@basics/core/client` — DI container (`di.get`), signals/`effect` (push-based, eager — see below), `Router`, components. Conventions:
- `*.component.ts` — view components. `*.service.ts` — injectable state/logic (+ `*.tool.service.ts` for editor tools).
- Entry `src/main.ts` → `startApp(AppComponent, '#app')`. `src/api.ts` wires `shared/api/*.gen.ts` typed clients (base `/api`).

⚠️ Signals are eager/push-based; derived-geometry effects can fire on mixed intermediate state. Coalesce side effects with `queueMicrotask`.

## Layout (`src/`)

`app/` shell · `auth/` login+guard · `courses/` list · `course-detail/` · `editor/` (toolbar + `tools/`) · `draw/` (SVG feature drawing, history/undo) · `import/` (SVG orthophoto trace import) · `measure/` · `analysis/` (green slope) · `planner/` (strategy: overlay, gates, plan service) · `player/` (club config) · `map/` (MapLibre style/tiles/interaction) · `geo/` (bezier, bspline, transform) · `furniture/`.

## Commands (cwd `web/`)

```sh
bun run dev          # vite dev server :5173, proxies /api + /tiles → :3000 (server must run)
bun test             # tests (happy-dom); mirrors in tests/
bun run check:client # typecheck
```

Prefer the `preview_*` tools to verify UI changes over asking the user to check.
