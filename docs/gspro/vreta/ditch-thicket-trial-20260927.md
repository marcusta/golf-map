# Ditch thicket trial — 2026-09-27

User-requested visual experiment against the supplied course photos. Verified in
Unity, not yet in GSPro/GreenKeeper. Marcus approved the appearance and requested
a commit after reviewing the trial.

## Scope and result

Tuned the existing lower-vegetation items in `creek_bank/thicket_wet` and the
two shared `Creek thicket - grass giant ...` items in `creek_bank/thicket`.
These are palette changes: every use of these thicket items gets the trial,
not only the photographed ditch. No normal tree palette, planted tree storage,
zone geometry, binding, terrain or source-pack asset was edited.

- Smaller and fewer willows; tall and shoot forms are now sparser than round/wide.
- Broad cottonwood canopy masses, scaled to 0.20–0.27 before noise variation,
  spaced at 3.1 m, lowered by 1.5 prefab-local metres (scaled with the instance).
- More low hazel and hazel clusters; maple remains a subordinate, sparse item.
- Shared clump noise creates low openings between shrub groups instead of a
  continuous hedge. Existing grass and reed masks fill the openings.
- Reduced the height/density of the giant grasses so shrubs are distinguishable.
- Cooler leaf tints, lower specular and AO, and non-mirrored back-face normals
  on the trial's course-local willow, hazel, maple and cottonwood materials.

The source cottonwood's yellow cast was particularly strong in the ground-level
view. Its final healthy/dry multipliers are `#6579b7` / `#7689b2`; these are
texture multipliers, not the resulting leaf colour. A full Apply followed by a
settled screenshot was used to verify the cooler result. Do not judge this
asset's rendered colour from its tint swatch.

Exact values are in `grass-palette.json` beside this note. Only the experiment's
items were copied into that repository snapshot; unrelated live palette edits
were not imported.

## Implementation and verification

`GolfMapGrass`, the vegetation palette model and live editor now expose
`noiseCutoff`, `noiseCutoffScale` and `verticalOffset`. Defaults keep the old
planting behaviour. Cutoff uses VSP's existing shared noise field; vertical
offset uses its instance-scaled local offset. No new shader/runtime component.

Sync check was clean before edits. Scripts compiled in Unity 2018.2 with no
errors. The palette was saved and rebuilt through `golfmap.grass.apply`;
the existing items retained their include/density mask rules. Reviewed the
original overview and both bank directions at 1.7 m eye height. Colour probes
and temporary density-zero diagnostics were restored; final density is 1.

The scene was already dirty at the start. Palette/package assets were saved;
the scene's unrelated unsaved work was not saved by this experiment.

## Comparison and rollback

Local, gitignored evidence and backups:
`tree-export/ditch-trial-20260927/` contains `grass-palette.before.json`,
`grass-palette.after.json`, `before-overview.png`, intermediate comparisons,
and final captures. The full before backup includes pre-existing live edits.

To undo, restore only the trial's willow, cottonwood, hazel, maple and giant-grass
items from the before backup into their matching palette slots; retain any
unrelated changes made since. Then reload the palette editor with
`golfmap.vegpalette.list reload=true` (after saving any unrelated pending edits),
and apply both `creek_bank/thicket` and `creek_bank/thicket_wet`.
The new controls can remain: missing cutoff/offset values default to disabled/0.

Overview camera: Unity eye `[1173.5, 32.48, 905.5]`, target
`[1143.67, 8.74, 884.61]`. Ground views: from `[1150, 0, 900]` towards
`[1134, 0, 886]`, and from `[1119, 0, 877]` towards `[1146, 0, 886]`, eye 1.7 m.
