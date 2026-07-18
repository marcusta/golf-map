# T54 — Batch ortho cleaning for game-engine texture export (`clean-ortho`)

**Status: built.** New `golfpipe clean-ortho` command LaMa-inpaints tree canopy, the
shadows it casts, and any manually masked noise out of the playable corridor of a course
ortho, producing a cleaned GeoTIFF for Unity/GSPro texture export — replacing the
Photoshop stamp-out pass with the data Photoshop doesn't have: lidar canopy polygons
(detect-trees), typed course features, and georeferencing.

## What was built

### Mask pipeline (`pipeline/golfpipe/clean_ortho.py` — pure, offline-tested)

```
mask = ((canopy ∪ shadow(canopy)) ∩ corridor) ∪ manual, dilated --margin (0.5 m)
```

- **Canopy** — `trees` polygons from `--trees` (detect-trees output or an exported
  features file; features typed `trees` plus untyped polygons are used).
- **Shadow** — the canopy union translated toward `--shadow-azimuth` (compass degrees the
  shadow *falls toward*; 0 = north, 90 = east — measure one tree in the source image) at
  sub-offsets spaced ≤ 3 m up to `--shadow-length` (default 15 m), unioned. Crowns are far
  wider than the 3 m spacing, so consecutive translates overlap into a solid penumbra band
  — not just a displaced copy at the tip. `--shadow-length 0` disables the band.
- **Corridor** — union of `--corridor-types` (default `fairway,semi_rough,rough,tee,green`)
  from `--features`. Canopy/shadow outside the corridor is untouched: real forest stays
  forest in the texture.
- **Manual mask** — optional `--manual-mask` GeoJSON (players, carts, blemishes), honored
  verbatim and deliberately **not** clipped to the corridor (explicit operator intent).
- **CRS handling** — inputs may be the pipeline's shared EPSG:3006 contract (legacy `crs`
  member, like detect-trees/fetch-water output) *or* the server's WGS84 `features.geojson`
  export — WGS84 is detected by coordinate range and reprojected. Rasterization runs
  through rasterio transforms in 3006 pixel space, `all_touched`, no GDAL binary (house
  rule intact).

### Inpaint runner (`pipeline/golfpipe/inpaint.py` — reusable, CLI-free; the T55 seam)

Two layers, both deliberately free of any CLI coupling so T55 (interactive editor
cleaning) can consume them directly:

- **`inpaint_tiled(image, mask, inpaint_fn, crop_size=512, overlap=64, progress=None)`**
  — pure orchestration over any `InpaintFn` (`(HxWx3 uint8, HxW bool) -> HxWx3 uint8`).
  Grids overlapping crops across the image, **skips crops with no masked pixels** (work is
  proportional to masked area), and feather-stitches results (linear ramp over the
  overlap, normalized weighted average, strictly-positive weights so single-crop pixels
  normalize exactly). Invariant, tested: pixels outside the mask come back byte-identical
  — seams can only land inside inpainted area. Model memory is bounded by crop size, so
  arbitrary-size orthos work.
- **`LamaInpainter(weights=None, device=None)`** — an `InpaintFn` running the TorchScript
  export of big-lama (Suvorov et al., WACV 2022) via `torch.jit.load` — no LaMa repo code
  needed. Weights resolve from `--weights` / `$GOLFPIPE_LAMA_WEIGHTS`, validated at
  construction (cheap, torch-free, fails fast with the download URL); torch imports lazily
  on first call with a crisp hint pointing at `pipeline/requirements-inpaint.txt`. Device:
  cuda if available else CPU; `--device mps` opt-in (LaMa's Fourier convolutions need
  torch's MPS FFT support, torch ≥ 2.1 — CPU is the safe default on the M-series and fine
  for batch).

### Dependencies & weights (not committed)

- `pipeline/requirements-inpaint.txt` — just `torch>=2.2,<3`; the base
  `requirements.txt` is untouched, and `golfpipe/inpaint.py` imports only
  numpy/stdlib at module level, so the base env stays slim.
- Weights: TorchScript big-lama, ~196 MB —
  `https://github.com/Sanster/models/releases/download/add_big_lama/big-lama.pt`
  (the same artifact lama-cleaner/IOPaint run; the original training checkpoint lives at
  `https://huggingface.co/smartywu/big-lama`). Documented in `pipeline/README.md`.
  A downloaded copy now sits at **`data/models/big-lama.pt`** (gitignored via `data/`) —
  set `GOLFPIPE_LAMA_WEIGHTS=$PWD/data/models/big-lama.pt`.

