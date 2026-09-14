# Vreta workflow trial

Vreta is the test environment for a reusable GSPro production workflow and the
eventual finished course. Confirmed by Marcus on 2026-09-10. Current Unity project:
`D:/gspro_courses/vreta_v4_2025_12_02`, Unity 2018.2.8f1.

## Appearance references

The six supplied screenshots are appearance references, not instructions or
evidence of Vreta's actual vegetation. The following interpretation is provisional:

- Gut Larchenhof (images 1–2): broad spreading crowns, warm greens, maintained
  turf meeting tall rough, and open parkland framing.
- Old Kinderhook (image 3): layered woodland, varied tree heights, darker foreground
  vegetation and atmospheric separation of distant slopes.
- The Wilds (images 4–5): varied crown silhouettes, tall straw-colored grass,
  shrubs between grass and canopy, and clear maintained playing surfaces.
  Autumn foliage is a reference option; Vreta's season is not yet selected.
- The Foundry (image 6): visible trunks, open spaces under woodland canopy,
  irregular woodland edges and ground vegetation that connects the scene.

Use these to compare composition, transitions, color and depth. Exact shader
parameters cannot be recovered from screenshots. Asset names do not establish
species identity at Vreta or suitability for its regional flora.

## Verified starting point

The Unity project's local GolfMap tools extend the repository tools with VSP
persistent storage. Saved September 7 reports record 24,421 imported trees and
passing XZ/count/source-clearing checks. These reports were read, not rerun here.
The importer uses source 42, independent per-stem random seeds, mesh ground probes
and terrain fallback. Current preset uses Broadleaf_Desktop and Conifer_Desktop.

Source-42 edits are replaced on reimport. Position-derived stem IDs remain stable
only while detector coordinates remain unchanged. Billboards are disabled due to
anisotropic sizing; extra tree mesh distance is 3,000 m. Performance and GSPro
collisions/build/export still require verification.

`prefab-files.json` records a filesystem inventory of all 1,248 prefab files and
their meta GUIDs at inspection time. This includes demos, furniture and other
non-vegetation assets. It is not a validated visual catalogue, and it omits model
assets used directly without prefab files. No dimensions, shader compatibility,
render quality or LOD behavior have been verified by this inventory.

Available folders include NatureManufacture, birch/oak packages, TreeShare,
CESimgolf trees, Trees, grasses, StixGames and rocks. Start with existing assets.

## First implementation slice

1. Capture the current scene's appearance settings and fixed-view renders before
   applying appearance changes. Include sunny/shaded and near/distant views.
2. Export a Unity-resolved vegetation catalogue: GUID, path, dimensions, materials,
   shader properties, LODs, VSP item settings and consistent visual previews.
   Select a manageable first palette for canopy, small trees, shrubs and tall grass.
3. Select one representative Vreta hole and its surrounding vegetation. Store
   measured stems separately from proposed assignments and approved overrides.
4. In golf-map, review stems with catalogue previews and save prefab GUID,
   position/rotation/scale overrides and approval state. Support exclusion of
   incorrect detections. Individual choices take precedence over zone defaults.
5. Extend the proven VSP path to consume resolved assignments. Repeat import must
   preserve approvals, avoid duplicates and leave other source IDs intact. Show
   missing assets and proposed changes before applying them.
6. Add editable zone defaults for open parkland, woodland interior, woodland edge
   and tall rough. These are visual/maintenance roles, not fixed species packages.
   Validate how installed VSP masks and biomes represent each before implementation.
7. Compare paired fixed-view renders and save actual selected settings as presets.
   Track manual correction time and check performance and ball collisions before
   expanding to the whole course.

Keep Unity changes coordinated with the other task working on this project.
Inspection and initial inventory in this task did not modify the Unity project.
Keep shared scripts, course configuration and authored overrides separate;
generalize proven operations after the single-hole loop works.
