# Photo cleanup: trees, shadows, players and paths off the ortho photo

The course meshes in Unity are textured from the ortho photo, so a tree crown, its shadow, a golfer or a gravel path in the photo shows on the fairway beside the 3D tree that now stands there. Cleanup paints those out of the **cleaned photo** (`data/sources/<siteId>/ortho-<vintage>.cleaned.tif`, see [workflows.md](workflows.md) § 6) on the ground where the photo blends into the meshes: tees, fairways, semi-rough, rough and greens, plus bunkers and paths.

It runs **hole by hole**: your mapped surfaces and your drawn cleanup areas decide *where*, plain statistics decide *what*, and LaMa or PhotoCraft fills it. Each fill sees only its own surface, so fairway edges stay where you drew them and forest is never continued into the grass. Vreta was cleaned this way on 2026-10-10 (18 holes, about 13 minutes).

A run is a **proposal**: it cleans a copy of the photo and leaves a before | after image per hole. Nothing in the photo changes until you **apply** the holes you accept, which goes in as one undo step.

## The pieces

| Piece | Where |
|---|---|
| Web | Create › Clean photo › **Clean holes** (run, look, untick, Apply) and › **Areas** |
| CLI | `bun run photo -- clean <course> [--holes 1,3-9]`, `bun run photo -- accept <course> [<job>] [--skip 10,11]` (`scripts/cleaned-photo.ts`) |
| Server | `PhotoCleanupService` (`server/services/photo-cleanup.service.ts`): runs, review images, apply through `CleanedPhotoService.importImage`; API `/api/photo-cleanup*` |
| Pipeline | `golfpipe cleanup-hole` (one hole) and `cleanup-compose` (the accepted holes as one overlay), `pipeline/golfpipe/hole_cleanup.py` |
| LaMa (inpainting network, local GPU) | `pipeline/golfpipe/inpaint.py`, model `data/models/big-lama.pt` (or `$GOLFPIPE_LAMA_WEIGHTS`) |
| PhotoCraft (content-aware fill, headless) | `photocraft-cli` from a PhotoCraft checkout beside golf-map (`D:\crafts\photocraft\target\release\photocraft-cli.exe`), or `$GOLFPIPE_PHOTOCRAFT_CLI`. Rebuild: `cargo build --release -p photocraft-cli --manifest-path D:\crafts\photocraft\Cargo.toml`. Without it, semi-rough, tees and bunkers are filled by LaMa and each hole says so. |
| Runs on disk | `data/sources/<siteId>/photo-cleanup/<job>/`: `job.json`, the inputs, `h<n>/` per hole (`review.png`, `photo.png`, `filled.png`, `detect.png`, `overlay.png`, `changed.png`, `hole.json`). The newest 3 runs are kept. |

## 1. Draw the cleanup areas

Create › Clean photo › **Areas**. Pick a kind, drag to trace (or click corners), **Finish area** or Enter. Ctrl-drag pans, Escape cancels, Backspace drops the last corner. The green preview is what may be cleaned, purple is Clean everything, orange is protected.

| Kind | What gets cleaned inside it |
|---|---|
| **Area to clean** (green) | Only the mapped tees, fairways, semi-roughs, roughs and greens, grown 2 m over unmapped ground and deep rough. It may reach into the forest, since forest is not a mapped blend surface. |
| **Clean everything** (purple) | All ground, mapped or not, filled as the nearest blend surface. Water, creeks and rock slabs are still left alone. |
| **Keep unchanged** (orange) | Nothing. It wins over both other kinds, in any drawing order. |

How to draw them well (lessons from Vreta):

- Cover each hole and the ground between holes that a player sees, generously, with **Area to clean**.
- Use **Clean everything** where trees stand on ground not mapped as rough, often 10 to 20 m outside it. Let it **overlap the mapped rough by a few metres**: a gap between the two belongs to neither and leaves a sliver of shadow or a stump.
- Keep every edge clear of greens, bunkers and tree crowns. An edge across a green leaves the golfers on the far side; an edge through a crown leaves half a tree with a hard cut.
- Extend the area along a path as far as the path should vanish. A path stops abruptly where the cleaned ground ends.
- Draw **Keep unchanged** over anything inside that must stay, such as a pond's shore or a feature tree.

