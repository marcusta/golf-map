# Omberg clubhouse local survey

Measured 2026-10-16 from the existing course sources, with no change to the database, terrain or Unity scene. The main clubhouse has a low western red roof and a much taller eastern red roof, joined along a valley. Its courtyard opens north. A tall, bent white metal-roof connector links its northern end to the diagonal red-roof building; the connector exists in both orthophoto vintages and in the lidar but is absent from the OSM building polygons.

## Evidence and coordinate frame

- Course `ce4629e1-042d-4ea7-b31e-9226e2742a56`, site `317d1f83-3ade-431c-8201-605ac0bd2871`.
- Pristine `ortho-orto-l2-2023.tif` and `ortho-orto-l2-2025.tif`, 0.16 m/pixel, EPSG:3006. The collection labels are vintages, not independently verified capture dates.
- Local COPC lidar `y22c009-64575_4775_25.copc.laz`, collection `dsm-skoglig-copc`, item `22c009-64575_4775_25`. Crop contains 71,643 returns: 14,281 class 1, 57,359 ground/class 2, 3 class 7. Adjacent broad `m22...` file contributes no points in this crop. The item name is retained without inferring a precise capture date.
- Existing `buildings.geojson`: OpenStreetMap footprints, fetched 2026-10-16, attribution © OpenStreetMap contributors, ODbL. Coordinates are source vertices, not centimetre survey measurements.
- Source `dem.tif`: ground elevation, RH2000. Roof elevation measurements below are absolute metres in the same height frame.
- Unity frame: x = E − 477021; z = N − 6456736; y = absolute elevation − 80.762001. Parent's read-only Unity probe at E477808/N6457659 gave mesh ground absolute 109.157 m; pristine DEM at the same place is 109.165 m.

`survey.json` retains original footprints, principal building rectangles, ground point distributions, raw roof percentiles, fitted roof planes and approximate extra roof outlines. Reproduce with `bun run py D:/golf-map/docs/gspro/ombergs-golfklubb/clubhouse/survey.py` from the repository root. It reads sources and only writes this survey JSON and images/cache in `data/omberg-clubhouse/`.

## Principal roofs

| Roof | Location E / N | Principal wall body / bearing clockwise from north | Measured ridge absolute |
|---|---|---|---|
| Main clubhouse west low wing | Ridge near 477796.3 / 6457660 | N–S, ~48 m roof length; roof width ~14 m; lower canopy extends west | 115.2 m |
| Main clubhouse tall east roof | Ridge near 477817.5 / 6457649 | Broad south body ~29.8 × 25.1 m, plus northern east stub ~7.7 × 6.7 m; concave outline | 120.0 m |
| Northern horizontal red gable, OSM 687779185 | Main wall center 477790.75 / 6457763.78 | 25.4 × 12.63 m, bearing 84.3°; south porch increases whole outline width | 114.1 m |
| NW diagonal red gable, OSM 687779186 | Main wall center 477780.10 / 6457724.03 | 24.64 × 13.25 m, bearing 148.4°; NE porch increases whole outline width | 114.8 m |
| NE long red gable, OSM 687779187 | Whole-outline center 477868.97 / 6457745.33 | 35.93 m long; main rectangular body ~12.9 m wide; bearing 174.4°; west porch widens whole outline | 116.9 m |
| Eastern long block, OSM 1431566994 | 477921.81 / 6457682.14 | 50.77 × 17.15 m; bearing 74.2° | 121.0 m |
| White bent connector | Diagonal center approximately 477790.5 / 6457703.6; south leg near 477796.6 / 6457687 | Diagonal roof ~24 × 14 m; south leg ~16 × 13 m, overlapping at bend | ~121.0 m |

The last two white-roof section outlines are interpretations with approximately ±1.5 m boundary uncertainty. Their ground changes substantially: pristine DEM ~106.27 m near the diagonal section center, ~108.97 m at the southern leg. Use absolute roof levels and inspect seating against the current Unity meshes. A single relative height would be misleading.

## Main clubhouse section

Both principal gables have approximately 22° pitches. Four robust roof plane fits use 117–255 retained returns per plane, with residual RMS 0.028–0.043 m. That tight fit measures the plane consistency; it does not imply similarly exact roof edges or geolocation.

At N6457652, the lower west roof has a ridge around 115.2 m; its western roof edge near E477789 is around 112.1 m and its valley near E477801 is around 113.3 m. The taller east roof rises from that valley to around 120.0 m at E477817.5, falling to approximately 116.3 m at E477826.5. These are an asymmetric roof assembly with a shared valley, not two same-height simple boxes. The wall/roof outline must preserve the northern courtyard cut.

The existing survey's `eaveM` and `ridgeM` are nDSM distribution percentiles, not physical eave/ridge measurements. In particular, the diagonal red building's p95 was contaminated by the adjoining high white roof; use `inferredGableAtMidLength` and the clean fitted red roof planes instead. For other gables those inferred eaves evaluate the planes at the principal OSM wall lines, so allow roughly 0.3–0.6 m when choosing the model's actual overhang edge.

