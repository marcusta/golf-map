# Photo cleanup: trees, shadows, players and paths off the ortho photo

The course meshes in Unity are textured from the ortho photo, so a tree crown, its shadow, a golfer or a gravel path in the photo shows on the fairway beside the 3D tree that now stands there. Cleanup paints those out of the **cleaned photo** (`data/sources/<siteId>/ortho-<vintage>.cleaned.tif`, see [workflows.md](workflows.md) § 6) on the ground where the photo blends into the meshes: tees, fairways, semi-rough, rough and greens, plus bunkers and paths.

It runs **hole by hole**: your mapped surfaces and your drawn cleanup areas decide *where*, plain statistics decide *what*, and LaMa or PhotoCraft fills it. Each fill sees only its own surface, so fairway edges stay where you drew them and forest is never continued into the grass. Vreta was cleaned this way on 2026-10-10: 18 holes, about 13 minutes, run by a Sonnet subagent for about 56k tokens.

## The pieces

| Piece | Where |
|---|---|
| Pilot scripts (`work.py`, `prep.py`, `detect.py`, `fill_lama3.py`, `fill_pc.py`) | `D:\crafts\photocraft-work\pilot\`, outside the repo. They read `data/app.sqlite` read-only and never write the cleaned photo themselves. |
| Python | `D:\golf-map\pipeline\.venv\Scripts\python.exe` (rasterio, scipy, torch). Called `$py` below. |
| LaMa (inpainting network, local GPU) | `pipeline/golfpipe/inpaint.py` and the model `data/models/big-lama.pt` |
| PhotoCraft (content-aware fill, headless) | `D:\crafts\photocraft\target\release\photocraft-cli.exe`. Rebuild: `cargo build --release -p photocraft-cli --manifest-path D:\crafts\photocraft\Cargo.toml` |
| Cleanup areas | Web editor: Create › Clean photo › **Areas**, stored per site in the `cleanup_areas` table |
| Import, undo, Unity | `bun run photo -- import\|undo <course>`, then **Update photo** |

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

## 2. Clean the holes

The cleaned photo must exist first: `bun run photo -- info <course>` says so, and `bun run photo -- export <course>` makes it from the pristine photo if not. Run everything below with the pilot folder as cwd. `<course>` is a case-insensitive part of the course name (`vreta`, `omberg`).

1. `$py work.py init <course> work.png` makes an 8192 px working copy of the cleaned photo. Holes overlap, so they are cleaned one after another on this one copy.
2. For each hole N, into `holes\hN`:
   1. `$py prep.py <course> N holes\hN work.png` writes the window, `labels.png`, `scope.png`, `paint-out.png` and `overlay.png`. It prints `scope_px`; **0 means no cleanup area there**, so skip the hole.
   2. `$py detect.py holes\hN` writes `targets.png`, `source-<n>.png` and `detect.png` (targets outlined in magenta), and prints `target_px` per surface.
   3. `$py fill_lama3.py holes\hN 48 1,3,5` fills rough, fairway and green with LaMa into `filled-lama.png`.
   4. `$py fill_pc.py holes\hN none filled-lama.png filled.png 2,4,7` fills semi-rough, tees and bunkers with PhotoCraft into `filled.png`.
   5. Review `photo.png` beside `filled.png` (section 3). If it passes, `$py work.py paste holes\hN work.png`. If it fails, skip the paste and note the hole.
3. `bun run photo -- import <course> D:\crafts\photocraft-work\pilot\work.png`: all pasted holes become one undo step. Done when it prints the changed pixel count.
4. **Update photo** (command bar, or `bun run gspro:update -- <course> photo`) puts it on the Unity meshes. Look at it in Unity: that is where it counts.

To take a batch back: `bun run photo -- undo <course>`, then Update photo again. To redo a single hole on top of an imported batch, start a fresh `work.py init` (it reads the current cleaned photo) and run just that hole.

## 3. Review a hole

A hole is **held back** (not pasted) when it shows a serious defect:

- a large area turned dark, black, murky or an obviously wrong colour;
- a green, fairway, tee or bunker that lost its shape, or was refilled wholesale (murky, or ringed in a pale outline);
- forest wiped outside the golf surfaces;
- a road, car park, cars or buildings changed;
- a script error.

**Known limits**, listed but pasted: small dark slivers at the edge of the cleaned ground, a few leftover players, soft texture where a large tree group stood, blocky marks on small tees, paths that stop abruptly at the edge of the cleaned ground.

A side-by-side scaled to 800 px per side catches large failures only. Check a full-resolution crop before deciding about anything that looks like a bunker, green or tee appearing or vanishing (one appeared on Vreta's hole 1 that had been under trees).

## Running it with an agent

Hand it to a Sonnet subagent with the steps of section 2, the review rules of section 3, and these constraints:

- Run the scripts as they are; report a failing script's error text rather than patching it (one retry).
- One review image per hole: `photo.png` and `filled.png` side by side, scaled so the pair is at most 1600 px wide, saved as `holes\hN\review.png`.
- Skip the import when no hole was pasted or more than three had serious defects.
- Report per hole: `scope_px`, `target_px`, seconds, pasted or not, one line on what it saw; then the minor issues with rough positions, the last lines of the import and Update photo, and the start and end clock times.

Then look at the review images and Unity yourself before telling Marcus it is done.

## How each step decides

**prep.py** (where)
- Window: the hole's saved map view, else the box round its tees, fairways, greens, semi-roughs and bunkers plus 40 m; then 15 m margin.
- Labels: 1 rough, 2 semi-rough, 3 fairway, 4 tee, 5 green, 7 bunker. Deep rough is cut out of the blend surfaces. Water, creeks and rock slabs block everything.
- The blend surfaces grow 2 m (`BUFFER_M`) over unmapped ground and deep rough; inside Clean everything they grow over all of it.
- Paths plus a 1.5 m shoulder (`PATH_SHOULDER_M`) are always targets, painted out as the nearest blend surface. A path on unmapped ground joins only within 6 m (`PATH_REACH_M`) of a blend surface and inside an area.
- `scope.png` = labelled ground inside an Area to clean or Clean everything, minus Keep unchanged.

**detect.py** (what)
- Per surface, a pixel is a target when it is darker than 80 % of the local lit brightness of that surface within about 7.5 m (crowns, shadows), or, on blend surfaces, small (at most 200 px, 12.5 m²) and far from the local lit colour (players, carts, bags). A larger off-colour patch is ground, such as dry grass.
- The lit level is taken over the whole window per surface type, so a tee or path lying entirely in shade is still recognised as shaded.
- Targets grow 6 px (1.5 m) to cover soft shadow edges, and holes in them are filled.
- `source-<n>.png` is the lit, untouched ground of each surface, used as PhotoCraft's sampling area.

**fill_lama3.py** (large grass): LaMa per surface; within 48 px of a target, everything that is not that surface is hidden too, so LaMa neither continues the forest nor blurs the fairway edge into the rough.

**fill_pc.py** (small surfaces): PhotoCraft `edit.contentAwareFill` per surface with `sampling: custom` on that surface's `source-<n>` channel, through one `photocraft-cli serve` session. LaMa paints dark blobs on small surfaces lying wholly in shade, which have no lit ground nearby; PhotoCraft copies lit texture of the same kind from anywhere in the window.

## Cleanup areas: storage and API

- Areas belong to the site's photo, so every course on that site sees them. Select a saved area to rename, redraw or delete it; **Undo area change** restores the previous set within the editing session. A concurrent change is refused: cancel the draft and **Reload areas**.
- **Download cleanup boundary** gives the effective scope as WGS84 GeoJSON: a `cleanup` feature (both including kinds, protected ground cut out) and, when one is drawn, a `cleanup-force` feature for the Clean everything part. The scripts read the `cleanup_areas` table directly instead.
- Builder APIs: `GET /api/cleanup-areas?courseId=<id>` (the versioned areas), `POST /api/cleanup-areas` with `{courseId, version, areas}`, `GET /api/cleanup-areas/export?courseId=<id>` (the GeoJSON above, with `siteId` and `version`).

## What did not work

- **An image model repainting 1024 px tiles** (the Codex `golf-course-cleanup` skill, `data/cleanup-jobs/`, 2026-10-09): it moved fairway outlines, turned grass yellow and missed players. Undone the next day.
- **PhotoCraft alone**: flat olive fills with blocky seams, and with default sampling it fills a tree on rough with fairway green.
- **Plain LaMa** over everything: it continues the forest and its shadow into the rough.
- **Filling paths as paths**: the whole drawn path came out as a flat beige ribbon, also where the photo shows no path. Painting them out as the surrounding ground replaced it.
