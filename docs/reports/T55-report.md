# T55 — Interactive photo cleaning in the web editor ("Clean photo")

**Status: built, live-smoked end-to-end.** New `clean` editor tool: click a blemish on the
ortho (player, cart, shadow, stray object) or drag an ellipse over it, the assist sidecar
LaMa-inpaints the 512 px crop, the result shows as a georeferenced preview overlay on the
map, and **Accept** bakes it into the course's ortho and tiles. Patches are a replayable
log — the pristine source ortho is never modified (terrain-edit plan philosophy).

## Sidecar decision: ONE process, extended

`tools/sam-server` (T45) gained a `POST /inpaint` endpoint instead of a sibling process:
one sidecar serves the whole assist session, `/segment` (SAM) and `/inpaint` (LaMa) share
the torch runtime the venv already carries (ultralytics depends on torch), and `/health`
now reports **per-capability readiness** — `point_model: loaded|mock` plus
`inpaint: { available, weights, detail? }` — so the SAM tool and the Clean tool gate
independently (mock SAM still works without LaMa weights and vice versa).

- `server.py` puts `<repo>/pipeline` on `sys.path` and imports `golfpipe.inpaint`
  directly (`inpaint_tiled` + `LamaInpainter` — the exact T54 runner, kept CLI-free for
  this purpose). That module imports only numpy/stdlib at module level, so the sidecar
  venv needs none of the pipeline's rasterio/laspy stack. Documented in the README.
- Weights resolve from `$GOLFPIPE_LAMA_WEIGHTS`, defaulting to
  `<repo>/data/models/big-lama.pt` (present on this machine). Missing weights/torch →
  `/health` reports unavailable and `/inpaint` answers 503 with the reason; the Clean
  panel shows it and disables itself. SAM keeps working.
- `/inpaint` contract: `{ image, mask }` base64 PNGs (mask >127 = inpaint) →
  `{ image, masked_pixels, elapsed_ms }`. Unmasked pixels come back **byte-identical**
  (inpaint_tiled invariant), so the whole result can overlay the map seamlessly.

## Patch/replay design as built

**Store (server-owned):** `data/sources/<mapKey>/patches/` holds `<n>.png` (RGBA — alpha
255 exactly on the inpainted pixels, so only they ever bake) + `patches.json`, an ordered
log of `{ seq, file, bounds3857, boundsSweref, tool, createdAt }`. golfpipe only ever
READS the store.

**Georeferencing deviation (deliberate):** the brief said "png + EPSG:3006 bounds", but a
patch is born on Web-Mercator tile pixels — its exact frame is an axis-aligned
**EPSG:3857** rectangle (the crop's integer-pixel bounds; `planBounds3857`). Storing 3006
boxes would ignore the ~0.5° meridian-convergence rotation between the frames and shift
patch edges by decimetres. The log therefore carries `bounds3857` as the authoritative
frame (replay reprojects patch RGBA onto the ortho's 3006 grid, bilinear, alpha-
composited — rotation preserved, pinned by test) and `boundsSweref` as the informational
3006 bbox the brief asked for.

**Replay:** new `golfpipe apply-ortho-patches --ortho <pristine> --patches-dir <dir>
--out <stem>.patched.tif --tiles-out <tiles>/ortho --minzoom 14 --maxzoom 20
[--extra-bounds w,s,e,n]…` (`golfpipe/patches.py` + `cmd_apply_ortho_patches`). Always
replays the FULL log onto the pristine source into the working `.patched.tif`
(deterministic, never incremental), then rewrites only the affected tile-pyramid subtree:
`affected_tiles` = union of `mercantile.tiles` over every logged patch bounds (plus
`--extra-bounds`) across z14–z20, cut via the tiling refactor `generate_tiles` (an
explicit-tile-list variant `generate_tile_pyramid` now delegates to) with the same WebP
encoder as `tile-ortho` (extracted `_ortho_webp_encoder`). A ~40 m patch touches ~19
tiles across the pyramid.

**Server:** `OrthoPatchesService` (+ `ortho-patches.api.ts`, `shared/api/ortho-patches.gen.ts`):

- `POST /ortho-patches/apply` — validates (PNG signature, finite non-degenerate bounds,
  ≤24 MB), stores png + log entry, runs the replay (map-build runner seam), and on
  pipeline failure **rolls the stored patch back** so the log only ever describes what
  the tiles show. Ops are queued per site so concurrent applies never interleave.
- `POST /ortho-patches/revert-last` (revert v1) — drops the last log entry, re-replays,
  and passes the reverted patch's bounds as `--extra-bounds` (its tiles must rewrite from
  the now-unpatched raster even though it left the log), then deletes the png.