The orthos visibly lean tall roofs relative to ground footprints and differ slightly between vintages. Traced roof outlines and OSM ground walls should remain separate evidence. Allow approximately 0.5–1 m for uncomplicated building edges and 1–1.5 m for the bent connector, rather than treating every decimal in the JSON as measured precision. Façade colours, opening layout and roof materials need the independent photographic evidence.

## Images

- `data/omberg-clubhouse/survey-annotated-ortho.png`: north-up 2025 ortho, roof heights and interpreted roof extents.
- `data/omberg-clubhouse/survey-height-section.png`: raw points and fitted main clubhouse roofs; vertical scale exaggerated.
- `data/omberg-clubhouse/ortho-2025-osm.png`, `ortho-2023-osm.png`: source outlines and OSM identifiers.
- `data/omberg-clubhouse/clubhouse-detail-2025.png`: unlabelled enlarged main clubhouse/connector crop.
- `data/omberg-clubhouse/lidar-height-top.png`: sparse DSM minus ground, with OSM outlines. Dark pixels have no return; they are not measured holes in roofs.

## Independent model review

Initial `model.py`, `build/Previews/top.png` and `build/Previews/southwest.png` reviewed against this survey. The model preserves the main north-opening courtyard and the tall/low roof distinction; the bent connector and principal lodge axes agree with the source plan. Review found and reported: high-roof planes must not be extrapolated into the uncovered north-west wing; overlapping low/tall roofs need a common valley seam; facade windows must follow the actual non-axis-aligned wall lines; the white connector's two legs need different floor levels as the ground rises.

The parent independently probed Unity at the white connector pivot E477792.5/N6457698: highest mesh ground absolute 106.6887493 m. A model authored with pivot base 107.2 m needs `dz = 0.5112507` to retain its absolute roof elevations, unless that authored base is changed. This offset is course-scene seating evidence, not a change to the source terrain. Other building pivot ground readings from the pristine DEM differ from their surrounding ground medians by less than 0.1 m.

The broad south-eastern block (OSM 1431566994) and the bent white connector are distinct structures despite both roofs reaching approximately 121 m absolute elevation. The former is a straight 50.77 × 17.15 m body on ground ~110.66 m; the latter bends, on ground ~106.7–109 m. Exterior photographic interpretation must follow these placements before assigning materials. The standalone Blender review uses a flat plane at the main clubhouse ground level, which hides lower northern floors; final seating must be judged against Unity's actual terrain.

Corrected generator and `build-report.json` were subsequently reviewed: ten assets, 83,286 triangles. Lodge ridge bounds plus their authored ground bases agree with the fitted roof levels to roughly 0.1 m, including ridge caps; main clubhouse highest vertex is approximately 119.86 m absolute, white connector approximately 121.08 m including its cap. The connector manifest carries `dz: 0.511251`; the roof coverage/valley and south-facade window fixes are present. This checks reconstruction coordinates and geometry; scene seating and final appearance remain subject to the parent's Unity visual check.

## Local vegetation clearance overlay

`vegetation-exclusions.py` and its JSON data are a course-local, reversible use of existing tree-edit and zone-patch mechanisms. Default invocation, or `--dry-run`, changes no external exports. `--apply` merges fifteen fixed tree IDs: nine stems strictly inside surveyed roofs and six strictly inside the separately traced paved courtyard, where the ortho shows continuous paving without trees. It preserves every existing edit and reports conflicts instead of overwriting them. Lower-vegetation mask pixels are cleared only inside the roof union plus 0.5 m and the paved courtyard. Dry run found fifteen new delete records and 5,472 changed pixels in only `ombergs-golfklubb-inner-zones-0.png`; no manual edit conflicts. Other nearby crowns remain: no tree is selected merely because its crown approaches a roof.

Review `data/omberg-clubhouse/vegetation-clearance-review.png` before applying. The courtyard polygon follows the visible continuous stone-paved space on the 2025 photo, stops west of the central annex and south of the parking approach, and has approximately 0.5–1 m boundary uncertainty. Each changed external file is copied first into `<export>/clubhouse-backups/<timestamp>/`.

Apply with `bun run py D:/golf-map/docs/gspro/ombergs-golfklubb/clubhouse/vegetation-exclusions.py --apply`. Then import through the existing Unity commands `golfmap.trees.plant {terrain: inner, save: true}` and `golfmap.zones.patch {terrain: inner, patch: D:/golf-map/data/omberg-clubhouse/clubhouse-vegetation-patch.json, save: true}`. The script also accepts `--trees` or `--zones` separately. Tree deletes persist through normal exports and replants. **The lower-vegetation mask overlay must be reapplied after a full or overlapping zones export**, then imported again with `golfmap.zones.patch`; it is reproducible from the saved script/data but is not integrated into Update vegetation. No shared runtime code, DB zone geometry, terrain or shaping changes are involved.

Patch retries preserve prior matching texture keys even when the source PNGs are already clear: zero changed source pixels does not prove Unity imported them. The report distinguishes `changedMasks`, `importMasks` and `retainedImportMasks`. `--zones --force-import --apply` can request a fresh import of every current mask; ordinary retries retain just the previous relevant masks. Dry run never replaces the original patch. Reimporting an already imported patch safely copies the same source PNGs and clears the same local VSP cache bounds again.
