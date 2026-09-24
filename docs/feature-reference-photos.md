# Plan: reference photos from the course for Unity look matching

**Status:** proposed 2026-09-24, nothing built
**Date:** 2026-09-24
**Scope:** `ios` (capture mode, offline queue, upload), `server` (photo store on the VPS,
pull endpoints, builder pull CLI, pose refinement, `unity-photos-v1` export), `web`
(photo layer in the builder), `unity/Editor/GolfMap` (reference cameras), `shared`
(feature gate, API client).

## 1. Purpose

The GSPro course is built in Unity on the Windows machine. Claude on that machine drives
Unity through a Unity MCP server the user built, which exposes the Unity editor to
Claude. To make the Unity scene look like the real course, Claude needs photos of the real course taken from known positions, and a Unity camera
placed at each of those positions.

The flow:

1. The user walks the course with the GolfMap iOS app and takes photos in a capture mode.
   Each photo records position, camera direction, tilt, field of view and time.
2. The app uploads photos to the VPS when it has a connection.
3. The Windows builder pulls new photos from the VPS into the matching site.
4. The builder corrects each photo's heading against the lidar skyline.
5. An export writes the photos and their poses in Unity terrain coordinates.
6. A Unity editor script creates one camera per photo. Claude renders from each camera,
   compares the render with the photo, and changes materials, terrain layers and
   vegetation settings.

## 2. Pose accuracy

A render only lines up with a photo if the Unity camera has the phone's pose. The phone
sensors give these errors:

| Quantity | Source | Typical error | Use |
|---|---|---|---|
| Horizontal position | GPS | 3 to 5 m open sky, 10 m under trees | used as is |
| Altitude | GPS | 5 to 15 m | stored, not used |
| Pitch, roll | CoreMotion gravity | about 1° | used as is |
| Heading | CoreMotion magnetometer | 5 to 15°, more near carts and metal | prior for refinement |
| Field of view | lens metadata | under 1° | used as is |

Heading error dominates. At 10°, a tree line 200 m away lands 35 m sideways
(200 × tan 10°). The iPhone main camera covers about 65 to 70° horizontally, so 10° is
about 15% of the frame width. Section 6 corrects the heading after capture.

Camera height comes from the DEM, not from GPS. It is the ground elevation at the photo
position plus the height the phone was held at (default 1.5 m).

## 3. Decisions

**D-RP1. Capture happens in the GolfMap iOS app, not the stock Camera app.** The stock
app writes heading to EXIF (`GPSImgDirection`) but not pitch or roll. Without pitch, the
horizon sits at the wrong height in every render. The app also knows the site, can gate
on sensor accuracy, and already has the motion code (`Motion/SpotLevelCapture.swift`).

**D-RP2. The camera direction comes from the device attitude, not from `CLHeading`.**
`CLHeading` reports the direction of the phone's top edge. The back camera looks along
the device's -Z axis. The capture reads `CMDeviceMotion` in `.xTrueNorthZVertical` (a
location fix exists during capture) and derives camera azimuth, pitch and roll from the
attitude matrix. The capture stores the quaternion too, so the derivation can be redone.

**D-RP3. Main 1x lens only, zoom locked.** One lens keeps the field of view and
distortion fixed across all photos. The ultra-wide lens has more distortion than the
comparison tolerates.

**D-RP4. No ARKit.** ARKit's `gravityAndHeading` alignment reads the same compass, so it
adds no heading accuracy. It also restricts the camera formats. `AVCapturePhotoOutput`
plus CoreMotion is enough.

**D-RP5. Sensor pose and refined pose are separate fields.** The sensor values are what
the phone measured and are never overwritten. Refinement writes its own fields with the
method and a residual. Exports use the refined pose when present.

**D-RP6. The VPS owns uploaded photos; the builder pulls them.** Photos are user data on
the VPS in the sense of `feature-local-builder-vps-serve.md`, so publish never touches them.
The builder pulls with the existing `PUBLISH_URL` and `PUBLISH_TOKEN`. The phone always
uploads to the VPS, never to the builder, because the builder is not reachable from the
course.

