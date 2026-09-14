# Vreta palette matching

The 18 assets in `palette.json` are Marcus's shortlist, resolved by exact name to
catalogue GUIDs and measured static bounds. Broadleaf/conifer and tree/shrub labels
describe the assets, based on their names; they do not identify real Vreta species.

Run from golf-map:

```
node unity/match-tree-palette.mjs <unity-trees.json> docs/gspro/vreta/palette.json <new-report.json> [overrides.json]
node --test unity/tree-matching.test.mjs
```

This is an offline proposal generator. The separate `GolfMapAssignmentImporter`
consumes its reports; the original bulk planter does not. Generating a report
does not modify the source survey or scene. See [hole1-trial.md](hole1-trial.md).

## Initial rules

- Known detector broadleaf/conifer classifications constrain asset type. Unknown
  detections may match either type but always require review.
- Stems up to 3.5 m use the dwarf-pine shrub palette. This is an editable proposal
  threshold. The detector's crown-ratio bush flag alone does not make a tall oak
  a shrub. There is currently no broadleaf shrub in the shortlist.
- Score height fit twice as strongly as width fit using logarithmic relative
  errors; prefer little scaling. Fit uniform scale between 0.75 and 1.4 to retain
  the original silhouette. These are initial tuning values, not calibrated limits.
- Choose deterministically among candidates within 0.08 of the best score using
  seed + stem ID + GUID. Asset/stem ordering does not change results. Changing the
  palette or rules can change automatic assignments; authored overrides persist.
- Flag fits beyond a 1.25 height ratio or 1.4 width ratio in either direction.
  Both the chosen candidate and up to three alternatives retain fit scores.
- Three selected firs are FBX model assets; flag their use for Unity/VSP checks.
  A passing fit is not evidence of working LODs, shaders, collision or species.

`zones` can map an explicit input `zoneId` to `allowedGuids` and rule overrides.
No geographic zones are inferred or assigned yet. In particular, the rules do
not infer fir versus pine or birch versus oak from orthophoto or regional ecology.
Within the detected broad type, geometry and authored species preferences select
a proposed asset. The current broadleaf weights and dedicated material copies
are documented in [foliage-v2.md](foliage-v2.md). They supersede the original
geometry-only species choice above. The palette's `catalogueGuid` links trial
copies back to their original catalogue dimensions and previews.

## Authored choices

Overrides are a separate JSON object keyed by stable stem ID:

```json
{
  "example-stem-id": {
    "guid": "0b2b38bbcc2b9a147b973ca085308922",
    "scale": 1.1,
    "rotationY": 45,
    "position": {"x": 100, "z": 200}
  },
  "excluded-stem-id": {"exclude": true}
}
```

Position is plot-local east/north in metres; ground height remains the Unity
importer's responsibility. An explicit asset override requires a positive uniform
scale. It takes precedence over zones and automatic type/size rules. Missing
override assets fail rather than silently substituting another tree. Reports list
unused override IDs; position-derived IDs still need reconciliation if detection
coordinates change between LiDAR runs.

Reports include hashes of source survey, palette and overrides. The scale is
relative to the catalogue's root-local mesh dimensions: an eventual Unity adapter
must account for prefab root transforms and verify loaded bounds. Do not apply
it through the existing planter's height/width scaling a second time.

## First dry run

`tree-export/vreta-assignments-v1.json` contains 24,421 assignments: 16,012 proposed
and 8,409 needing review. The initial report was a dry run. A subsequent 118-tree
hole-1 subset has been applied with the assignment importer; see
[hole1-trial.md](hole1-trial.md) for results, review workflow and limitations.
