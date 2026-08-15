# Reticle browse — pan-to-aim interaction (iOS first)

2026-08-12. Replaces tap-to-inspect as the primary browse-mode interaction on iOS.
Modeled on Shot Pattern's pan-to-aim, with our club data and plays-like engine.
Web mobile companion port is a later wave.

## Interaction model

- **Reticle**: a fixed crosshair, centered horizontally, **30% down from the top**
  of the map viewport. It never moves on screen; panning the map moves the geo
  point under it. That point is the **aim** — "where the player wants the ball".
- **Aim line**: solid line from the origin (live GPS fix when in GPS mode,
  else `browseOrigin`, else active tee — round 3) to the reticle point, with the from→aim distance as a big number near the reticle. A
  **dotted extension** continues past the reticle along the same bearing (to
  the green line's remaining length, capped at longest-club carry past the aim)
  — "where you end up if you fly it".
- **Remaining**: aim→green-center distance shown alongside (smaller number
  past the reticle, plus the existing to-hole readout).
- **Pan state** (camera moving): ONE arc + raw numbers only. The arc sits at
  the reticle distance, centered on the aim line, its width = the lateral
  dispersion of the **pan club** — the first club in the bag whose carry ≥ raw
  from→aim distance (the club that reaches; `clubAdvice`'s `front` slot). No
  elevation, no wind, no plays-like. Everything here is O(1) per frame.
- **Settled state** (camera idle ≥ **200 ms** — idle, not finger-lift): full
  answer, computed once per settle:
  - plays-like distance (elevation sample + wind) from origin to aim;
  - **advised club** re-picked from plays-like distance; solid dispersion
    ellipse via the existing `computeSelectedTargetVisualization` path
    (wind-hold iteration included);
  - **neighbor clubs**: closest shorter and closest longer club drawn as
    **dotted arcs** at their own plays-like-adjusted carries, each arc's width
    = that club's lateral dispersion, club name labeled at the arc edge;
  - **aim offset**: wind-hold readout ("aim 6 m left") + ghost tick where to
    aim (existing `TargetWindHold`);
  - remaining-to-green from the aim point.
  - The settled layer hides on the next pan-start; the pan arc persists
    throughout (it is also drawn under the settled ellipse).
- **Club swap at settle is expected**: the pan club is picked from raw
  distance; plays-like may flip it (152 raw / 164 plays-like → longer club).
  Preview vs answer — not a bug.
- **Actions** (buttons near the bottom, SF Symbol chips, no emoji):
  - **+ Target**: add a plan point at the current reticle point (existing plan
    target flow).
  - **Browse from here**: `setBrowseOrigin(reticle point)` — the origin jumps
    to the reticle, replacing today's inspect→promote two-step as the primary
    origin-move. (Tap-a-shape inspect stays for front/carry readouts.)
- ~~**Snap**~~ *(removed, device feedback round 2)*: settling near a ladder
  rung / hazard edge used to magnetically capture the aim. Pulled — the
  capture moved the measured point away from where the user actually stopped
  (most visibly onto the green center). The aim now stays exactly where the
  pan ends.

## Camera

- On hole switch: fit the hole with **bearing = tee→green-center** as vertical
  (already supported — `MapCameraCommand.fitHole(bearing:)`; verify the screen
  passes it). Frame so the tee sits in the lower part of the viewport given
  the reticle anchor at 30%.
- All standard gestures stay live afterwards: pan, pinch zoom, two-finger
  rotate. No rotation lock. Compass / hole re-select re-aligns.
- Dogleg follow-up (not this wave): first-leg bearing instead of tee→green.

## Performance contract

Per-frame (every camera change event): unproject ONE screen point
(0.5·w, 0.30·h) → LatLon → planar; `hypot` for distance; linear scan of ~14
clubs; arc polyline ~32 points. No terrain sampling, no wind math, no hazard
corridors during pan. Settle work (elevation sampler, wind hold, neighbor
arcs) runs once per settle, ≥200 ms after the last camera change.
This mirrors the existing rule: hover/expensive geometry is gated off during
pan (see memory: terrain-aware project ~40 µs — even that is fine per frame,
but keep pan work flat-transform cheap).

## What replaces what

| Today (browse mode) | After |
|---|---|
| Tap map point → `inspectBrowsePoint` → card shows readout | Reticle IS the inspected point, continuously |
| "Browse from here" promotion on card (`promoteInspectedBrowseTarget`) | Button acts on reticle point directly |
| Ladder row tap → focus/inspect | Unchanged |
| Tap shape → front/carry inspect | Unchanged (secondary) |
| Plan target placement | + Target button at reticle |

Reticle mode is active whenever a hole is selected — both browse and GPS mode
(round 3; originally browse-only).

## Tasks (serial — iOS builds serialize)

- **RB1 — reticle math, pure Swift.** `ios/GolfMap/Strategy/BrowseReticle.swift`:
  pan-club pick (first carry ≥ distance, else longest), closest-shorter/longer
  neighbors, lateral half-width for a club at a distance (reuse the dispersion
  model in `Ellipse.swift` / `Club.swift`), arc polyline generator (planar,
  centered on bearing at radius, spanning ±half-width as chord/arc). Unit
  tests with a fixture bag.
- **RB2 — CourseMapView reticle plumbing.** Continuous callback with the geo
  point under the reticle anchor during camera changes + a pan/idle state
  (`regionIsChanging` / idle delegate hooks), gated by an `isReticleEnabled`
  flag. Unproject via the flat transform (convert point→coordinate). Tests
  follow `CourseMapViewGestureTests` patterns.
- **RB3 — OnCourseModel reticle state.** Reticle target + panning flag; 200 ms
  settle (injectable clock/scheduler for tests); pan snapshot (raw distance,
  pan club, arc geometry); settled snapshot (elevation sample, plays-like,
  advised club, neighbor arcs, wind hold via
  `computeSelectedTargetVisualization`, remaining-to-green). Memoized like the
  existing ladder/visualization caches. Unit tests.
- **RB4 — overlays.** MapOverlayState + renderers: aim line (solid) + dotted
  extension, pan arc, settled ellipse + two dotted neighbor arcs with club
  labels (`EllipseLabelRenderer` pattern), wind-hold ghost tick. Settled layer
  hidden while panning.
- **RB5 — screen UI + actions.** SwiftUI crosshair at the fixed anchor; big
  from→aim number + remaining readout; + Target and Browse-from-here buttons;
  reticle active in browse mode; keep tap-shape inspect. Copy per iOS
  conventions (SF Symbols, terse).
- **RB6 — snap + camera bearing.** Snap-to-rung/hazard-edge on settle with
  haptic (later removed — see round-2 feedback); verify/fix hole-fit
  bearing = tee→green with reticle-aware insets.
- **RB7 — verify.** Full `xcodebuild test`, headless sim verify
  (`-openCourse`/`-browseMode` launch args), screenshots of pan + settled
  states.

## Device feedback round 1 (2026-08-12)

- Reticle marker: minimal — one small open circle, no hairlines/rings.
- ~20 pt extra gap between the marker and the big from→aim number.
- Snap does NOT write a text label ("L Bunker front"); it highlights the
  corresponding ladder rung instead. *(Round 2: snap removed entirely — the
  magnetic capture itself was unwanted.)*
- ALL THREE clubs are labeled on the map in the same boxed style (advised
  club's name on its ellipse, same anchor side as the neighbor arc labels) —
  a HUD-only club chip was misread as the nearest arc's label. No club chip
  in the HUD readout row.
- While the reticle is active, the tap-target line and the browse
  forward-route distance line are suppressed — only the reticle aim line +
  dotted extension draw. Tap-shape inspection (card readout) still works.

## Device feedback round 2 (2026-08-15)

- Browse-mode tap on the open map toggles the distance card
  (expand/collapse — same as the chevron) instead of inspecting a point;
  no tapped dot is drawn at all. The reticle IS the aim point, so a tap
  point would be a second, competing target. Tap-a-shape inspect stays; a
  second tap (same shape or open map) dismisses it. GPS mode is unchanged
  (two-stage tap + chrome toggle). *(Round 3: GPS tap handling unified with
  browse — see below.)*

## Device feedback round 3 (2026-08-15)

- **Reticle live in GPS mode too.** Browse-only was a mistake ("I always want
  that obviously") — no toggle, always active in distance mode when a hole is
  selected.
- **GPS origin = the player's feet**: the reticle measures from the same chain
  as everything else — gated live fix, else `browseOrigin`, else active tee.
- **Drift re-settle**: a settled answer stores its origin; when the GPS fix
  moves > 3 m from it (walking with the aim parked), the settled snapshot
  recomputes. Below 3 m, fix jitter keeps the answer stable. Mode flips
  (`setGPSEnabled`) also re-settle.
- **Chips**: "+ Target" works in both modes; "From here" / "Tee" stay
  browse-only — origin rebasing is a browse concept.
- **Tap handling unified**: a tap never point-inspects in either mode. Tap a
  new shape → inspect; tap the same shape or open map → dismiss; nothing up →
  screen chrome toggle. The GPS two-stage tap-to-aim-point is removed — the
  reticle owns aiming.

## Notes

- Working tree has unrelated in-flight changes (elevation profile, wind
  editor, tap-shape distances) touching `OnCourseModel.swift` /
  `CourseScreen.swift`. Build on top; never revert or commit them.
- New files require `cd ios && xcodegen generate` before building.
- Competition mode: the settled advice layer (ellipse, club, wind hold) is
  advice — hide under competition mode like `selectedTargetEllipse` does; the
  raw distances + pan arc width are DMD-legal distances? NO — dispersion arcs
  are advice too; competition mode shows line + distances only.
