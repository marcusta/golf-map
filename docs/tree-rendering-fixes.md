# Tree rendering fixes

Troubleshooting record for automated trees in Unity 2018.2.8f1, Vegetation Studio Pro
(VSP), and GSPro. Read this before changing tree materials, shaders or planting.
Project paths and script-copy workflow live in [unity/AGENTS.md](../unity/AGENTS.md).

Record new fixes here with the symptom, actual material/shader, cause, exact change,
refresh steps and where the result was verified. Separate confirmed results from
experiments: a Unity result does not establish the GSPro result.

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
2. In Unity, run **GolfMap > Vreta > Refresh vegetation from materials**.
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

## Recurring pitfalls and diagnosis

### One-click comparisons in Unity

Open **GolfMap > Vreta > Tree rendering tests**. The panel is implemented in
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
