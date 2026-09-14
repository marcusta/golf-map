# Species and bark correction

The canopy pass's hard-coded woodland species-fit slack of 0.2 excluded oak/elm
before species weights could apply. Similar survey dimensions therefore produced
birch clusters. Woodland now reads `woodlandSpeciesFitSlack` (1.5 in Vreta), with
ordinary `speciesFitSlack` as fallback. Other matching and scale limits are unchanged.

Audit using the previous inner export's density classifications: of 11,337 matched
broadleaf stems, birch falls from 8,625 to 4,358; oak rises from 1,469 to 3,573 and
elm from 1,243 to 3,406. Imperfect/unknown broadleaf fits rise from 3,078 to 6,674.
These are proposals when review matches are included, not a measured live-scene count.
The palette needs smaller elm and narrower oak assets to improve this tradeoff;
the single elm is 26.6 m tall, while oak crown widths are 13.3 and 16.1 m.

Private birch bark tint changes from 0.95 to 0.68 RGB, oak from 0.85 to 0.72.
Leaf materials are unchanged. The bark shaders use these colours in albedo;
birch metallic/smoothness powers are already zero. Installed files are backed up.
Visual bark appearance is not yet verified. Replant to apply species changes;
rebake outer billboards to include bark changes.

Validation: installed-Unity compilation, seven matching tests and 25,563-stem
JS/C# parity. Reproducible staging: `unity/prepare-species-bark-pass.mjs`.
