# Tree rendering fixes

Troubleshooting record for automated trees in Unity 2018.2.8f1, Vegetation Studio Pro
(VSP), and GSPro. Read this before changing tree materials, shaders or planting.
Project paths and script-copy workflow live in [unity/AGENTS.md](../unity/AGENTS.md).

Record new fixes here with the symptom, actual material/shader, cause, exact change,
refresh steps and where the result was verified. Separate confirmed results from
experiments: a Unity result does not establish the GSPro result.

## Arborist birch colour and dark leaves, 2026-10-12

Verified visually in Arborist on Vreta, not in GSPro. The library's
`S7_European_White_Birch` uses `Arb_AwesomeTechnologies/VS_SpeedTree`, not the
course's Forst/CTI birch. A black `TintColor1` probe removed the pale leaf areas;
the inspected leaf material exposes no smoothness/specular controls. Disabling
`EFFECT_BUMP`, the directional light's shadows, or postprocessing AO individually
did not resolve the dark-leaf contrast in the comparison view.

Leaf colour: `TintColor1 = #527e4b`, `TextureSaturation = 0`, texture brightness
kept at 0. This removes the texture's yellow/olive hue variation while retaining
its detail. Applied to both birch looks and their controller arrays; species
mapping records the same tint for regeneration. Billboard settings are unchanged.

Postprocessing also matters: the active ACES colour grading had
`lift.w = -0.20678772032260896`. Raising only that component to `-0.03` retains
more detail in dark leaves. This is a whole-view adjustment, saved separately
in the course's `arborist_postprocess.dat`; no claim yet about its use in GSPro.
AO, exposure, gamma, gain and all other postprocessing settings were retained.
Experiments with flatter ambient light also reduced contrast, but the original
Trilight colours, directional intensity 1.1 and shadow strength 0.556 were restored.
The temporary normal-map probe was reset through `RefreshVegetationSystem`.
After `LoadPostProcessingData` and `SetPostProcessingUISettings`, the lift value
was confirmed from disk and every other postprocessing parameter matched the
snapshot. Ambient lighting had changed to Flat/0.596 during this reload sequence;
the session's original Trilight values were reapplied. Do not assume a postprocess
reload preserves viewer lighting. The original ambient colours were sky
(0.72, 0.68, 0.704), equator (0.678, 0.768, 0.662), ground
(0.5019608, 0.490196079, 0.458823532).

Local originals and diagnostic scripts are in
`tree-export/arborist-birch-20261012/`: `before.dat`, `before.biome`,
`species-before.json`, `postprocess-before.dat`, and the decoded/updated files.
The vegetation-file patch changes only 40 colour properties on four birch items;
all placements, other species and billboard settings are preserved.

## Exposed rock material, 2026-09-28

Confirmed in Unity: `EditorUtility.CopySerialized` rewrote the painted mesh's
CPU data and collider while the renderer retained old vertex buffers. This
made repeated crest rounding and green-channel painting appear ineffective.
`GolfMapVertexPaint.SetMesh` now reassigns vertices, normals and colours before
`UploadMeshData(false)` and rebinding the mesh. Upload/rebinding alone did not
resolve it. The corrected render visibly shows the rounded shoulder and grass
pockets; reduce the steep-face AO multiplier to 1.6 after this refresh. GSPro
runtime has not been checked.

Verified in Unity; GSPro runtime still unverified. A blue-painted klippa looked
like grass because the stock OPCD Mossy Rock preset uses soil/gravel detail,
blends to a grass-like base at distance, and lets underlying colour through
its height mask. `GolfMapWallGround` now supports appended exposed-rock texture
slices on the same stock shader, disables that channel's base-distance blend,
and uses a white height mask so full paint means full rock. Original texture
slices were compared after script reload and preserved. Green provides a
brighter steep-face variant: OPCD's slope shading multiplies colour toward
black by `acos(normal.y) * _SlopePower` (0.604 in this course), independent of
the normal-map setting. See the Stone walls section of `unity/README.md` and
`docs/gspro/vreta/pond-klippa.md` for the recipe and verification commands.

