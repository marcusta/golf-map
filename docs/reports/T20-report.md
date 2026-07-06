# T20 — End-to-end smoke harness (Playwright)

The project's first E2E harness. Local-only (no CI this round). `bun run e2e`
from the repo root boots an isolated, freshly-seeded API + the web dev server,
logs in once, and runs a 5-flow smoke suite. Green and deterministic.

## How to run

```
bun run e2e            # headless chromium, list reporter
bun run e2e:headed     # same, headed (watch the map)
bun run e2e:ui         # Playwright UI mode
```

No manual setup: the harness seeds its own DB and boots both servers. It never
touches dev `data/*.sqlite`.

## Verbatim result

```
$ bun run e2e
$ playwright test --config e2e/playwright.config.ts

Running 6 tests using 1 worker

  ✓  1 [setup] › e2e/tests/auth.setup.ts:12:6 › authenticate as the seed user (293ms)
  ✓  2 [chromium] › e2e/tests/01-course-loads.spec.ts:12:5 › course detail loads with toolbar and all tool buttons (1.1s)
  ✓  3 [chromium] › e2e/tests/02-planner-decade.spec.ts:14:5 › planner shows DECADE light chip + EV readout for an approach (1.5s)
  ✓  4 [chromium] › e2e/tests/03-drag-cadence.spec.ts:16:5 › dragging a shot keeps enrichment flat across frames and bumps once on release (4.4s)
  ✓  5 [chromium] › e2e/tests/04-apply-aim.spec.ts:14:5 › apply recommended aim moves the selected shot and the panel reflects it (1.9s)
  ✓  6 [chromium] › e2e/tests/05-caddy-advice.spec.ts:12:5 › caddy advice renders at least one item on an approach leg (1.5s)

  6 passed (12.0s)
```

