# golf-map-2 Reference: Distance Measurement & Green Slope Analysis

Source repo (read-only recon target): `/Users/marcust/dev/github/golf-map-2/webapp/frontend`
Stack in the source prototype: Vite + React + TypeScript + Three.js (`@react-three/fiber`/`drei`), NOT MapLibre. This document extracts the *algorithms and constants* so they can be reimplemented on **MapLibre + Terrain-RGB tiles + a 0.5m DEM**.

Key files referenced (all paths relative to `webapp/frontend/`):
- `src/components/MeasurementLine.tsx`
- `src/components/HoverDetector.tsx`
- `src/Viewer.tsx`
- `src/components/GreenHeightMap.tsx`
- `src/components/Terrain.tsx`
- `src/components/GolfFeatures.tsx`
- `scripts/tessellate-greens.mjs`
- `CLAUDE.md`, `PROJECT_CONTEXT.md`

---

## 0. Global constants used throughout (CLAUDE.md, Terrain.tsx:33-42, tessellate-greens.mjs:14-40)

```
terrainSize        = 2300        // meters, square area (matches SVG viewBox 0 0 2300 2300)
ELEVATION_MIN       = 53.255      // meters, RH2000 (Swedish height datum)
ELEVATION_MAX       = 93.8094     // meters
ELEVATION_RANGE     = 40.5544     // = MAX - MIN
displacementScale   = 40.5544     // == ELEVATION_RANGE
displacementBias    = 53.255      // == ELEVATION_MIN
segments (terrain mesh) = 512
```

The terrain heightmap is a 16-bit grayscale PNG (`landery_inner_surface.png`, 4097x4097) produced via:
```
gdal_translate -of PNG -ot UInt16 -scale 53.255 93.8094 0 65535 -outsize 4097 4097 -r bilinear
```
i.e. pixel value `v` (0-65535) maps to elevation `ELEVATION_MIN + (v/65535) * ELEVATION_RANGE`.

World <-> heightmap UV mapping (used everywhere, e.g. GolfFeatures.tsx:783-784, CLAUDE.md:167-172):
```
u = (worldX + terrainSize/2) / terrainSize
v = (-worldZ + terrainSize/2) / terrainSize   // note the -worldZ, Y-flip from SVG->world
```

Important architectural point: **elevation is baked directly into mesh vertex Y positions** at preprocess time (not sampled from a texture at runtime for greens). The live Three.js scene's greens/fairways/etc. are literally terrain-following 3D meshes; raycasting against them gives exact elevation, slope comes from the mesh's own vertex normals. This is different from a typical "displacement map + flat raycast plane" approach and is the main design decision to port for a DEM-based analog (see Section 4 for a port strategy).

---

## 1. Distance measurement tool

### 1.1 Interaction model — click-click, not drag

Two independent pieces of state in `Viewer.tsx`:
```ts
// Viewer.tsx:88-93
const [isMeasuring, setIsMeasuring] = useState(false);
const [measurementPoints, setMeasurementPoints] = useState<{
  pointA: Vector3 | null;
  pointB: Vector3 | null;
}>({ pointA: null, pointB: null });
```

