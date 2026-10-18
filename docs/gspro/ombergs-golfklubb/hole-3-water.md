# Hole 3's water: stepped ponds and waterfalls

Hole 3 (and 9 and 14) are the course's showpieces; hole 3 goes first, built
through tools so hole 9 (falls D-G) is a rerun. Marcus, 2026-10-18.

## What is there (lidar `dem.tif` 2022 + orthos 2023/2025)

The creek past hole 3 is a stair of ponds: flat water surfaces in the lidar
with short steps between them. Read with `golfpipe.water_steps` on
`hole_3_23e` (feature 574) + `hole_3_23c` (572), one cut asked at
[478141, 6457677]:

| Piece | Kind | Water (m) | Note |
|---|---|---|---|
| 23e #0 | pond | 109.61 | east end, by the white tee |
| 23e #1 | pond | 109.12 | full of floating plants (lidar ±0.1 m) |
| 23e #2 | pond | 108.62 | the long pond along the fairway |
| 23c #0 | pond | 107.50 | under the stone arch bridge, fountain |
| 23c #1 | pond | 106.28 | short, between two stone sills |
| 23c #2 | creek | 104.38 -> 103.48 | runs on past the green towards D |

| Fall | Style | Drop | Where (SWEREF 99 TM) |
|---|---|---|---|
| S1 | sill (earth neck) | 0.49 | 478163, 6457672 |
| S2 | sill (earth neck, asked: the plants smear it in the lidar) | 0.50 | 478142, 6457679 |
| A | outlet | 1.12 | 477982, 6457769: a grass crossing; the water goes through a pipe under it (Marcus). Built as a fall out of its west face, for the look |
| B | sill (stone band) | 1.22 | 477939, 6457801 |
| C | sill (stone band) | 1.92 | 477920, 6457820, by the green's bunker |

Hole 9's falls, for later: D 103.0 -> 100.9 (rockery by the cart path,
x≈477814), E 100.9 -> 99.3 (bridge at hole 9's green), F 99.3 -> 98.0,
G 98.0 -> 96.8. The water features there (573, 576, 569, 575) are separate
polygons already.

## The feel to aim for (Marcus's photos)

- [views/hole-3-green-to-creek.webp](views/hole-3-green-to-creek.webp): across
  the green towards the creek. A row of big old broadleaf trees (wide, dense
  crowns, trunks leaning) stands along the creek right behind the green; the
  water is sunk out of sight below a mown bank that runs from the green's
  apron down to it; tall yellow-green rough beyond the creek, open course
  further back. The creek reads as a cool, shaded line under the trees, not
  as open water.
- From the white tee (shown in chat 2026-10-18): the long pond 108.62 runs
  away towards the green, a few boulders at its edge, a low stone-edged bank
  to the left, trees closing the view at the green end.
- From the fairway towards the padel courts: the crossing at A reads as a
  grass strip level with the upper pond; the lower pond and the stone arch
  bridge sit 1.1 m down, hidden until you are near.

## Hole 7, later: the creek on below 9 (`hole_7_23f`, feature 575)

[views/hole-7-creek-stone-bridge.webp](views/hole-7-creek-stone-bridge.webp),
100-130 m short of the green: the creek is a narrow sunk ditch across the
fairway, full of tall vegetation (reeds, tall herbs) standing above the banks,
mown banks down to it, and an old fieldstone arch bridge over it (dark
red-grey stones, a low round arch). The ortho shows two crossings on 575, at
about 477521, 6457811 and 477447, 6457786 (the western one, by the green with
the single bunker, is most likely the photo's).

Find falls on 569 + 575 (2026-10-18, read only): fall G 1.20 m (pond 569 at
97.93-98.0 into the creek), the creek runs 96.76 -> 95.09 over ~250 m, then a
0.72 m sill at 477383, 6457759 into a small pool at 94.37. The finder cut
slivers of 9 and 15 m² at the creek's two ends: a step at a body's very end
should become a fall into the next body rather than a piece of its own (to
do when hole 7 is built). The tall growth is the creek's `bankVeg` (its
`_wet` mix: reeds); the stone arch bridges (here and the one over hole 3's
107.50 pond) want one reusable bridge prop.

## The chain (tools added for it)

1. **Find falls** (terrain editor; `bun run water:steps`): propose the split
   and the falls from the lidar, add/skip a step by clicking, Accept. Each
   body's largest piece keeps its feature (shape name), the others are new;
   ponds become `water` with a level dig (`digBankAboveDeg` 45,
   `digLevelOffsetM` so the dig holds the lidar's level), the creek run stays
   `water_creek`; every fall is a `waterfall` feature.
2. **Digs**: Generate pond digs and creek digs, then Update terrain (the levels
   reach Unity through `<prefix>-inner-water-levels.json`).
3. **Shapes -> OPCD -> meshes**: the new ponds are new lake shapes.
4. **Water planes**: one per pond; a plane's outset ring now stops half way to
   the next pond, so two ponds a sill apart don't overlap at two levels.
5. **Waterfalls** (board row; `golfmap.waterfalls.build`): a R.A.M. spline per
   fall from the upper water over the lip into the lower, foam and spray
   particles; levels snap to the planes found either side.
6. Stone sills at B and C: rock slabs across the strip between the ponds
   (the sill strip is 1 m wide).

## State

- 2026-10-18: all tools in and committed: steps finder, `waterfall` type,
  Find falls (terrain editor + `bun run water:steps`), the waterfalls export
  and its board row, the Unity builder, the water-plane clipping. The dry run
  of Find falls on the live data gives the table above. **Waiting**: the DB
  split (run Find falls / `bun run water:steps -- "Ombergs Golfklubb"
  --feature hole_3_23e --feature hole_3_23c --cut 478141,6457677`), the digs
  and anything through OPCD/Blender/Unity wait until the new map's
  integration into Blender and Unity is finished (Marcus). DB backup:
  `data/backups/app-before-hole3-water-2026-10-18.sqlite`.
- The waterfall look is not judged yet: in the scene the place is still tall
  grass (no ponds); the R.A.M. "big cascade" reads as a white wall until it
  stands in water. Tune `<course>/Waterfalls/Waterfall water.mat` (made once,
  kept) once the ponds are in.