## Confirmed: oak turns white from one angle

**Confirmed by Marcus in Unity on 2026-09-17. GSPro not yet checked.**

### Symptom and cause

Automatically planted oaks looked pale/white from one viewing direction and green
from another. The shared material was
`Assets/GolfMap/Vreta/FoliageTrialV2/Oak Leaves.mat`, used by the four
`PF_Oak_* Terrain` palette prefabs.

It used `NatureManufacture Shaders/Trees/Tree Leaves Metalic`. Both
`_MetallicPower` and `_SmoothnessPower` were already zero. Zero metallic still
leaves dielectric specular reflection; zero smoothness broadens the reflection
rather than removing it. Against dark foliage, this can produce white highlights
that change with viewing angle.

The material also contained `_SPECULARHIGHLIGHTS_OFF`, but the stock NM shader
does not declare that shader variant, so the flag had no effect. Its saved CTI
translucency properties were leftovers: the active NM shader did not read them.
Changing those values would not address this rendering path.

### Exact fix

| Setting | Before | After |
| --- | --- | --- |
| Shader | `NatureManufacture Shaders/Trees/Tree Leaves Metalic` | `NatureManufacture Shaders/Trees/Tree_Leaves_Specular` |
| `_SpecularPower` | Not used by metallic shader | `0` |
| `_SmoothnessPower` | `0` | `0` |
| AO/smoothness texture slot | `_MetalicRAOGSmothnessA` | Same texture also assigned to `_AmbientOcclusionGSmoothnessA` |
| `_SPECULARHIGHLIGHTS_OFF` keyword | Present but ineffective | Removed |

The specular shader writes albedo multiplied by `_SpecularPower` into its specular
output. With that output and smoothness both zero, Unity 2018's desktop BRDF1
removes both direct and indirect specular. This uses the existing stock shader,
whose exact name VSP recognises; no shader source was changed or renamed.

Preserved: albedo texture, healthy/dry tints, normal texture, AO, alpha cutoff,
wind values, material path/GUID and tree placements. `_BackFaceMirrorNormal`
remained `0`. The old normal strength was `1`, which matches the specular shader's
unscaled normal map; that shader has no `_BumpScale` control.

### Reproduce and refresh

[prepare-oak-specular.mjs](../unity/prepare-oak-specular.mjs) prepares this change
from the pre-fix metallic material. From the repo root:

```powershell
bun unity/prepare-oak-specular.mjs 'D:/gspro_courses/vreta_v4_2025_12_02' 'tree-export/oak-specular-new'
```

The stage directory must be new. The script validates the source material and
shader, writes the changed material under `Assets/`, and saves the exact original
under `before/`. It deliberately rejects an already-converted material. Its
report says visual verification is pending for each new run.

1. Copy only the staged `Assets/GolfMap/Vreta/FoliageTrialV2/Oak Leaves.mat` to
   the same relative path in the Unity project. Leave its `.meta` unchanged.
2. In Unity, run **GolfMap > Refresh vegetation from materials**.
   VSP caches material state and colour overrides; editing the file alone is
   insufficient. No replant is needed for the mesh material change.
3. Compare the same oak from the previously white and green angles. Marcus
   confirmed this resolved the reported whitening in Unity.
4. Rebake affected billboards before export and verify the result in GSPro.

For the confirmed run, the local original is at
`tree-export/oak-specular-20260917/before/Assets/GolfMap/Vreta/FoliageTrialV2/Oak Leaves.mat`.
`tree-export/` is gitignored; that backup is local, not a repository asset.
To undo, restore the original material and refresh vegetation again.

Do not rerun the older `prepare-oak-nm-shader.py` conversion over this fix: it
targets the metallic shader and writes older smoothness/back-face settings.

## Confirmed: Forst trees on CTI shaders under stock names (2026-09-26/27)

