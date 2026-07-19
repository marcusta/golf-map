# Clean-photo: clone stamp, batch baking, and the dual photo state

**Status: built, live-verified end-to-end on Linkan.** Three deliverables landed together
(the second two arrived as scope extensions mid-task and reshaped the first):

1. **Clone-stamp mode** — a third Clean-tool mode: Alt-click picks a source, drag paints;
   strokes are logged as *parameters* (never pixels) and re-rendered server-side by a pure
   numpy brush engine. Torch-free, byte-reproducible on replay.
2. **Batch baking** — accepted edits (LaMa masks AND stamp strokes) accumulate as a
   PENDING queue; "Bake N edits" submits them in ONE call → one golfpipe invocation, one
   union-subtree retile, one version bump, one map refresh.
3. **Dual photo state** — cleaning is for golf-simulator export ONLY. Bakes never touch
   the pristine flat tile tree again; they retile into a sparse copy-on-write
   `ortho-sim/` overlay with its own version stamp. Planning/playing imagery (web
   planner, draw mode, iOS bundles) always shows the original photo.

## The stroke log (patch log v2, second entry kind)

`data/sources/<mapKey>/patches/patches.json` entries now carry `kind` (absent = `mask`):

```json
{ "seq": 24, "kind": "stamp",
  "bounds3857": { … },          // dest stroke bbox + brush radius — the retile frame
  "boundsSweref": { … }, "tool": "stamp", "createdAt": "…",
  "stamp": {
    "brush": { "sizeM": 3, "opacity": 1, "flow": 0.7, "hardness": 0.7 },
    "offsetM": { "dx": 8, "dy": 5 },   // source = dest + offset, EPSG:3006 metres
    "path": [[e, n], …],               // dest polyline, EPSG:3006
    "aligned": true, "toneMatch": true } }
```

Bake/replay re-executes the stroke against the CURRENT patched raster
(`golfpipe/stamp.py` + `patches.stamp_entry_into`): feathered circular dabs along the
path, source pixels read from the same raster shifted by the offset (snapshot before the
stroke composites — no mid-stroke feedback), windowed write, one log entry per stroke so
revert-last peels strokes. Pure float64/np.rint pixel math — **byte-reproducible**
(pinned by test), no torch anywhere on the stamp path.

### Brush-engine semantics (mirrored exactly in `web/src/clean/clean-stamp.ts`)

- **size** — brush diameter, ground metres.
- **hardness** — fully-opaque core fraction of the radius; raised-cosine feather to the rim.
- **flow** — per-dab alpha; dabs composite over each other (`a += dab·(1−a)`), AND flow
  sets dab spacing: `0.25·diameter / flow`, clamped to [1 px, 2 diameters].
- **opacity** — scales the whole accumulated stroke alpha (a stroke-level cap).
- **tone-match** (per stroke, default on) — the clone's mean RGB over the painted region
  is shifted to the destination region's mean before compositing: texture (variance)
  preserved, tone blended. Measured in tests: mean lands within 1 gray level of the
  destination, variance stays the source's (σ ≈ 12 in, σ ≈ 12 out vs dest σ 5).
- **aligned** — ON: the source→dest offset established by the first stroke persists
  across strokes (the source follows the brush); OFF: every stroke restarts from the
  picked source. A new Alt-click always re-anchors. The flag is stored per stroke.

Pixels whose shifted source falls off the raster are left untouched (window-edge rule,
pinned at the raster edge in tests).

## Batch baking

- **Client**: `accept` (mask candidate) and every finished stamp stroke push onto a
  pending queue — overlays stay visible (mask previews under per-edit ids; stamp strokes
  render onto tile-composed preview surfaces, all anchored below `features-fill` per
  00b7955c). Panel: "N pending edits", **Bake N edits**, **Discard last**; Esc prompts
  before discarding the queue; tool-switch prompts bake-or-discard.