- `GET /ortho-patches/info` — count + last entry for the panel.
- The patched source is the **active** (flat-tree) vintage from the tile manifest
  (`activeOrtho`), resolved course→site; sites built before source persistence (no
  persisted ortho GeoTIFF) get a clear "build the map first" error.

**Tile version bump:** tile responses carry year-long immutable cache headers, and the
web derives `?v=` from the tile-manifest's `generatedAt`
(`tileset.service.ts` `deriveTileVersion`). Every apply/revert rewrites `generatedAt`
(ms-precision ISO, **strictly monotonic** — two bakes in one millisecond still mint
distinct versions) in BOTH the on-disk `manifest.json` and the `tile_manifest` asset's
`metaJson` (optimistic-lock update). After accept/revert the web calls
`tileset.reload()`; the editor canvas re-inits the map against the new version (existing
plumbing), and the Clean tool captures the camera first and restores it once the new map
is ready, so the user stays on the spot they just cleaned.

## Web tool

`web/src/clean/` — `EditorTool` registry entry (`id 'clean'`, order 70, new `eraser`
icon), tool service, dock panel, sidecar client, and pure mask/mercator math:

- **Two mask modes.** *Click object*: crop composed from ortho tiles at the manifest's
  maxzoom via the T45 sam-crop machinery (MapLibre canvas never read; crop sent as PNG so
  the sidecar round trip is lossless) → existing `/segment` → largest polygon → scanline
  fill → dilated ~0.5 m (T54 learning: half-masked blemishes get plausibly *continued*
  by LaMa, so the soft edge must go with it). *Drag ellipse*: mousedown-drag defines the
  ellipse bbox with a live dashed outline (GeoJSON overlay); the mask is rasterized
  directly — **no SAM required**, and micro-drags decay silently. ⌘-drag stays the pan
  escape hatch; Esc cancels a drag or discards a preview.
- **Preview:** the full inpainted crop as a `data:` image overlay at the crop's exact
  WGS84 corners — new `MapService.addImageOverlay` (image source + raster layer,
  companion to the GeoJSON overlay API). Unmasked pixels are byte-identical to the tiles
  underneath, so the overlay edge is invisible; accept/discard in the panel.
- **Panel:** per-capability health (online / degraded "no LaMa weights" / offline, with
  retry), mode toggle, busy/preview/notice states, baked-patch count + **Revert last
  patch**.
- Pure modules: `clean-mask.ts` (scanline polygon fill, ellipse fill, disc dilation,
  mercator↔lngLat, `planBounds3857`) and `clean-client.ts` (typed `/health` + `/inpaint`
  with a fetch seam). All canvas work sits behind a `CleanImaging` seam so the whole
  state machine runs under bun test.

## Live smoke — ran end-to-end on real Landeryd data

Updated sidecar started on :8600 (Marcus's pre-T55 instance on :8000 was left running and
used for `/segment` — real SAM weights); real big-lama weights; driver mirrors the web
client's math exactly:

