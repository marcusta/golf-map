# Omberg clubhouse area

Authored exterior models for the existing Omberg Unity course, based on local
2023/2025 orthophotos, lidar and inspected exterior photographs. This is a
reconstruction for course rendering, not an architectural survey. No OPCD
generated course `.blend` is modified.

## Evidence and editable source

- `survey.py`, `survey.json`, `survey.md`: measured footprints, roof planes,
  elevations, source provenance and uncertainty. The local evidence images are
  under `data/omberg-clubhouse/`.
- `references.md`: photographic sources, observed details and unresolved details.
- `model.py`: course-specific Blender geometry, materials and placement manifest.
- `main_building.py`: the tall main building's joined shell, recessed window
  openings, facade details and roof junction, based on the user's photographs.
- `courtyard.py`, `courtyard.json`: the photo-traced courtyard paving, triangulated
  on a 1 m grid and sampled over the exported edited DEM with a 3.5 cm lift.
  Surveyed roofs, the foyer and its existing brick apron are excluded.
- `install.ps1`: copy models into the Unity project and merge this set with any
  unrelated props. Existing overwritten files are backed up; `placed.json` and
  Unity `.meta` files are preserved.

The model separates the clubhouse, western white-roof connector, three red
lodging blocks, southeast hall and four smaller ancillary buildings. Geographic
labels are asset identifiers; they do not assert the buildings' official names
or current functions. The existing terrain, parking and playing surfaces remain
the course's own geometry.

## Rebuild and install

Run these commands from the repository root in PowerShell:

```powershell
bun run py D:/golf-map/docs/gspro/ombergs-golfklubb/clubhouse/courtyard.py

& 'C:/Program Files/Blender Foundation/Blender 4.5/blender.exe' -b --factory-startup --python-exit-code 1 --python docs/gspro/ombergs-golfklubb/clubhouse/model.py -- --out data/omberg-clubhouse/build

./docs/gspro/ombergs-golfklubb/clubhouse/install.ps1 -Build ./data/omberg-clubhouse/build -UnityProject D:/gspro_courses/omberg_v4_2025_12_02 -CourseFolder Omberg -BlenderDestination D:/gspro_courses/omberg-opcd/clubhouse -DryRun
```

After reviewing the dry-run output, run the same installation command without
`-DryRun`. With the Omberg course scene open in Unity:

```powershell
bun unity/mcp/call.ts golfmap.props.place '{"dryRun":true}' 120 omberg
bun unity/mcp/call.ts golfmap.props.place '{"save":true}' 180 omberg
```

The installer places FBX models, generated textures and `props.json` under
`Assets/GolfMap/Omberg/Props/`. It also copies the packed authored Blender file to
`D:/gspro_courses/omberg-opcd/clubhouse/omberg-clubhouse-authored.blend`.
The `.blend` has a geographically arranged review scene; Unity places each FBX
individually using the EPSG:3006 manifest and the inner-terrain coordinate frame.

This custom architecture generator is rebuilt with the command above. The
general **Update props** command does not execute `clubhouse/model.py`. Keep
these assets and their instances when adding a future ordinary props spec.
The installer merges them, but a later full replacement of `props.json` by an
unrelated generator would need the same merge.

## Placement and limitations

Roof elevations use RH2000 absolute metres. The low clubhouse ridge is about
115.15 m; the high eastern ridge about 119.95 m. The main ground surface is about
109.16 m. The western connector reaches about 121 m and spans a rising site;
its parts use different floor levels. Grounding corrections are recorded in the
generator, not hidden in manual scene transforms.

Roof outlines traced from the orthophoto are approximately accurate to 0.5–1.5 m.
Individual facade openings, unseen elevations and small furnishings are
interpretations where photographs do not resolve them. The southeast pale hall
and western white-roof connector are distinct buildings; the official oblique
photo in `references.md` documents the southeast hall. The models have exterior
meshes and colliders, without furnished interiors.

Review the model on the course terrain in Unity: the Blender presentation
ground is an approximation, not a terrain-height reference. Check both the parking/courtyard side
and the course side after any terrain update. Editor screenshots do not confirm
appearance or performance in a built GSPro course.

## Vegetation clearance

`vegetation-exclusions.json` records 15 detected tree stems strictly inside the
surveyed roofs or the paved courtyard, and the courtyard polygon traced from the
orthophoto. `vegetation-exclusions.py` preserves existing manual tree edits and
backs up changed export files. It removes these false tree detections and clears
lower vegetation only inside the roof/paving polygons.

