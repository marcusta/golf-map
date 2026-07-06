# Plan: Shot Capture, Strokes-Gained Analytics & Dispersion Calibration

**Status:** designed 2026-07-06 (schema + fitting spec locked; implementation delegated — see
[delegation-briefs.md](delegation-briefs.md))
**Scope:** `server` (additive migration + rounds API extension), `ios` (capture UI), `web`
(follow-up analytics), one server-side fitting job. Builds on the existing `rounds` / `shots`
tables — this is an extension, not a new subsystem.
**Related:**
- [decades-planner engine](decade-planner-strategy-engine.md) — supplies `shotsToHoleOut` (built:
  `shared/strategy/expected-strokes.ts`), which SG analytics consume.
- [decision register](decisions-strategy-2026-07-06.md) — D13 (σ semantics) and D19 (baseline
  verification) directly constrain this feature.

---

## 1. Purpose — close the loop

Every strategy feature personalises through the player's club carry + dispersion, and today those
numbers are **hand-entered guesses**. Recording where shots were actually played from gives us,
in value order:

1. **Fitted per-club dispersion** — replaces the σ guess with data; the whole aim engine gets
   better without any engine change (fitted values slot into the same `ClubSpec`).
2. **Strokes-gained analytics** — "you lose 2.1 strokes/round from 120–160 m" — the
   practice-prioritisation feature, nearly free once `shotsToHoleOut` exists (it does).
3. **Plan-vs-actual review** — plans are persisted, rounds are persisted; the diff measures
   discipline separately from skill.

## 2. Recording convention (the one rule everything hangs on)

**A shot row = one stroke, recorded at the position it was played FROM.** The landing position of
stroke *i* is the position of stroke *i+1*; the last stroke on a hole lands in the cup. Penalties
are not rows: stroke *i* carries `penalty_strokes ≥ 0` (strokes added as a consequence of that
stroke — OB, water, unplayable). A re-tee after OB is simply the next row from (near) the same
spot with `penalty_strokes = 1` on the previous row.

This convention makes SG a pure fold over the ordered rows and needs no "drop event" modelling.

## 3. Schema (additive migration, no breaking change)

```
rounds  + game_plan_id      TEXT NULL     -- plan-vs-actual link
        + wind_speed_mps    REAL NULL     -- round-level conditions snapshot
        + wind_direction_deg REAL NULL    -- (per-hole overrides: later, if data shows drift)

shots   + shot_type         TEXT NOT NULL DEFAULT 'full'
                                          -- 'full' | 'partial' | 'putt' | 'recovery'
        + target_lat        REAL NULL     -- intended target, captured at address
        + target_lon        REAL NULL
        + penalty_strokes   INTEGER NOT NULL DEFAULT 0
```