(1 setup project + 5 smoke flows = 6 "tests" in Playwright's count.)

## Typecheck

- `web` (`bunx tsc --noEmit -p web/tsconfig.json`): **clean** — the data-attribute
  instrumentation did not break the app typecheck.
- `server` (`bunx tsc -p tsconfig.server.json --noEmit`, which includes `db/`):
  **clean** — covers the new `server/db/seed-e2e.ts`.

## The seed + boot + login recipe (what works)

Playwright starts `webServer`s **before** `globalSetup`, so seeding cannot live
in globalSetup (it would race the server's DB open → "disk I/O error"). The
working shape:

1. **Seed** (`server/db/seed-e2e.ts`) — reuses the SAME unit-test seed fns
   (`seedUsers` + `seedCourse` + `seedClubs`) via `createDb` + `runMigrations`
   against an isolated sqlite, then inserts ONE extra row the unit seeds lack: a
   `tile_manifest` course asset (see below). Must run with **cwd = `server/`** so
   Bun resolves the `@basics/core` workspace `file:` dep (it resolves from the
   file's directory, and only `server/`/`web/` node_modules link it — that's why
   the seeder lives in `server/`, not `e2e/`). Ends with
   `PRAGMA wal_checkpoint(TRUNCATE)` + physical `-wal`/`-shm` removal so the
   server opens a clean, self-contained file.
2. **Boot API** — the API `webServer` command is
   `bun db/seed-e2e.ts "$DB" && bun main.ts` (cwd `server/`). Chaining guarantees
   a fully-migrated, seeded DB exists before `main.ts` opens it. Env:
   `PORT=3100`, `DB_PATH`/`SESSION_DB_PATH`/`OBS_DB_PATH` → `e2e/.tmp/*.sqlite`,
   `DATA_DIR` → repo `data/` (so tile routes don't crash).
3. **Boot web** — `bunx vite` (cwd `web/`) on `PORT=5273` with
   `API_PROXY_TARGET=http://localhost:3100` (new env knob in `web/vite.config.ts`,
   defaulting to `:3000` — behaviour-neutral for dev) so vite proxies `/api` +
   `/tiles` to the isolated API.
4. **Login** — the `setup` project (`e2e/tests/auth.setup.ts`) runs first (after
   servers are up), `POST`s `/api/auth/login` with `marcus` /
   `test-password-123` through the proxy, asserts the `session` cookie stuck,
   and persists `storageState` to `e2e/.tmp/storage-state.json`. The `chromium`
   project `dependencies: ['setup']` and loads that storageState — every flow
   starts authenticated.

**Ports are deliberately off the dev defaults** (API 3100 not 3000, web 5273 not
5173) so a running dev environment doesn't collide with the harness.

### Why the tile_manifest seed is mandatory

`TilesetService.hasTiles` gates map init: with no `tile_manifest` asset the
editor map never initialises, `MapService.ready` never flips true, and the
toolbar + planner map chrome (all gated on `ready`) never render — every flow
would be blocked. The seeded manifest only needs valid `bounds`/zoom/
`generatedAt`; the tile **bytes** 404 (no pyramid on disk), which MapLibre
tolerates — the editor style has no glyphs/sprites, so `map.on('load')` still
fires and the map reaches `ready`. The 404s are expected and harmless (they
flood the server log during a run — ignore them).

## data-testid / data-* conventions (the project convention going forward)

Hooks are **inert in prod** — pure attributes, no test-mode flag, no behaviour
or perf change. Style: kebab-case `data-testid`, area-prefixed; dynamic state as
`data-*` on a stable element.

Course detail / editor:

| Attribute | Element |
|---|---|
| `data-testid="course-detail"` | course detail page root |
| `data-testid="course-detail-header"` | detail header bar |
| `data-testid="course-name"` | course name `<h2>` |
| `data-testid="course-plan-btn"` / `course-import-svg-btn` | header actions |
| `data-testid="course-hole-row"` + `data-hole-number="N"` | a hole row |
| `data-testid="editor-toolbar"` / `editor-toolbar-bar` | tool host + button bar |
| `data-testid="tool-btn-<id>"` + `data-tool-id="<id>"` | one per tool (`draw`/`furniture`/`measure`/`analysis`) |

Planner:

| Attribute | Element |
|---|---|
| `data-testid="planner"` | planner page root |
| `data-testid="planner-hole-row"` + `data-hole-number="N"` | a hole row |
| `data-testid="planner-panel"` + `data-enrich-count="N"` | panel root; **N = completed DECADE enrichment passes** (the cadence hook) |
| `data-testid="planner-add-shot"` / `planner-add-gate` | mode buttons |
| `data-testid="planner-legs-section"` / `planner-legs-body` | legs readout |
| `data-testid="planner-leg"` | one wrapper per leg line |
| `data-testid="planner-leg-light"` + `data-light="green\|yellow\|red"` | DECADE confidence chip |
| `data-testid="planner-leg-ev"` | the EV (expected-strokes) readout |
| `data-testid="planner-leg-total"` | totals line |
| `data-testid="planner-caddy-section"` / `planner-caddy-body` | caddy area |
| `data-testid="planner-caddy-card"` | one per ranked caddy card |
| `data-testid="planner-shots-section"` / `planner-shot-list` | shots area |
| `data-testid="planner-shot-row"` + `data-shot-id` + `data-lat`/`data-lon` | a shot row; lat/lon reflect the LIVE landing point |
| `data-testid="planner-apply-aim"` / `planner-seed-aims` | shot-section buttons |
| `data-testid="planner-gates-section"` / `planner-gate-list` / `planner-auto-gates` | gates area |

Non-DOM state hook: `data-enrich-count` on the panel root, driven by a new
`PlannerToolService.enrichCount` signal bumped once at the end of
`refreshStrategy`'s coalesced microtask (the single place a full DECADE pass
completes). This is what makes the compute-cadence guarantee **testable for
real**: a drag holds it flat across frames and bumps it exactly +1 on release.

## The compute-cadence proof (flow c) — how the drag is real

MapLibre renders to a WebGL canvas, so shot markers aren't DOM-queryable. The
drag helper (`e2e/tests/fixtures.ts` `dragShotByPixels`) projects the shot's
live lat/lon (read off `data-lat`/`data-lon`) to canvas pixels via the app's QA
hook `window.__map.project(...)`, then dispatches a genuine
`mousedown → N×mousemove → mouseup` through Playwright's mouse API — driving the
planner tool's real raw-handler drag path. The test samples `data-enrich-count`
on every frame (must never exceed `before+1`) and polls it to exactly `before+1`
after release. Assertions are on PANEL DOM / data-attributes only — never on map
pixels or tiles.

## Flows

- (a) `01-course-loads` — authed course load → toolbar + all 4 tool buttons
  present (guards the "toolbar disappeared" regression).
- (b) `02-planner-decade` — planner approach renders the DECADE light chip +
  EV readout.
- (c) `03-drag-cadence` — real shot drag: `data-enrich-count` flat across
  frames, +1 on release.
- (d) `04-apply-aim` — "Apply recommended aim" moves the selected shot; the
  reflected `data-lat`/`data-lon` change.
- (e) `05-caddy-advice` — caddy advice renders ≥1 card on an approach leg.

**Nothing skipped.** All 5 flows run and pass.

### Key modelling fact the flows depend on

A leg's club = the club of the **shot it lands on**; the green is never a shot,
so a leg landing on the green is only clubbed via the **index-0 tee-leg
preferred-club fallback** (`buildHolePlan` in `web/src/planner/plan-overlay.ts`).
Therefore the *enriched approach* case (light chip + caddy + ghost aim) is
cleanest on **par-3 hole 2 with a preferred club set** — its tee→green leg is
that index-0 clubbed approach. Flows b + e use hole 2 that way. Flows c + d use
par-4 hole 1 with one clubbed shot (a draggable S1 whose tee→S1 leg is enriched).

## Test-setup detail: plans seeded via the real API

The flows seed plan state (`upsert` → `set-hole` → `shots/add`) through the real
API from the page's session (`seedPlanViaApi` in `fixtures.ts`), then load the
planner against it. This is legitimate setup through the same endpoints the app
uses, and it keeps the flows testing the DECADE/caddy **render + enrichment**
seams rather than the client's plan-*creation* path — see open concern #1. The
helper is idempotent (the plan is per-course: `upsert` creates on the first call
and 409s afterwards, so it falls back to reading the existing plan tree).

## Files touched

New (harness):

- `e2e/playwright.config.ts` — config: 2 webServers (isolated API + vite),
  `setup`→`chromium` project dependency, ports 3100/5273, `outputDir` under `e2e/`.
- `e2e/tests/auth.setup.ts` — login + storageState.
- `e2e/tests/fixtures.ts` — constants, `waitForMapReady` (reads `__map.loaded()`),
  `openPlanner`, `seedPlanViaApi`, `dragShotByPixels`, `enrichCount`.
- `e2e/tests/tool-ids.ts` — the 4 editor tool ids (no import into app source).
- `e2e/tests/01-course-loads.spec.ts` … `05-caddy-advice.spec.ts` — the 5 flows.
- `server/db/seed-e2e.ts` — isolated seeder (reuses unit seeds + tile_manifest).

Modified (behaviour-neutral instrumentation + harness wiring):

- `web/vite.config.ts` — `API_PROXY_TARGET` env knob (defaults to `:3000`).
- `web/src/editor/toolbar.component.ts` — toolbar + per-tool-button testids.
- `web/src/course-detail/course-detail.component.ts` — detail/header/hole-row testids.
- `web/src/planner/planner.component.ts` — planner root + hole-row testids.
- `web/src/planner/planner-panel.component.ts` — panel/legs/caddy/shot/button
  testids + `data-enrich-count` reflection + shot-row `data-lat`/`data-lon`.
- `web/src/planner/planner-tool.service.ts` — new `enrichCount` signal bumped in
  `refreshStrategy` (the cadence hook).
- `package.json` — `e2e` / `e2e:headed` / `e2e:ui` scripts + `@playwright/test` devDep.
- `.gitignore` — `e2e/.tmp`, `e2e/test-results`, `e2e/playwright-report`.
- `bun.lock` — Playwright install.

## Open concerns

1. **Client plan-creation bug (pre-existing, unrelated to T20).** The app's own
   first-edit path `PlannerPanel "Seed shots from aim points"` / map-click place
   → `PlanService.ensurePlan()` → `set-hole` sends an **empty `planId`** and the
   server 400s ("Validation failed: /planId Expected string"), so the FIRST edit
   on a plan-less hole creates no shot (silent — the error lands in the panel
   status, not the hint). The raw API sequence (`upsert` → `set-hole` with the
   returned id) works fine, so it's a client reactive-state issue in
   `web/src/planner/plan.service.ts` (upsert response id not reaching
   `plan.peek()` before `set-hole` reads it — consistent with the known
   eager-signal cascade gotcha). The flows sidestep it by seeding via the API;
   **worth a separate fix** — it's a real user-facing "clicking the map places
   nothing on a fresh hole" bug. (A background task chip has been filed.)
2. **Serial + shared DB.** The 5 flows run serially against one seeded DB and
   accumulate plan state (e.g. hole 1 gains a shot per drag/apply run). Tests are
   written to be order-independent (target by `data-shot-id`, assert relative
   change), but a future parallel run would need per-worker DBs.
3. **Pre-existing `[ARC]` debug `console.log`s** in `web/src/map/map.service.ts`
   and `web/src/furniture/furniture-tool.service.ts` were already uncommitted in
   the working tree at session start (another chat's dev work) — left untouched.
   They spam the browser console during runs but don't affect the suite.
4. **WebGL in headless chromium** relies on SwiftShader; runs clean locally on
   macOS/arm64. A CI image would need to confirm GL support (or `--use-gl=swiftshader`).
