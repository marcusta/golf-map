# Hole 1: species and foliage revision

The second trial retains the same 118 positions and uniform scale limits (0.75–1.4).

| Species | First trial | Revised trial |
|---|---:|---:|
| Birch | 93 | 35 |
| Oak | 9 | 50 |
| Elm | 9 | 26 |
| Dwarf pine | 7 | 7 |

Species weights are oak 0.45, elm 0.40 and birch 0.15. They are preferences, not forced quotas. Species compete only within 0.8 of the best dimension-fit score. Within the chosen species, the existing fit and variation rules choose a prefab. Species sampling is deterministic per stem and independent of the number of prefab variants. Known conifers retain their separate selection rules; unknown detector classes retain explicit review status.

This tradeoff produces 41 flagged assignments versus 12 in the first trial: increasing oak/elm use accepts more crown/height mismatches. No scale limits were relaxed. The current palette lacks small elms and small narrow oaks, so some birches remain the better geometric option.

## Dedicated foliage copies

`Assets/GolfMap/Vreta/FoliageTrialV2` in the Unity project contains copies of the six oak/birch prefabs and two leaf materials. All mesh LOD leaf-material references in those copies point to the new materials. Original prefabs, original materials, bark and elm materials were not edited. VSP billboards remain disabled by the assignment importer; original standalone prefab billboard assets are not retuned by this pass.

- Oak CTI leaves: ambient scattering 4 → 1 (shader default), translucency strength 0.7 → 0.45. The installed shader adds ambient backlighting multiplied by these properties; the original values are a plausible cause of pale crowns. `_Color` is not used as an albedo tint by that shader, so changing it would not fix the effect.
- Birch NM leaves: healthy tint `(1, .974, .934)` → `(.8, .86, .74)` and dry tint `(.868, .818, .612)` → `(.75, .77, .56)`. This is an initial summer-green art adjustment, not an exact colour calibration.

Scattering alone did not remove the pale oak appearance. `unity/prepare-oak-tint.mjs` prepares an isolated shader named `GolfMap/CTI Oak Leaves Trial`, with a leaf-albedo multiplier, specular capped at 0.02 and smoothness capped at 0.15. Its private lighting include replaces CTI's Lux-specific deferred specular/normal encoding with ordinary Unity deferred encoding, matching Vreta's GraphicsSettings. This removed the mint highlights in editor inspection. It retains wind, alpha clipping and LOD logic and adds no keywords. Ordinary deferred direct lights do not gain Lux's custom translucency; the forward and ambient scattering paths remain. Only the trial oak material uses this shader. Its custom inspector does not expose the tint; use Debug view for `_GolfMapLeafTint`.

## Middle-brightness balance, 12 September

Following the user's side-by-side comparison, `unity/prepare-foliage-balance.mjs` stages a further balance after the shader preparation step:

- Oak tint `(0.32, 0.45, 0.23)`, ambient translucency 0.35 and translucency strength 0.25.
- Birch healthy tint `(0.65, 0.74, 0.50)` and dry tint `(0.60, 0.66, 0.40)`.
- Original planter's `Broadleaf_Desktop` gets a private prefab copy and nine leaf/frond material copies over LOD0–2. Each original leaf tint is multiplied by 1.15, clamped to 1. Bark and hue variation are unchanged. This is a material brightness adjustment, not a shadow-only shader change.

`GolfMap > Vreta > Apply foliage colour balance` switches the existing generic broadleaf catalogue entry to the copy, retaining its item ID, then refreshes vegetation materials without replanting. This affects existing generic broadleaf trees using that entry throughout Vreta, not only the 118 trial stems. On the applied run Unity reported one catalogue entry balanced and verified identical serialized persistent storage before/after. Original package assets remain unchanged. The scene view was inspected after applying; final artistic acceptance and distant billboard/wind checks remain. Billboard assets were not recoloured.

The prior oak/birch materials are backed up in `tree-export/foliage-before-balance`; the catalogue backup is under the Unity project's `GolfMapSpelunk/ColourBackups`. These are separate from tree storage backups. Re-running the earlier oak preparation script resets its material values; run the balance staging step afterwards to retain this revision.

The revised 118-tree import completed and verified all transforms and 24,303 unchanged outside instances. A fresh backup was created by the importer before replacement. Backups restore storage, not material settings; `tree-export/oak-leaves-before-tint.mat` preserves the trial oak material from before the shader-tint pass.

The staging script is `unity/prepare-foliage-trial.mjs`. Its manifest is in `tree-export/foliage-v2-stage/manifest.json`. It refuses an existing staging directory or an already migrated palette. The palette retains original catalogue GUIDs for thumbnail lookup and accepts old GUIDs in authored overrides, resolving them to the trial copies. Catalogue thumbnails still show the original material appearance.

Report: `tree-export/vreta-assignments-foliage-v2.json`; current hole subset and review page use this revision. The initial report predates the explicit algorithm label update; subsequent CLI reports identify `uniform-species-fit-v2`.

Six matcher tests pass, including species proportions over 3,000 equal-size stems, independence from birch variant count, and rejection of grossly incompatible size fits. The DOM review/override test also passes. Shader keyword exhaustion remains a separate project issue; full wind and distant LOD verification is still required.