Done when the green preview covers every place you want clean and nothing you want kept.

## 2. Run the cleanup

**Web:** Clean photo › **Clean holes**. Type the holes (`1-9`, `3,5`; empty = every hole) and **Run**. About 30 to 60 s a hole; the list fills in as each hole finishes.

**CLI:** `bun run photo -- clean <course> [--holes 1-9]`. It prints a line per hole and the path of its `review.png`, then the `accept` command to run next. `<course>` is a course id or a unique part of its name (`vreta`, `omberg`).

The run makes the cleaned photo first if the site has none. Holes are cleaned in number order on one copy, so where windows overlap a hole sees the holes before it. A hole with no cleanup area over its surfaces changes nothing and says so; a hole that fails is reported and the others still run.

Done when the run's line reads `N of N holes cleaned`.

## 3. Review and apply

Look at each hole's before | after image (web: the thumbnail, click for full size; CLI: `review.png`). Untick (web) or `--skip` (CLI) any hole with a **serious defect**:

- a large area turned dark, black, murky or an obviously wrong colour;
- a green, fairway, tee or bunker that lost its shape, or was refilled wholesale (murky, or ringed in a pale outline);
- forest wiped outside the golf surfaces;
- a road, car park, cars or buildings changed.

**Known limits**, accepted as they are: small dark slivers at the edge of the cleaned ground, a few leftover players, soft texture where a large tree group stood, blocky marks on small tees, paths that stop abruptly at the edge of the cleaned ground.

