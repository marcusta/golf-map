# Expanded broadleaf palette

Added the five requested Poplar prefabs, Broadleaf_Desktop, Elm-Split PREFAB and
Maple (Assets/TreeShare/Maple/Maple.prefab). Catalogue bounds and GUIDs were checked.
Broadleaf_Desktop uses the existing Broadleaf Balanced prepared copy; elm and
poplars use private copies with cool foliage tints across mesh/cross-card materials.
Maple retains its supplied Arboreum materials and needs visual/runtime verification.
Existing oak, birch, pine and fir entries remain. Total: 26 assets.

Species weights: poplar 10%, broadleaf 15%, elm 20%, birch 10%, oak 30%, maple 15%.
Poplar variants share one species draw; adding variants does not multiply its weight.
Weights remain conditional on geometric eligibility, not enforced course quotas.

Inner-export forecast (11,337 matched known broadleaf stems): poplar 2,530,
broadleaf 555, elm 2,220, birch 2,606, oak 2,314, maple 1,112. This is approximately
22.3%, 4.9%, 19.6%, 23.0%, 20.4%, 9.8%, respectively. It uses prior audited density
classifications, not live scene counts. More size coverage or a separately designed
quota allocator is needed to enforce percentages at the expense of local fit.

The species random draw now avalanches FNV output to avoid correlations between
species suffixes. Rotation/prefab hash is unchanged. Eight tests, including a
10,000-stem six-group distribution test, and 25,563-stem JS/C# parity pass.
Unity 2018.2 compilation passes. Installation is backed up; scene was not replanted.
Use Clear existing trees first when replanting the selected storage; rebake outer
billboards. New prefab rendering and material colours still need visual review.

Reproducible staging: unity/expand-vreta-palette.mjs.

## Additional elm and oaks

Added `Elm` from Assets/Trees/Elm/Elm.prefab (11.97 m tall, 14.39 m crown bounds),
`PF_Oak_tall_bare Terrain` and `PF_Oak_tall Terrain` (both 20.40 m tall, 14.67 m
crown bounds). `PF_Oak_small Terrain` was already present and remains unchanged.
Total is now 29 entries. Elm uses private cool foliage materials; both new oaks
reference the existing prepared oak leaf and bark materials at all mesh LODs.
Species weights remain unchanged. No matching code changes in this addition.

Updated forecast: birch 2,234 (19.7%), poplar 2,163 (19.1%), oak 3,294 (29.1%),
elm 2,039 (18.0%), maple 1,052 (9.3%), broadleaf 555 (4.9%). All eight tests and
25,563-stem parity pass. Installed files verified; scene not replanted or visually
reviewed. Tall and tall-bare variants have the same measured bounds but different
geometry; the bare variant should be reviewed for woodland canopy coverage.
