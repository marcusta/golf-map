# Plan: site transfer between build machines

**Status:** decided 2026-09-06 (option B, full stack on Windows); W1 built
**Date:** 2026-09-06
**Scope:** `server/scripts` (export/import CLIs), `pipeline` (source recipe), small `docs`
change. Reuses the publish bundle format.

## 1. Purpose

Move a site from the Mac builder to a Windows machine that runs the GSPro/OPCD tooling.
Hand-made data travels. Downloaded data does not; the receiving machine fetches it again
from Lantmateriet using a recipe that pins exactly what was fetched. Derived data is
rebuilt from the two.

Two options exist, and they are not exclusive.

- **Option A, export package only.** The Mac runs every pipeline step and ships only the
  Unity-facing output: heightmap `.raw` and sidecar, ortho JPG, `unity-trees-v1`, and later
  surfaces. Under 100 M per site, no golf-map stack on Windows, no downloads there.
- **Option B, site transfer.** Windows runs the full golf-map stack. A site bundle carries
  the manual data and a source recipe; an import step refetches sources and rebuilds.

Decision: option B. The Windows machine becomes the content machine (map builds, web
editor, GSPro export); the Mac stays the development machine. Option A's package still
falls out of the Unity exporter and is what the Mac would use if it ever needs to feed
Unity directly.

The transfer is therefore two different things:

- **One-time migration of the current sites.** The full `data/` dir is 10 G (8.5 G of it
  lidar and orthos under `sources/`). Copying it once over the LAN or an SSD takes minutes,
  carries user data (rounds, plans, calibration) and every derived artifact unchanged, and
  needs no rebuild whose reproducibility is untested. Recommended. Re-downloading through
  the site bundle (section 5) works too, and is the fallback if copying is impractical.
- **Ongoing two-way movement of single sites.** Content lives on Windows. The Mac needs
  sites back as development fixtures, and a site built on either machine should be
  reproducible on the other. That is what the bundle plus recipe below is for.

## 2. What is manual, downloaded, derived

Per site under `data/`, measured on 208f4f4d (Landeryd) 2026-09-06.

| Data | Where | Class | Size |
|---|---|---|---|
| Content tables: sites, courses, holes, tees, greens, aim_points, course_features, hazards, pins seed | `app.sqlite` | manual | small, 8787 features |
| Terrain edits (op, params, rings; replayed onto the raw DEM) | `app.sqlite` `terrain_edits` | manual | rows |
| Ortho patch log and stamp images | `sources/<site>/patches/patches.json` + `N.png` | manual | 208 K |
| Clean-ortho manual masks, if any | `sources/<site>/` | manual | small |
| Lidar COPC tiles | `sources/<site>/lidar/*.copc.laz` | downloaded | 925 M |
| Ortho GeoTIFFs per vintage | `sources/<site>/ortho-<collection>.tif` | downloaded | 235 M each |
| Hydro and OSM GeoJSON | `sources/<site>/` | downloaded | small |
| Patched ortho, `dem.tif`, `dem-edited.tif`, `dem-analysis.tif`, `trees.geojson` | `sources/<site>/` | derived | 10 to 235 M |
| Tile pyramids, `manifest.json`, `tree-stems.json` | `tiles/<site>/` | derived | 150 to 250 M |
| `tile-archives/`, `course_assets` rows, `map_build_jobs` | | derived / local | |
| User data: game plans, rounds, shots, scans, calibration, clubs | `app.sqlite` | user | not needed for GSPro |

Manual data is a few hundred kilobytes. Everything large is downloaded or derived.

## 3. The bundle

`bun run site-export <siteId> [--out <dir>] [--with-user-data]` writes
`<siteId>.site.tar.zst`:

```
meta.json               bundle format, site id, pipeline git sha, exported at
content/<table>.jsonl   same writer as publish (server/scripts/publish.ts, CONTENT_TABLES)
content/pins.jsonl      seed pins
edits/terrain_edits.jsonl
edits/patches/          patches.json + stamp PNGs, copied verbatim
edits/masks/            manual clean masks when present
sources.json            the download recipe, section 4
user/<table>.jsonl      only with --with-user-data
```

Publish already exports the content tables and hashes them. The site bundle adds the
edit logs and the recipe, and leaves tiles out.

## 4. The source recipe

`sources.json` pins what the pipeline fetched, so the importer can fetch the same bytes
instead of "whatever is newest":

