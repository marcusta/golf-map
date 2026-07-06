# Plan: Feature Distances (Rangefinder / Yardage List)

**Status:** proposal (for evaluation against other candidate work)
**Date:** 2026-07-06
**Scope:** `shared/strategy`, `server/services/analysis.service.ts` (+ route/client), `web/src/planner`. v1 planner-only. No schema change.
**Related:** [decade-planner-strategy-engine.md](decade-planner-strategy-engine.md) — this is the *measurement* layer that feeds the *decision* layer.

---

## 1. Purpose

Give the player the list every rangefinder / GPS app shows — **distances from where I am to every
target that matters**: front / centre / back of green, each bunker and water carry, layups and
aim points — but computed from our **real geometry + LiDAR heightmap + wind** instead of a
hand-tagged flat-earth GPS point.

The output is a sorted, structured list. Each entry carries not one number but three separable
numbers:

- **line** — straight-line ground distance (what every other app shows),
- **plays-like elevation delta** — from the DEM (uphill adds, downhill subtracts),
- **plays-like wind delta** — head/tail component projected onto the shot bearing,

plus, where clubs are configured, the **club that covers the plays-like distance**.

## 2. Why we can beat typical apps

| Input | Typical app | Us |
|-------|-------------|-----|
| Target positions | Hand-tagged points, a handful per hole | Real feature **polygons** — every edge is a target |
| Elevation | None (flat) | 0.5 m LiDAR DEM (`dem_cog`), true rise/fall |
| Wind | None, or manual guess | Per-hole `windSpeedMps` / `windDirectionDeg`, projected onto bearing |
| Carry vs front | One "hazard" dot if lucky | Near-edge (front) **and** far-edge (carry) along the shot line |
| Club fit | None | Player's per-club carry (`clubAdvice`) against the *plays-like* number |

The keystone advantage: because targets are **polygons**, "front of that bunker" and "carry that
bunker" fall out of geometry — no human has to place two dots per hazard on every hole.

## 3. What already exists (this is ~70% assembly)

`shared/strategy` (pure, zero-dep, tested, Swift-mirrored) already ships the hard math:

- `plays-like.ts` — `segmentStats(a, b)` → `{ horizontalM, elevationDeltaM, straightLineM, slopeDeg, slopePct, playsLikeSimpleM }`. The caddie rule (horizontal + signed elevation) is already here.
- `wind.ts` — `windEffect(speedMps, dirDeg, bearingDeg)` → fractional multiplier; `playsAsM(distanceM, effect)` → "plays as" distance; `windComponents()` → head/tail + crosswind split.
- `club.ts` — `clubAdvice(clubs, distanceM)` → `{ front?, center?, back? }`; `closestClub()`; `maxCarryM()` for "can I carry it".
- `corridor.ts` — `rayRingDistance(origin, dir, points)` (nearest ray↔ring hit) — the exact primitive Phase 2 generalises.
- `analysis.service.ts` — **`bilinearSample(win, e, n)` is already exported and pure**, and `openDem()` / `readDemWindow()` already own the COG (caching, nodata, path-escape guard).

Data already present: `Green.{center,front,back}{Lat,Lon}` (+ nullable `elevation`), `CourseFeature` polygons (EPSG:3006 bezier rings, typed `bunker`/`water`/…), `Tee`, `AimPoint`, per-hole/per-plan wind, per-player club carries.

**Three real gaps** (§5): point elevation sampling, along-line carry/front, and the assembly glue.

## 4. Key design decisions (lock before building)

### 4.1 The feature owns a generic **origin**, not a "planner shot"

v1 runs in the planner, but the engine must never take a `PlanShot` / `Shot` / `Tee` (entities
owned elsewhere). It takes a small point type **this feature owns**, and callers adapt their
entity into it. Same shape as the existing `StrategyPoint` — reuse it rather than inventing a
parallel type:

```ts
// shared/strategy/plays-like.ts (existing)
export interface StrategyPoint { x: number; y: number; elevation?: number | null }
```

The origin is just a `StrategyPoint` in projected EPSG:3006 metres. A planner shot, a round's last
`Shot`, a tee, or a future live-GPS fix all become `StrategyPoint` via the existing
`wgs84ToSweref99tm(lat, lon)` + an elevation fill. **The engine has no idea what produced the
point.** This is what makes "works for any point in the future" free.

### 4.2 The feature owns a generic **target**, not `Green` / `CourseFeature`

Likewise the engine consumes typed targets, not domain entities. Adapters (planner-side) convert
`Green` → three point targets, `CourseFeature` (hazard) → a ring target, `AimPoint` → a point
target. The engine only sees:

```ts
export type DistanceTarget =
  | { kind: 'point'; label: string; role: PointRole; at: StrategyPoint }
  | { kind: 'hazard'; label: string; ring: FlatRing };   // FlatRing from corridor.ts

export type PointRole =
  | 'green_front' | 'green_center' | 'green_back' | 'layup' | 'aim' | 'pin';
```