The before | after image is scaled down and catches large failures only. Check `photo.png` against `filled.png` at full size before deciding about anything that looks like a bunker, green or tee appearing or vanishing (one appeared on Vreta's hole 1 that had been under trees). `detect.png` outlines what was found, `overlay.png` the surfaces and the scope.

Then **Apply N holes** (web) or `bun run photo -- accept <course> <job> [--skip 10,11]` (CLI; without a job it takes the newest run). The changed pixels of the accepted holes go into the photo as **one undo step**, and the map tiles under them are rewritten. Apply is refused when the photo changed after the run (a brush stroke, an import, an undo): run again. A run is applied once.

Finally **Update photo** (command bar, or `bun run gspro:update -- <course> photo`) puts it on the Unity meshes. Look at it in Unity: that is where it counts.

To take it back: **Undo last session** in the Clean panel (or `bun run photo -- undo <course>`), then Update photo again. To redo a single hole on top of an applied run, run just that hole again.

## Running it with an agent

Hand it to a Sonnet subagent: `bun run photo -- clean <course> [--holes …]`, then view every `review.png` against the review rules of section 3, then `bun run photo -- accept <course> <job> --skip <holes with a serious defect>`, then `bun run gspro:update -- <course> photo`. Constraints:

- Leave the scripts, the database and the cleanup areas as they are; report a failure's text (one retry).
- Skip the accept when more than three holes have serious defects.
- Report per hole: scope px, changed px, seconds, accepted or skipped, one line on what it saw; then the minor issues with rough positions, and the last lines of accept and Update photo.

Then look at the review images and Unity yourself before telling Marcus it is done.

## How each step decides

The rules live in `pipeline/golfpipe/hole_cleanup.py` as the module's constants; the values are the ones the Vreta pilot was tuned with, and they assume the 8192 px photo of a ~2 km square (0.25 m/px) where a value is in pixels.

**Where** (`scope_maps`)
- Window: the hole's saved map view, else the box round its tees, fairways, greens, semi-roughs and bunkers plus 40 m; then 15 m margin.
- Labels: 1 rough, 2 semi-rough, 3 fairway, 4 tee, 5 green, 7 bunker. Deep rough is cut out of the blend surfaces. Water, creeks and rock slabs block everything.
- The blend surfaces grow 2 m (`BUFFER_M`) over unmapped ground and deep rough; inside Clean everything they grow over all of it.
- Paths plus a 1.5 m shoulder (`PATH_SHOULDER_M`) are always targets, painted out as the nearest blend surface. A path on unmapped ground joins only within 6 m (`PATH_REACH_M`) of a blend surface and inside an area.
- The scope is labelled ground inside an Area to clean or Clean everything, minus Keep unchanged.

**What** (`detect_targets`)
- Per surface, a pixel is a target when it is darker than 80 % of the local lit brightness of that surface within about 7.5 m (crowns, shadows), or, on blend surfaces, small (at most 200 px, 12.5 m²) and far from the local lit colour (players, carts, bags). A larger off-colour patch is ground, such as dry grass.
- The lit level is taken over the whole window per surface type, so a tee or path lying entirely in shade is still recognised as shaded.
- Targets grow 6 px (1.5 m) to cover soft shadow edges, and holes in them are filled.
- Each surface's lit, untouched ground is PhotoCraft's sampling area.

**Fill, large grass** (`fill_lama`): LaMa per surface on rough, fairway and green; within 48 px of a target, everything that is not that surface is hidden too, so LaMa neither continues the forest nor blurs the fairway edge into the rough.

**Fill, small surfaces** (`fill_photocraft`): PhotoCraft `edit.contentAwareFill` per surface on semi-rough, tees and bunkers, with `sampling: custom` on that surface's lit ground, through one `photocraft-cli serve` session. LaMa paints dark blobs on small surfaces lying wholly in shade, which have no lit ground nearby; PhotoCraft copies lit texture of the same kind from anywhere in the window.

`changed.png` is every pixel the fills changed; apply lays exactly those pixels of the accepted holes over the photo (`cleanup-compose` writes them as one transparent PNG, `cleaned-replace` lays it over). The port into the repo was checked against the pilot scripts on Vreta's holes 4 and 10: the same window, scope, targets and filled pixels, byte for byte.

## Cleanup areas: storage and API

- Areas belong to the site's photo, so every course on that site sees them. Select a saved area to rename, redraw or delete it; **Undo area change** restores the previous set within the editing session. A concurrent change is refused: cancel the draft and **Reload areas**.
- **Download cleanup boundary** gives the effective scope as WGS84 GeoJSON: a `cleanup` feature (both including kinds, protected ground cut out) and, when one is drawn, a `cleanup-force` feature for the Clean everything part. The cleanup itself reads the stored areas.
- Builder APIs: `GET /api/cleanup-areas?courseId=<id>` (the versioned areas), `POST /api/cleanup-areas` with `{courseId, version, areas}`, `GET /api/cleanup-areas/export?courseId=<id>` (the GeoJSON above, with `siteId` and `version`).
- Cleanup APIs: `POST /api/photo-cleanup` `{courseId, holes?}` starts a run (400 without cleanup areas or for a hole the course lacks, 409 while one runs); `GET /api/photo-cleanup/job?courseId&jobId`, `GET /api/photo-cleanup/current?courseId` (`{ job }`, the running or newest run); `POST /api/photo-cleanup/apply` `{courseId, jobId, holes}` (409 when the photo changed since or the run was applied); `GET /api/photo-cleanup/<courseId>/<jobId>/<hole>/<review|photo|filled|detect|overlay>.png`.

## What did not work

- **An image model repainting 1024 px tiles** (the Codex `golf-course-cleanup` skill, `data/cleanup-jobs/`, 2026-10-09): it moved fairway outlines, turned grass yellow and missed players. Undone the next day.
- **PhotoCraft alone**: flat olive fills with blocky seams, and with default sampling it fills a tree on rough with fairway green.
- **Plain LaMa** over everything: it continues the forest and its shadow into the rough.
- **Filling paths as paths**: the whole drawn path came out as a flat beige ribbon, also where the photo shows no path. Painting them out as the surrounding ground replaced it.
