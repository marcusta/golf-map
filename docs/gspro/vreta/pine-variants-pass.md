# Pine variants and colour pass — 2026-09-12

Installed in `D:/gspro_courses/vreta_v4_2025_12_02` from `tree-export/pine-variants-v1`. Replaced files backed up in `tree-export/pine-variants-backup-20260912-230043`.

The palette now contains 31 assets. Forest pine 04 and 06 were added; 01, 03, 05, 00_B and 00_C remain. Pine 03 and 05 each have selectionWeight 5, other forest pines 1. The stable weighted selection runs only after the existing matcher chooses pine, within a bounded size-fit score window. Uniform scale limits still apply. Broadleaf species percentages are unchanged.

Forecast over the saved 25,563-stem fixture: 03 = 1,907 and 05 = 1,768 of 5,614 pine assignments (65.5% combined). These are preview assignments, not verified scene counts.

Private pine materials: bark tint 0.62 → 0.50; needle Healthy tint (0.52, 0.65, 0.61) → (0.68, 0.80, 0.74), Dry (0.48, 0.59, 0.55) → (0.64, 0.75, 0.69). All referenced pine mesh and cross-card materials are copied. Baked cross-cards combine bark and needles, so their bark cannot be adjusted independently through the single colour property.

The shared NatureManufacture M_Fir_Leaves material changes Healthy (0.46, 0.59, 0.54) → (0.32, 0.44, 0.40), Dry (0.42, 0.55, 0.50) → (0.30, 0.41, 0.37). This affects other uses of that shared fir material too.

In GolfMap Trees, use **Refresh planted colours from prefab materials** to synchronize VSP's stored shader settings. To apply added variants and weights, load/check the palette and replant with **Clear existing trees first** for the selected imported storage. Plant also synchronizes colours. Outer billboards need **Rebake billboard colours** when planting.

Validation: nine matcher tests pass, including weighted pine distribution, ordering stability and poor-fit rejection. Planter compiles against installed Unity/VSP assemblies. C# and JavaScript agree on prefab, scale, rotation and review status for all 25,563 fixture stems. Installed file hashes verified. Scene appearance and actual replanting have not been tested in Unity.
