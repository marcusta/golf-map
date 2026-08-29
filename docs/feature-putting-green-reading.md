# Plan: Putting & Green Reading — break, pace, and a legal green book

**Status:** Phases A, B, D, E built 2026-07-07 (physics core `shared/strategy/putting/` +
bit-exact Swift mirror, DEM adapters web+iOS, planner green view + training loop, server
scan/calibration storage with QC-gated bias fit + agreement confidence, iOS spot-level
capture, competition toggle, green-read UI Tiers 1–3, ARKit corridor scan). Payload
contract: [reference/green-scan-payload.md](reference/green-scan-payload.md). Phase C
(§5.2 competition book) explicitly deferred. ARKit capture layer awaits on-course device
validation (Landeryd session, §9 Q2 calibration + real-scan QC rates).
**Date:** 2026-07-07
**Scope:** new `shared/strategy/putting/`, web planner green view, iOS ARKit capture + read UI, PDF green-book export (extends T19). Small schema addition (green scans / calibration samples).
**Related:**
- [decade-planner-strategy-engine.md](decade-planner-strategy-engine.md) — tee-to-green engine. Putting is the missing last segment of `shotsToHoleOut`'s reality.
- [feature-smart-caddy.md](feature-smart-caddy.md) — explicitly scoped caddy v1 as "tee-to-green only" (§10). This lifts that restriction.
- [feature-distances-yardages.md](feature-distances-yardages.md) — plays-like pattern reused here for putt pace.
- [delegation-briefs.md](delegation-briefs.md) — T17 (Swift strategy mirror) and T19 (yardage-book PDF) are direct dependencies/absorbers.
- `web/src/analysis` `computeSlopeGrid` — existing DEM slope sampling this builds on.

---

## 1. Purpose

Putting is roughly 40% of strokes and the engine currently stops at the green edge: the caddy
uses green slope to pick an *approach* target, then goes silent. This feature answers the two
questions a player asks standing over a putt:

1. **Where do I aim?** (break — an aim offset and a rendered path)
2. **How hard do I hit it?** (pace — a plays-like putt length adjusted for slope and stimp)

…and produces two deliverables from the same math:

- **Practice / friendly-round mode** — full-detail live reads plus a training loop that teaches
  the player to produce the read themselves.
- **Competition mode** — a rules-conforming printed green book (part of the T19 yardage book),
  because detailed reads are illegal in competition and the app must degrade gracefully, not
  tempt the user into a penalty.

## 2. The core insight (the "thinking")

Three ideas shape the design:

1. **One physics core, three data tiers.** The break/pace math is identical whether the surface
   comes from a phone LiDAR scan, the Lantmäteriet DEM, or a human slope estimate. Design the
   integrator against a `GreenSurface` interface and the data tiers become interchangeable —
   including the zero-data tier (manual Tour Read arithmetic), which works on any course on
   Earth.

2. **The phone LiDAR line-walk dodges the drift problem.** Scanning a whole green fails on
   VIO drift; scanning the *putt corridor* succeeds, because slope is tilt relative to gravity
   and roll/pitch are gravity-anchored in ARKit (~0.1°) no matter how far you walk. Yaw and
   position drift — the unbounded errors — don't affect a break read. A 5–10 m corridor pass
   is read-quality; a 40 m stitched green mesh is not.

3. **Practice mode passively surveys the course.** Every scanned putt is a fresh, dense,
   gravity-referenced ground-truth patch. Diffed against the DEM slope grid, scans accumulate
   into a per-green bias correction and confidence map — so practice rounds continuously
   improve the data that competition mode (the printed book) and the caddy's green-slope rules
   are built from. No dedicated surveying step, ever.

## 3. Physics core (lock before building)

All formulas below are first-order point-mass results; the constant `k` and the integrator's
rolling-resistance model get calibrated empirically (naive point-mass overestimates break
~2–3×; see §9 Q2).

### 3.1 Friction from stimp

Stimpmeter releases at v₀ ≈ 1.83 m/s; rollout distance S gives:

```
μ ≈ v₀² / (2·g·S) ≈ 0.56 / S_ft        (stimp 10 → μ ≈ 0.056)
```

### 3.2 Break (aim offset), first order

Cross-slope lateral acceleration is g·s (s = slope fraction); drift grows with time-on-green,
which grows with distance and green speed:

```
aimOffset ≈ k · s · D · S_ft            (linear in slope %, distance, stimp)
```

This is exactly the shape of the **Tour Read** formula (Ralph Bauer's system —
[Golf Digest](https://www.golfdigest.com/story/tour-read-putting-app-ralph-bauer-how-it-works-green-reading),
[tourreadgolf.com](https://tourreadgolf.com/)):

```
aim inches = (paces × 2 − 1) × slope%     calibrated at ~stimp 10,
                                          pace finishing ~1 ft past the hole
```

The `−1` captures that short putts spend proportionally less time in the slow high-curvature
phase. Stimp scaling: ~±10% break per stimp foot from the reference (linear, per §3.1–3.2).

### 3.3 Uphill/downhill → break multiplier

Grade m along the line changes effective deceleration a = g(μ ± m):

```
breakMultiplier = μ / (μ ∓ m)           (downhill −m: more break; uphill +m: less)
```

At stimp 10: 2% downhill → ×~1.55, 2% uphill → ×~0.74. A 2% downhill putt breaks like a flat
putt at stimp ~15 — the effect is comparable to several stimp feet and must never be dropped.

### 3.4 Uphill/downhill → pace (plays-like putt length)

Energy balance (friction loss + elevation gain):

```
playsLikeLength = D + Δh/μ_play = D + Δh · S_ft / 0.88
```

The plays-like surcharge runs on a CALIBRATED friction constant, 0.88, not the stimpmeter's
0.56. Pure Coulomb overstates what a struck putt costs to climb: the launch skid and
speed-dependent rolling losses raise the effective friction over the roll. 0.88 is fit to GSPro
readings at stimp 11 (8 cm rise → +1.0 m; 29 cm over 8 m → +3.6–3.7 m), valid to about 12 m and
32 cm of rise. `canStop` and `breakMultiplier` keep the physical 0.56: whether the ball can stop
is lag-speed stimpmeter physics.

At stimp 10, ~11× the elevation change (10 m putt rising 0.3 m plays ~13.4 m). Degenerate
case: as Δh/μ → −D the ball barely stops; beyond it the putt cannot be stopped near the hole —
surface this explicitly ("can't stop this one — lag to the low side").

### 3.5 Capture speed

Target finish ~30–45 cm past the hole on flat/uphill; die it at the hole on quick downhillers
(effective capture width shrinks with arrival speed). The integrator's objective: choose
(aim bearing, initial speed) maximizing holed probability with a lag-distance penalty — same
EV framing as `aim.ts`, one dimension smaller.

### 3.6 Exact tier — rolling-ball integrator

Penner-style ODE on the surface height field: gravity along −∇h, rolling resistance μ·g
opposing velocity, integrate until rest or capture. Handles double-breakers and anything the
linear formula can't. Deterministic (Halton, per D14) if probabilistic pace/aim spread is
added later. Lives in `shared/strategy/putting/` — pure, zero-dep, Swift-mirrorable (T17).

## 4. Data tiers (the "use LiDAR when possible, fall back" ladder)

| Tier | Source | When | Quality |
|---|---|---|---|
| 1 | **Phone LiDAR corridor scan** (iPhone Pro, ARKit) | on-course, device has LiDAR | best: fresh, dense, ~0.1–0.2% slope |
| 2 | **Lantmäteriet DEM slope grid** (`computeSlopeGrid`), bias-corrected by accumulated Tier-1/IMU data | planner (web) always; iOS without a scan | good macro, weak micro (1–2 pt/m², ~5 cm noise); confidence varies per green |
| 3 | **Manual Tour Read** — user paces the putt and estimates slope %; app does §3.2–3.4 arithmetic | no LiDAR, no DEM coverage, any course | as good as the user's slope read — which is the skill practice mode trains |

Precision budget for a trustworthy read: **0.2–0.5% slope** (0.2° tilt = 0.35% slope = a
flipped read on a subtle putt). Tier 1 clears it; Tier 2 clears it only where confidence says
so; Tier 3 is honest about being an estimate.

### 4.1 Tier 1 — LiDAR line-walk design

- **Corridor, not line.** The ball's path bows toward the high side (up to ~1 m on a 3%
  slider). Scan a ~2 m corridor biased to the high side; from ~1 m hold height the useful
  footprint is a 2–3 m radius patch (ARKit depth error ~1% of range; grazing angles beyond
  that are noise). If the simulated path exits the scanned corridor, prompt to widen.
- **Walk beside the line** (etiquette = physics: don't dent the surface being measured).
- **Anchor the ends:** aim the on-screen crosshair at the ball / the hole and tap — the LiDAR
  hit under the crosshair is the endpoint, so the player stands normally instead of holding the
  phone over the spot. Only the horizontal position matters (`prepareCorridor` re-levels height
  from the ground points near the ball).
- **Optional endpoint levels:** phone set flat on the green at ball and hole for ~1 s each — two
  static IMU level readings bracketing the scan, a drift check for free. **Skippable**: they
  produce `endpointLevelDeltaPct` (a cross-check) and a calibration sample, and feed neither the
  read nor the verdict. Skipped ⇒ payload carries fewer than two `endpointLevels` and the delta
  is omitted.
- **Out-and-back is the quality gate:** walk to the hole and back; pass-to-pass mismatch is a
  direct error estimate → confidence score. Green = show read; yellow = suggest re-scan;
  red = refuse ("read it yourself"). **Never show a confident read from a bad scan.**
- **Self-sufficient:** the read runs on the scanned patch alone, no DEM required.

### 4.2 Tier 1 → Tier 2 feedback (scans improve the DEM)

Each accepted scan (and each standalone IMU spot-level — phone laid flat at a point of
interest, ~0.1° truth) is stored as a calibration sample against the green's DEM grid:

- per-green **bias correction** (low-frequency tilt/offset fit between scan patches and grid)
- per-green **confidence map** (agreement statistics; unsampled greens inherit a prior from
  DEM vintage/point density)

Confidence feeds three consumers: Tier-2 read gating on iOS, the caddy's existing
`green-slope-half` rule (low confidence → soften advice), and the competition book (flag
low-confidence greens rather than print false precision).

## 5. Two modes

### 5.1 Practice / friendly rounds (full detail)

- Live read: rendered break path on the green view, aim point ("14 in left edge"), plays-like
  pace, per §3. Tour Read verbal form is always shown alongside the exact tier — it's the
  on-course takeaway and a sanity cross-check (large disagreement on a single-plane putt ⇒
  grid problem).
- **Training loop (first-class, not incidental):** before revealing, the app asks for the
  user's estimate (slope %, aim, pace), then scores it and tracks estimation accuracy over
  time. Slope-% estimation is precisely the skill that remains legal in competition; the
  accuracy trend sits naturally next to strokes-gained putting (T14 UI).

### 5.2 Competition (legal green book)

- PDF green pages inside the green-reading-materials limits (2019 interpretation of Rule
  4.3a): map scale capped at 3/8 in : 5 yd (~1:480), pocket book ≤ ~4¼ × 7 in, no detail
  beyond what that scale carries. Coarse fall-line arrows + slope % numbers at that scale —
  what commercial green books ship legally. Encode the limits as named constants with a
  source link; **verify exact numbers against the current USGA/R&A interpretation text when
  building** (§9 Q5).
- Delivered as a section of the **T19 yardage-book export** — one brief covers both.
- **App-level competition toggle on iOS**, not a putting-only switch: it must gate live reads
  *and* slope-adjusted plays-like distances (DMD local rule allows distance only; slope
  functions must be off).

## 6. Architecture

```
shared/strategy/putting/
  green-surface.ts   — GreenSurface interface (heightAt/slopeAt + confidence), 3 adapters
  putt.ts            — ODE integrator: (surface, ball, hole, stimp) → {aimOffset, path, pace, holedProb}
  tour-read.ts       — closed-form §3.2–3.4: (paces, slope%, stimp, Δh) → {aimInches, playsLike}
                       (also the Tier-3 mode and the verbal formatter)
web/src/planner/     — green view overlay: break paths, fall-line field, training quiz
web/src/reports/     — legal green-book pages (extends T19 engine)
server/              — green_scans / calibration samples tables + confidence endpoint
ios/                 — ARKit corridor capture, gravity-framed surface fit, read UI,
                       competition toggle; consumes T17 Swift mirror of putting/
```

## 7. Implementation phases

- **Phase A — physics core (shared, pure)** ⭐ keystone: `tour-read.ts` + `putt.ts` +
  `green-surface.ts`, golden-putt tests (flat, single-plane at 3 stimps, up/down, double-break,
  can't-stop downhill). DEM adapter over `computeSlopeGrid`. Ships value in the web planner
  immediately (Tier 2).
- **Phase B — web green view + training loop.** Break rendering, quiz, accuracy tracking.
- **Phase C — competition book.** Legal-limit constants, green pages in T19 export.
- **Phase D — iOS Tier 3 + IMU spot-level.** Manual Tour Read mode (works everywhere), phone-
  as-level calibration samples, competition toggle. Needs T17 for the exact tier; Tier 3 is
  closed-form and can ship before T17.
- **Phase E — iOS LiDAR corridor scan.** ARKit capture, out-and-back QC, scan→DEM calibration
  pipeline. Largest unknowns; everything before it is independently valuable.

## 8. Effort / value / risk

- **Value:** putting is ~40% of strokes and currently unserved; best asset-to-value ratio in
  the backlog (DEM, `computeSlopeGrid`, green rendering, report engine all exist).
- **Effort:** A–C moderate (mostly geometry + one ODE + report pages). D small. E is the real
  project (ARKit pipeline + calibration store).
- **Risk:** Tier-2 data quality on subtle greens (mitigated by confidence gating + Tier-1
  feedback loop); calibration constant k (mitigated by golden-putt validation on a known
  green); ARKit surface fit on grass texture (Phase E only, prototype early).

## 9. Open questions to resolve

1. **Stimp source:** manual per-round entry (like wind today)? Course default + seasonal
   estimate? Could be inferred from scanned-putt outcomes later.
2. **Calibration constant k / rolling model:** validate integrator + closed form against
   measured putts on a real green (Landeryd practice green session with a level and a chalk
   line — cheap and decisive).
3. **Lantmäteriet vintage & density per green:** check actual scan year and pt/m² over
   Landeryd greens; sets the Tier-2 confidence prior.
4. **Corridor surface fit:** mesh vs. low-order polynomial patch vs. thin-plate spline —
   prototype in Phase E, judge by out-and-back residuals.
5. **Legal limits:** confirm current Rule 4.3a interpretation numbers (scale, book size,
   electronic display equivalence) before Phase C ships.
6. **Where does holed-probability feed back into `shotsToHoleOut`?** A personal putting curve
   is part of the personal expected-strokes surface work — coordinate with that spec so the
   two don't define competing green models.

## 10. Explicitly out of scope / non-goals

- **Full-green LiDAR scanning** — fails the drift budget; the corridor walk is the design.
- **Grain reading, wind on putts, dew/moisture** — real effects, not modeled in v1.
- **Automatic stimp measurement** — v1 takes stimp as input (§9 Q1).
- **In-competition live assistance of any kind** — competition mode exists precisely to make
  the app safe to have in the bag.
- **Survey-grade (RTK GNSS) capture** — noted as the calibration backstop if Tier-1 data ever
  disputes the DEM systematically; not built.
