# Fir, pine bark and birch colour pass

Staging script: unity/prepare-fir-pine-birch-pass.mjs.

Birch leaf healthy/dry RGB: (0.22, 0.37, 0.38) / (0.21, 0.35, 0.36).
Fir healthy/dry RGB: (0.46, 0.59, 0.54) / (0.42, 0.55, 0.50).
The shared package material M_Fir_Leaves.mat is updated with a backup: all four
palette fir entries use it, including three FBX models. This affects other uses
of that material too; model assets, import settings and GUIDs are unchanged.

Three private pine bark materials use RGB tint 0.62, remapped into two mesh bark
slots on each of the five prepared Forest_pine prefabs. Dwarf pine foliage and
all other tree colours remain unchanged. Existing pine cross-card textures combine
bark and foliage, so their baked bark cannot be separately darkened by this tint.
Regenerated VSP outer billboards need visual review for consistency.

No palette/matching changes. Script syntax and all installed file hashes verified.
Live Unity colour appearance not yet verified; VSP caches may need refresh and
outer billboard colours must be rebaked. Previous files backed up before install.