Rationale:
- **`target_lat/lon` is the schema decision that matters.** Dispersion fitting must rotate
  landings into the intended-line frame; without the intended target, the frame is guessed and
  the lateral/length split is garbage. Capture defaults it silently (pin/green-centre or the
  plan's aim for that leg) — the player only adjusts it when they aimed somewhere unusual, so the
  cost at capture time is zero taps in the common case.
- **`shot_type` gates fitting, not SG.** Only `'full'` swings enter dispersion fitting.
  `'partial'` (knock-downs, wedge-distance feel shots), `'recovery'` (punch-outs) and `'putt'`
  are SG-relevant but would poison the ellipse. Auto-defaulted: `putt` when the address point is
  on the green polygon, `full` otherwise — one picker tap only for the exceptions.
- **`lie` stays the existing nullable column** = user override. Derived lie comes from geometry
  (`lieFromFeatureType` + point-in-feature, same classification the aim engine uses) and is
  computed, not stored.
- Existing rows remain valid (`shot_type` defaults, penalties default 0).

## 4. Capture UX (iOS, one-hand on-course)

- One tap per stroke: crosshair starts at GPS fix, drag to adjust; club pre-selected via
  `closestClub(clubs, remaining-to-pin)`; shot_type auto per §3; target pre-filled with pin /
  plan aim. Confirm = one tap. Hole-out = one tap (writes the final putt with distance 0 next
  position).
- Everything is editable after the round on the web (the existing `updateShot` API already
  covers position/club/lie; extend for the new fields).
- Offline-first: capture queues locally, syncs when connectivity returns (iOS app already plans
  offline course bundles; shots join that sync queue).

## 5. Strokes-gained computation (server or web, pure)

For ordered strokes `i = 0..n−1` on a hole (positions `p_i`, hole position `h` = pin if a pin is
recorded for the round's date, else green centre):

```
d_i   = ‖p_i → h‖            (planar, after wgs84→SWEREF99TM projection)
lie_i = override ?? classifyLie(p_i)    (first stroke of the hole: 'tee')
sg_i  = shotsToHoleOut(d_i, lie_i) − shotsToHoleOut(d_{i+1}, lie_{i+1}) − 1 − penalty_strokes_i
```

with `shotsToHoleOut(d_n, ·) = 0` (holed). Categories: **off-tee** (stroke 0, par 4/5),
**approach** (`full`/`partial`, `d_i ≥ 30 m`), **short** (< 30 m, not a putt), **putting**.
Aggregate per round / per category / per distance band; the distance-band table is the headline
analytics view. Blocked on decision **D19** (baseline verification) before user-facing display —
aim decisions tolerate ±0.03 strokes of table error, per-shot SG reporting does not.

## 6. Dispersion fitting (the calibration spec)

Server-side job (or on-demand endpoint), per player per club:

**Sample set.** Shots with `shot_type = 'full'`, a club, a landing (next stroke's position), and
a target (recorded or defaulted). Exclude nothing else — **mishits are real dispersion**
(DECADE's core premise); trim only data errors: landing implying carry > 1.3 × hand-entered
carry, or beyond 4 robust σ (GPS glitches, wrong-club entries).

**Frame.** Bearing θ = origin→target. Offsets: `a` = along-line component of (landing − origin),
`c` = across-line component (shot-right positive).

**Condition back-out** (all via existing `shared/strategy` functions, so web/iOS/server agree):
1. Wind (round snapshot): `a′ = a / (1 + windEffect(speed, dir, θ))`;
   `c′ = c − crosswindDriftM(club.carryM, crosswindMph(θ))`.
2. Elevation (DEM, via the distances feature's `sampleElevations`):
   `a″ = a′ · (1 + slope)` — inverse of the ellipse's ground-slope projection, so fitted carry is
   the AIR carry, matching what `ClubSpec.carryM` means.

**Robust estimates.** `carry^ = median(a″)`; `σ_along = 1.4826·MAD(a″)`;
`σ_across = 1.4826·MAD(c′)`. Median/MAD, not mean/stddev — fat-tailed golf data, and we keep
mishits in.

**Shrinkage toward the hand-entered prior** (small-n safety; prior weight `k = 8` shots):

```
carry_post = (k·carry₀ + n·carry^) / (k + n)
σ²_post    = (k·σ₀² + n·σ^²) / (k + n)
```

where the priors come from the hand-entered values via D13: `σ₀_across = dispersionM / (2·2)`,
`σ₀_along = lengthDispersionM(carryM) / (2·2)` (semi-axis ÷ sigmaScale). Five recorded drives
therefore nudge, never replace, the player's stated numbers; 40+ shots dominate them.

**Output.** Convert back to `ClubSpec` units: `carryM = carry_post`,
`dispersionM = 2 · 2 · σ_across,post` (full extent = 2 · sigmaScale · σ). Present as a suggestion
("based on 23 shots — apply?") next to the manual value; applying writes the ordinary club
record. **The strategy engine never changes** — calibration flows through the same two numbers
it already consumes.

## 7. Plan-vs-actual (consumes the above, no new math)

Join `rounds.game_plan_id` → plan legs by hole. Per leg: planned aim/club vs actual target/club
(discipline), planned landing region vs actual landing (execution), planned EV vs realised SG
(outcome). v1 is a per-hole table + map overlay of planned ellipse vs actual points.

## 8. Non-goals / out of scope

- Automatic shot detection (watch sensors, swing detection) — manual tap is v1.
- Per-lie dispersion models (rough vs fairway σ) — one model per club until data volume justifies
  splitting.
- Per-hole wind capture — round-level snapshot only (documented error source in fitting).
- Skill-tier baseline tables — unchanged from D3.

## 9. Phasing

| Phase | Deliverable | Depends on |
|-------|-------------|-----------|
| 1 | Migration + rounds API extension (§3) + gen-client regen | — |
| 2 | iOS capture UI (§4) + sync | 1 |
| 3 | SG computation + web follow-up analytics (§5) | 1, D19 verification |
| 4 | Dispersion fitting job + "apply suggestion" UI (§6) | 1, distances Phase 1 (elevations) |
| 5 | Plan-vs-actual view (§7) | 1–3 |
