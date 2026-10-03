# Plan: cleaned-photo export and re-import loop

**Status:** proposed 2026-10-03, awaiting go and the Windows auto-clean branch
**Scope:** `pipeline/golfpipe` (two commands, one log entry kind), `server` (three routes), `web/src/clean` (one panel section)

## 1. Purpose

Some photo cleaning is faster in an external image editor than in the Clean tool. The builder
needs to export the cleaned photo as one square 8192 px image, edit it outside, import the
result, and repeat. The pristine photo and the cleaned photo stay separate, as they are
today. Every import becomes one more entry in the existing patch log, so revert, replay,
rebuild and the sim tile overlay keep working unchanged.

## 2. What exists

- Pristine ortho: `data/sources/<siteId>/ortho-<vintage>.tif`, EPSG:3006, 0.16 m/px on
  Linkan (10648 x 10635 px, 1.7 km square).
- Patch log: `data/sources/<siteId>/patches/patches.json`, version 2, entry kinds `mask`
  (LaMa) and `stamp` (clone brush). golfpipe replays the log from the pristine file into
  `ortho-<vintage>.patched.tif`. That file is the cleaned photo.
- Sim tiles: bakes retile only patch-affected tiles into `tiles/<siteId>/ortho-sim/`
  (92 tiles on Linkan today, against 19,872 pristine tiles). The tile route falls back to the
  pristine tile. Planner, draw mode and iOS never see the sim layer.
- `pipeline/gspro.py ortho` renders a square EPSG:3006 extent to a JPEG, 8192 px default,
  from a WGS84 bbox. It takes a GeoTIFF path and knows nothing about sites or the log.
- Nothing imports pixels. The Windows machine has an unpushed change that auto-cleans
  bunkers and paths because they halo in game. Its output location and mechanism are
  unknown to this plan. Section 7 states the contract it has to meet.

## 3. Decisions

**D-OX1. One fixed square frame per site.** `data/sources/<siteId>/sim-frame.json` holds
`{ extent3006: [e0, n0, e1, n1], size: 8192 }`. The first export creates it from the tile
manifest bounds, squared the way `gspro.py` already does. Every later export, the Unity
texture, the future heightmap exporter and every import use this frame. Reprojection is
EPSG:3006 to EPSG:3006, so an export is a resample, never a rotation. The frame can be set
once from a bbox for a site whose Unity texture already exists.

**D-OX2. The export source is the replayed log, nothing else.** Export reads the
`.patched.tif` after `bake-ortho-patch` has brought it up to date. There is no second
"cleaned raster" path. Whatever the Windows auto-clean does has to land in the log
(section 7).

**D-OX3. Import stores a diff, not the whole image.** The server keeps every export on disk.
An import is compared pixel by pixel with the export it was edited from. Pixels that differ
by more than a tolerance in any channel, dilated 1 px, form the change mask. Only those
pixels are written back. Reasons:

- Untouched areas keep source resolution. The export is 0.21 m/px on Linkan, the source is
  0.16 m/px. Writing the whole image back would soften the whole course on every round trip.
- Imports compose. An import edited from export 3 still applies correctly on top of a log
  that has grown since export 3, because it only carries what the user changed.
- Storage stays small. A diff PNG is a few megabytes, a full 8192 PNG is 100 to 200 MB.

**D-OX4. New log entry kind `raster`.** Version 2 of the log gains a third kind. The entry
holds an RGBA PNG cropped to the change bbox, alpha 255 on changed pixels, with
`bounds3006` as the authoritative frame and `bounds3857` derived for retiling. Replay is a
windowed alpha composite onto the ortho grid, bilinear, torch-free, byte-reproducible. This
kind also fits any other externally produced raster change (section 7).

**D-OX5. Export files are numbered and immutable.** `data/sources/<siteId>/exports/<n>/`
holds `ortho-sim-<n>.png`, `ortho-sim-<n>.pgw` (world file) and `export.json`. The JSON
carries `exportSeq`, `extent3006`, `size`, `logSeq` (highest patch seq at export time),
`sha256` of the PNG, and `createdAt`. An import names the export it came from; default is
the latest.

