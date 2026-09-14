# Canopy and foliage pass

The manual planter infers woodland from at least four other mature stems within
20 m (not a mapped woodland boundary). Shrubs and isolated trees retain the old
matching rules. Nearby stems outside the selected terrain/exclusion are not counted.

Woodland matching weights height and crown width equally, targets 1.12 times the
survey crown diameter and reduces species-fit slack to 0.2. A final 1.10 uniform
scale multiplier improves overlap, capped at the existing 1.4 maximum. This also
increases height; no nonuniform scaling was introduced because VSP billboards
require uniform scale. Review flags reflect the final size. Authored JS overrides
are unchanged. JS callers must supply `stem.woodland`; the manual planter computes
it from the eligible loaded stems. This is a visual trial, not a survey correction.

Audit of the current inner export: 22,499 matched woodland stems, 10,443 prefab
changes. Mean crown bounds increase from 7.97 to 8.71 m, and mean height from 14.49
to 16.05 m. Survey crown width averages 7.14 m, so bounds were already larger than
the survey: mesh foliage density and spatial coverage also need visual assessment.
All isolated matches were unchanged. Full-export JS/C# matching parity: 25,563 stems.

Private oak leaf tint is now (0.27, 0.39, 0.25); hue variation is muted green
(0.38, 0.48, 0.32), strength 0.07. Birch healthy/dry tints are
(0.48, 0.62, 0.49) and (0.44, 0.56, 0.43). Bark and lighting are unchanged.
`unity/prepare-canopy-pass.mjs` stages these exact values reproducibly.

Apply by replanting the intended storage with **Clear existing trees first**
enabled; otherwise planting appends instances. Backups precede replacement.
Outer billboards need **Rebake billboard colours** enabled. Do not leave an older
planted system active over the same area. Inspect the result overhead and at
playing height; neither visual canopy closure nor the new colour is verified yet.
