# Plan: DECADE-style Strategy Engine for the Planner

**Status:** proposal (for evaluation against other candidate work)
**Date:** 2026-07-06
**Scope:** `shared/strategy`, `web/src/planner`, planner UI. No forced server/schema change.

---

## 1. Purpose

Turn the planner from a **geometry visualiser** into a **decision engine**.

Today the planner can *draw* where a ball might go (dispersion ellipse), *measure* how far
offline trouble is (corridor gates), and *adjust* distance for wind and elevation. What it
cannot do is answer the only question a player actually has: **"where should I aim to shoot
the lowest score?"**

DECADE (Scott Fawcett's course-management system) is the reference answer to that question.
Its value is not more geometry — it is a **decision framework layered on a statistical
baseline**. We already built the geometry half. This plan builds the missing scoring half.

## 2. The core insight (the "thinking")

DECADE's whole method reduces to one loop:

1. Know the **expected strokes to hole out** from any distance + lie (a published statistical baseline).
2. Model **where the ball could actually go** (a dispersion pattern — the "shot cone").
3. **Aim so the expected score of that pattern is minimised** — which in practice means
   *aim off the trouble* (bias away from hazards / short-side), and *default to the fat side
   / centre of green* unless conditions justify attacking the pin.

We already have step 2 (`dispersionEllipse`, `corridor`, `wind`, `plays-like`, `club`). **We
have nothing for step 1, and therefore cannot do step 3.** Every existing overlay is
decoration until a shot outcome carries a *number*.

So the keystone is a single pure function:

```ts
shotsToHoleOut(distanceM, lie): number
```

Everything DECADE is famous for — aim-off-trouble, centre-green bias, green/yellow/red pin
lights, short-side avoidance, "leave your favourite number" — falls out of that one table
plus the dispersion model we already have.

## 3. Why this fits the codebase

- `shared/strategy` is already a **pure, zero-dep, tested, Swift-mirrored** math library. An
  expected-strokes table and an aim optimiser are the same shape as `club.ts` / `corridor.ts`
  and slot straight in.
- The geometry inputs already exist and are proven: `dispersionEllipse()`, `corridorWidth()`,
  `windEffect()`, `plays-like` segment stats.
- Several pieces are **built but unwired**, so part of the value is cheap plumbing, not new math:
  - `corridorWidth()` (hazard ray-casting) is not connected to real course-feature rings.
  - `PlanGate.source: 'manual' | 'computed'` exists in the schema but nothing generates computed gates.
  - `clubAdvice()` (front/centre/back) exists but is not surfaced in the panel UI.
- Lie classification has a working precedent: `analysis-tool.service.ts` `hitGreen()` already
  does topmost-smallest point-in-feature testing via `web/src/geo/bezier.ts`.

## 4. Key design decisions (lock before building)

### 4.1 Lie taxonomy
Course `FeatureType` (11 types, `web/src/draw/feature-palette.ts`) maps to a 7-value
strokes-gained `Lie`:

| FeatureType            | Lie        |
|------------------------|------------|
| `tee`, `fairway`       | `fairway`  |
| `green`                | `green`    |
| `semi_rough`, `rough`  | `rough`    |
| `deep_rough`           | `recovery` |
| `bunker`               | `sand`     |
| `water`, `water_creek`, `outside` | `penalty` |
| `path`                 | `fairway` (cart-path relief) |

### 4.2 Baseline data
Use the **publicly published scratch / PGA-Tour "shots to hole out" baseline** (Broadie,
*Every Shot Counts*), converted to meters. One shared constant.

**Player skill is already personalised by the player's own club carry + dispersion values** —
a wider-dispersion player automatically gets a worse expected score from the same aim. So we
do **not** need a per-player baseline table. This keeps the model simple and the data legal to
use (do not copy DECADE's proprietary tables or trademarked "light" branding — only the public
principles and public baseline data).

### 4.3 Purity boundary
`shared/strategy` must stay dependency-free, so it cannot read the web feature store. Mirroring
the existing `corridor.ts` contract, **the caller pre-flattens typed rings and passes them in**.
Web flattens via `bezier.ts` (`flattenRing` / `pointInGeometry`), exactly like `hitGreen()`.

### 4.4 Dispersion → probability
Treat club `dispersionM` (full lateral extent) as ~2σ. Expose a `sigmaScale` knob so this one
modelling assumption can be calibrated rather than hard-coded. This is the single most
sensitivity-prone parameter in the whole design.

### 4.5 Compute cadence
Expected-strokes / aim optimisation runs on **shot-place and drag-release only — never per drag
frame**. Per-frame stays pure geometry (the existing local-patch path). With bbox pre-reject,
~100 samples × ~15 aim candidates × point-in-ring is cheap off the hot loop.

### 4.6 Persistence
EV is **derived, not persisted** (compute client-side). No migration in the initial cut. Can
revisit if we later want server-side plan scoring.

## 5. Implementation phases

### Phase A — Expected-strokes core (shared, pure) ⭐ keystone
- New `shared/strategy/expected-strokes.ts`:
  ```ts
  export type Lie = 'tee' | 'fairway' | 'rough' | 'sand' | 'recovery' | 'green' | 'penalty';
  export function shotsToHoleOut(distanceM: number, lie: Lie): number;              // interpolated baseline
  export function strokesGained(fromM, fromLie, toM, toLie): number;
  ```
  Baseline arrays per lie, linear interpolation between anchors; `penalty` = +1 stroke + drop-back distance.
- New `shared/strategy/lie.ts`: `lieFromFeatureType(type: string): Lie` (table in 4.1; string-keyed to avoid a web dep).
- Export both from `index.ts`.
- Tests `expected-strokes.test.ts`: monotonic in distance; known anchors; `sand > rough > fairway` at equal distance; penalty adds ~1+.
- **No server/schema change.**

### Phase B — Aim optimiser (shared, pure)
- New `shared/strategy/aim.ts`:
  ```ts
  interface AimOptions {
    origin: Vec2; club: ClubSpec; targetBearingDeg: number;
    surfaces: FlatRing[];               // reuse corridor's FlatRing
    greenCenter: Vec2;
    windSpeedMps?; windDirectionDeg?; sweepDeg?; candidates?; samples?; sigmaScale?;
  }
  interface AimResult {
    bestBearingDeg: number;
    perCandidate: { bearingDeg; expectedStrokes; breakdown: Record<Lie, number> }[];
    breakdown: Record<Lie, number>;      // %lie at chosen aim → drives the lights
  }
  export function optimizeAim(o: AimOptions): AimResult;
  ```
  For each candidate bearing across ±sweep: build `dispersionEllipse()`, sample N points
  (2D Gaussian on the semi-axes / `sigmaScale`), classify each point's lie (topmost-smallest
  containing ring, else `rough` fallback), remaining = `‖pt→greenCenter‖`,
  `shotsToHoleOut(remaining, lie)`, average → EV; pick the minimum.
