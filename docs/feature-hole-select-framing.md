# Hole-select framing — reticle default, two-anchor camera, compact card

2026-08-16. Design note for the hole-change experience in on-course distance
mode (iOS first). Extends `feature-reticle-browse.md` (which specifies the
reticle interaction once the user pans); this note specifies **the state the
map is in before the first pan** — what the reticle aims at, how the camera is
placed, and how much chrome covers the map.

## Problem (observed on device, 2026-08-16)

Two screenshots, Hole 3 (par 3, 158 m) and Hole 15 (par 4, 348 m):

- **Stale / garbage reticle on hole change.** Aim line at 235 m on a 158 m
  par 3; 524 m on a 348 m par 4 with the aim sitting on a mall parking lot.
  The reticle point carries over from the previous hole and/or is re-derived
  from the screen center *during* the fly-to animation — a race between the
  camera animation and pan-to-aim's screen→world resolution.
- **Camera framed by the bogus line.** Once the aim is garbage the framing
  follows it (highway / parking lot dominating the viewport), a feedback
  loop: bad aim → bad frame → screen center further off → worse aim.
- **No plausibility clamp.** Driver dispersion ellipse and 3W arc rendered on
  a 158 m par 3, over a motorway.
- **Chrome eats the map.** The distance card is ~25% of the screen; most of
  it is buttons used at most once per hole.

## Decisions

### D-HF1 — Default aim target (per hole entry)

On hole select (and on origin change — GPS fix adopted, browse origin reset),
the reticle's aim point is **set explicitly in world coordinates**, never
inherited and never derived from a screen point:

1. **Plan exists** → aim = the plan's current-leg landing point (green center
   for the last leg). The plan/layup engine already picked a corridor-aware
   target; the reticle defaulting anywhere else is incoherent with the card.
2. **Curated furniture aim points** (still ahead of the origin per the shared
   forward-route chainage filter, in hole order) → aim = the farthest one
   whose plays-like is within longest-club carry. All beyond carry → the
   point at longest-club carry along the origin→**first**-aim-point bearing
   (the curated direction, not the green chord). A curated aim point beats
   the ring walk whenever present — it IS the intended line.
3. **No aim points** → aim = green center, **clamped to the longest club**:
   if plays-like(origin → green center) ≤ longest-club carry, aim at green
   center. Otherwise ring-walk (D-HF2).
4. Clamp uses **plays-like** distance (elevation-adjusted), not horizontal —
   clamping on horizontal defaults the aim into the slope.

Origin = live GPS fix in GPS mode, else `browseOrigin`, else active tee —
same resolution order as the aim line (reticle-browse round 3).

The clamp applies to the **default only**. Panning past the longest club
remains allowed (scouting "what's at 280" is legitimate); the dotted
extension already caps at longest-club carry past the aim.

### D-HF2 — Fairway snap (ring walk)

When rule 3's clamped point lands outside fairway (or short of green on a
reachable hole but in junk):

- **Fairway scoping**: the surface stack is course-wide and carries no
  holeIds, so an unfiltered walk snaps to whatever fairway crosses the ring —
  on real courses an adjacent hole's (45–90° aim bearings, the Linkan device
  bug). The walk only sees fairways intersecting a **±60 m corridor** around
  the hole's routed play-line (tee → curated aim points → green center,
  override-aware).
- Walk distance rings origin-outward, starting at longest-club plays-like
  carry, stepping **down** in ~5 m steps.
