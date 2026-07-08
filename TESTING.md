# Testing

How we test golf-map, and why. These are opinions inherited from the
[@basics](https://www.npmjs.com/org/basics) framework — follow them.

## The four rules

1. **Integration-first.** Test through the real service graph and real
   infrastructure, not isolated functions. A server service test runs against a
   real migrated database; a pipeline test runs against real rasters. Prove the
   pieces work *together*, because that is where bugs live.
2. **No mocks.** We do not use `vi.mock`, `jest.mock`, `sinon`, `testdouble`, or
   any mocking library — grep the suite, you will find zero. Use real objects in
   isolated environments instead (see [Seams](#seams-instead-of-mocks) below).
   A mock asserts *how* code works; we want to assert *what* it does.
3. **Unit tests only for hard algorithms.** Pure, gnarly math earns a focused
   unit test — Bézier/B-spline curves, coordinate transforms, green-slope,
   strokes-gained, expected-strokes ellipses, caddy EV rules. Everything else is
   exercised at the service or system level. If you reach for a unit test for
   glue code, you are probably testing the wrong layer.
4. **A user journey is covered by a system test.** The Playwright E2E harness
   drives the real app end-to-end for the flows that matter.

The shape of the tree enforces this: one service = one service test
(`courses.service.ts` → `courses.service.test.ts`).

## Layout & how to run

| Area        | Runner                     | Command (from that dir) | What lives here |
|-------------|----------------------------|-------------------------|-----------------|
| `server/`   | `bun test`                 | `bun test`              | Kysely-backed service tests against a real migrated DB |
| `shared/`   | `bun test`                 | `bun test`              | Strategy + caddy-rule algorithm units (expected-strokes, EV rules) |
| `web/`      | `bun test` (happy-dom)     | `bun test`              | Service/state integration + algorithm units; mirrors in `tests/` |
| `pipeline/` | `pytest`                   | `pytest`                | Rasterization integration (tiling, DEM grid, terrain-RGB, STAC, manifest) |
| `e2e/`      | Playwright                 | `bun run e2e` (repo root) | Full-stack system smoke tests |

E2E variants: `bun run e2e:headed`, `bun run e2e:ui`.

## Seams instead of mocks

When a test needs to isolate a boundary, use a real implementation in an
isolated environment — never a mock:

- **Database** — `createTestDb()` ([`server/testing/db.ts`](server/testing/db.ts))
  spins a real migrated SQLite instance per test and wires the real service
  graph via `createServices`. Seed with composable functions (`seedUsers`,
  `seedCourse`, …). Each test gets a fresh DB.
- **Rasters** — `pipeline/tests/conftest.py` generates synthetic in-memory
  GeoTIFFs with numpy/rasterio. Real raster objects, deterministic data.
- **Network** — web client tests stub `globalThis.fetch` by hand (a tiny
  URL router, e.g. [`web/tests/auth.service.test.ts`](web/tests/auth.service.test.ts)),
  not via a mocking library.

## Adding a feature

New server feature = **api descriptor + service + service test**, mounted under
`/api`, then `bun run generate`. The service test is not optional — it is how
the feature is considered done.

New hard algorithm (geometry, scoring, strategy) = a focused unit test next to
it. New user-visible flow = consider an E2E spec in `e2e/tests/`.

## E2E harness (T20)

`e2e/` runs Playwright smoke tests against the real stack on isolated ports
(API :3100, web :5273) with a fresh seeded SQLite DB (`db/seed-e2e.ts`). Auth
runs once (`auth.setup.ts`) and persists a session; the specs run serially
(`workers: 1`) because they share one seeded DB and mutate plan state. Select
elements by `data-*` ids via the `tid()` helper in `e2e/tests/fixtures.ts` —
not by CSS.

## Known gaps

- **No CI.** There is no `.github/workflows`; all suites are run manually. Green
  means someone ran `bun test` in `server/`, `shared/`, `web/`, `pytest` in
  `pipeline/`, and `bun run e2e` at the root. Run them before you push.
- **E2E is local-only** — no CI wiring yet, by design for now.
- **No component-level specs for web UI** — web coverage is service/state +
  algorithm units, with UI flows covered by E2E rather than per-component tests.
