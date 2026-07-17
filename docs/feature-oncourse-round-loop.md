# Plan: On-Course Round Loop — consume the plan, decide when it breaks, report as you go

**Status:** built 2026-07-17 — T31 `0e726b3d` (PlayingState + card modes), T33 `1389d97a`
(decide moment + can-you-carry-it), T34 `a88741c8` (capture drivetrain), T35 `d8f534a8` (green
handoff + per-round stimp), T36 `70620011` (contextual laser entry + residual refresh). T37 `86b7e5d3`
closed the review follow-ups: R4 fully met (authored options merge into decide, priced via the
single-shot aim path per O4), capture prefill follows the active line, DecideKey/laser-sheet
nits fixed. Remaining follow-ups: `parentShotId` in the iOS add-shot push (T37 finding 3,
deferred while the stimp session holds GolfAPIClient/PlanSync — see T37-report); server
`rounds.stimp_ft` sync and the `WebMercatorTiles.tilePixel` NaN fix (separate sessions). Briefs:
[delegation-briefs-oncourse.md](delegation-briefs-oncourse.md); reports in `docs/reports/`.
**Scope:** `ios` (orchestration + card UX over existing engines), small `shared/strategy`
dependency on [feature-plan-shot-options.md](feature-plan-shot-options.md). No schema change
beyond the options migration.
**Related:**
- [feature-plan-shot-options.md](feature-plan-shot-options.md) — authored alternatives this loop
  picks between (T28–T30 land first for the option parts; the loop itself does not block on them).
- [feature-shot-capture.md](feature-shot-capture.md) — capture exists (RoundModel/CaptureModel);
  this doc makes it the round's drivetrain.
- [feature-laser-pin-and-calibration.md](feature-laser-pin-and-calibration.md) — pin placement +
  origin calibration exist; §6.4's opportunistic residual refresh is built here (T36).
- [feature-putting-green-reading.md](feature-putting-green-reading.md) — putt read exists; this
  doc wires the handoff (auto green mode, pin override as hole position, stimp entry).
- [feature-smart-caddy.md](feature-smart-caddy.md) — the decide moment (§4) is the caddy's
  on-course debut; remaining rules get their Swift ports here.

---

## 1. Purpose

Everything the on-course app needs already exists as **tools you open** — plan overlay, capture,
putt read, pin entry, calibration, green view. Nothing follows the round. The player must be
their own orchestrator: open the right tool, find the right leg, aim the right recompute.