```json
{
  "bboxWgs84": [15.5556, 58.3944, 15.5763, 58.4053],
  "bufferM": 200,
  "lidar": { "collection": "laserdata-skog", "items": ["m21c011-647_53"] },
  "orthos": [
    { "collection": "orto-l2-2025", "items": ["..."], "role": "built" },
    { "collection": "orto-l2-2023", "items": ["..."], "role": "leaf-off" }
  ],
  "hydro": { "fetched": true }, "osm": { "fetched": true },
  "gridDem": { "resolution": 0.5, "classes": [2, 9] },
  "pipelineSha": "f15f22f0"
}
```

The fetch commands (`fetch-lidar`, `fetch-ortho`) already search STAC by bbox and write
the item ids as file names. Two changes make the recipe exact:

- Each fetch command writes the STAC item ids and collection it downloaded into
  `sources/<site>/sources.json` (merge, same pattern as `manifest.py`).
- Each fetch command accepts `--items <id,...>` to download those items instead of
  searching. Lantmateriet keeps old ortho collections, so a pinned 2023 or 2025 vintage
  stays fetchable.

Pinning matters for the replay steps. Terrain edits are rings in EPSG:3006 replayed onto
the gridded DEM, so they survive a regrid as long as the same lidar tiles and grid
parameters go in. Ortho patches are baked onto one vintage and are wrong on another.

## 5. Import

`bun run site-import <bundle> [--fetch] [--build]` on the receiving machine:

1. Insert content rows and pins. Refuse if the site id exists, unless `--replace`.
2. Insert `terrain_edits`, copy `patches/` and masks into `sources/<site>/`.
3. With `--fetch`: run `fetch-lidar --items`, `fetch-ortho --items` per vintage, hydro and
   OSM, from `sources.json`.
4. With `--build`: the normal map build for the site (grid-dem, apply-dem-edits,
   apply-ortho-patches, tiles, canopy, trees-stems, register). This is the existing
   `MapBuildService` job chain, run from the CLI.

Sizes: bundle under 1 M, downloads about 1.4 G per site from Lantmateriet, build time as
for a fresh site.

## 6. Windows setup

Run the whole golf-map stack inside WSL2 (Ubuntu). Unity and GSPro stay native Windows.
Reasons, from the repo as it is:

- `data/tiles/` contains a courseId to siteId symlink (`7CE5...` to `26D3...`). Native
  Windows symlinks need Developer Mode and behave differently in Explorer. WSL2 keeps them.
- `package.json` scripts and `scripts/*.sh` assume bash (`ios:deploy`, `trees:regen`).
- Map builds default to `pipeline/.venv/bin/python` (`MAP_PIPELINE_PYTHON` overrides).
- `tools/sam-server` and LaMa inpainting are torch; CUDA works under WSL2 and gives the
  Windows GPU to both.

What is not a blocker: the Python requirements are pure wheels (rasterio bundles GDAL,
laspy with lazrs, shapely bundles GEOS). No PDAL, no system GDAL. `bun` runs natively on
both sides.

Setup on the Windows box:

1. WSL2 Ubuntu, `git clone` of golf-map and `../mackans-client-fw` beside it (only
   `fw:update` needs the sibling; the vendored tarball under `vendor/` is what installs).
2. `bun install`, `cd web && bun install`, `pipeline/.venv` with `requirements.txt`,
   `tools/sam-server/venv` with its requirements, `curl` of `big-lama.pt` into
   `data/models/` (pipeline/README.md).
3. `.env` with `LANTMATERIET_USER`/`LANTMATERIET_PASS`, `PUBLISH_URL`/`PUBLISH_TOKEN`.
4. `data/` copied in (migration) or built from bundles.
5. Keep `data/` on the Linux filesystem (`~/`), not under `/mnt/c`. Cross-filesystem I/O
   in WSL2 is slow enough to hurt tiling. Write the Unity export to `/mnt/c/...` or read it
   from `\\wsl$\Ubuntu\...` in Unity.

Publishing to the VPS runs from Windows afterwards with the same `bun run publish`.

## 7. Work items

- W1 (built 2026-09-06): `fetch-lidar`, `fetch-ortho`, `fetch-dem` record collection,
  STAC item ids, files, bbox and buffer into `sources/<site>/sources.json`
  (`golfpipe/sources.py`, merged per kind and per ortho vintage) and accept
  `--items id,id` to refetch a pinned set. Recipes only exist for sites fetched after
  this change; earlier sites get one on their next rebuild, or by hand from the file
  names under `sources/<site>/` (lidar file name = STAC item id).
- W2: `site-export` CLI reusing publish's content writer; add edits and recipe.
- W3: `site-import` CLI with `--fetch` and `--build`.
- W4: round-trip test: export Landeryd, import into an empty data dir, build, compare
  `tree-stems.json` count and DEM checksum against the Mac.