### CLI / output

`__main__.py` wires `clean-ortho` next to the other detect/tile commands;
`cmd_clean_ortho` in `commands.py` orchestrates (inpaint_fn injectable for tests; the
LamaInpainter is constructed lazily and **only when the mask is non-empty** — an empty
mask writes an unmodified copy without ever touching torch/weights). Output goes
**alongside** the source as `<stem>.clean.tif` (never overwrites — refusing `--out` ==
source is tested), preserving CRS/transform/dtype/compression from the source profile.
`--mask-out mask.tif` writes the rasterized mask for eyeballing before a long run.
`tile-ortho` can be pointed directly at the `.clean.tif` (same georeferencing) — noted
here only, no pipeline change.

## Live smoke — ran, on real Landeryd data

torch 2.13.0 (cp314, arm64) installed into `pipeline/.venv` via
`requirements-inpaint.txt`; big-lama.pt downloaded. Two runs on a 512 px crop of
`data/sources/208f4f4d-…/ortho-orto-l2-2025.tif` (row 5317 / col 5324 — fairway with
isolated crowns, shadows falling NW):

1. **Runner-level** (synthetic disk masks through `inpaint_tiled` + `LamaInpainter`):
   34,064 masked px, **8.4 s on CPU**, unmasked pixels verified byte-identical.
2. **Full CLI** (georeferenced crop GeoTIFF + a real `trees` polygon over one crown +
   fairway corridor, `--shadow-azimuth 315 --shadow-length 12`, real weights): mask came
   out 10,195 px (~261 m²), exit 0, output CRS/transform equal to source.

Eyeball verdict: the masked crown **and its NW shadow band are gone**, replaced with
convincing grass — texture continues from the surroundings, no visible seams or blur
blobs at this scale; neighboring unmasked crowns are untouched. One learning from run 1:
if the mask covers a crown only partially, LaMa plausibly *continues* the remaining dark
canopy into the hole — so mask quality (full crown + shadow, which is exactly what
detect-trees polygons + the shadow band produce) matters more than model settings.
Throughput estimate: ~8 s per 512 px crop on CPU → a full course corridor (a few hundred
mask-bearing crops at 0.16 m/px) lands in the tens-of-minutes range as a batch job;
`--device mps` may cut that if torch's MPS FFT path works on this install.

## Tests

`cd pipeline && ./.venv/bin/python -m pytest -q` → **149 passed** (baseline 115 + 34 new,
zero regressions), fully offline, no torch needed (and robust to torch *being* installed
— the lazy-import test blocks `sys.modules['torch']` instead of relying on absence):

- `tests/test_clean_ortho.py` (20) — shadow azimuth/offset correctness on synthetic
  squares (east/north, gap-free band for long shadows, zero-length empty), mask algebra
  (corridor clipping, manual-mask not clipped, margin dilation, empty cases), GeoJSON
  loading (3006 passthrough, WGS84 reprojection against rasterio-computed corners, typed
  selection, bad-file error), rasterize expectations, and CLI/command wiring with a fake
  fill inpaint (masked px changed / unmasked byte-identical / profile preserved / source
  untouched / default `.clean.tif` name; overwrite refusal; no-corridor error; end-to-end
  `main()` empty-mask run; missing-weights run exits 1 naming `$GOLFPIPE_LAMA_WEIGHTS`).
- `tests/test_inpaint.py` (14) — identity round-trip, multi-crop fill with unmasked
  pixels untouched, feathered blend strictly between two disagreeing crops' values (no
  hard seam), empty-mask short-circuit (fn never called), image-smaller-than-crop, window
  coverage/skip proportionality, shape/overlap validation, progress callback, lazy-import
  error message, weights errors (unset env, missing file, env resolution).

Real-model execution is excluded from pytest by construction (no test touches torch).

## Gaps / follow-ups

- **Shadow azimuth/length are per-flight constants** the operator reads off the source
  image; a future nicety could estimate them from flight metadata or the image itself.
- The whole ortho RGB is held in memory during a run (~340 MB for Landeryd) — crops bound
  the *model* memory, which is the expensive part; windowed raster I/O is a straightforward
  extension if a giga-ortho ever needs it.
- T55 consumes `inpaint_tiled`/`LamaInpainter` directly; keeping `golfpipe/inpaint.py`
  CLI-free is a standing constraint for that task.
- MPS was not exercised (CPU was fast enough for the smoke); `--device mps` exists but is
  unverified on this torch build.
