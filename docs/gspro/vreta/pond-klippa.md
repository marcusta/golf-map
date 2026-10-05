# Pond-side klippa

Added 2026-09-27 from Marcus's red outline on the aerial screenshot.
Centre approximately E 530095, N 6487337 (EPSG:3006), beside the pond.

The screenshot was registered to the 2025 ortho at 0.144 metres per screenshot
pixel (normalized correlation 0.969). `POND_KLIPPA` in `stone-walls.gen.py`
records its boundary. The existing `trace_face` workflow finds the west-facing
bank in the edited lidar: 27 stations, 36.5 metres along its foot, 2.24–5.71
metres high.

Revised with Marcus on 2026-09-28: the bank targets 65 degrees with 5 degrees
of variation, a 6 m circular shoulder (limited on low banks), and smoothing
along the upper rim. The shoulder can lower the original crest as well as
raise it; only raising left a sharp lip. `placeStones: false` keeps the steep
face free of the old 64 scattered blocks. The three top slabs remain.

The rock footprint is inset 1.8 m from the traced outline. Six irregular,
feathered grass pockets include the birch at E 530096.5, N 6487342.5 and the
tree at E 530103.5, N 6487329.5. These are `grassPatches` in the recipe,
specified as E, N, east radius, north radius.
The radii define envelopes, not circular lawns: domain-warped coordinates and
uneven lobes produce indented soil pockets with narrow extensions. Cliff
displacement blends into the original ground over 2 m at the foot and rear
join, with local smoothing at the toe to avoid a second sharp step.

The ground uses `Rockdetail4.tif` and its imported normal from the project's
Rocks and Boulders pack, tiled at 8 m. Blue paints the top; green blends in
over 35–60 degree slopes with brighter albedo and no amplified normal detail.
Both count as rock for vegetation. The stock OPCD shader and all original
texture-array slices remain; new rock slices are appended in course-owned
arrays. The original Mossy Rock material's soil/gravel texture, distance
blend to grass and height-mask bleed are no longer used for these channels.

`placedColors` persists the slab colour match, applied without moving the
objects by `golfmap.walls.colors` and after future wall builds.

Rebuild with the stone-walls generator and `golfmap.walls.build`, selecting
those four IDs. To change just ground paint/shape, run `golfmap.paint.apply`
without rebuilding hand-positioned slabs. After changes, export `golfmap.surfaces.export`, regenerate
vegetation with `bun run grass:zones -- Vreta`, then import the zones and apply
grass. Rock classification keeps generated tall grass off this outline.

Verified in Unity from the supplied camera: E 530058.3, N 6487356.9,
H 113.8, heading 121, tilt -32.6. GSPro runtime appearance has not been checked.