**The standard for Forst trees (the Vreta birches and oaks). Confirmed by Marcus in
GreenKeeper on 2026-09-27. Still reversible.**

The course built and loaded in GreenKeeper (OPCD's course tool), and the CTI birches and
oaks rendered there. The log showed no exception after the course loaded, so the whole
package loaded. GreenKeeper's VSP runtime
(`D:/gspro/GreenKeeper_Launcher/Data/Application/GreenKeeper_Data/Managed`) is a
different build from GSPro's but the same size (524800 bytes), with the same IL for the
lookup: exact `==` in `CTIShaderController.MatchShader`, and no fallback in
`ShaderUtility.GetShaderController`. That makes it the same test as the GSPro release. Not
yet seen: wind in motion, and GSPro itself. Both would only show the look, not whether
the package loads.

The feature is still named "trial" (`golfmap.cti.*`, `CTITrial/`, `trial.json`). Renaming
would move assets that `GolfMapVegBake` and the palette editor read by path, for no
functional gain. The trial state *is* the configuration: palette prefabs, looks, the
palette's baked tints and replants all use it.

Forst's manual recommends its CTI shaders for the oaks and birches in VSP, with
`VSPro_CTIShaderController.unitypackage`. That package is no use for GSPro: it only
replaces `CTIShaderController.cs`, and C# never reaches GSPro (courses load as asset
bundles; GSPro runs its own VSP build). Checked by IL in both GSPro builds on this
machine:

| | Release (2025-12) | Public beta (2026-06) |
| --- | --- | --- |
| Controller lookup | every `IShaderController` in the VSP runtime assembly, no fallback | same |
| `CTIShaderController.MatchShader` | `name == "CTI/LOD Leaves"` / `"CTI/LOD Bark"` / `"CTI/LOD Bark Array"` | `"CTI/LOD Leaves".Contains(name)` - Forst's patch, compares the wrong way round |
| `CTI/LOD Leaves 301` (Forst's name) | unknown: drops the whole package | unknown: drops the whole package |
| `CTI/LOD Leaves` | known | known |

So the trial copies Forst's three 301 shaders under the stock names, changing nothing
else except `exclude_path:deferred exclude_path:prepass` on the leaves. CTI leaves in
deferred need Forst's `CTI_Internal-DeferredShading` in Graphics settings, which GSPro's
are not ours to set; forward-only leaves light correctly either way. VSP's own
`CTIWindController` (present in GSPro) feeds `_TerrainLODWind`, which "Use Wind from
Script" reads. The materials are Forst's originals, extracted from the Asset Store
cache: every Forst material in the project had been converted in place to NM shaders.

- `pipeline/.venv/Scripts/python unity/prepare-cti-trial.py <UnityProject>` writes new files only:
  `Assets/GolfMap/CTI/Shaders/` and `<course>/CTITrial/` (materials + `trial.json`).
- `golfmap.cti.status` / `golfmap.cti.apply` / `golfmap.cti.restore`
  ([GolfMapCtiTrial.cs](../unity/Editor/GolfMap/GolfMapCtiTrial.cs)). Apply backs up the
  palette prefabs it swaps, both tree catalogues and their billboard folders to
  `GolfMapSpelunk/cti-trial/<stamp>/` (outside Assets), swaps the oak and birch
  leaf/bark materials, refreshes vegetation from materials and resets VSP. Restore puts
  that backup back; `backup=<stamp>` picks an older one.
- Swapped: every prefab the catalogues draw, plus every prefab under the course folder,
  that uses a swapped material. That is 12 on Vreta: the 4 oaks, the palette's own 4
  birches in `FoliageTrialV2` and the 4 `Looks/birch/darker` copies. Most planted birches
  are the darker look, but the palette's own prefabs are what the "original" look
  replants and what GolfMap Lab shows. The first version skipped the unplanted ones, and
  the Lab's original row stayed on NM with its flecks. Each swap
  has its own trial material, because restore reverses swaps in memory. The darker-look
  birches still get the original birch colour; Marcus never liked the dark look.
- Looks are trial-aware (`GolfMapLooks.LookSources`, `GolfMapCtiTrial.Original/TrialFor`).
  Swapping the palette's source prefabs made a look **Regenerate** (2026-09-27) take the
  trial materials for the species' sources. It copied them into the look folder and pointed
  the darker birches there, outside `trial.json`, so the palette's baked tint control
  disappeared. A look is now always defined against the NM originals, which is how
  `palette.json` keys its records anyway. While the trial is applied, a regenerated look
  prefab draws its copy's trial material. Restore now checks that each prefab's in-memory
  materials exactly match its restored file, not just that no trial material remains.
  That Regenerate left two unreferenced copies, `Looks/birch/darker/CTI Birch {Leaves,Bark}.mat`,
  which are safe to delete.
- Forst trees in the Vreta palette: the 4 birches and 4 oaks, all on the trial. The fir is
  NM. Forst's Conifers package is in the Asset Store cache but not imported.
- `pipeline/.venv/Scripts/python unity/prepare-cti-maps.py <UnityProject> oak birch` tunes the look.
  CTI has no tint or specular controls, so every change is a texture copy under
  `<course>/CTITrial/Textures/`, recorded as an override in `trial.json`. Re-running
  `golfmap.cti.apply` on an applied trial only updates the trial materials.
- Tints are tuned live in `GolfMap > Vegetation Palettes` (2026-09-27): the leaves' healthy tint and
  the bark colour are baked there with the same formula (bit-identical to the script's bake, from the
  lossless source copies it writes to `GolfMapSpelunk/cti-trial/sources/`), and Save records the tint
  on the override (`tint`, `source`); the script honours a recorded tint. The birch bark (a
  Texture2DArray the script never tinted) got a course copy, `CTITrial/Textures/Birch Bark Array
  [Albedo] [Smoothness] 2K4K tinted.asset`, at tint 1 (identical to Forst's) so it can be graded too.
  See unity/README.md, "CTI trees (baked tints)".

Unity result: the shaders render cleanly (alpha, bark, VSP instancing, wind). Billboards
are VSP's default atlas while the trial is applied. The look took three steps, each
confirmed by Marcus on screen (2026-09-26/27):

1. **Too bright.** Untinted, the CTI oaks were about 4.5× the approved oak. The NM
   materials multiply albedo by `_HealthyColor`/`_Color` ≈ 0.5, and in this linear
   project a colour property is linearised first (×0.22). The tint is baked into albedo
   copies: linear RGB × the linearised NM tint.
2. **Grey-white, "too little olive".** With the albedo at the approved level, Forst's 4%
   dielectric leaf reflection (spec 0.043 in `_BumpSpecMap` B, smoothness up to 0.41 in
   `_TranslucencyMap` A) outshone the leaf. Both channels are zeroed in copies, the same
   fix as the NM oak above. Then the oak was shifted "a tad greener": red ×0.88,
   renormalised to the same luma.
3. **Birches still pale.** A black-albedo probe left the birch leaves grey-white, so the
   light wasn't albedo. The project's `Birch Leaves [Normal] [Spec] 4K.psd` had been
   switched to *Normal map* import on 2026-09-14 (Forst ships it as Default, and the manual
   says to keep it Default and linear). A Normal-map import repacks the channels, so the
   zeroed spec channel was no longer zero. Packed-map copies now always import as Default
   and linear. The birch tint is then scaled to the approved birch/oak brightness ratio
   (1.6×, from `prepare-foliage-luma.py`'s references).
4. **"Much better but slightly darker"** (2026-09-27): birch gain 0.69 → 0.60 (×0.87
   linear); the birch leaves in a golfer's view measured ~16 % darker.
5. **Wind "almost like a storm"** (2026-09-27): `_BaseWindMultipliers` (x primary
   bending, y branch turbulence, z edge flutter) 1/1/1 → 0.5/0.5/0.5 on all six trial
   materials, leaves and bark alike so the leaves stay on their branches. It is set by
   `golfmap.cti.apply` (`WindMultipliers` in GolfMapCtiTrial.cs). VSP's CTI controller
   does not override it, and the global wind the other trees use is unchanged.
   Still more than the other trees (2026-10-11): 0.5 → 0.25. The leaves' tumble
   (`_TumbleStrength`) and `_LeafTurbulence` are not scaled by the multipliers; they are
   the next knob if the leaves alone still move too much.

Restore was verified end to end four times. All four backups are byte-identical to
each other, so every restore returned exactly the original files, and the view matches
the pre-trial screenshot. What it took, which applies to any tool that puts files back
under an open Unity 2018.2 editor:

1. Unity does not reload a loaded prefab or ScriptableObject when its file is replaced
   and force-reimported. The editor kept the trial state in memory and would have saved
   it back over the restored files. Restore therefore reverses the prefab swap in memory
   (Unity's save of it is byte-identical to the backup), and calls
   `Resources.UnloadAsset` on the catalogues after copying them back, so they reload from
   disk. It then checks memory against disk before continuing.
2. VSP then kept drawing the oaks from stale managed state: opaque leaf cards with no
   alpha cut. Neither a refresh nor disabling and re-enabling the systems cleared it; a
   script reload did. Apply and restore end with `InternalEditorUtility.RequestScriptReload()`.
   GSPro loads the bundle fresh, so this is editor-only.

Rollback: `golfmap.cti.restore backup=20260927-134917` returns the NM setup. That backup
is byte-identical to the original state; newer backups are taken of whatever state apply
starts from. Then delete `Assets/GolfMap/CTI/` and `<course>/CTITrial/` to remove CTI
completely. Keep `GolfMapSpelunk/cti-trial/20260927-134917/` for as long as that rollback
should stay possible.

Open items:
- **Billboards.** Swapping the shader re-derived the items and replaced the
  GolfMap-baked billboards with VSP's default atlas. Replant the outer with "Rebake
  billboard colours" before a release build, so distant birches and oaks match.
- **Other courses.** `prepare-cti-trial.py` / `prepare-cti-maps.py` name Vreta's paths
  (`FoliageTrialV2/...`, `Looks/birch/darker/...`). A new course needs its own SWAPS
  rows, or the planter needs to pick the CTI materials for Forst prefabs itself.

## Black speckles flashing on far CTI trees (2026-10-09)

**The live test was confirmed by Marcus in the Unity Scene view. The shader fix built from it is
not yet confirmed by eye, and GSPro/GreenKeeper is unchecked.**

Symptom: on birches at LOD2 (from about 37-58 m, out to the tree distance), black speckles in a
random pattern that show for a few milliseconds, often, all over the crown.

Cause: VSP's `CTIShaderController` has `LODFadeCrossfade = true`, so VSP enables
`LOD_FADE_CROSSFADE` on the material copies of the last mesh LOD only (LOD0/1 get
`LOD_FADE_PERCENTAGE`). The CTI shaders compile a dither crossfade for that keyword, and it cut
random pixels out for single frames. Why the fade value is wrong there is not established.
Not the cause: leaf turbulence (`_LeafTurbulence` 0) and advanced edge flutter, both tried first.
Switching the keyword off on VSP's LOD2 copies removed the speckles.

Fix: the stock-named shader copies in `Assets/GolfMap/CTI/Shaders/` no longer compile the variant
(`dithercrossfade` dropped from the three surface pragmas, `LOD_FADE_CROSSFADE` dropped from the
bark shaders' `multi_compile`). VSP still sets the keyword; the shaders ignore it. Shader names are
unchanged. `prepare-cti-trial.py` writes the copies this way (`no_dither_crossfade`), but it only
writes missing files, so the existing project copies were edited in place. Cost: CTI trees pop at
the tree distance instead of dithering out over its last 10 m. Applies to the oaks too.

Probe used: `golfmap.vegperf.materials item=<glob> [lod] [on/off keywords] [floats] [vectors]`
reads and changes the material copies VSP actually draws, per LOD. Runtime only; a VSP refresh
puts the assets' values back, so read the keywords back before trusting a test.

## Recurring pitfalls and diagnosis

### One-click comparisons in Unity

Open **GolfMap > Tree rendering tests**. The panel is implemented in
[GolfMapTreeRenderingTests.cs](../unity/Editor/GolfMap/GolfMapTreeRenderingTests.cs).
Use a saved scene with its GolfMap VSP systems active, frame an oak and birch, and
enable Scene Lighting. The first test captures the current baseline automatically.

| Button | Isolated change | What to inspect |
| --- | --- | --- |
| Baseline | Restores captured lighting, leaf properties and catalogue tints | Original appearance at the same camera angle |
| Ambient fill +30% | Scales skybox ambient intensity, or ambient colours for flat/gradient lighting | More readable shadows versus flatter crowns; sunlight stays unchanged |
| Oak / Birch — RED material probe | Sets both leaf tints to pure red and updates matching VSP overrides | Confirms whether the visible leaves use the targeted material; unchanged green foliage requires tracing the material/LOD/billboard/cache before tuning |
| Oak / Birch — BLACK albedo probe | Sets both leaf tints to black | Separates leaf albedo from remaining lighting or other materials; the fixed oak should be nearly black, whereas birch can retain specular |
| Oak / Birch — neutral leaf normals | Replaces only that species' normal map with a neutral linear texture | Whether fine speckling comes from the normal texture; mesh normals remain unchanged |
| Oak — tint saturation -20% | Moves healthy/dry tint 20% toward weighted gray | Whether oak blends better with the ground colours |
| Birch — greener tint | Raises tint green 5%, lowers red/blue 5%, then normalises weighted RGB brightness | Whether the dusty cast improves; this is an exploratory tint, not a calibrated correction |
| Restore baseline and end tests | Restores and releases the baseline | End the comparison before normal editing resumes |

Every test first restores the same baseline and then refreshes VSP. Tests do not
stack. Colour tests update only catalogue items using the target material, and
restoration reinstates their previous overrides. These are shared material tests,
so all trees using that oak/birch material change. Existing billboard textures do
not change. Zero ambient remains zero when multiplied, and baked lighting may not
respond to the ambient test.

The panel does not save assets or the scene. Do not save/export, replant, or edit
the affected materials/lighting during a comparison. Closing the panel, changing
away from the scene, entering Play mode, or recompiling scripts restores the
baseline. A GUID-based recovery snapshot remains at
`Library/GolfMapTreeRenderingBaseline.json` until restoration succeeds. After an
interrupted session, open the original scene and panel and click **Restore baseline
and end tests**. Keep that recovery file until restoration succeeds.

Current validation: compiled against installed Unity 2018.2.8f1/VSP assemblies
with C# 6. On 2026-09-20 Marcus tested the original buttons in Unity: ambient fill
changed the scene noticeably, but normal/tint comparisons showed little tree
change. Those results do not yet rule out normals or tint: the tint adjustments
were subtle and the visible material path was not verified with a strong probe.
Follow-up red/black screenshots on 2026-09-20 confirmed that the targeted oak and
birch foliage turns red, so the material/tint override path reaches those visible
trees. Oak leaves become essentially black with black albedo, consistent with the
confirmed zero-specular fix. Birch foliage becomes predominantly black but retains
some pale flecks; residual specular or other visible surfaces remain possibilities,
not a confirmed diagnosis from the screenshots. Next useful isolation: suppress
birch specular while preserving its normal map, AO and baseline tint. Do not infer
that the oak's remaining appearance issue is another white-reflection fault.
The earlier subtle normal/tint comparisons do not justify a permanent change yet.
Colour tests
now report matching catalogue items and updated overrides (not visible instance
counts), log prefab names, and reject zero matches rather than silently succeeding.
Screenshots varied in camera framing, so use a fixed view for the next comparison.
The panel deliberately has no “keep changes” button: record
the useful comparison here before turning it into a permanent fix.

### Known symptoms

These are established project notes from [unity/AGENTS.md](../unity/AGENTS.md)
and [unity/README.md](../unity/README.md); the oak entry above records the newly
confirmed result in detail.

| Symptom | Check and action |
| --- | --- |
| White foliage changes with view angle | Check actual specular output, not just smoothness or saved keywords. For this oak, the stock specular shader at zero specular/zero smoothness fixed it. Do not apply this blindly to every species. |
| Glossy leaves with no mask assigned | NM metallic leaves sample a white default mask, making smoothness equal to `_SmoothnessPower`. Assign the correct packed mask or reduce the power; this was the earlier elm gloss fix. |
| Material colour edits do nothing | VSP's NM controller overrides leaf `_HealthyColor`/`_DryColor` and bark `_Color` from the catalogue. Refresh vegetation from materials. |
| Dark leaf clusters after changing normals | Leave `_BackFaceMirrorNormal = 0` on these outward-bent leaf meshes; mirroring darkened elm/oak clusters. Birch is the existing exception. |
| Trees render in Unity but disappear in GSPro | Check exact shader names. Unknown/renamed shaders can break GSPro's shader-controller lookup and abort the whole vegetation package. |
| Distant trees keep old colours | Billboards are baked textures. Refreshing mesh materials does not update existing billboard textures; rebake them. |
| Trees flatten or lose parts under VSP | VSP uses the first renderer per LOD and the instance transform. Use compatible `VS_`/baked prefabs; check extra renderers and non-identity transforms. |
| Retired trees still cause loading faults | VSP loads all catalogue items, even unplanted ones. Use the planter's catalogue pruning; removing a palette entry alone does not remove its catalogue item. |

### Investigate before tuning

1. Establish whether the problem occurs in Unity, GSPro, or both, and whether
   the affected tree is a mesh LOD or a billboard.
2. Trace the actual prefab, renderer/LOD, shared material and resolved shader.
   Saved properties can survive a shader swap without being used by that shader.
3. Back up the material, then make one controlled diagnostic change at a time.
   A temporary pure-red tint followed by a VSP refresh identifies the affected
   material. A black-albedo probe distinguishes remaining lighting from albedo;
   restore the original tint afterwards.
4. Inspect shader source for the properties and keyword variants it actually
   reads. Check packed texture channels and import settings before reassigning
   textures between shader families.
5. Refresh VSP and compare the same tree from both directions and across LOD
   transitions. Record the result here, including any remaining GSPro check.

Do not revive the retired `GolfMap/Tree Leaves No Spec` or private renamed CTI
shader experiments. They introduced unsupported names, and GSPro's VSP runtime
has no fallback for those names. The confirmed oak fix uses a stock supported
shader instead. Older experiment comments are historical hypotheses, not proof
that the current material's problem is albedo or translucency.

## Creek thicket visual trial (2026-09-27)

The user-requested [ditch trial](gspro/vreta/ditch-thicket-trial-20260927.md)
uses course-local NM `Tree_Leaves_Specular` bush copies with specular 0,
reduced AO and `_BackFaceMirrorNormal=0`, plus cooler tints. The cottonwood
canopy needed particularly cool multipliers (`#6579b7` / `#7689b2`) to remove
its strong yellow cast in the ground-level comparison. Saved and rebuilt in
Unity; screenshots reviewed from both bank directions and approved by Marcus.
GSPro/GreenKeeper remains unchecked. This is a combined visual trial, not an isolated
proof that the normal toggle alone caused the previous contrast, and does not
replace other species' confirmed material settings. Backups and exact values
are recorded in the linked note.