```powershell
bun run py D:/golf-map/docs/gspro/ombergs-golfklubb/clubhouse/vegetation-exclusions.py --dry-run
bun run py D:/golf-map/docs/gspro/ombergs-golfklubb/clubhouse/vegetation-exclusions.py --apply
bun unity/mcp/call.ts golfmap.trees.plant '{"terrain":"inner","save":true}' 300 omberg
bun unity/mcp/call.ts golfmap.zones.patch '{"terrain":"inner","patch":"D:/golf-map/data/omberg-clubhouse/clubhouse-vegetation-patch.json","save":true}' 180 omberg
bun unity/mcp/call.ts golfmap.vsp.reset '{}' 180 omberg
```

The tree edits persist across replants. The lower-vegetation mask clearance is a
documented post-export overlay: after **Update vegetation** or any zones export
that touches this area, rerun the Python command with `--zones --apply`, then
`golfmap.zones.patch`. The application database is unchanged. The overlay is not
yet part of the general update chain.

For this course's open Unity 2018 editor, a successful texture patch still left
the old grass visible until `golfmap.vsp.reset` rebuilt its active caches. The
reset above is therefore part of this local workflow. Source masks alone do not
prove that the current Scene view has respawned from the changed pixels.

The fine grey courtyard paving is a separate authored mesh inside exactly the
saved photo-traced polygon. It follows the existing exported DEM and changes no
terrain, database, greens or surrounding lawn. Regenerate `courtyard.json` after
any DEM or entry-apron geometry change, rebuild the Blender set, then inspect
the paving against the actual Unity course meshes before saving. The ground
photo had painted this paved area green; the local mesh restores its surface
without replacing the course-wide photo or terrain.

The script preserves previously requested mask imports even when a repeated run
finds zero source pixels to change. If a Unity patch import fails, retry that
same `golfmap.zones.patch` command; rerunning the script also retains the pending
texture keys and region. Reimporting an already imported patch is safe. For a
fresh forced reimport of every current mask, use `--zones --force-import --apply`
and then the patch command. Reports distinguish changed source masks from masks
requested for import; `--dry-run` never replaces the original patch file.

## Validation checkpoint (2026-10-16)

The current `data/omberg-clubhouse/build/build-report.json` records 11 assets,
83,248 triangles and 38 materials. The authored Blender file has 39 packed images,
and eight preview views are available. These counts describe this checkpoint;
read the build report again after a rebuild.

The tall main building uses a joined shell with actual window holes, 22 cm
reveals, inset green frames, mullions and glazing. Its seven course-facing upper
bays follow the photographed single/wide pattern `S,S,W,W | S,W,S`. The roof
planes are clipped to the joined building outline. Unseen elevations remain
interpretations.

The new main-building solid palette and courtyard asphalt are converted from
sRGB to linear on the exported manifest copy only. Blender keeps the authoring
palette. Main roof and basement texture tints are calibrated in the Unity view;
the shared props kit and unrelated courses are unchanged. Roof seams use texture
and normal detail; tiny physical seam strips caused distance aliasing and were
removed. Ridge caps, fascia, gutters and downpipes retain geometry.

All eleven props have been installed and the Unity scene saved with no placement
warnings. The matte specular treatment resolved the bright terracotta roof
glare. Actual Unity course-side, elevated, courtyard and entrance views were
inspected after material calibration: the main roof has no distance speckles,
the wall reads grey, glazing/mullions are visible, and the stone basement is
darker than the upper facade. The entrance uses a 26.1-degree gable, a raised
stone shoulder and a title width of 3.24 m within its 4.02 m portal.

The fifteen tree exclusions have been applied and the trees replanted. After a
later exports restored the masks, the courtyard overlay was reapplied at 17:59,
clearing 5,472 pixels. The zone patch was imported and `golfmap.vsp.reset`
visually cleared the stale courtyard grass. The separate 618.8 m² paving mesh
has also been installed. Its source follows the exported DEM and leaves the
entry's existing brick apron free.
The paving FBX uses continuous smooth normals with no sharp edges (794 vertices,
1,407 faces); buildings retain flat architectural normals. Reimporting the FBX
confirmed continuous shared normals. Broad tonal patches remain on the courtyard
in Unity; smoothing normals and a temporary 15 cm clearance test did not remove
them. The clearance test was restored and is not part of the authored placement.
The cause of this remaining ground-shading issue is not established.

The parallel GSPro build finished at 18:10. It predates the final entrance
proportion correction and the reapplied courtyard mask. The final authored
model is saved in Unity; appearance and performance inside GSPro remain unverified.
Run `bun unity/mcp/build-status.ts <project>` before diagnosing an unresponsive
editor: a course build can occupy Unity's main thread. A new GSPro build is a
separate step from importing and reviewing these models in the editor.
