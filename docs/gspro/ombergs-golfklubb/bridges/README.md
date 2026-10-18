# Omberg bridges

Props specs for Omberg's stone bridges; the same build/install chain as the tee signs
([../tee-signs/tee-signs.gen.py](../tee-signs/tee-signs.gen.py) header).

## Hole 17: the creek between the two ponds (`hole_17_233`)

[creek-bridge.json](creek-bridge.json), asset `omberg_creek_bridge_17`: `bridge_brick` (props_kit), 4.8 m long on
bearing 69 deg, 2.0 m between 0.25 m parapets, low arch (rise 0.2), pale grey-beige granite (`granite_beige` walls,
`granite_plinth` deck). Position and bearing from the 2023 ortho (a pale slab 4.7 x 1.7 m, centre
477672.7 / 6457220.7, axis 68 deg); Marcus's screenshot point 477669.7 / 6457222.4 is the same crossing.
[creek-bridge-deck.geojson](creek-bridge-deck.geojson) is the `surface: bridge` path feature (source `props-bridges`,
imported with `server/scripts/import-generated-features.ts`) that keeps creek-bank vegetation off the bridge; it is
left out of the SVG like every bridge deck.

```
blender -b --factory-startup --python blender/tools/build_props.py -- --spec docs/gspro/ombergs-golfklubb/bridges/creek-bridge.json --out data/omberg-bridges/build --preview
pwsh docs/gspro/ombergs-golfklubb/clubhouse/install.ps1 -Build data/omberg-bridges/build -UnityProject D:/gspro_courses/omberg_v4_2025_12_02 -CourseFolder Omberg
```

then `golfmap.props.place only=omberg_creek_bridge_17 save=true` in Unity **after** the terrain update (the bridge sits on the
highest ground under it, which the creek dig lowers). A hand move in Unity is kept by the next place; write it into the spec's
`e` / `n` / `yawDeg` / `dz` to make it permanent.

## The water around it (DB, terrain edits)

| Feature | Dig | Level |
|---|---|---|
| pond `hole_17_230` (south, open water) | `water-digs`: depth 1.4 m, bank 20 deg, 30 deg above the water, level offset -0.09 | 107.80 m (lidar water 107.75-107.82) |
| pond `hole_17_231` (north, reeds, stone rim) | depth 1.3 m, bank 22 deg, 40 deg above, offset -0.11 | 106.42 m (lidar 106.41-106.45) |
| creek `hole_17_233` | `creek-digs`: depth 0.5 m, bank 30 deg | surface from 107.7 (pond 230's outlet) falling to ~106.7 (0.25 m above pond 231) |