**D-OX6. Lossless by default.** Export writes PNG. `--format jpg` exists for a direct Unity
texture but an import from a JPEG is refused unless `--tolerance` is raised explicitly,
because JPEG noise would mark the whole image as changed.

**D-OX7. The loop is export, edit, import, export.** Each import is diffed against the
export it was edited from. The next export includes it. Nothing in the chain requires the
user to import before exporting again, and nothing breaks if an export is skipped.

## 4. Pipeline

Two commands in `golfpipe/commands.py`, geometry in a new `golfpipe/square_frame.py`,
composite in `patches.py`.

```
golfpipe export-ortho-square --ortho <patched.tif> --frame <sim-frame.json> \
    --out-dir <exports/n> --seq <n> --log-seq <k> [--size 8192] [--format png|jpg]

golfpipe import-ortho-square --ortho <patched.tif> --patches-dir <patches> \
    --export-dir <exports/n> --image <edited.png> --seq <new log seq> \
    [--tolerance 2] [--min-area-px 4]
```

`export-ortho-square`: creates `sim-frame.json` from `--bounds-wgs84` when it is missing,
refuses to change an existing frame, reprojects bands 1 to 3 bilinear into size x size,
writes PNG, world file and `export.json`, prints the JSON.

`import-ortho-square`: validates the image size against `export.json`, computes the
change mask, drops connected regions below `--min-area-px`, dilates 1 px, crops to the
mask bbox, writes `patches/<seq>.png` as RGBA, prints the log entry fields
(`bounds3006`, `bounds3857`, `changedPixels`, `exportSeq`). The server appends the entry
and runs the existing `bake-ortho-patch --seq`, which composites and retiles.

`patches.py`: `RasterEntry` dataclass, `raster_entry_into(dataset, patches_dir, entry)`,
`load_patch_log` accepts `kind == "raster"`, `bake_entry_into` dispatches it,
`needs_inpaint` stays false for raster entries.

Composite rule: the RGBA PNG is in the frame grid (0.21 m/px). It is reprojected onto the
ortho window bilinear, alpha included, and composited `out = src * a + dst * (1 - a)` with
`np.rint`. The alpha edge after resampling is one source pixel wide, which is the seam
treatment. Tests pin determinism, a zero-alpha no-op, an off-raster crop, and that pixels
outside the mask are byte-identical.

Numbers to expect on Linkan: export resample about 3 s, PNG encode about 10 s, 8192 PNG
about 150 MB. Import diff about 2 s. Retile cost scales with the change bbox; a change
spread over the whole course rewrites the full z14 to z20 sim subtree, about 20,000 tiles,
which is minutes, not seconds. The panel shows the bbox area before the user confirms.

## 5. Server

`OrthoPatchesService` gains three operations, all queued per site like apply and revert.

- `POST /ortho-patches/export` `{ courseId, format? }`. Brings the working raster up to
  date (`bake-ortho-patch` with no seq is a no-op when nothing is stale, otherwise it
  replays), runs `export-ortho-square`, returns `export.json` plus a download path.
- `GET /ortho-patches/export/:siteId/:seq/file`. Streams the PNG with `Content-Disposition`.
  Builder mode only, auth required, same as the other ortho-patch routes.
- `PUT /ortho-patches/import/:courseId?exportSeq=<n>&tolerance=<t>`. Raw body, the
  hand-pumped sink from `photos.routes.ts`, 400 MB cap, PNG signature check, writes to
  `patches/.incoming`, runs `import-ortho-square`, appends the `raster` entry, bakes and
  retiles with the existing machinery, bumps `patchesGeneratedAt`, deletes the incoming
  file. Pipeline failure rolls the entry back, as apply does today.
- `GET /ortho-patches/info` adds `exports: [{ seq, createdAt, logSeq, size }]` and `frame`.

`dev:server` sets `BODY_LIMIT` to 64 MB. The import route needs 400 MB. Raise it for
builder mode only.

The TypeScript `PatchLogEntry` gains `kind: 'raster'`, `bounds3006`, `exportSeq`,
`changedPixels`. The generated client `shared/api/ortho-patches.gen.ts` is regenerated,
never hand-edited. The raw-body route is a Hono route beside the descriptor API, as the
photo file route is.

## 6. Web

The Clean panel gets an "External edit" section below the pending-edit controls.

