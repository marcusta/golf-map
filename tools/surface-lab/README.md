# surface-lab — experiments for automating Draw

Experiments on drawing course surfaces automatically from the photo, the photo's near-infrared band (NIR) and the lidar DEM, scored against the courses Marcus has drawn. What came out of them is in the app as Draw › **Find bunkers…** / `bun run bunkers` (pipeline `propose-bunkers`): the surface model (`pilot/`) finds the bunkers, the NIR sand line (`bunkers.py`) draws their edges.

| Step | Command | Writes |
|---|---|---|
| 1. Drawn features per site | `bun tools/surface-lab/export-labels.ts` | `data/experiments/surfaces/<siteId>/features-<courseId>.geojson` |
| 2. Photo with NIR, DEM layers, drawn surfaces as rasters | `pipeline/.venv/Scripts/python.exe tools/surface-lab/prepare.py [--site <id>]` | `rgbi-2025.tif`, `dem-layers.tif`, `instances.tif`, `labels.tif`, previews (see the script's docstring) |
| 3. SAM box test cases | `pipeline/.venv/Scripts/python.exe tools/surface-lab/sam_cases.py [--site <id>]` | `data/experiments/surfaces/sam-bench/cases/*.npz` |
| 4. SAM box bench | `tools/sam-server/venv/Scripts/python.exe tools/surface-lab/bench_sam.py` | `sam-bench/results.csv`, `summary.md`, `sheets/` |
| 5. Furniture-seeded cases and bench | `furniture_cases.py` (pipeline venv), then `bench_furniture.py` (sam venv) | `furniture-bench/` |
| 6. Bunkers without SAM | `pipeline/.venv/Scripts/python.exe tools/surface-lab/bunkers.py box\|course\|rules\|model` | `bunkers/` (`box.md`, `rules.md`, `model.md`, course overlays) |
| 7. Surface model | `pilot/` (its README); the app's model: `pilot/train.py --holdout none --inputs rgbnd --bg --iters 5000 --out data/models/surfaces-unet-r34-rgbnd-bg.pt` | `data/experiments/surfaces/pilot/`, `data/models/` |

Step 2 downloads the 4-band photo tiles from Lantmäteriet (about 700 MB each, `LANTMATERIET_USER/PASS` from `.env`) unless a copy is already on disk.

What the numbers said (2026-10-22, five drawn courses):
- **Bunkers:** the surface model finds 265 of 270, with 45 false finds. The NIR sand line draws the edge 0.12 m (median) from Marcus's line; SAM in a box 0.15 m, the model's own edge 0.20 m.
- **Fairway, green, water, rough:** the model's IoU, testing each course on a model trained on the other four, is 80 / 80 / 78 / 76. SAM with a box gets fairways to only 0.62–0.66.
- **Tees:** SAM with a box + the type (0.75) does better than the model (54).
- **Semi rough:** an offset round tee or fairway.
- **Deep rough:** each course draws it its own way, so it cannot be learnt.
- **Inputs:** NIR adds nothing to the model or to SAM, but it is what makes the bunker edge work. The DEM helps the model on tees and water.
- **Furniture** (tee markers, green points, aim points) does not sharpen outlines. Its value is that no box is needed, plus the hole assignment.

The GPU is shared, and the open Unity editors already use most of it. Every CUDA job in the lab takes `gpulock.gpu_lock(...)` first, so only one job runs on it at a time.
