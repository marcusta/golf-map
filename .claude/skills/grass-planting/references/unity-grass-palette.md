# Unity side of the grass palette (reference)

Moved from unity/AGENTS.md. The loop in SKILL.md is the owner; this holds the palette-building facts it lacks.

Lower vegetation (tall rough grass etc.) is a **grass palette**: `<course>/grass-palette.json`
(`golfmap-grass-v1`, snapshot in `docs/gspro/<course>/`), built into VSP by `GolfMapGrass.cs`
(`golfmap.grass.apply`): greyscale copies of the source textures (RUSTIC Grass PSDs) under
`<course>/Grass/Textures/`, texture grass items on the stock `AwesomeTechnologies/Grass/Grass` shader in a
`GolfMap lower vegetation` package (Default biome) on the terrain's system, coloured by the items'
dry/healthy tints. An item with a `prefab` instead of a `source` texture is a mesh bush (VSP Plant,
own materials, shader checked against GSPro's VSP): the `shrub` palette's willow thicket. Loop: apply -> `bun run zones -- add <course> <zoneType> --from-feature <id>` and
`bun run zones -- bind <course> <zoneType> --palette <grass-palette.json>` -> `bun run gspro:export --
<course> zones:inner` -> `golfmap.zones.import` (terrain, package) -> apply again (items spawn only once a
zone mask includes them: an include rule on a group that exists in the package). Tune colours against the ground, not by eye: compare a 30 m top-down shot with
the palette hidden (`golfmap.grass.apply spawn=false`) and shown, and scale the tints by the ground/grass
ratio; the green items carry the match, straw/seed-head items stay sparse, muted accents. A palette's
`distanceFalloff` thins the grass towards the draw distance instead of a pop line. **Where** tall grass
grows is generated for the whole course by rule - see the `grass-planting` skill
(`.claude/skills/grass-planting/SKILL.md`): `golfmap.surfaces.export` (surface map from the built
meshes: OPCD's `Outer_Deep_Sat` fill is not a DB feature) -> `bun run grass:zones -- <course>` ->
`golfmap.zones.import` -> `golfmap.grass.apply`. Creek banks: creeks (and `water` polygons) marked with a `bankVeg` palette
get `creek_bank` zones from the same `grass:zones` run (palettes `creek_bank/<variant>`, same skill).
