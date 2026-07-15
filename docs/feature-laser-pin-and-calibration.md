# Plan: Laser Input — Pin Placement & GPS Origin Calibration

**Status:** designed 2026-07-14 (spec locked; implementation not yet delegated)
**Scope:** `ios` only (voice input, pin solve, origin correction). No server/schema change in
phase 1; phase 2 has one optional additive furniture ask (anchors). Geometry is iOS-local and
deliberately **not** parity-pinned to TS (no web counterpart consumes it — revisit if the web
planner grows a live mode).
**Related:**
- [feature-distances-yardages.md](feature-distances-yardages.md) — the distance card this feeds.
- [feature-shot-capture.md](feature-shot-capture.md) — same "cheap capture in the moment" design
  philosophy; a corrected origin also improves captured shot positions (free synergy, phase 2).

---

## 1. Purpose

On course the player carries a laser rangefinder and gets **exact** distances — mostly to the
pin, sometimes to fixed features ("the back bunker lip", "the tree", "the water bank"). GPS is
only good to a few metres. Two distinct problems, phased:

- **Phase 1 — place the pin.** Fast (voice-first) input of where today's pin actually is, from a
  pin sheet, a laser shot, or a visual estimate. The placed pin feeds the existing
  `activePin` → `OnCourseDistances.compute` path; pin distance, plays-like-pin and pin club all
  update with zero downstream change.
- **Phase 2 — correct the origin.** Laser shots at *fixed, mapped* features (or standing on a
  known point) solve the GPS bias vector. Applied as an additive correction to the raw fix,
  **every** distance on the card improves — bunker carries, front/centre/back, layups — not just
  the pin.

Ordering matters: pin depth is solved from a distance circle centred on the origin, so a
corrected origin (phase 2) makes phase 1's laser-depth mode more accurate. Phase 1 is still
useful standalone: raw GPS + a laser to the pin beats the pure map guess.

## 2. GPS error model (why calibration is reusable at all)

Phone GPS error decomposes into two components with very different lifetimes:

| Component | Cause | Lifetime | Spatial reach | Magnitude |
|---|---|---|---|---|
| **Common-mode bias** | ionosphere/troposphere delay, satellite clock/ephemeris | ~5–15 min | correlated across the whole course | ~2–4 m |
| **Multipath / shadowing** | reflections off trees, terrain, buildings; body blocking satellites | seconds; jumps on constellation change or canopy entry | local to the spot and posture | 0 – many m near trees |

Calibration captures the **bias** and can be reused for minutes and across the hole. The
multipath part cannot be calibrated away — the design must therefore *revalidate continuously
and degrade honestly* rather than trust a solved bias blindly. Near dense canopy the corrected
number may still drift; the residual gate (§6.4) catches this and prompts a re-shoot instead of
lying.

## 3. Core geometry: the green-local frame (`GreenFrame`)

All pin inputs collapse into one representation once each green has a local 2D frame:

- **Depth axis** — the tee→green-centre bearing (line of play), unit vector in EPSG:3006.
- **Lateral axis** — perpendicular to depth (positive = right, from the player's view).
- **Origin** — the green polygon's front-most point along the depth axis.

Built from `GreenPolygonStore.GreenPolygon.rings` (already in EPSG:3006) + the hole's primary
tee. The frame precomputes:

- `depthM` — extent front→back along the depth axis.
- `widthAt(depth)` — lateral extents (left edge, right edge) of the polygon cross-section at a
  given depth. Implemented as the intersection of the outer ring with the lateral line at that
  depth (a green is convex enough in practice; take the min/max intersection pair, ignore
  interior holes).
- `point(depth:lateralFraction:)` — depth in metres from front + lateral position as a fraction
  of that cross-section's width (0 = left edge, 0.5 = middle, 1 = right edge) → EPSG:3006 →
  WGS84.

`GreenFrame` is a pure value type; unit-testable with synthetic polygons (rectangle, kidney
shape) and exact expected coordinates.

### 3.1 Pin input unification

| Input mode | Depth from | Lateral from |
|---|---|---|
| **Pin sheet** — "pin 4 from front, 5 from left" | sheet number | sheet number (metres from left edge at that depth) |
| **Laser + side word** — laser says 143, say "right" | distance-circle solve (§3.2) | side word → fraction |
| **Visual** — "close to back, far left" | discrete depth word → fraction of `depthM` | discrete word → fraction |

Discrete word → fraction mapping (both axes): `front/left = 0.15`, `middle = 0.5`,
`back/right = 0.85`; modifiers `far/close to` push to `0.05 / 0.95`. Exact values are
constants in one place — tune later, don't bikeshed now.

```swift
struct PinSpec {
    enum Source { case sheet, laser, visual }
    var depthFromFrontM: Double        // resolved depth
    var lateralFraction: Double        // 0 = left edge … 1 = right edge
    var source: Source
}
```

### 3.2 Laser-depth solve

The player lasers the pin: `d` metres from the (corrected) origin. The pin lies on
`circle(origin, d) ∩ green`. Because a green is ~25–35 m deep but sits 60–200 m away, that
intersection is a short arc nearly **perpendicular to the line of play** — i.e. the laser
distance almost purely determines **depth**, the axis that is hardest to eyeball and most
valuable. Lateral comes from the spoken side word.

Solve: walk the depth axis, find the depth `t` where
`|origin − frame.point(depth: t, lateralFraction: f)| = d` (monotone in `t` for any realistic
approach angle; bisection over `[0, depthM]`). Use the side-word fraction `f` during the solve
so the small lateral-induced distance skew is accounted for.

Degenerate cases:
- `d` shorter than distance-to-front or longer than distance-to-back → clamp to front/back edge
  and flag the mismatch in the confirm UI ("laser says 143 but green spans 138–151 — check
  origin?"). A large mismatch is itself a signal the GPS origin is off → suggest calibration.
- Sharply oblique approach (frame axis nearly parallel to the sight line never happens for a
  green being approached, so no special handling).

### 3.3 What updates, what doesn't

The placed pin becomes the hole's `activePin` override. `OnCourseDistances.compute` already
takes `targets.activePin` — pin metres, `playsLikePin`, `windPlaysLikePin` and `pinClub` all
recompute with **no change** to that function. Front/centre/back are green geometry and are
untouched by pin placement (they *are* affected by phase 2 origin correction, which is the
point).

## 4. Voice input

### 4.1 Recognition — on-device, no LLM in the hot path

Competition reality: offline, gloved, time-boxed. So:

- `SFSpeechRecognizer` with `requiresOnDeviceRecognition = true`; locale from a new setting
  (`sv-SE` / `en-US`), stored like the existing per-course defaults.
- Recognised text → a **hand-written token grammar** (not an LLM): deterministic, offline,
  ~200 lines, trivially unit-tested. An LLM fallback for weird phrasings is a possible later
  nicety, never a dependency.
- Every parse ends at a **confirm UI**: the pin rendered on the green, draggable, with the
  parsed interpretation echoed ("4 m from front · 5 m from left"). Commit is one tap. A misparse
  is a drag-fix, never a silent wrong distance.

### 4.2 Grammar (both languages, one grammar)

Token classes: `NUMBER` (digits or number words, sv+en), `UNIT` (`m|meter|meters`), `FROM`
(`from|från`), `EDGE` (`front|fronten|framkant`, `back|bak|bakkant`, `left|vänster`,
`right|höger`), `POSITION` (`middle|mitten|center|mitt`), `MODIFIER`
(`far|långt|close to|nära`), `PIN` (`pin|flagga|flaggan|hål`).

Accepted shapes (examples):

| Utterance | Parsed |
|---|---|
| "pin is 4 from front, 5 from left" | sheet: depth 4, lateral 5 m from left |
| "flaggan 6 från framkant, mitten höger" | sheet depth 6, lateral = right-of-middle fraction |
| "one forty three, right" / "hundratrettionio, vänster" | laser 143 m / 139 m + side word |
| "close to back, far left" / "nära bak, långt vänster" | visual: depth 0.95, lateral 0.05 |

Rules of thumb baked into the parser:
- Two `NUMBER FROM EDGE` clauses → sheet mode.
- One bare large number (> green depth, i.e. plausible laser distance) + optional side word →
  laser mode. If a Bluetooth-connected rangefinder ever lands, the number arrives digitally and
  only the side word is spoken.
- No numbers, only position words → visual mode.
- Ambiguity → don't guess: show both interpretations in the confirm UI, tap to pick.

Parser is a pure function `parsePinPhrase(text, locale) -> PinPhrase?` — golden-tested with a
table of utterances per language.

## 5. Phase 1 — implementation map

New files:
- `ios/GolfMap/Analysis/GreenFrame.swift` — frame build + `point(depth:lateralFraction:)` +
  laser-depth bisection solve. Pure geometry, built on `GreenPolygonStore`.
- `ios/GolfMap/Screens/PinPlacement.swift` — `PinSpec`, discrete-word fractions, solve
  orchestration (spec + frame + origin → WGS84 pin).
- `ios/GolfMap/Voice/PinPhraseParser.swift` — grammar; `ios/GolfMap/Voice/VoiceCapture.swift` —
  `SFSpeechRecognizer` wrapper (locale setting, on-device flag, permission flow).

Touched:
- `ios/GolfMap/Screens/OnCourseModel.swift` — `pinOverrides: [holeId: LatLon]`, persisted per
  course+date using the `teeOverrides` key pattern (a pin is valid for *today*; key includes a
  date stamp so yesterday's pin doesn't leak into today's round). `activePin` resolution order:
  override → furniture pin → green centre.
- Card UI — a pin chip showing source (`sheet/laser/visual`) + a mic button; long-press pin to
  clear override.

Persistence: `UserDefaults` like tee overrides — no schema, no sync. Pins are ephemeral daily
facts, not course data.

Tests: `GreenFrameTests` (synthetic polygons, exact coordinates), `PinPhraseParserTests`
(utterance goldens sv+en), `OnCourseModelTests` additions (override resolution order, date
expiry).

**Competition mode:** rangefinders are legal under the standard local rule; entering a laser
distance and placing a pin is fine. The existing `competitionMode` gating of slope/wind advice
is untouched and automatically applies to the new pin (no plays-like leak).

## 6. Phase 2 — origin calibration (`OriginCalibration`)

### 6.1 The value

One solved bias vector, applied additively to every raw GPS fix:

```swift
struct OriginCalibration {
    var biasE: Double            // EPSG:3006 metres, add to raw fix
    var biasN: Double
    var solvedAt: Date
    var solvedNear: LatLon       // where the calibration was taken
    var confidence: Double       // 0…1, decays (§6.4)
    var method: Method           // .anchor | .trilateration | .residualRefresh
}
```

Applied in `OnCourseModel` where `origin` is derived from the live fix, *before*
`OnCourseDistances.compute` — one insertion point, everything downstream (f/c/b, carries,
layups, plan distances, shot capture positions) inherits the correction.

### 6.2 Input method A — "I am here" (anchor)

Stand on a mapped point, tap, hold still. Raw GPS (averaged over ~2–3 s to wash out jitter) vs
the anchor's known coordinate = the bias vector directly. **One action solves full 2D** — the
gold standard.

Anchor quality ranking (weights the confidence):
- **Best:** sprinkler heads, yardage plates, 150/100 markers — static and surveyed.
- **OK:** distinct bunker corner, path junction — mapped from ortho, ~1 m class.
- **Weak:** tee markers (moved daily within the box), "green centre" (a concept, not a spot).

Data ask (the one schema-adjacent item): an `anchor` furniture type (point + label + quality
tier) authored in the web editor, delivered in the bundle like pins/aims. **Fallback for MVP:**
any existing point feature the user taps on the map is usable as an ad-hoc anchor with `OK`
quality — no schema change required to ship.

UX: "Calibrate" → map shows nearby anchor candidates → tap the one you're standing on → hold
still, progress ring, done. Calibrate from open sky; the UI warns if `CLLocation`
`horizontalAccuracy` is poor (canopy multipath would be baked into the bias).

### 6.3 Input method B — laser trilateration

From wherever you are (typically the tee), laser **2–3 non-collinear fixed features**. Each
shot constrains position along one bearing (1D); the GPS offset is 2D, hence ≥2 shots with
angular spread. Least-squares over residuals
`r_i = |truePos − feature_i| − laserDist_i`, solved for the 2D position delta
(Gauss–Newton, 2 unknowns, converges in a few iterations; seed at the raw fix). Angular spread
< ~25° → refuse to solve along the weak axis (report the well-constrained component only, low
confidence).

Target selection UX: tap the feature on the map (bunker, tree, hazard bank — anything with a
mapped point/edge) → speak or type the laser number → repeat → solve. The map already renders
all of these; picking is one tap each.

### 6.4 Revalidation, decay, invalidation

The player lasers fixed things all round anyway — every such shot is a **free residual check**
against the current calibration:

- `|residual| ≤ ~2 m` → calibration confirmed; refresh `solvedAt` silently
  (`method: .residualRefresh`).
- `|residual|` large → mark stale, badge the card ("distances uncalibrated"), prompt a
  re-shoot or anchor tap.

Confidence decay (multiplicative factors, all constants in one place):
- **Age:** full trust < 5 min, linear decay to zero at ~15 min.
- **Distance from `solvedNear`:** mild — bias is course-wide; halve confidence beyond ~500 m.
- **Discrete GPS jump** (fix moves >> speed × Δt) or `horizontalAccuracy` degradation (canopy
  entry): drop to stale immediately.

Below a confidence floor the correction is **not applied** (raw GPS, badge shown) — a stale
correction is worse than none because it *looks* authoritative.

### 6.5 Interplay with phase 1

Pin laser-depth solve (§3.2) uses the corrected origin when calibration is live. The resulting
workflow — the whole point of the feature:

1. Tee box: anchor tap **or** 2–3 laser shots → bias solved.
2. Rest of hole: bunker carries, f/c/b, layups all corrected — no more lasering them.
3. Pin: one laser for depth (it moves daily) + a side word.
4. Any fixed shot taken anyway keeps the calibration honest for free.

### 6.6 Phase 2 implementation map

New: `ios/GolfMap/Calibration/OriginCalibration.swift` (model + decay),
`ios/GolfMap/Calibration/Trilateration.swift` (least-squares, pure function),
`ios/GolfMap/Calibration/AnchorCalibrator.swift` (fix averaging + anchor diff).
Touched: `OnCourseModel` (apply correction at origin derivation; stale badge state), card UI
(calibration chip: fresh/decaying/stale), map (anchor candidates + feature-pick mode).
Optional server/pipeline: `anchor` furniture type end-to-end (editor → bundle → iOS models).

Tests: trilateration goldens (synthetic geometry with known bias, incl. the collinear
degenerate), decay table tests, fix-averaging tests, residual-gate state machine tests.

## 7. Decisions locked by this spec

- **L1** — Pin inputs unify in a green-local frame (depth from front along tee→centre bearing;
  lateral as width fraction); three input modes (sheet / laser+side / visual) produce one
  `PinSpec`.
- **L2** — Voice parsing is a deterministic on-device grammar, sv+en, locale from a setting; an
  LLM is never in the hot path. Every parse passes a draggable confirm UI before commit.
- **L3** — Pin overrides are ephemeral per-day `UserDefaults` state, not course data. No schema
  change in phase 1.
- **L4** — GPS correction is a single additive 2D bias in EPSG:3006, solved by anchor or
  trilateration, continuously revalidated by opportunistic residuals, and **dropped** (not
  degraded silently) below a confidence floor.
- **L5** — Phase order: pin placement ships first; calibration second; anchor furniture type is
  optional and never blocks either phase.
- **L6** — None of this geometry is parity-pinned to TS; it is iOS-local. Revisit only if the
  web planner grows a live on-course mode.

## 8. Open questions (decide at implementation kickoff)

1. Discrete word → fraction constants (0.15/0.5/0.85, modifiers 0.05/0.95) — tune on-course.
2. Residual gate threshold (±2 m?) and decay window (5→15 min?) — validate against real rounds.
3. Whether the pin override should also nudge the green-analysis view's default pin (probably
   yes, cheap).
4. Bluetooth rangefinder integration (some models expose GATT) — would remove the spoken number
   entirely; out of scope, keep the parser's "digital distance + spoken side word" seam.