This feature adds the missing spine — a **playing state** advanced by shot capture — and turns
the bottom card into a context machine over it: *plan* (here's your shot), *decide* (plan broke,
here are your choices), *green* (here's your putt). The engines underneath do not change.

## 2. The core insight

1. **Capture is the drivetrain, not a reporting chore.** One tap at the ball both records the
   stroke (shot reporting) and advances the state that drives everything else (current leg, card
   context, replan origin). Reporting stops competing with playing — it *is* how you play.

2. **Replan-from-here beats authored plan-Bs.** When the ball isn't where the plan expected, the
   right answer comes from the actual position through the existing engine (lie → distances →
   layup enumeration → aim EV → caddy rules), not from a pre-authored branch. Authored options
   (the options doc) cover *known* decision points; the engine covers *everywhere else*. Both
   render through one decide UI.

3. **The laser is one input with contextual meaning.** A number spoken at a rangefinder is a pin
   depth, a calibration observation, or a carry check depending on what it was aimed at. One
   entry point that routes on context — plus every laser at a mapped feature silently
   revalidating the GPS bias — makes precision ambient instead of a chore.

## 3. PlayingState (the spine)

### R1 — Definition and advancement

```swift
struct PlayingState {
    var holeNumber: Int
    var strokeIndex: Int            // 0-based; next stroke to be played
    var ballPosition: LatLon?       // last captured position, else nil (on the tee)
    var lie: Lie                    // classified from ballPosition (tee for stroke 0)
    var activeLine: [PlanShot]?     // chosen option branch for this hole (round-scoped)
    var currentLeg: Int?            // index into activeLine matched from ballPosition
}
```

- Lives in `OnCourseModel`, derived from the active `RoundModel` round: hole = current hole,
  strokeIndex = captured strokes on that hole, ballPosition = last stroke's position.
- **Capture-driven first, GPS-assisted second.** Capturing a stroke advances the state
  authoritatively. Live GPS only *suggests*: crossing into the next hole's tee geofence prompts
  hole advance (R5); it never silently moves the state. No round active → PlayingState is nil
  and the card behaves exactly as today (zero regression surface).
- `currentLeg`: nearest planned landing (of the active line) within a divergence radius (R3);
  the leg *after* it is "your shot".

### R2 — The card is a context machine

Card mode = f(PlayingState):

- **plan** — a leg card leads: planned club, aim label, gate width at that leg, distance +
  plays-like to the planned landing, hole notes. Option chips when the current decision point has
  authored siblings (options doc §5); tapping sets `activeLine`. Today's F/C/B + pin block stays
  below — it is the trust anchor.
- **decide** — divergence detected (R3) or user taps "off plan": ranked choices (R4).
- **green** — ballPosition inside the green ring: putt-first card (R6).
- **tee preview** — on hole entry before any capture: one strip = plan summary for the hole
  (tee club, aim, the one hazard that matters, hole notes) + option chips.

No round → current card, unchanged. Competition mode gates what it gates today (club advice,
plays-like, reads); the card modes themselves are legal scaffolding.

### R3 — Divergence rule

Off-plan when the ball's distance to the nearest planned landing of the active line exceeds
`max(1.5 × club lateral dispersion semi-axis at that leg, 25 m)`, or when strokeIndex has passed
the planned shot count. Constants in one place, tuned on course. Divergence flips to *decide*; it
never edits the plan.

## 4. The decide moment (R4)

One ranked list, **max 3 choices**, assembled from:

1. **Authored options** at the current decision point (if any survive from here).
2. **Engine candidates** from the actual ball: layup enumeration (`Layup.swift`) + go-for-it
   (aim EV via `Aim.swift` with the classified lie) — the same trio shape as the par-5 rule
   (go / lay-up-to-number / lay-back).
3. **Caddy rules** rank and veto: `no-doubles` + `par5-attack` are already on iOS; port
   `take-your-medicine`, `short-side-guard`, `can-you-carry-it` (parity-pinned to the TS goldens
   like the rest of `Strategy/`).

Each choice: one headline + club + the **score/risk triple** — probable hole score (strokes
taken so far + EV to hole out), penalty probability from the dispersion-sample lie breakdown,
and the CVaR₈₀ tail where it changes the call ("Layup 95 → full wedge · prob. 4.1 · 1% pen" /
"Go — 178 plays 186 · prob. 3.9 · 18% pen, blow-up 5.6"). Same vocabulary as the planner's
option chips (options doc O4) — engine candidates get the triple directly from `Aim.swift`
outputs (expectation, `tailStrokes`, `breakdown`), no chain scorer needed for a single shot.
Tap → it becomes the working
target: distance line, club, ghost aim on the map; capture then records against it (capture's
target prefill reads the working target before pin/plan defaults). Recompute on demand and on
capture — never continuously while walking.

## 5. Capture as drivetrain (R5)

Existing `CaptureModel` keeps its flow; additions:

- Capturing advances PlayingState (R1) and re-derives card mode — the loop closes.
- **Penalty quick-action** and **one-tap hole-out** on the card in round mode (spec'd in
  shot-capture §4, never built).
- **Auto hole advance:** after hole-out, advance; GPS tee geofence prompts if the player walks on
  without holing out ("Start hole 8? 7 has no hole-out") — prompt, never silent.
- Calibration synergy is already free: capture stores the corrected origin because the bias is
  applied at origin derivation.

## 6. Green handoff (R6)

- Ball on green (point-in-ring, same test capture uses) → card flips to *green*: distance to
  hole, putt read one tap away with **ball = ballPosition, hole = today's pin override ?? active
  pin** — closes the laser-doc open question 3: the lasered pin becomes the read's hole position.
- **Stimp per round**: one field on round start (default from the previous round at this course),
  stored on the round like wind; feeds `PuttReadModel` instead of its hardcoded default.
- Tier 1 stays opportunistic: if a corridor scan exists for this putt it wins (existing
  `installScannedSurface` seam); otherwise Tier 2/3 as today.

## 7. One laser entry point (R7)

A single laser affordance on the card routes a spoken/typed number by context:

- No feature picked and number plausible as pin distance → **pin depth solve** (existing
  `PinEntrySheet` flow).
- Mapped feature picked (browse-tap, same picker the calibration sheet uses) →
  - no live calibration → **calibration shot** (trilateration session, existing).
  - live calibration → **opportunistic residual refresh** (the open TODO,
    laser doc §6.4): residual ≤ gate → silently refresh `solvedAt`
    (`method: .residualRefresh`); residual large → mark stale, badge, prompt re-shoot. The
    state machine and gates exist in `OriginCalibration`; this wires the ambient path.
- The number always also renders as a plain carry check against the picked target (free).

## 8. Decisions locked by this spec

- **R1** — PlayingState lives in `OnCourseModel`, derived from the active round; capture advances
  it authoritatively, GPS only prompts. No active round → nil → today's behaviour.
- **R2** — The card is a mode machine (tee-preview / plan / decide / green) over PlayingState;
  F/C/B block always present; competition gating unchanged.
- **R3** — Divergence = distance to nearest planned landing of the active line >
  max(1.5 × lateral dispersion, 25 m); flips the card, never edits the plan.
- **R4** — Decide shows ≤3 ranked choices merging authored options + engine candidates + caddy
  ranking/vetoes, each carrying the probable-score / penalty% / tail triple (options doc O4
  vocabulary); choosing sets a transient working target consumed by capture prefill.
- **R5** — Penalty + hole-out quick actions; auto hole advance on hole-out; geofence advance is
  prompt-only.
- **R6** — Green mode auto-enters via point-in-ring; putt-read hole position = pin override ??
  active pin; stimp is per-round input like wind.
- **R7** — One laser entry; number meaning routes on picked context; every laser at a mapped
  feature under live calibration runs the residual gate (refresh or stale, never silent decay).
- **R8** — The day's option choice (`activeLine`) is round state, never a plan write.

## 9. Explicitly out of scope

- New strategy math — everything prices through existing `Strategy/` ports.
- Continuous background replanning while walking (battery + noise; compute on demand/capture).
- Watch app, auto shot detection, voice score entry.
- Plan-vs-actual and strokes-gained *display* — web follow-up (SG still gated on D19).
- Persisted GPS-bias calibration (stays in-memory by design).
- Conditional plan branches (options doc §6).
