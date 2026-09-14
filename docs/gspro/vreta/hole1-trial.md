# Hole 1 assignment trial

Implemented and applied in Vreta on 2026-09-12 using Unity 2018.2.8f1 and its installed Vegetation Studio Pro.

## Result

The sample is a 60 m buffer around the straight line from the first tee to the green, derived from golf-map's local database. It is a convenient test area, not a surveyed hole boundary.

- 118 stems, nine selected assets; 106 proposed and 12 flagged for visual review.
- All 118 were replaced in VSP persistent storage, keeping their stored ground heights.
- Runtime checks verified chosen vegetation item, scale and rotation.
- The other 24,303 stored instances were compared and unchanged.
- Full storage backup created under the Unity project's `GolfMapSpelunk/AssignmentBackups`.
- Unity reported the existing 256 shader-keyword limit, including `_FADEOUT_WIND_ON` during this trial. Appearance and wind are not yet visually approved.

## Review and revise

Open `D:/golf-map/tree-export/vreta-hole1-review.html` in your browser. Click a dot to inspect its dimensions, selected asset and alternatives. Choose an asset and scale, then Save choice; Exclude tree marks a removal. Download the overrides before closing the page. This is a standalone schematic review page; it is not integrated into the course-builder map yet.

Save the downloaded overrides as `D:/golf-map/tree-export/vreta-overrides.json`. From `D:/golf-map`, run:

```powershell
node unity/match-tree-palette.mjs D:/gspro_courses/vreta_v4_2025_12_02/Assets/GolfMap/Vreta/Vreta_trees.json docs/gspro/vreta/palette.json tree-export/vreta-assignments-reviewed.json tree-export/vreta-overrides.json
bun unity/prepare-hole-review.ts tree-export/vreta-assignments-reviewed.json
```

Choose a new full-report filename each time. The preparation step replaces the generated hole sample and review page. Authored choices and exclusions in that report are retained when downloading the next set of overrides.

In Unity open **GolfMap > Vreta > Review and import assignments**, select `D:/golf-map/tree-export/vreta-hole1-assignments.json`, Validate, then Apply. Validation runs again on Apply. Review flags are informational and are included in the trial.

## Recovery and current limits

**Restore last storage backup** restores the entire storage from immediately before the most recent Apply. Do this before unrelated planting edits: those later changes would also be replaced. Unity Undo also restores the storage while the importer window is open, with cache refresh. Added catalogue entries and generated billboard assets remain after storage restoration.

An excluded stem has no stored ground height on a later run. To reintroduce it, first restore the preceding storage backup, then apply the revised report. Moving stems is deliberately rejected until a ground-projection pass is implemented. The original bulk tree planter still replaces all source-42 trees; use the assignment importer for this workflow.

The matcher preserves broadleaf/conifer classes and fits dimensions. It cannot infer exact botanical species from those classes. Species labels are asset choices, not claims about individual real trees. Model-asset wind, LOD behavior and rendered dimensions still need visual verification in the course and GSPro.

## Verification

Compiled the importer against the actual Unity/VSP assemblies with C# 6. Ran the five matcher tests and the DOM review test (selection, saving, exclusion, matcher override round trip). Verified validation and first application in the open Vreta editor. Repeat-application and backup restoration were not exercised in this trial.