Keyboard control (`Viewer.tsx:96-120`):
- **M** toggles measurement mode on/off. Turning it off clears both points.
- **Escape** clears the two points without exiting measurement mode.
- Clicking a 3rd time after A+B are both set starts a **new** measurement from that click (doesn't need Escape first) — see the click handler below.

Click handling is a simple 3-state machine (`Viewer.tsx:153-166`):
```ts
function handleMeasurementClick(point: Vector3) {
  setMeasurementPoints(prev => {
    if (prev.pointA === null) {
      return { pointA: point.clone(), pointB: null };       // 1st click: set A
    } else if (prev.pointB === null) {
      return { pointA: prev.pointA, pointB: point.clone() }; // 2nd click: set B
    } else {
      return { pointA: point.clone(), pointB: null };        // 3rd click: restart at new A
    }
  });
}
```

There is **no drag interaction** — purely click-to-place. No live "rubber band" preview of the line while moving the mouse before the 2nd click (the line only renders once both A and B exist — see `MeasurementLine.tsx:15-21`, `mainLinePoints` returns `null` unless both points are non-null).

### 1.2 How a click becomes a world-space point (`HoverDetector.tsx`)

`HoverDetector` owns the only `Raycaster` in the scene and is fed `isMeasuring` + a callback:

```ts
// HoverDetector.tsx:26-41 (essential logic)
const onClick = useCallback(() => {
  const raycastPos = document.pointerLockElement
    ? new Vector2(0, 0)      // fly-mode: screen center (crosshair-style)
    : mouse.current;          // normal mode: last tracked mouse NDC position
  raycaster.current.setFromCamera(raycastPos, camera);
  const intersects = raycaster.current.intersectObjects(scene.children, true);
  if (intersects.length === 0) return;

  if (isMeasuring && onMeasurementClick) {
    const point = intersects[0].point;   // first (nearest) hit point, full 3D world coords
    onMeasurementClick(point);
    return;
  }
  // ...otherwise falls through to green-selection logic
}, [camera, scene, onGreenClick, isMeasuring, onMeasurementClick]);
```

Key details:
- Raycast is against **the actual rendered mesh geometry of the whole scene** (`scene.children`, recursive `true`), not a separate flat plane or a texture sample. Because terrain/greens/fairways/etc. are all real 3D geometry with baked-in elevation, `intersects[0].point` is already a true 3D point (x, y=elevation, z) with no further lookup needed.
- Mouse position is tracked continuously via a `mousemove` listener into NDC coords (`HoverDetector.tsx:19-23`):
  ```ts
  mouse.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  ```
- In fly/pointer-lock mode the raycast uses NDC `(0,0)` — i.e. it always measures against whatever is at the center of the screen (crosshair), consistent with a first-person flight camera.
- `HoverDetector` disables the green-click handler while measuring (`Viewer.tsx:228-230`: `onGreenClick={isMeasuring ? undefined : handleGreenClick}`) so the two interaction modes don't collide.
- The same raycaster instance is reused every frame in `useFrame` for hover-feature detection (`HoverDetector.tsx:109-128`), so there is no per-click raycaster allocation cost.

### 1.3 Distance computation — full 3D, decomposed into components

All math lives in a small presentational component (`Viewer.tsx:19-61`), computed straight from the two `THREE.Vector3` points (already real-world meters since 1 unit = 1 meter):

```ts
// Viewer.tsx:26-35
const dx = pointB.x - pointA.x;
const dy = pointB.y - pointA.y;   // vertical (elevation) delta
const dz = pointB.z - pointA.z;

const horizontalDistance = Math.sqrt(dx*dx + dz*dz);              // 2D "as the crow flies" ground distance (XZ plane only)
const straightLineDistance = Math.sqrt(dx*dx + dy*dy + dz*dz);    // true 3D Euclidean distance (line-of-sight through the air)
const elevationChange = dy;                                        // signed vertical delta (+ = B higher than A)
const slopeAngle = Math.atan2(Math.abs(dy), horizontalDistance) * (180/Math.PI); // degrees
const slopePercent = horizontalDistance > 0
  ? (Math.abs(dy) / horizontalDistance) * 100
  : 0;
```

**Important — this is NOT terrain-following/along-the-ground distance.** It's a straight chord between the two 3D points:
- `horizontalDistance` = flat 2D distance ignoring elevation (projection onto XZ plane).
- `straightLineDistance` = 3D line-of-sight distance between the two points (a straight chord, not a path draped along the terrain surface). No terrain-following polyline sampling/integration is performed anywhere in the codebase.
- Height difference is shown as its own explicit stat (`elevationChange`), not folded silently into the horizontal distance.
- Slope between the two points is derived purely from `dy` and `horizontalDistance` — a simple secant slope between two samples, not derived from the mesh normal (that formula, using surface normals, is reserved for the green analysis feature — see Section 2).

### 1.4 UI presentation

**During measurement** (`Viewer.tsx:319-364`), a fixed-position overlay top-center:
- Header "Measurement Mode" (amber, `#fbbf24`).
- State-dependent body:
  - No points yet: "Click to set Point A"
  - A set only: "Point A set - Click to set Point B" (A-set text in green `#22c55e`)
  - Both set: renders `<MeasurementStats>` — a 2-column CSS grid table:
    ```
    Horizontal:     {horizontalDistance.toFixed(1)} m
    Elevation:      {sign}{elevationChange.toFixed(2)} m   (green if >=0, red #ef4444 if negative)
    Straight line:  {straightLineDistance.toFixed(1)} m
    Slope:          {slopeAngle.toFixed(1)}° ({slopePercent.toFixed(1)}%)
    ```
- Footer hint: "M to exit | Escape to reset | Click to start new"

**3D scene visuals** (`MeasurementLine.tsx`):
- Point A marker: sphere radius 0.5, color `0x22c55e` (green), positioned at `pointA.y + 0.5` (raised 0.5m above the surface to avoid z-fighting/clipping into terrain).
- Point B marker: sphere radius 0.5, color `0xef4444` (red), same 0.5m Y offset.
- Main line A→B: solid line, color `0xfbbf24` (amber/yellow), lineWidth 2, drawn at each point's raised Y (both offset the same way, so the "main line" is actually the straight-line/slope line between the two raised points).
- Vertical drop line: dashed cyan `0x06b6d4`, lineWidth 1, dashSize 1, gapSize 0.5 — drawn from `(B.x, B.y+0.5, B.z)` up/down to `(B.x, A.y+0.5, B.z)`. This visually shows the elevation delta as a vertical segment at point B's location.
- Horizontal reference line: dashed gray `0x9ca3af`, lineWidth 1, same dash params — drawn from `(A.x, A.y+0.5, A.z)` to `(B.x, A.y+0.5, B.z)`, i.e. a level line at A's height running to B's XZ position. Together with the vertical drop line this forms a visual right-triangle (horizontal leg + vertical leg + the diagonal "straight line" hypotenuse), making the elevation/slope relationship legible in 3D.
- Sphere geometry is memoized/reused (`SphereGeometry(0.5, 16, 16)`) rather than recreated per point.

**Bottom-left help panel** (`Viewer.tsx:268-317`) always shows `M measure` as a hint alongside fly/wireframe controls.

### 1.5 Pseudocode summary — measurement tool

```
state: measuring = false, pointA = null, pointB = null

on keydown 'M':
    measuring = !measuring
    if measuring was just turned off: pointA = pointB = null

on keydown 'Escape' (while measuring):
    pointA = pointB = null

on click (while measuring):
    ray = camera_ray_through(pointerLocked ? screenCenter : mouseNDC)
    hit = first_intersection(ray, all_scene_meshes)   // uses REAL mesh geometry, not a flat plane
    if hit == null: return
    point3D = hit.point   // (x, y=elevation, z) in world meters

    if pointA == null:      pointA = point3D
    elif pointB == null:    pointB = point3D
    else:                   pointA = point3D; pointB = null   // restart

render_if_both_points_set:
    dx, dy, dz = pointB - pointA
    horizontal   = sqrt(dx^2 + dz^2)
    straightLine = sqrt(dx^2 + dy^2 + dz^2)
    elevation    = dy
    slopeAngleDeg   = atan2(|dy|, horizontal) * 180/pi
    slopePercent    = |dy| / horizontal * 100   (0 if horizontal == 0)
```

### Port notes for MapLibre + Terrain-RGB + 0.5m DEM
- Replace the Three.js raycast with: unproject the click's screen (x,y) to (lng, lat) via the map's camera/projection, then sample elevation from the Terrain-RGB tile (or better, directly from the 0.5m DEM if available at that resolution) at that (lng, lat). MapLibre GL JS exposes `map.queryTerrainElevation(lngLat)` (if terrain is enabled) which is the direct analog of the Three.js raycast hit point.
- Compute `horizontalDistance` using a proper geodesic/great-circle or projected-meters distance function (e.g. turf.js `distance()` or a local UTM/equirectangular projection), not naive XZ subtraction, since MapLibre coordinates are lng/lat, not meters.
- Keep the exact same 3-stat decomposition (horizontal, elevation delta, straight-line 3D, slope %/angle) — these formulas translate directly once you have two (lng, lat, elevation) samples.
- Consider adding an actual "along-terrain" distance (sum of a densely sampled polyline draped on the DEM) as an enhancement — the prototype does NOT do this, it only computes the straight 3D chord.

---

## 2. Green slope/height analysis overlay

### 2.1 Activation model — per-green, toggled, non-exclusive with measurement

- Only **greens** are clickable for analysis (`HoverDetector.tsx:44-58`, `CLAUDE.md:335`: "Only greens have click interaction"). Each green mesh carries `userData = { featureType: 'green', greenId: <string> }` (`GolfFeatures.tsx:929-931`, id format `"green-{index}"` from `GolfFeatures.tsx:869`).
- Click-to-select flow (`Viewer.tsx:126-146`):
  ```
  onGreenClick(greenId, geometry):
    if greenId is null: clear selection
    elif greenId == currently selected green id: clear selection (click again to hide/toggle off)
    else: select the new green (setSelectedGreen({id, geometry}); stats reset to null until GreenHeightMap reports them)
  ```
- Clicking anywhere that isn't a green clears the selection (`HoverDetector.tsx:57-58`, falls through to `onGreenClick(null, null)`).
- **G** key toggles between `'height'` and `'slope'` view modes, but only if a green is currently selected (`Viewer.tsx:101-103`). This is a per-session UI toggle, not per-green persisted state — mode is global and applies to whichever green is selected.
- Measurement mode and green-analysis are mutually exclusive at the input level: while `isMeasuring` is true, `onGreenClick` is passed as `undefined` to `HoverDetector` (`Viewer.tsx:228`), so clicks can't accidentally select a green mid-measurement.
- The overlay mesh is rendered as an extra pass positioned `[0, 0.05, 0]` above the selected green's own mesh (`GreenHeightMap.tsx:454`) — i.e. it draws a second, slightly-elevated copy of the SAME geometry with a custom shader, layered on top of the normal green mesh rather than replacing it.

### 2.2 Slope computation method — from mesh vertex normals, not a raster gradient kernel

Two places compute "the same formula" for consistency (explicitly commented as such):

1. **Preprocessing** (`scripts/tessellate-greens.mjs`, function `computeSlopeColors`, lines 279-361): computes face normals per triangle via cross product of edge vectors, then averages face normals per vertex (mimicking `THREE.BufferGeometry.computeVertexNormals()`), then:
   ```js
   horizontalComponent = sqrt(nx^2 + nz^2)
   slopeRatio = horizontalComponent / max(|ny|, 0.001)
   slopePercent = slopeRatio * 100
   ```
   This is used only to **darken the base grass color** by slope (not for the interactive slope-mode overlay) — see 2.4.

2. **Live shader** (`GreenHeightMap.tsx`, fragment shader lines 108-115, and CPU-side stats in the `useEffect` at lines 204-224): identical formula, driven by `geometry.computeVertexNormals()` (called once when the tessellated geometry is built in `GolfFeatures.tsx:809`) and consumed per-vertex/per-fragment via the interpolated `vNormal` varying:
   ```glsl
   vec3 n = normalize(vNormal);
   float horizontalComponent = length(vec2(n.x, n.z));
   float slopeRatio = horizontalComponent / max(abs(n.y), 0.001);
   float slopePercent = slopeRatio * 100.0;
   ```

**This is the standard "slope from normal" trick**: for a unit surface normal `(nx, ny, nz)` with `ny` the "up" component, the surface's rise/run ratio (i.e. tan of the slope angle) is `sqrt(nx² + nz²) / ny`. It's algebraically equivalent to computing slope from a gradient (`dz/dx`, `dz/dy`) since the normal is just the (negated, normalized) gradient extended into 3D — but the prototype gets it "for free" from mesh normals rather than running an explicit Sobel/finite-difference kernel over a grid. No separate cell-size parameter exists because it operates directly on the tessellated mesh's irregular vertex/triangle structure (see Section 2.6 for the effective resolution of that mesh, which functions like a variable "cell size").

There is **no aspect (downhill direction) computed as an angle** for display purposes — but the arrow directions (Section 2.5) do use the normal's horizontal component directly as the downhill vector.

### 2.3 Height/slope color ramps — exact thresholds and hex values

Both ramps are implemented **twice** — once in GLSL (used for the actual per-pixel overlay mesh, `GreenHeightMap.tsx:63-102`) and once as a CSS `linear-gradient` swatch for the legend UI (`Viewer.tsx:474-500`). Both are given below.

**Height ramp** (`getElevationColor`, `GreenHeightMap.tsx:63-81`) — 5-stop, piecewise-linear, driven by `t = (vertexElevation - localElevMin) / (localElevMax - localElevMin)` clamped to [0,1] (i.e. normalized to the SELECTED GREEN's own local min/max elevation range, not the whole course's global 53.255-93.8094m range):

| t range | Color stops | RGB (0-1) |
|---|---|---|
| t < 0.25 | blue → green | blue=(0.0, 0.4, 1.0), green=(0.0, 0.8, 0.2) |
| 0.25 ≤ t < 0.5 | green → yellow | yellow=(1.0, 1.0, 0.0) |
| 0.5 ≤ t < 0.75 | yellow → orange | orange=(1.0, 0.533, 0.0) |
| t ≥ 0.75 | orange → red | red=(1.0, 0.0, 0.0) |

Each band does `mix(colorA, colorB, (t - bandStart)/0.25)` (linear interpolation within the 0.25-wide band).
Legend CSS gradient (`Viewer.tsx:481-483`): `linear-gradient(to right, #0066ff, #00cc33, #ffff00, #ff8800, #ff0000)` labeled "Low → High".

**Slope ramp** (`getSlopeColor`, `GreenHeightMap.tsx:85-102`) — 4-stop, explicitly commented as matching "professional golf green analysis: 0-7%+ scale":

| slopePercent range | Colors | RGB (0-1) |
|---|---|---|
| < 1.0% | flat blue (stays blue) | blue = (0.2, 0.5, 1.0) |
| 1.0% – 3.0% | blue → green | green = (0.2, 0.8, 0.2) |
| 3.0% – 5.0% | green → orange | orange = (1.0, 0.5, 0.1) |
| 5.0% – 7.0% | orange → magenta | magenta = (1.0, 0.2, 0.6) |
| ≥ 7.0% | solid magenta (clamped, no further gradation) | (1.0, 0.2, 0.6) |

```glsl
if (slopePercent < 1.0)       return mix(blue, blue, slopePercent);       // effectively always blue
else if (slopePercent < 3.0)  return mix(blue, green, (slopePercent-1.0)/2.0);
else if (slopePercent < 5.0)  return mix(green, orange, (slopePercent-3.0)/2.0);
else if (slopePercent < 7.0)  return mix(orange, magenta, (slopePercent-5.0)/2.0);
else                           return magenta;
```
Legend CSS gradient (`Viewer.tsx:489-491`): `linear-gradient(to right, #3388ff, #33cc33, #ff8822, #ff3399)` labeled "0% → 7%+".

Bucket semantics roughly: **0-1% "flat/blue", 1-3% "gentle/green", 3-5% "moderate/orange", 5-7%+ "steep/magenta"** — note this is NOT a simple green/yellow/red traffic-light scheme; it uses blue/green/orange/magenta, with blue as the safest/flattest end and magenta (not red) as the steepest end.

### 2.4 Height visualization method — vertex-color bands via shader (not a texture/contour raster)

- The overlay is a single `THREE.ShaderMaterial` (`GreenHeightMap.tsx:264-279`) applied to a cloned copy of the green's own tessellated `BufferGeometry`.
- **Vertex shader** (`contourVertexShader`, lines 32-45): trivial passthrough — passes `position.xz` (world XZ) as `vWorldXZ`, `position.y` (actual mesh elevation, already real-world meters — see `displacementToElevation()` at line 25-28, a no-op since heights are baked into vertex Y at preprocess time) as `vMeshHeight`, and the vertex normal as `vNormal`.
- **Fragment shader** (`contourFragmentShader`, lines 47-167) branches on a `viewMode` uniform (0 = height, 1 = slope):
  - Height mode: color = `getElevationColor(normalizedHeight)` where `normalizedHeight = (vMeshHeight - localElevMin) / (localElevMax - localElevMin)`.
  - Slope mode: color = `getSlopeColor(slopePercent)` computed from `vNormal` as in Section 2.2.
  - **Both modes** then overlay contour lines (see below) and a world-space grid.
- `localElevMin`/`localElevMax` are computed once per selection by scanning all vertex Y values of the selected green's geometry in a `useEffect` (`GreenHeightMap.tsx:179-258`) — i.e. **the color ramp is normalized per-green**, not to the course's global elevation range. This means a very flat green and a very undulating green both use the full blue→red range, scaled to their own local relief.

**Contour lines** (drawn in both height and slope mode, using elevation not slope — `GreenHeightMap.tsx:117-129` / 137-148, identical code duplicated in both branches):
```glsl
contourInterval = 0.025   // meters (~2.5cm), default prop value, GreenHeightMap.tsx:173
v = vMeshHeight / contourInterval
dvdx = dFdx(v); dvdy = dFdy(v)              // screen-space derivatives = anti-aliasing width
dv = sqrt(dvdx^2 + dvdy^2)
f = abs(fract(v + 0.5) - 0.5)               // distance to nearest integer band edge, folded into [0,0.5]
lineWidth = dv * 2.0
softness = 0.3
t = clamp(f / (lineWidth + softness*dv), 0, 1)
line = 1.0 - t*t*(3.0 - 2.0*t)              // smoothstep-based falloff -> line intensity in [0,1]
finalColor = mix(finalColor, contourColor, line * 0.7)   // contourColor = light gray 0xdddddd, max 70% blend
```
This is a standard **screen-space anti-aliased contour line technique** using derivatives (`dFdx`/`dFdy`) rather than baking discrete contour bands into a texture — contour spacing is exactly `contourInterval` meters of elevation, contourWidth uniform (0.003) is present but not actually used in the line-width math shown (line thickness is derived from `dv`, i.e. auto-scales with screen-space elevation gradient density so lines stay ~constant pixel width regardless of zoom/slope).

**Grid overlay** (independent, always drawn under contour lines — `GreenHeightMap.tsx:151-163`): 1m world-space grid (`gridSize = 1.0`), thin lines (`gridWidth = 0.02`), dark gray (`0x888888`), blended at 25% opacity max:
```glsl
distToGridX = min(mod(x, 1.0), 1.0 - mod(x, 1.0))
distToGridZ = min(mod(z, 1.0), 1.0 - mod(z, 1.0))
distToGrid = min(distToGridX, distToGridZ)
gridStrength = 1.0 - smoothstep(0, gridWidth, distToGrid)
finalColor = mix(finalColor, gridColor, gridStrength * 0.25)
```
This is a scale reference grid (1 world unit = 1 meter), not a height/slope encoding.

### 2.5 Fall-line arrows and slope labels (slope mode only)

Computed CPU-side in a `useMemo` (`GreenHeightMap.tsx:292-386`), only when `mode === 'slope'`:

1. Compute the geometry's XZ bounding box (min/max X, Z from all vertex positions).
2. **Sample spacing**: `spacing = max(2.0, min(width, length) / 8)` meters — i.e. roughly an 8x8 grid across the green's bounding box, but never denser than 2m apart.
3. Build a flat list of all vertices with position + normal (linear scan, not a real spatial grid).
4. For each grid sample point `(gx, gz)` (centered in each spacing-sized cell):
   - Find nearest vertex by brute-force squared XZ distance.
   - Reject if `nearestDist >= spacing^2` (i.e. no vertex was close enough — point falls outside the green's actual footprint).
   - Compute `slopePercent` from that vertex's normal using the same formula as Section 2.2.
   - **Only emit an indicator if `slopePercent > 0.5%`** (flat areas get no arrow).
   - Downhill direction = normalized horizontal component of the normal: `dirX = nx/horizLen, dirZ = nz/horizLen` (the normal's XZ projection already points downhill for a tilted surface, no negation needed).
   - Arrow position is raised `0.15m` above the vertex's own height.
5. **Arrow geometry** (`GreenHeightMap.tsx:389-410`): a single flat 2D arrow `THREE.Shape` reused (one `<mesh>` per indicator, sharing one `ShapeGeometry`), pointing along local +X, then rotated per-instance about Y by `angle = atan2(dirZ, dirX)`. Dimensions:
   ```
   len = 0.65 m (total arrow length)
   width = 0.08 m (shaft width)
   headLen = 0.22 m
   headWidth = 0.26 m
   ```
   Rendered with `meshBasicMaterial` color `0xffffff` (plain white), `DoubleSide`.
6. **Slope value labels**: only every 4th arrow gets a text label (`slopeIndicators.filter((_, i) => i % 4 === 0)`), to reduce visual clutter. Each label is a `THREE.CanvasTexture` (64x32px canvas, white bold 20px Arial text showing `slope.toFixed(1)` — slope percent to 1 decimal, no "%" suffix on the label itself), rendered as a billboard `<sprite>` positioned slightly offset in the downhill direction from its arrow (`position + dir * 1.0`, then `+0.3` in Y), scale `[1.2, 0.6, 1]`, `depthTest={false}` (always visible, draws on top).

### 2.6 Smoothing applied before analysis (all in `scripts/tessellate-greens.mjs`, offline preprocessing — NOT runtime)

This is the most important piece for porting to a DEM pipeline, since it's what makes the analysis look smooth/professional rather than noisy/steppy:

1. **Gaussian blur on the raw heightmap** (`gaussianBlurHeightmap`, lines 128-184) — separable 2D blur (horizontal pass then vertical pass), `radius = HEIGHTMAP_BLUR_RADIUS = 3` pixels, `sigma = radius/2 = 1.5`, kernel built from `exp(-x²/(2σ²))` normalized to sum 1, clamped-edge boundary handling. Purpose (explicit comment): "removes integer quantization steps from heightmap" — the source LiDAR-derived heightmap was integer/16-bit quantized and blurring removes visible stair-stepping before any geometry is derived from it.
2. **Adaptive-resolution Delaunay tessellation** (`tessellatePolygon`, lines 748-990) — NOT a fixed grid. A quadtree-like recursive subdivision (`processCell`) starts from a coarse grid (cell size = `maxResolution`) and recursively quarters any cell whose corner+center height variance exceeds `slopeThreshold`, down to a floor of `minResolution`. For greens specifically (`TESSELLATION_CONFIG.green`):
   ```
   minResolution  = 0.2 m   // "Dense mesh for accurate physics/rendering"
   maxResolution  = 0.5 m   // "Even flat areas need detail for ball rolling"
   slopeThreshold = 0.01    // variance threshold (normalized 0-1 height units) that triggers subdivision — more sensitive than any other feature type
   ```
   Points are then triangulated with `Delaunator`. Boundary points are separately densified at `BOUNDARY_RESOLUTION = 0.4m` (universal across feature types, to keep adjacent features' shared edges vertex-aligned), plus `TRANSITION_ZONES = 3` interior "rings" at `TRANSITION_SPACING = 0.5m` inset from the boundary, to avoid degenerate sliver triangles where fine boundary meets coarse interior.
   Height at each generated point is sampled from the (already Gaussian-blurred) heightmap using **bicubic interpolation** (`sampleHeightmap`, Catmull-Rom, lines 236-268).
3. **Taubin smoothing on the resulting mesh's vertex heights** (`smoothVertexHeights`, lines 650-723) — the key "de-noise the surface without shrinking it" step, applied AFTER tessellation, directly on mesh-vertex Y values (not on the raster). Parameters:
   ```
   TAUBIN_ITERATIONS = 70
   TAUBIN_LAMBDA     = 0.5     // positive ("smooth") pass factor
   TAUBIN_MU         = -0.54   // negative ("inflate") pass factor; must be more negative than -λ to avoid shrink
   FEATURE_THRESHOLD = 0.05 m  // height delta above which a vertex is treated as a "real feature" and smoothed less
   ```
   Algorithm per iteration: build a vertex adjacency list from the triangle index buffer; for each iteration do **two sub-passes**, first with `λ` then with `μ`:
   - For each non-boundary vertex, compute the weighted average height of its neighbors (boundary-neighbors get 2x weight, to bias interior heights toward matching the pinned boundary — creates a smooth ramp).
   - `delta = |neighborAvg - currentHeight|`; `featureSensitivity = max(0.2, 1.0 - delta/FEATURE_THRESHOLD)` — vertices that differ a lot from their neighbors (likely a genuine undulation, not LiDAR noise) get damped smoothing (floor 20% of normal strength) so real greens contours (humps, ridges) survive smoothing.
   - `newHeight = currentHeight + (baseFactor * featureSensitivity) * (neighborAvg - currentHeight)`.
   - Boundary vertices (shared with adjacent features like fringe/fairway) are **excluded from smoothing entirely** — they're pinned to the exact (blurred) heightmap value so adjacent feature meshes still meet seamlessly.
4. **Post-tessellation boundary alignment across ALL features** (main(), lines 1132-1204): vertices from different feature meshes that land within a `5cm` grid cell of each other are grouped and snapped to a single shared height re-sampled from the heightmap — closes residual seams between a green mesh and its neighboring fairway/rough mesh.
5. **Interior blending near boundaries** (lines 1206-1284): a second pass blends each feature's *interior* (non-boundary) vertices toward nearby boundary heights if within `BLEND_RADIUS = 1.5m`, with `BLEND_STRENGTH = 0.9` and linear falloff — smooths the seam zone from both sides so there's no visible "crease" where the smoothed interior meets the pinned boundary.
6. Only AFTER all the above does `computeSlopeColors` run (Section 2.2, item 1) to bake per-vertex darkening into the base grass color for the *non-interactive* material shading (separate from the interactive slope-mode shader in GreenHeightMap.tsx, which recomputes slope live from `computeVertexNormals()` on the already-smoothed mesh).

No smoothing/filtering happens at runtime in `GreenHeightMap.tsx` — by the time the frontend loads `golf-features.json`, all elevation data is already blurred + Taubin-smoothed + boundary-aligned; the shader only computes color from whatever vertex positions/normals it's handed.

### 2.7 Stats panel (`Viewer.tsx:148-150, 385-507`, computed in `GreenHeightMap.tsx:179-258`)

`GreenStats` shape:
```ts
{
  width: number,            // bounding-box X extent, rounded to 0.1m
  length: number,           // bounding-box Z extent, rounded to 0.1m
  minElevation: number,     // rounded to 0.1m
  maxElevation: number,     // rounded to 0.1m
  heightDifference: number, // max-min, rounded to 0.01m
  maxSlope?: number,        // percent, rounded to 0.1, from scanning ALL vertex normals
  avgSlope?: number,        // percent, rounded to 0.1, mean over all vertex normals
}
```
Computed by a single linear scan over `position`/`normal` buffer attributes (every vertex in the tessellated green mesh — adaptively dense down to 0.2m spacing). UI shows Width/Length always, then conditionally either Height diff (height mode) or Max/Avg slope (slope mode), plus the color legend swatch matching the current mode (Section 2.3).

### 2.8 Pseudocode summary — green analysis

```
OFFLINE PREPROCESS (tessellate-greens.mjs), per green polygon:
  heightmap = load_16bit_png(heightmap_path)              // 0-1 normalized per pixel
  heightmap = gaussian_blur(heightmap, radius=3)           // remove LiDAR integer stepping
  mesh = adaptive_delaunay_tessellate(
            polygon, minRes=0.2m, maxRes=0.5m, slopeVarianceThreshold=0.01,
            sample_height = bicubic_sample(heightmap))
  mesh.vertices.y = smooth_via_taubin(mesh.vertices.y, mesh.triangles,
                        iterations=70, lambda=0.5, mu=-0.54,
                        featureThreshold=0.05, pin_boundary_vertices=true)
  # (later, across all features) snap/blend shared boundary vertices within 5cm/1.5m radii
  mesh.colors = per_vertex_slope_darkened_base_color(mesh, slopeFormula)  // static material shading only
  export mesh {vertices, indices, colors} to golf-features.json

RUNTIME (GolfFeatures.tsx + GreenHeightMap.tsx):
  geometry = BufferGeometry(mesh.vertices, mesh.indices)
  geometry.computeVertexNormals()      // <-- THIS drives the interactive slope shader
  userData = {featureType:'green', greenId}

  on click hit a green mesh:
     selectedGreen = {id, geometry}
     compute stats: width,length from XZ bbox; min/maxElevation from Y bbox;
                    maxSlope/avgSlope by scanning every vertex normal:
                        slope% = sqrt(nx²+nz²)/max(|ny|,0.001) * 100

  render translucent-overlay-mesh at y+0.05 above the green, ShaderMaterial:
     vertex shader passes (worldXZ, meshY, normal) to fragment shader
     fragment shader:
        if mode == height:
            t = clamp((meshY - localMin)/(localMax-localMin), 0, 1)
            color = 5-stop ramp: blue(0.0,0.4,1.0) -> green(0.0,0.8,0.2) -> yellow(1,1,0)
                                -> orange(1,0.533,0) -> red(1,0,0), each band width 0.25
        else: // slope
            slope% = sqrt(nx²+nz²)/max(|ny|,0.001) * 100
            color = 4-stop ramp: blue(0.2,0.5,1.0) <1% -> green(0.2,0.8,0.2) 1-3%
                                -> orange(1,0.5,0.1) 3-5% -> magenta(1,0.2,0.6) 5-7%+ (clamped)
        # both modes: overlay anti-aliased contour lines every 0.025m of elevation
        #             using screen-space derivatives (dFdx/dFdy) of meshY/contourInterval
        # both modes: overlay a faint 1m world-space reference grid at 25% max opacity

  if mode == slope:
     sample an ~8x8 grid (spacing = max(2m, min(width,length)/8)) of nearest-vertex slope+normal
     for each sample with slope% > 0.5:
        draw a flat white arrow (0.65m long) pointing in the downhill direction (normal's XZ projection)
        every 4th arrow also gets a floating text label showing slope% to 1 decimal
```

### Port notes for MapLibre + Terrain-RGB + 0.5m DEM
- The prototype's "slope from mesh normal" trick assumes you already have a smoothed, tessellated 3D mesh. On a raster DEM (0.5m cell), the direct analog is a **classic Horn (1981) or simple central-difference gradient operator** over a 3x3 neighborhood at 0.5m cell size:
  ```
  dz/dx = ((z(x+1,y) - z(x-1,y)) / (2 * cellSize))   // similarly for dz/dy
  slope_ratio = sqrt((dz/dx)^2 + (dz/dy)^2)
  slope_percent = slope_ratio * 100
  aspect = atan2(dz/dy, -dz/dx)   // for fall-line direction, if wanted
  ```
  Mathematically the raster equivalent of the normal-based method (both derive from the local surface gradient); use it if you keep elevation as a raster (Terrain-RGB / DEM sampled per-pixel) rather than building a per-green mesh.
- Reuse the exact same color stop tables and thresholds (Section 2.3) — they're independent of the underlying elevation-sampling technology.
- Reuse the same two-stage smoothing philosophy even on a DEM: (1) a small Gaussian blur (radius ~3 cells) to kill quantization noise from Terrain-RGB's 1cm quantized encoding, (2) a feature-preserving smoothing pass (Taubin-style bidirectional λ/μ, or a bilateral filter) so real green undulations aren't flattened — the prototype's specific parameter values (`λ=0.5, μ=-0.54, 70 iterations, featureThreshold=0.05m`) are a reasonable starting point to tune against the 0.5m DEM's actual noise characteristics.
- Normalize the height-mode color ramp **per selected green's own local min/max elevation**, not a global course-wide range — this is what makes subtle 20-30cm greens undulations visible in color instead of washing out against a 40m whole-course elevation range.
- The contour-line technique (screen-space derivative based, `contourInterval=0.025m`) ports directly to a MapLibre custom layer as long as you have per-fragment elevation and screen-space derivatives available (`dFdx`/`dFdy` are standard GLSL and work in the WebGL contexts MapLibre uses).
- Fall-line arrows: the sampling strategy (8x8 grid over bounding box, min 2m spacing, skip near-flat samples <0.5%, arrow direction = downhill gradient) is a simple, portable heuristic independent of the 3D-mesh-specific implementation — reimplement directly against DEM-derived gradient vectors.

---

## 3. Related helpers

### 3.1 Elevation sampling helpers (preprocessing-time, `tessellate-greens.mjs`)
- `sampleHeightmapBilinear(x, y, heightmapData, w, h, svgSize)` (lines 207-234): standard 4-tap bilinear sample, converts SVG-space (x,y) to heightmap pixel space via `u=x/svgSize, v=y/svgSize`, then to real elevation via `value*DISPLACEMENT_SCALE + DISPLACEMENT_BIAS`. Defined but unused in the main pipeline (superseded by bicubic).
- `sampleHeightmap(x, y, heightmapData, w, h, svgSize)` (lines 238-268): 16-tap **bicubic** (Catmull-Rom, `cubicInterpolate` lines 187-196) sample — the one actually used for all vertex height assignment and boundary re-alignment. Clamps result to [0,1] before converting to elevation (bicubic can overshoot/ring). Out-of-bounds (beyond 1px padding) falls back to `DISPLACEMENT_BIAS` (minimum elevation).
- `getHeightmapPixel(...)` (lines 199-203): raw single-pixel lookup with clamped (edge-extended) bounds, the sampling primitive for both blur and bicubic interpolation.

### 3.2 Runtime terrain raycasting for cursor position (`HoverDetector.tsx`)
- Single shared `Raycaster` + `Vector2` mouse NDC tracker, updated on `mousemove`, re-cast every `useFrame` tick for hover-highlight plus on-demand on `click` (measurement/green-select) and on **P key** (debug: logs + `alert()`s world X/Z/height and feature/green id at the cursor, `HoverDetector.tsx:62-91`).
- In pointer-locked "fly mode," raycasts always originate from NDC `(0,0)` (screen center) rather than the last mouse position.
- Raycasts intersect `scene.children` recursively — i.e. against whatever is actually rendered, taking the nearest hit. This is the ONLY elevation-sampling mechanism used at runtime; elevation always comes from mesh geometry pre-baked from the heightmap offline.
- The keyboard "P" debug feature is a decent reference for a minimal "cursor coordinates + elevation" HUD: raycast, read `intersects[0].point` for (X, Z, height) and `intersects[0].object.userData` for `featureType`/`greenId`, format to 1 decimal (X/Z) or 2 decimals (height in meters).

### 3.3 Plays-like distance
No plays-like distance calculation (elevation-adjusted effective yardage) exists anywhere in the codebase — confirmed via full-repo search. The only elevation-aware distance metrics present are the raw `elevationChange` (signed vertical delta) and `slopePercent`/`slopeAngle` shown in the measurement tool (Section 1.3-1.4). If a plays-like calculation is needed for the port, it must be designed from scratch — there is no prototype reference for it. (Note: golf-map v1 iOS has wind-adjustment rules in its club model that partially cover this — see the v1 GolfWeatherCalculator.)

---

## 4. Suggested porting architecture notes (synthesis, not verbatim from source)

These are implementation implications drawn from the above for a MapLibre + Terrain-RGB + 0.5m DEM stack (not present verbatim in golf-map-2, but follow directly from its design):

- **Elevation source of truth**: golf-map-2 bakes elevation into static mesh vertices offline and treats the live 3D scene as ground truth for all runtime queries (both measurement and green analysis just raycast/read the mesh). For a MapLibre port, the equivalent is: maintain one elevation-query function (backed by the 0.5m DEM directly, or Terrain-RGB decoding as a fallback for far-out zoom levels) and have BOTH the measurement tool and the green-slope overlay call into it — don't duplicate elevation logic between features.
- **Per-feature local normalization**: the color ramp for green height mode normalizes to the selected green's own min/max, not the whole course. Replicate this — compute local min/max over just the green's polygon footprint each time a green is selected. (For the golf-map "green surrounds" requirement, extend the sampled region to green + buffer but consider normalizing height relative to the green's mean/median so surrounds hollows read as "below green level".)
- **Precompute vs. live-compute tradeoff**: golf-map-2 precomputes the smoothed mesh offline (expensive Taubin smoothing, adaptive tessellation) so the runtime slope calc is just "read the vertex normal" (cheap). On a DEM + Terrain-RGB stack, consider precomputing a smoothed slope/aspect raster per green (same Gaussian + feature-preserving-smoothing philosophy) at build time — e.g. server samples dem_cog directly at full 0.5m precision (no Terrain-RGB 1cm quantization noise in the gradients) and serves a small pre-baked analysis texture per green — rather than computing gradients from quantized Terrain-RGB live in a shader.
- **Distance tool simplicity**: keep the click-click (not drag) interaction model and the same 4-stat breakdown (horizontal, elevation Δ, straight-line 3D, slope %/angle) — simple, well-tested UX from the prototype. Consider whether an along-terrain (draped) distance is worth adding since golf-map-2 never implemented one.
