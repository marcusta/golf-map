# Vegetation zones — rasterizer validation

Synthetic renders of `pipeline/gspro.py zones` (docs/feature-vegetation-zones.md, section 6),
made with the real rasterizer (`gspro.render_zone_masks`) on hand-built zones, no course
database. Regenerate with `pipeline/.venv/Scripts/python.exe docs/validation/vegetation-zones/render.py`
(`pipeline/tests/test_gspro_zones.py` asserts the same numbers).

## `synthetic-zones.png`

A 400 m square at 800 px (0.5 m/px, the density a 4096 mask gives the 2050 m inner
terrain). Six zones of four types in document order:

1. `rough_tall`, weight 1, feather 8 m — the big olive blob with the soft edge.
2. `shrub`, weight 0.7, feather 4 m, noise 3 m — drawn over the rough; its edge wanders
   (value noise on the signed distance, seed 3) and where it overlaps the rough it takes
   0.7 and the rough keeps 0.3 (later zone claims first).
3. `fern`, weight 1, feather 3 m, noise 1.5 m — inside the rough; it claims fully, so the
   rough channel is zero under it and crossfades back over the feather.
4. `meadow`, weight 0.5, feather 0 — a hard-edged rectangle with a hole (even-odd), drawn
   last; under it the rough drops to exactly 0.5.
5. `shrub`, weight 1, feather 0 — a lone hard-edged zone.
6. `fern`, weight 0.3, feather 6 m — a lone zone that stays at 0.3 (nothing scales up).

Left: colour composite, each type's colour times its weight over a pale ground. Right: the
packed RGBA mask exactly as the exported `<stem>-0.png` holds it (R rough_tall, G shrub,
B fern, A meadow shown as white). Bottom: the four channel weights along the red line
(y = 250 m) and, in grey, their sum — flat at 1 wherever anything is drawn at full weight,
0.5 under the meadow, and never above 1 anywhere (max channel sum printed on the image).

## `synthetic-zones-mask-0.png`

The raw RGBA mask from the same render, the file format Unity imports (readable RGBA32,
one texture mask group per channel).