**D-RP7. Photos are keyed by site.** A photo belongs to `site.id`, like the map. Course
and hole are optional tags, filled from the nearest hole at capture time.

**D-RP8. Heading refinement runs on the builder, against the lidar surface.** The builder
has the DEM and canopy rasters; the VPS does not. The refinement is automatic. A manual
heading nudge in the web builder covers photos where it fails.

## 4. iOS capture mode

### 4.1 Screen

A camera button in the course screen opens a full-screen capture view. UI copy follows the
existing conventions: SF Symbol chips, no emojis, no wordy labels.

- Live preview from the main camera, 4:3, zoom locked.
- A horizon line drawn from gravity, so the user sees the tilt.
- Chips for GPS horizontal accuracy and heading accuracy, amber above a threshold.
- Compass azimuth of the camera direction.
- Hole number, auto-filled from the nearest hole, tap to change.
- Optional tags (`look`, `trees`, `bunker`, `green`, `water`) and a dictated note.
- Shutter. It warns, but still captures, when the phone is moving or accuracy is poor.

Behind the gate `referencePhotos` in `shared/feature-gates.json`, tier T1.

### 4.2 What the capture records

At the shutter press the app takes the median of the device-motion samples from the last
0.3 s and checks that the rotation rate stayed under a threshold (tuned in the field
test). It records:

| Field | Source |
|---|---|
| `id` | UUID made on the phone, makes upload idempotent |
| `siteId`, `courseId`, `hole` | open course, nearest hole |
| `capturedAt` | UTC timestamp of the photo |
| `lat`, `lon`, `hAccM` | `CLLocation` at capture |
| `gpsAltM`, `vAccM` | `CLLocation`, stored for reference |
| `attitudeQuat` | `CMDeviceMotion.attitude.quaternion`, `.xTrueNorthZVertical` |
| `yawDeg`, `pitchDeg`, `rollDeg` | camera azimuth (true north), tilt above horizon, roll |
| `headingAccDeg` | `CLHeading.headingAccuracy` at capture |
| `magCalibration` | `CMDeviceMotion.magneticField.accuracy` |
| `hfovDeg`, `vfovDeg` | from `AVCaptureDevice.activeFormat.videoFieldOfView` and aspect |
| `width`, `height` | image size |
| `eyeHeightM` | default 1.5, a setting |
| `deviceModel`, `lens` | device identifier, `wide` |
| `tags`, `note` | user input |

The photo is HEIC from `AVCapturePhotoOutput`, 12 MP, about 3 MB.

### 4.3 Local storage and upload

Photos use the local-first pattern of rounds (`Store/RoundStore.swift`). Capture writes a
`reference_photos` row in the app's GRDB database with `syncState = pending`, and the
HEIC under `Application Support/photos/<id>.heic`. Capture never waits for the network.
The server-side table is `site_photos` (section 5.1).

Upload uses a background `URLSession`, so it continues when the app is suspended:

1. `photos.create` (descriptor API) with the metadata.
2. `PUT /api/photos/<id>/file` with the HEIC as the raw body and its SHA-256 in a header.
3. On success the row becomes `synced`. The app deletes the local HEIC 7 days later and
   keeps a 512 px thumbnail for the in-app list.

A repeated `create` or `PUT` with the same id and hash returns success, so retries are
safe.

## 5. Server

### 5.1 Table

Migration `016_site_photos` adds `site_photos`, present in both modes:

- the fields in section 4.2
- `x3006`, `y3006` from the existing SWEREF 99 TM transform in `server/services/geo.ts`
- `fileSha256`, `bytes`, `uploadedAt`
- `pulledAt` (VPS side, set by the builder's acknowledgement)
- `refinedYawDeg`, `refinedPitchDeg`, `refinedRollDeg`, `refineMethod`
  (`skyline` or `manual`), `refineResidualDeg`, `refinedAt` (builder side)

Files live at `data/photos/<siteId>/<id>.heic`. The server writes a 2048 px JPEG next to
each original for the web builder and the Unity export, since browsers and Unity do not
read HEIC.

### 5.2 Routes

Phone routes, cookie session, both modes:

- `photos.create`, `photos.list`, `photos.update` (tags, note, hole), `photos.delete`
- `PUT /api/photos/:id/file`

Builder pull routes, `PUBLISH_TOKEN` bearer, serve mode only, next to `ingest.routes.ts`:

- `GET /api/ingest/photos?since=<cursor>` returns metadata for photos uploaded after the
  cursor
- `GET /api/ingest/photos/:id/file` streams the original
- `POST /api/ingest/photos/ack` with ids sets `pulledAt`

`start:vps` sets `BODY_LIMIT` to 256 MB, so a 3 MB photo fits. The file route still
streams the body to disk, like the ingest route, and caps it at 20 MB.

### 5.3 Builder pull

`bun run photos-pull` on the builder:

1. Calls the list route with the last cursor, stored in `data/photos/pull-state.json`.
2. Downloads each original, checks the hash, inserts or updates the row, writes the
   JPEG.
3. Sends the ack, then saves the cursor.

The builder server runs the same pull every `PHOTOS_PULL_INTERVAL_MIN` minutes when that
variable and `PUBLISH_URL` are set. On Windows the builder runs in WSL2, and this
in-process interval means no separate scheduler is needed there.

### 5.4 Retention on the VPS

The VPS deletes an original 14 days after `pulledAt` and keeps the row and the JPEG. At
3 MB per photo, 300 photos per course is about 0.9 GB, several times a published site
(80 to 135 MB). 14 days leaves time to pull again after a builder data loss.

## 6. Heading refinement

`bun run photos-refine <siteId> [--photo <id>]` on the builder, one Python command in the
pipeline (`golfpipe/photo_pose.py`) called per photo.

Inputs: the refined-or-sensor pose, the JPEG, and `surface.tif`. The `canopy` command
writes `surface.tif` for the `surface` tile layer. It holds ground DEM plus canopy
height, with crowns tapered at their edges. It lands in the map-build job's work dir,
which the build does not keep, so wave RP5 (section 13) makes the map build copy it to
`sources/<site>/surface.tif`. The camera height uses the edited
DEM (`dem-edited.tif` when present, else `dem.tif`), because the Unity heightmap reads the
edited DEM and the photo camera must stand on the same ground.

Steps:

1. **Model skyline.** For each image column, cast a ray from the camera at that azimuth
   and find the highest elevation angle of the surface out to 2000 m. Record the angle
   and the distance of the hit.
2. **Photo skyline.** For each column, find the sky boundary from the top. A color and
   brightness threshold on the top rows handles clear and overcast skies. A segmentation
   model replaces it only if the field test shows the threshold fails.
3. **Fit.** Search heading ±25° in 0.1° steps and pitch ±2° in 0.1° steps for the smallest
   weighted difference between the two skylines. Weight columns by hit distance and
   drop columns with a hit under 80 m. A 5 m GPS error moves a skyline 100 m away by about
   3°, and one 300 m away by about 1°.
4. **Accept or flag.** Accept when the residual is under 0.5° and at least 30% of columns
   are usable. Otherwise leave the sensor pose and flag the photo for the manual nudge.

Open fairway views with a flat distant skyline and photos dominated by one near tree
will fail step 4. The manual nudge in section 7 handles them.

The `canopy` command's building suppression zeroes roofs (`canopy.py`), so buildings are
missing from the model skyline. The fit drops columns where the photo skyline is above
the model skyline by more than 3°.

## 7. Web builder

A photo layer in the builder, builder mode only:

- A marker per photo with a view wedge: refined azimuth and field of view, 150 m long.
  Unrefined photos draw the wedge dashed.
- Clicking a marker opens the JPEG in a side panel with the metadata and refinement
  residual.
- An overlay toggle projects the golf-map features (greens, bunkers, fairways, water,
  tree stems) into the photo with the current pose. The projection uses the same camera
  model as the refinement.
- A heading slider (±10°, 0.1° steps) moves the overlay. Saving writes
  `refineMethod = manual`.

When drawing features, the panel shows what a bunker edge or tree line looks like from
the ground.

## 8. Unity export: `unity-photos-v1`

`bun run unity-photos-export <siteId> --out <dir>` writes `photos.json` and the JPEGs to
`<dir>/photos/`. Plain JSON that `JsonUtility` parses, same plot and axis conventions as
`unity-trees-v1` (`unity/README.md`):

```json
{
  "format": "unity-photos-v1",
  "plot": { "crs": "EPSG:3006", "originX": 651200.0, "originY": 6403500.0,
            "sizeM": 1500, "minM": 12.4, "maxM": 71.9 },
  "photos": [
    { "id": "…", "file": "photos/….jpg", "capturedAt": "2026-10-02T09:14:31Z",
      "hole": 7, "tags": ["look", "trees"], "note": "",
      "x": 412.3, "z": 880.0, "groundM": 34.85, "eyeHeightM": 1.5,
      "yawDeg": 212.4, "pitchDeg": -3.1, "rollDeg": 0.8,
      "hfovDeg": 67.2, "vfovDeg": 53.0, "width": 2048, "height": 1536,
      "poseSource": "skyline", "refineResidualDeg": 0.3,
      "sunAzimuthDeg": 148.2, "sunElevationDeg": 21.7 }
  ]
}
```

- `x`, `z` are metres east and north of the plot origin (`x3006 - originX`,
  `y3006 - originY`).
- `yawDeg`, `pitchDeg`, `rollDeg` are the refined values when present, else the sensor
  values. `poseSource` is `refineMethod`, or `sensor` for an unrefined photo.
- `groundM` is the edited-DEM elevation at the photo position. The Unity camera height is
  `terrain.position.y + (groundM - minM) + eyeHeightM`.
- `yawDeg` is a compass azimuth. With x east and z north, Unity's Y rotation equals it.
- `sunAzimuthDeg` and `sunElevationDeg` come from `capturedAt` and the position (NOAA
  solar position algorithm, a small function in the pipeline).

The plot comes from the `.raw` heightmap export, which is not written yet. Until it
exists, the export takes `--plot originX,originY,sizeM,minM,maxM` on the command line.

## 9. Unity side

`GolfMap > Reference Cameras`, in `unity/Editor/GolfMap/GolfMapReferenceCameras.cs`:

- **Import.** Reads `photos.json` and creates a disabled `Camera` per photo under a
  `GolfMapPhotoCameras` parent, named `<hole>-<id>`. It sets position, rotation,
  `fieldOfView` (Unity's is vertical, so `vfovDeg`) and aspect. A component holds the
  photo metadata. Re-import updates cameras by id.
- **Overlay.** Shows the photo over the camera view at adjustable opacity, to check
  alignment by eye.
- **Sun.** Rotates the scene's directional light to the photo's sun azimuth and
  elevation.
- **Render pair.** Renders the camera at the photo's resolution through the scene's
  post-processing stack. Writes `GolfMapPhotos/renders/<id>.png` next to a copy of the
  photo.

Each action is a public static method (`GolfMapReferenceCameras.Import(path)`,
`.SetSun(id)`, `.RenderPair(id)`) besides the menu item. An MCP that can run menu items
or editor methods can drive the whole loop. Before the first real use, a test photo of
a known scene pins the sign conventions for pitch and roll.

## 10. The comparison loop

Claude on the Windows machine has the golf-map repo and the Unity MCP. Per photo:

1. `photos-pull`, `photos-refine`, `unity-photos-export`, then Import in Unity.
2. `SetSun(id)`, `RenderPair(id)`.
3. Read the photo, the render and the surface statistics (section 10.1).
4. List the differences: tree species mix and density, understory, rough height and
   color, bunker edge shape and sand color, missing objects such as sheds or fences.
5. Change materials, terrain layers or VSPro settings through the MCP. Render again.
6. Append each change and its reason to `GolfMapPhotos/look-log.md`.

Changes go through Unity's Undo. The OPCD project is under version control, so the user
reviews the diff before keeping it.

### 10.1 Surface statistics

A vision model reads the images well for structure and poorly for absolute color. The
phone's white balance and exposure shift colors, and the Unity render has its own
tonemapping. The builder measures color instead:

1. Project the golf-map features into the photo with the refined pose. Drop pixels the
   surface raster hides (depth test against the model from section 6).
2. Write a label image per photo: green, fairway, rough, bunker, water, canopy.
3. Per label, the median and interquartile range in CIELAB.

The Unity camera has the same pose, so the same label image applies to the render.
Compare ratios within one image (green against fairway lightness, rough against fairway
hue) rather than absolute values. Ratios cancel most of the white balance and exposure
difference.

`photos-refine` writes `labels/<id>.png` and `stats/<id>.json` next to the JPEGs, and the
export copies them.

## 11. Limits and numbers

- 300 photos per course is about 0.9 GB of HEIC on the VPS before retention, and about
  150 MB of 2048 px JPEGs per site on the builder.
- Heading refinement is one ray cast per image column: 2048 columns × 4000 steps at
  0.5 m, well under a second per photo in numpy.
- At 2048 px over 67°, one pixel is 0.033°. The 0.5° acceptance residual is about
  15 pixels, enough for comparing tree lines and bunker shapes and too coarse for pixel
  differencing.
- The surface raster has 0.5 m DEM cells and 1 m canopy cells. A 1 m cell on a skyline
  300 m away subtends 0.2°.

## 12. Open questions

- What the user's Unity MCP can call: menu items, arbitrary static methods, or only a
  fixed tool set. This decides whether section 9's static methods are enough or the MCP
  needs new tools.
- Whether the renders for comparison should go through GSPro's post-processing or a
  neutral one. The goal is a match in GSPro, which argues for GSPro's stack.
- Whether site bundles (`feature-site-transfer.md`) should carry photos, so the Mac gets
  them as fixtures.
- The motion and accuracy thresholds for the shutter warnings. Set them after the first
  field test.

## 13. Waves

1. **RP1 iOS capture.** Capture screen, pose derivation, `reference_photos` table, gate.
   Verify on device: photo of a known landmark (a flagstick from a tee), compare recorded
   azimuth with the bearing between the two points in golf-map.
2. **RP2 VPS store and phone upload.** Migration, phone routes, file route, background
   upload with retry. Verify: capture offline, reconnect, the row and file appear on the
   VPS.
3. **RP3 Builder pull.** Pull routes, `photos-pull`, interval pull, retention job.
   Verify on the Windows builder.
4. **RP4 Web photo layer.** Markers, wedges, side panel, feature overlay, manual heading
   nudge.
5. **RP5 Heading refinement.** Keep `surface.tif` in `sources/<site>/` after the map
   build. `golfpipe/photo_pose.py`, `photos-refine`. Validation
   renders of model and photo skylines under `docs/validation/reference-photos/`.
6. **RP6 Unity export and reference cameras.** `unity-photos-v1`, the editor script, sun
   position. Depends on the plot from the `.raw` heightmap export or the `--plot` flag.
7. **RP7 Surface statistics.** Label images and CIELAB stats.
8. **RP8 First look pass.** One hole, 20 photos, the loop in section 10 with the Unity
   MCP. The report records which differences Claude found, which it could fix, and
   where the pose was too far off to compare.
