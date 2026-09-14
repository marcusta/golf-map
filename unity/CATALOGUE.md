# Asset catalogue exporter

Copy `Editor/GolfMap/GolfMapCatalogueExporter.cs` and `GolfMapCatalogueGallery.html` into the Unity project's
`Assets/Editor/GolfMap/` folder. It is standalone and does not require VSP or
GolfMapJson. It compiles with C# 6 against Unity 2018.2.8f1's installed assemblies.

Open **GolfMap > Export Asset Catalogue**. Start with `Assets/Trees` for a small
trial, leave Render previews enabled, and choose an output parent outside Assets.
The exporter creates a unique report directory containing:

- `index.html`: searchable offline gallery, rendering only 24 assets at a time.
- `details/<guid>.html`: per-asset metadata, loaded only when opened.
- `catalogue.json`: versioned report with asset GUIDs/paths, dimensions, materials,
  shader properties, texture GUIDs, LOD transitions/triangle counts and VSP links.
- `previews/<guid>.png`: 512-pixel mesh previews using consistent camera and lights.

Open index.html in a browser. Broaden the semicolon-separated folder scope after
visually checking the trial. Cancellation writes a partial report. Individual
asset failures are recorded without stopping the remaining export. Each run gets
a new directory; it does not overwrite the preceding report.

To upgrade an existing large gallery without rerendering previews, run
`node unity/rebuild-catalogue-gallery.mjs <catalogue-directory>` from golf-map.
The utility preserves the original index as `index-before-pagination.html`.
Keep the HTML template beside the exporter script when installing updates.

The exporter reads project assets, draws meshes directly and never instantiates
prefab scripts, modifies materials, saves scenes or changes persistent storage.
VSP package discovery covers the project, independently of the asset folder scope.
Each asset's `vspItems` links package GUID and vegetation item ID. Package settings
are a raw EditorJsonUtility snapshot: embedded Unity object references are not a
portable import contract. Material texture GUIDs and asset GUIDs are exported
separately. This report is for inspection, not automatic restoration of packages.

## Interpretation and limitations

- Scope includes model GameObjects and prefabs, including demos and duplicates;
  it does not infer species or automatically classify vegetation.
- Height/width are combined static mesh bounds in root-local space, including
  all LODs. Root placement/scale is excluded. Crown width is max X/Z extent,
  not a botanical crown measurement. Shader displacement is not measured.
- Preview uses LOD0 where LOD groups exist. Skinned meshes are omitted and flagged.
  Billboards, wind, scene lighting and custom global shader state are not reproduced.
  Some specialized shaders may require a scene-specific preview adapter.
- VSP data is collected through serialized fields without a VSP compile dependency.
  Unrecognized package layouts are reported.

## Verification

Compiled against the actual Unity 2018.2.8f1 managed assemblies using its bundled
C# compiler. Interactive rendering has not yet been verified.

On 2026-09-11, verified menu registration and opened the exporter window in Vreta.
The project initially failed to rebuild because `__MeshConform/EdgeHelpers.cs`
and `__MasksFromMesh/CreateBiome1MaskFromMesh.cs` declared the same global type.
Renamed the MeshConform helper to `MeshConformEdgeHelpers` and updated its references
in `__MeshConform/MeshConform.cs`. Originals are in the Unity project's
`GolfMapTools/backups/edgehelpers-20260911-214441/`. Both runtime and editor
assemblies then rebuilt successfully. This was a local project compatibility fix,
not an exporter source change; no course scene was saved.

In Unity, export `Assets/Trees` and inspect the resulting gallery: each static
tree should be centered and fully visible with plausible dimensions, usable
materials, and the expected VSP links. Compare one entry's dimensions/materials/
LOD transitions to the Inspector. Confirm that the scene remains unmodified.
Cancel a larger run and confirm the partial report is usable. Check error and
warning fields before expanding the catalogue to the whole project.