- **Server**: `POST /ortho-patches/apply` now takes `{ courseId, edits: [...] }` (mask |
  stamp union, ordered). All entries append to the log, then ONE
  `golfpipe bake-ortho-patch --seq a --seq b …` bakes them in order against the evolving
  `.patched.tif` and retiles the UNION of affected subtrees once. One sim-version bump,
  one response, one map refresh (the seamless `refreshOrthoTiles`-style path from
  893be053, pointed at the sim source). A single accept is a batch of one — there is no
  second code path. Batch-wide rollback on pipeline failure.
- **LaMa laziness**: golfpipe only constructs the LaMa runner when a mask entry is
  actually being baked/replayed. A stamp-only log is fully bakeable without torch or
  weights; the server pre-flight now reports `bakeable` (masks) and `stampBakeable`
  (stamps — source-resolution only) separately, and the panel gates per mode.

## Dual photo state (sim layer)

- The pristine flat tree `tiles/<mapKey>/ortho/` is **never modified by bakes again**,
  and its `generatedAt` no longer changes on bake/revert — pristine tile caches are never
  invalidated by cleaning.
- Bakes retile into `tiles/<mapKey>/ortho-sim/` (ONLY patch-affected tiles). The tile
  route serves `ortho-sim` requests from the overlay when the file exists, else falls
  back to the pristine tile. Lower-zoom sim parents composite sim children where present
  and pristine children otherwise (`--pristine-tiles` fallback in the retiler).
- The sim layer has its own stamp: `patchesGeneratedAt` in manifest.json + the
  tile_manifest asset metaJson (ms-ISO, strictly monotonic) → the `ortho-sim` `?v=`.
- **iOS bundles**: the archive endpoint rejects `ortho-sim` outright (400) and the ortho
  archive enumeration never enters the sibling `ortho-sim/` dir — pinned by test with sim
  tiles on disk. No iOS change needed.
- **Editor**: the Clean tool switches the live flat ortho source to the sim template on
  activate (new `MapService.setOrthoPhotoState` — presentation-only, never touches the
  `displayedVersion` re-init guard), a panel "Show cleaned photo" toggle flips for
  comparison, and deactivate always restores pristine. Mask crops and stamp preview
  surfaces also compose from the sim layer, so cleaning is cumulative on the cleaned
  photo. Every other tool/mode keeps the pristine source.
- **Export**: the working `.patched.tif` remains the Unity/GSPro source of truth —
  export flows should read it (no export implementation in this task).
- Reverting the last remaining log entry deletes the sim tree entirely (pure pristine
  fallback); partial reverts rewrite the reverted bounds' sim tiles from the replayed
  raster (`--extra-bounds`, unchanged machinery).

### Preview fidelity (documented in the service headers)

The local stamp preview clones from served-tile pixels (WebP-lossy, mercator-resampled);
the bake re-executes the stroke on source pixels in the raster's own grid. Visually
near-identical — and the bake is seam-free BY CONSTRUCTION, since clone source and
destination share raster provenance. The preview px-offset is derived at the stroke
start (rotation between EPSG:3006 and 3857 ignored for preview only, ~0.5°); the logged
offset is exact SWEREF99 TM. Overlapping pending edits preview independently; the bake
applies them in order against the evolving raster.

## Linkan migration (flat tree was contaminated)

The 23 previously-baked mask patches had been retiled into the flat tree under the old
single-state model. Migration (one-time script, ~2.1 s):

1. Re-rendered every patch-affected subtree of the flat tree from the pristine
   `ortho-orto-l2-2025.tif` — **92 tiles restored**.
2. Built the sim overlay from the existing current `.patched.tif` (no LaMa re-run) —
   **92 tiles**.
3. Verified by re-rendering sample z20 tiles from the matching rasters:
   **12/12 flat tiles byte-identical to pristine renders, 12/12 sim tiles byte-identical
   to patched renders.**

## Live verify (Linkan, site 208f4f4d…, 245 MB ortho, real service + real golfpipe)

Synthetic strokes (5× ~5 m paths, 3 m brush, aligned, tone-match on) driven through the
real `OrthoPatchesService` against the real DB:

- **5 single stamp bakes** (batch of one each): 0.78 / 0.51 / 0.52 / 0.53 / 0.51 s —
  **2.85 s total**. No torch import at any point (stamp-only path).