1. **Click → SAM → inpaint (Landeryd Masters, real bunker):** crop composed from 9 real
   z20 tiles, SAM traced the bunker, `/inpaint` filled 15,413 px in **1.5 s** — the
   bunker reads as convincing grass, no visible seams, unmasked pixels verified
   byte-identical. (First click on the bunker's rim segmented only its shadow lip —
   clicking near the object's center matters; the panel hint says so.)
2. **Accept → replay → retile (Landeryd/Linkan site `208f4f4d`, the only site with a
   persisted pristine ortho):** `OrthoPatchesService.apply` with the REAL pipeline
   runner: 237 MB ortho replayed + 19 affected tiles (z14–z20) rewritten in **9.5 s**;
   patch png + log entry on disk; `generatedAt` bumped in manifest + asset; center-tile
   hash changed; recomposed crop from the baked tiles matches the preview to ~1.3 gray
   levels (WebP re-encode + reprojection resample).
3. **Revert:** log emptied, png deleted, tiles rewritten from the pristine copy
   (content restored to ~1.5 gray levels mean of the original render — not byte-identical,
   because the subtree VRT's resample grid differs from the full-pyramid original; visually
   indistinguishable), version bumped again. Landeryd data left in its pre-smoke state
   (plus the working `.patched.tif`, an empty patch log, and a fresher tile version).

Exercised live: sidecar `/health`+`/segment`+`/inpaint`, crop/mask/patch geometry, the
service under the endpoint with the real pipeline, retile, version bump, revert. NOT
exercised live: the HTTP/auth layer above the service and the in-browser pointer wiring
(MapLibre doesn't run under bun/happy-dom, and the preview pane never ticks rAF — see
memory) — both covered by the web service tests' fakes.

## Tests

Zero regressions; all three suites green (typechecks clean: `check:client`,
`check:test`, `check:server`):

- **pipeline** `./.venv/bin/python -m pytest -q`: baseline 149 → **183** (+19 T55 in
  `tests/test_patches.py`, +15 from the concurrent terrain-edit session). Log
  loading/validation, 3857→3006 composite correctness incl. the rotation-preservation
  pin, replay determinism + last-wins ordering + pristine-source untouched,
  zero-alpha/out-of-raster no-ops, affected-tile computation vs independent mercantile
  enumeration + dedupe, real (tiny) WebP subtree retiling, `--extra-bounds`, CLI wiring,
  overwrite refusal.
- **server** `cd server && bun test`: baseline 438 → **454** (+8 T55 in
  `ortho-patches.service.test.ts`, +8 concurrent). Fixture-runner pattern: store/log/
  exec args, seq append, failure rollback (apply and revert), revert `--extra-bounds` +
  png deletion, version bump in manifest + asset (monotonic, distinct per bake), no-op
  revert, PNG/bounds validation, no-map errors.
- **web** `cd web && bun test`: baseline 781 → **833** (+33 T55 across
  `clean-mask.test.ts` + `clean-tool.service.test.ts`, +19 concurrent). Mercator/bounds
  math against the independent tile-math path, mask fills/dilation, mask-mode state
  machine, `/inpaint` + `/health` contracts (canned), SAM-mask dilation observed at the
  seam, preview overlay geometry, accept payload (exact `planBounds3857`, sweref bbox,
  tool label) + reload, discard, preview-blocks-new-clicks, failed-bake keeps preview,
  revert gating, health gating incl. weights-missing degraded state, claim gating,
  out-of-domain clicks.

## Gaps / notes

- Only the **active (flat-tree) ortho vintage** is patched; viewing a non-active vintage
  while cleaning would preview against the active tree's imagery. Multi-vintage patching
  is out of scope.
- A map **rebuild** re-tiles from the pristine source — baked patches vanish from tiles
  until the next apply/revert re-runs the replay. Re-running `apply-ortho-patches` after
  a build (or folding it into the build chain) is a natural follow-up.
- The working `.patched.tif` (~source-sized) stays alongside the source by design — it is
  the input for future Unity/GSPro texture export off the CLEANED imagery (and
  `clean-ortho` batch output can feed the same log-replay later).
- Reverted tiles restore pristine *content*, not byte-exact original encodes (subtree
  VRT resample grid ≠ full-pyramid grid; ~1.5 gray levels, invisible).
- Sites built before source persistence (Vreta, Landeryd Masters/Classic) have no
  pristine ortho on disk and get a clear error; a rebuild fixes that.
- `/inpaint` on this machine: ~1–2.5 s per 512 px crop (CPU, warm model; first call adds
  the lazy model load).