- Tests `aim.test.ts`: water left ⇒ best aim shifts right; symmetric field ⇒ aim ≈ pin;
  higher penalty share ⇒ higher EV.

### Phase C — Web wiring
- New `web/src/planner/lie-map.ts`: reads `ctx.features.store.items`, flattens once per hole,
  exposes `classifyLie(p)` + `hazardRings()` (reuse `pointInGeometry` / `outerRingArea`).
- `plan-overlay.ts` `buildHolePlan()`: add `expectedStrokes?` + `lieBreakdown?` to `PlanLeg`;
  fill via `optimizeAim` / `shotsToHoleOut`.
- Auto-gates: generate `source:'computed'` `PlanGate`s per leg from `corridorWidth()` +
  `hazardRings()`. Panel "Auto gates" button. (Flag already exists — this is the
  "compute instead of eyeball" wiring.)

### Phase D — UI
- Green/yellow/red chip per approach leg from `lieBreakdown` thresholds + short-side check →
  panel row + overlay tint.
- Ghost "recommended aim" marker on overlay; optional "apply" → writes shot/gate.
- Wire `clubAdvice()` front/centre/back into the shot-edit popover.

### Phase E — Tee planning (later, optional)
- Extend `suggestClubForHole` → pick tee club/aim maximising fairway-hit probability
  (Phase B breakdown) *and* leaving a full approach number.

## 6. Sequencing & dependencies

```
A ─┬─> B ─> C ─> D
   └────────^         (C also depends on A directly, for per-leg shotsToHoleOut)
                 E (optional, after B)
```
- **A unblocks everything** and ships + tests standalone (pure, no UI).
- D is cosmetic on top of C. E is optional.

## 7. Effort / value / risk (for cross-item evaluation)

| Phase | Effort | Value | Risk | Notes |
|-------|--------|-------|------|-------|
| A expected-strokes | S | **High** (keystone; unlocks all) | Low | Pure, fully testable in isolation |
| B aim optimiser | M | **High** (the signature DECADE move) | Med | σ-assumption sensitivity |
| C web wiring | M | High | Low–Med | Partly plumbing of existing math |
| D UI (lights/advice) | S–M | Med (most player-visible) | Low | Pure presentation on top of C |
| E tee planning | M | Med | Med | Nice-to-have; reuses B |

**Biggest risk:** the σ interpretation in Phase B (4.4). Mitigation: `sigmaScale` knob +
calibration against a couple of known holes.

**Why this is a strong candidate:** the expensive half (geometry, wind, dispersion, club
gapping) is already built and tested; this adds a small pure keystone (A) that converts all of
it into actual decisions, and a chunk of the remaining work is wiring code that already exists
but was never connected.

## 8. Open questions to resolve

1. `deep_rough → recovery` vs plain `rough`? (Default: `recovery`.)
2. Persist EV server-side or always derive client-side? (Default: derive; no migration.)
3. Baseline granularity — single scratch/Tour table, or a coarse skill tier? (Default: single;
   personalise via the player's own club dispersion.)
4. Penalty (water) drop model — nearest-point + 1, or a simpler flat penalty? (Affects A.)

## 9. Explicitly out of scope / non-goals
- Copying DECADE's proprietary strokes tables or trademarked "green/yellow/red light" branding
  (we use the public baseline and generic terminology).
- A full ballistics model (plays-like stays the simple placeholder rule; Phase 7 concern).
- Per-player baseline tables (personalisation comes from club carry/dispersion).
- Server-side plan scoring / storage (derive client-side for now).