- **1 batch of 5**: **0.67 s** end-to-end — 4.3× the single-accept path, ~0.13 s/edit
  amortized (one python start, one raster open, one 16-tile-deep retile, one bump).
  For contrast, the pre-batch T55 mask accept measured 2.31 s *per edit*.
- **Seam check** (c8174463's gradient sampling: RGB steps across the stroke's exact
  alpha-boundary in the baked raster vs the same ring geometry in untouched texture):
  boundary mean 2.13 / p95 6.67 vs natural-texture baseline mean 2.14 / p95 6.00 —
  **ratio 1.00, no discontinuity spike. Seam-free.**
- **Dual state held live**: pristine `generatedAt` unchanged through all bakes/reverts;
  all 16 stroke-affected z20 flat tiles still byte-identical to pristine renders; sim
  overlay carried all 16 (14 with visible stroke content, 2 only grazed by the padded
  bounds). `patchesGeneratedAt` bumped monotonically per operation.
- **Reverts**: 13.0–13.5 s each — dominated by the full replay's 23 LaMa mask
  re-inpaints, not by stamps (stamp re-render is milliseconds). Linkan left restored:
  23 mask entries, sim regenerated, pristine untouched.

Revert-last peels ONE log entry (not one batch) — kept deliberately simple. No strong
reason found to group; if batches grow large a "revert batch" could reuse the same
extra-bounds machinery.

## Tests

All suites green, typechecks clean (`check:client`, `check:test`, `check:server`),
ortho-patches client regenerated (`applyOrthoEdits`, `stampBakeable`,
`patchesGeneratedAt`):

- **pipeline** 204 → **224** (`tests/test_stamp.py` + retile/CLI updates): dab spacing
  from flow, feather from hardness (hard/soft/monotone), opacity cap + flow build-up,
  tone-match mean-shift with variance preservation, byte-determinism, stamp log round
  trip + validation, mixed mask+stamp replay in seq order against the evolving raster,
  stamp-only replay/bake with `inpaint_fn=None` and a monkeypatched exploding LaMa
  factory (never constructed), window-edge source validity, batch `--seq` union retile,
  sim-overlay parent derivation from pristine fallback.
- **server** 471 → **478** (suite rewritten for the batch API): batch append order +
  single pipeline call with repeated `--seq`, stamp payload round trip, batch-wide
  rollback, sim-tree targeting (`--tiles-out ortho-sim` + `--pristine-tiles`), sim
  version bump with pristine `generatedAt` pinned unchanged, sim-tree deletion on
  revert-to-empty, `bakeable`/`stampBakeable` split (weights/torch missing → stamps
  still bake), tile route sim-overlay serve + pristine fallback + 404, plain-ortho
  never serves sim, archive endpoint rejects `ortho-sim` and excludes sim tiles from
  iOS bundles, vintage-resolution suite carried over.
- **web** 846 → **871** (`clean-stamp.test.ts` + service suite rewrite): brush-engine
  parity pins (spacing/feather/opacity/tone-match/edge/determinism), stamp state
  machine (source pick, offline-sidecar independence, surface reuse, aligned vs
  non-aligned offsets, payload shape incl. radius-padded 3857 frame, discard-last
  re-render, esc cancel, shift-click line), pending queue (accept queues, no server
  call, batch payload order, failed-bake retains queue), photo-state switching
  (activate/toggle/deactivate, sim `?v=` fallback), deactivate prompt.

## Gaps / notes

- Parked v2 ideas (documented in code): stamp source **rotation**, **cross-vintage
  donor** sources (cloning from another year's flight).
- A map **rebuild** still re-tiles the flat tree from pristine and leaves the sim
  overlay stale until the next bake/revert regenerates it (same standing caveat as
  before, now scoped to the sim layer only).
- Sim tiles for a *partially* reverted area are re-encoded from the replayed raster —
  content-identical to pristine where nothing remains, but not byte-identical to the
  pristine tiles (they only vanish entirely when the log empties).
- The pending queue lives in the Clean tool's DI singleton; a page reload drops
  unbaked edits (previews are client-side only by design).