- Export button. Shows the frame size and the export count. On success it shows the file
  path and a download link. Disabled while a bake runs.
- Import control. A file input, an export picker defaulting to the latest, a tolerance
  field hidden behind "Advanced". On pick it uploads with progress, then shows the server's
  change summary (changed pixels, bbox in metres, tiles to rewrite) and runs the same
  seamless refresh the bake path uses. The patch count and revert-last include the import.
- Revert last patch already covers an import entry. No new revert UI.

The service exposes `exportPhoto()`, `importPhoto(file, exportSeq, tolerance)`,
`exports` and `frame` signals. Tests use the existing fetch seam.

## 7. Contract for the Windows auto-clean

The bunker and path auto-clean must be visible to the export. Two ways satisfy D-OX2:

1. **As a log entry kind with parameters.** `kind: "auto"` carrying the feature types, the
   margin and a hash of the feature polygons used, replayed by golfpipe from the course
   features. This is the right shape if the auto-clean is a mask plus LaMa or a mask plus
   a fill rule, because it survives feature edits and rebuilds. It needs the branch
   pushed so the replay function can be wired into `bake_entry_into`.
2. **As a `raster` entry.** If the auto-clean already produces a modified raster, a
   one-shot `golfpipe import-ortho-square`-style diff against the pre-auto-clean raster
   turns it into a `raster` entry. No new replay code, but a feature edit does not
   re-run it.

Either way, the export then includes it, the ortho-sim tiles show it, and revert peels it.
Until the branch is on the remote this plan assumes option 1 and leaves the `auto` kind
unimplemented. Pushing the branch before OX1 starts avoids a conflict in `patches.py`
and `commands.py`, which both sides touch.

## 8. Workflow walkthrough

1. Builder presses Export. Server replays anything stale, writes `exports/1/`, panel shows
   the path.
2. Builder opens `ortho-sim-1.png` in the image editor, fixes things, saves as PNG.
3. Builder imports the file against export 1. Server stores `patches/24.png` holding only
   the changed pixels, bakes, retiles the change bbox, bumps the sim version. The map
   shows the result with "Show cleaned photo" on.
4. Builder cleans more in the tool, stamps and masks append as seq 25 and 26.
5. Builder presses Export again. `exports/2/` includes everything through seq 26.
6. Repeat from step 2 against export 2. An import against export 1 at this point still
   works and still touches only its own changed pixels.
7. Unity texture: `exports/<n>/ortho-sim-<n>.png` converted to JPEG q95 by the exporter's
   `--format jpg`, same frame every time, so the texture drops in without re-aligning.

## 9. Work briefs

| Brief | Model | Owns | Deliverable |
|---|---|---|---|
| OX1 | opus | `pipeline/golfpipe/square_frame.py`, `patches.py`, `commands.py`, `__main__.py`, `tests/test_square_frame.py`, `tests/test_patches.py` | Both commands, `raster` kind, determinism and seam tests, Linkan dry run with timing |
| OX2 | opus | `server/services/ortho-patches.service.ts`, `server/api/ortho-patches.api.ts`, new `ortho-patches.routes.ts`, tests, regenerated client | Export, download, import routes with rollback and version bump |
| OX3 | sonnet | `web/src/clean/clean-panel.component.ts`, `clean-tool.service.ts`, tests | Panel section, upload with progress, refresh |
| OX4 | sonnet | `docs/`, `pipeline/README`, `web/AGENTS.md` | Operator notes, frame setup for an existing Unity site |

OX1 first. OX2 and OX3 in parallel after OX1 fixes the CLI output shape. OX4 last.

## 10. Open questions

- Which bbox did the existing Linkan Unity texture use? The frame should match it, or the
  next texture drop needs re-alignment in Unity. If unknown, the manifest-derived square is
  the default and the texture is re-imported once.
- Does the image editor on Windows preserve PNG pixels exactly? Photoshop with a colour
  profile conversion can shift every pixel by one level. The default tolerance of 2 covers
  that; the import summary reports the changed-pixel count so a whole-image shift is
  obvious before confirming.
- Should an import that touches more than, say, 30 percent of the frame require a second
  confirmation? Proposed yes, in the panel only.