Adding a new target source later (e.g. "widest part of fairway", a saved layup) is a new adapter,
not an engine change.

### 4.3 Elevation is an **injected provider**, not a call the pure core makes

The math library is Swift-mirrored and must stay pure / zero-I/O. So the engine never fetches
elevation itself — it receives points with `elevation` already filled, and the *fill* is done by a
provider the platform supplies:

```ts
export interface ElevationProvider {
  // Fill elevation for many points in one shot. null = nodata / off-DEM.
  sample(points: readonly { x: number; y: number }[]): Promise<(number | null)[]>;
}
```

- **Web** → `ServerElevationProvider`: POSTs to `/analysis/sample-elevations` (§5.1). The 150 MB
  COG stays server-side.
- **iOS** → `LocalElevationProvider`: reads the **downloaded** COG on-device (offline on-course).
  Different implementation, identical interface, identical downstream math.

This one seam is why the platform split (decision #2) costs nothing in the engine.

### 4.4 Raw distance always visible; deltas are separable

Plays-like formulas are opinionated (the `×0.01/mph` wind curve, the 1 yd/1 yd elevation rule).
Golfers distrust a single fudged number. The output keeps `lineM`, `elevationDeltaM`, and
`windDeltaM` as **distinct fields**; the UI shows `148 · +9↑ · +4wind → 6i` with the deltas
individually toggleable. The engine never collapses them into one number.

## 5. Components (new / changed)

### 5.1 Phase 1 — Point elevation (server; the one infra gap)

**`server/services/analysis.service.ts`** — add beside `sampleGrid`:

```ts
async sampleElevations(
  courseId: string,
  points: readonly { e: number; n: number }[],
): Promise<(number | null)[]>
```

- Compute a bbox over `points`, synthesise the `GridSpec`-shaped window, **reuse existing
  `openDem()` + `readDemWindow()`** unchanged.
- Sample each point with the already-exported `bilinearSample(win, e, n)`.
- **No Gaussian blur** — blur is a green-slope concern; point yardages want the raw bilinear
  height. Round to mm, `NaN` → `null` (matches `sampleGrid`).

**Route + client:** `POST /analysis/sample-elevations`, body `{ courseId, points: [{e,n}] }` →
`{ elevations: (number|null)[] }`; regenerate `shared/api/analysis.gen.ts`.

**Tests:** bbox synthesis; a point sampled here must equal `sampleGrid`'s pre-blur value at the
same coordinate; off-DEM → null; empty input → empty.

### 5.2 Phase 2 — Along-line carry / front (pure)

**New `shared/strategy/carry.ts`:**

```ts
export interface CarryOverHazard {
  ring: FlatRing;
  frontM: number;   // near-edge distance along the shot line
  carryM: number;   // far-edge distance (the "clear it" number)
}

export function hazardsAlongLine(
  origin: Vec2,
  bearingDeg: number,
  obstacles: readonly FlatRing[],
  maxM?: number,
): CarryOverHazard[]
```

- Cast the ray `bearingToUnitVector(bearingDeg)`; for each ring collect **all** intersection `t`s
  (sorted), not just the nearest. ≥2 hits → `frontM = min t`, `carryM = max t`.
- Rings the line misses are skipped — *lateral* clearance stays `corridorWidth()`'s job; this is
  purely "what does the line fly over".
- **Refactor:** extract the segment-intersection loop currently inlined in `corridor.ts`
  `rayRingDistance` so corridor (nearest hit) and carry (all hits) share it — no duplicated math.

**Tests:** ray through a box → front/carry = the two crossings; tangent/miss → omitted; origin
inside the ring → `frontM = 0`.

### 5.3 Phase 3 — Distance-list assembly (pure engine)

**New `shared/strategy/feature-distances.ts`:**

```ts
export interface FeatureDistance {
  kind: PointRole | 'hazard_front' | 'hazard_carry';
  label: string;
  bearingDeg: number;
  lineM: number;                    // always present
  elevationDeltaM: number | null;   // null when either endpoint has no DEM elevation
  playsLikeM: number | null;        // line + elevΔ (segmentStats.playsLikeSimpleM)
  windDeltaM: number | null;        // playsAsM(playsLikeM, windEffect(...)) − playsLikeM
  club?: ClubSpec;                  // clubAdvice against (playsLike + windDelta)
}

export interface FeatureDistancesInput {
  origin: StrategyPoint;                 // elevation already filled
  targets: readonly DistanceTarget[];    // adapters produced these
  wind?: { speedMps: number; directionDeg: number };
  clubs?: readonly ClubSpec[];
}

export function featureDistances(input: FeatureDistancesInput): FeatureDistance[]
```

- Pure composition over existing functions: bearing from origin→target; `segmentStats` for
  line + elevation; `hazardsAlongLine` for hazard front/carry (expands one hazard target into up
  to two rows); `windEffect`/`playsAsM` for the wind delta on that bearing; `clubAdvice` for the
  club. Sort ascending by `lineM`.
- **Zero new math** — glue over Phase-5 primitives + Phase-2 carry.

**Tests:** golden hole fixture → exact ordered list; wind absent → `windDeltaM = null`, list still
valid; missing elevations → `playsLikeM = null` but `lineM` unaffected.

### 5.4 Phase 4 — Wiring (web planner)

1. Adapters: `Green`/`CourseFeature`/`AimPoint` + the active origin → `DistanceTarget[]` (project
   with existing `wgs84ToSweref99tm`).
2. `ServerElevationProvider.sample()` — **one batched** call filling every point lacking elevation
   (hazard edges always; greens when `elevation` is null).
3. `featureDistances(...)` → render the sorted panel; deltas toggleable per §4.4.

## 6. Architecture (layering)

```
┌ web/src/planner ─────────────────────────────────────────────┐
│  adapters: Green/Feature/AimPoint/origin → DistanceTarget[]   │
│  ServerElevationProvider ── POST /analysis/sample-elevations ─┼─► server
│                                    │                          │
│                            featureDistances()  ◄── pure       │
└────────────────────────────────────┼─────────────────────────┘
                                      ▼
        shared/strategy (pure, zero-dep, Swift-mirrored)
        plays-like · wind · club · corridor · carry(new) · feature-distances(new)

iOS (future): same DistanceTarget[] + featureDistances(); LocalElevationProvider reads the
downloaded COG. No engine change.
```

The dependency arrow only ever points *into* `shared/strategy`. Nothing in the pure core knows
about planners, HTTP, or the DEM file.

## 7. Platform split (decision #2, made concrete)

| Concern | Web | iOS |
|---------|-----|-----|
| DEM location | Server-side `dem_cog` (~150 MB) | Downloaded COG on device |
| Elevation provider | `ServerElevationProvider` → `/analysis/sample-elevations` | `LocalElevationProvider` → on-device GeoTIFF read |
| Distance math | `featureDistances()` (shared TS) | `featureDistances()` (Swift mirror) |
| Origin source | Planner shot/tee (v1) | Live GPS later, same `StrategyPoint` |

The **only** platform-specific code is the provider implementation behind §4.3's interface.

## 8. Non-goals / out of scope for v1

- Live-round / on-course GPS origin (the origin abstraction supports it; no UI wired).
- Crosswind aim guidance (`crosswindDriftM` exists; this feature is *distances*, not aim).
- Any schema change or new persisted "ball position" entity — origin is transient.
- Optimal-aim / expected-strokes scoring — that's the DECADE doc's job; this feeds it.
- iOS implementation — designed-for, not built here.

## 9. Risks / open questions

- **Which hazards to list.** Every ring on the hole, or only those within a corridor of the shot
  line? Proposal: list carry/front only for hazards the line crosses (`hazardsAlongLine`), plus
  green + aim points always. Revisit once real holes are on screen.
- **Bearing for hazard carry.** Uses origin→green-centre as the default shot line when no aim
  point is selected; a chosen aim point overrides. Confirm that default.
- **Elevation batching cost.** One round-trip per recompute; fine for planner. On-course (iOS) it's
  local, so a nonissue there.
- **Plays-like model is v1's simple rule.** `playsLikeSimpleM` ignores apex/flight; good enough to
  ship, flagged for later refinement, and isolated behind the separable-delta UI.

## 10. Effort & phasing (prio input)

| Phase | Deliverable | Depends on | Rough size |
|-------|-------------|-----------|-----------|
| 1 | `sampleElevations` + route/client + tests | — | **S** (reuses all DEM plumbing) |
| 2 | `carry.ts` + corridor refactor + tests | — | **S** (one pure function) |
| 3 | `feature-distances.ts` engine + tests | 1, 2 | **S–M** (glue + fixtures) |
| 4 | Planner adapters, provider, panel UI | 1–3 | **M** (UI is the bulk) |

Phases 1 and 2 are independent, pure/near-pure, and testable in isolation with no UI — low-risk
early wins. The load is in Phase 4 UI. Total: small-to-medium; the value-to-effort ratio is high
because the math already exists and the two owned abstractions make it reusable rather than a
planner one-off.

**Sequencing vs the DECADE engine:** this is a strict prerequisite-shaped sibling. This feature
answers *"how far is it?"*; DECADE answers *"where should I aim?"*. Both consume the same
`StrategyPoint` + target adapters, so building this first de-risks and partly plumbs DECADE.

## 11. Future extensions (unlocked, not built)

- Live-round origin from GPS / last `Shot` — new adapter, zero engine change.
- Arbitrary "measure from any point" mode — the origin is already generic.
- Per-target "can I carry it?" flag — compare `carryM` to `maxCarryM(club)`.
- Fairway-width / widest-landing targets — new adapter into `DistanceTarget`.
- iOS offline yardages — `LocalElevationProvider` + Swift mirror of the two new files.