- At each ring, intersect the arc with the fairway polygon(s). A hit yields
  one or more arc segments; pick the segment whose midpoint is closest to the
  origin→green-center line and use the **segment midpoint** (that is "middle
  of the fairway" laterally at that distance).
- Require segment width ≥ the advised club's lateral dispersion at that
  distance (existing ellipse math); a 6 m sliver at 240 is not a target —
  step down until a landable cross-section exists.
- First passing ring wins → the farthest fairway point that is centered and
  wide enough. No fairway hit at all (forced carry hole data gaps) → fall
  back to the unclamped direction at longest-club carry toward green center.

Deliberately **corridor-dumb**: it may aim over trees the player can't carry.
Acceptable for a default — tree-awareness comes from preferring the plan
target (rule 1), which respects the hazard-corridor ladder. The snap stays a
dumb-but-sane fallback; do not grow it.

Degenerate cases fall out naturally: par 3 → first ring hits the green
polygon → green center. Tree-lined dogleg → rings shorten to the corner.

### D-HF3 — Two-anchor camera solve

Key structural fact: in pan-to-aim mode the reticle is **screen-fixed**
(center-x, 30% down the usable viewport — reticle-browse) and panning moves
the map. So "where the reticle aims" and "where the camera is" are the same
decision. The hole-select camera is therefore **solved, not fitted**:

- **Ball anchor**: x = center, y ≈ 78% of the usable (inset-adjusted)
  viewport. The origin (tee/ball) renders here on hole entry.
- **Reticle anchor**: x = center, y = 30% (existing).
- **Bearing**: origin → default aim (D-HF1). First-shot-up, not tee→green-up;
  on a dogleg the fairway runs up the screen instead of diagonally into a
  corner.
- **Zoom**: uniquely determined — world distance origin→aim divided by the
  screen distance between the two anchors.

Zero free parameters once the aim is chosen. **Never fit-bounds on the aim
line**; the green being off-screen on long holes is correct — the chips carry
that information and one pan up reveals it.

Adjustments on top of the pure solve, in order:

1. **Zoom clamps** (min/max). When clamped, the ball anchor holds and the
   aim drifts from its anchor (short par 3s would otherwise zoom absurdly).
2. **Dispersion margin**: if the advised club's ellipse at the aim would clip
   the usable viewport laterally, back the zoom off just enough to contain
   it.

Mechanism: extend `MapCameraCommand` with a two-point target
(`.anchored(origin:aim:originAnchor:aimAnchor:)` or precompute
center+zoom+bearing model-side and issue `.center`). One animated command per
hole entry; `token` bump on re-selecting the same hole.

### D-HF4 — Settle gating on hole change

During the hole-entry camera animation the reticle line, labels, and
dispersion overlays are **hidden** (not frozen-stale). They appear at first
settle (existing ≥200 ms idle definition), computed from the D-HF1 world
point — not from unprojecting the screen anchor mid-flight. The screen-anchor
unprojection path resumes on the first user pan. This kills the
screenshot-class bug by construction.

### D-HF5 — Compact distance card (default)

The distance card gets two fixed states; **compact is the default**:

- **Compact**: one row — big to-green number, advised club + carry
  (`7I · 155`), plays-like/actual delta. Nothing else. Whole row is the
  tap target (44 pt min height).
- **Expanded**: today's full card — Laser, Pin, tee selector, profile chart,
  Browse toggle, origin reset strip.
- Tap compact row → expand. Tap map / drag down / complete an action in the
  expanded card (tee picked, Laser toggled) → collapse. Two fixed detents,
  no free-drag continuum — deterministic chrome insets.
- State persists per session; default compact. **No auto-expand on hole
  change** — that is exactly when the map matters most.
- Ship without a contextual action slot in the compact row; if Laser proves
  too buried in practice, revisit with one contextual slot (Laser on
  approach, Pin near green) rather than growing the row.

**Camera/insets rule**: the two-anchor solve and all camera fits use the
**compact** card's inset, always. Expanding overlays the map temporarily and
never re-frames the camera (no toggle-induced camera motion). Measured via
the existing chrome-frame plumbing (`trackFrame` → `MapEdgeInsets`, as the
Green-view fit does).

**Relation to immersive mode**: immersive (tap map → chrome hides,
`CompactChipView`) stays as-is — it is "no card"; this adds a middle state.
Resulting ladder: immersive (chip only) ⊂ compact (one row) ⊂ expanded.
A tap on the map with the card expanded collapses to compact first;
immersive toggling remains the existing single-tap behavior when the card is
already compact.

## Non-goals

- Web mobile companion parity (later wave, after the iOS shape settles).
- Smarter corridor-aware snapping (see D-HF2 — plan target is the smart path).
- Free-dragging sheet detents for the card.

## Testing

- Unit: default-aim resolution (plan / clamp / ring-walk) is pure geometry —
  golden cases per hole class (short par 3, reachable par 4, long par 5,
  dogleg, no-fairway data). Swift + TS when ported (parity-pin like layup).
- Unit: two-anchor solve → center/zoom/bearing for known inputs; clamp and
  dispersion-margin branches.
- Existing reticle tests (`CourseMapViewReticleTests`,
  `OnCourseReticleTests`) extend with: hole change hides overlays until
  settle; aim state does not survive hole change.
- Headless sim verify (`-openCourse` launch args): screenshot per hole class
  after settle; assert card compact by default.
