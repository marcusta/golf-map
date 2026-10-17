# Roads and paths as centerlines

Implementation notes for centerline `path` features, moved from server/AGENTS.md and web/AGENTS.md.

## Server

`geometry.centerline` (`{ points: [{ x, y, corner? }], widthM }`, optional)
makes a feature a centerline feature: `create`/`update` validate it and
REPLACE `rings` (and `curveType`) with the corridor derived by
`shared/features/centerline.ts`, whatever rings the caller sent. Everything
reading rings keeps working; `TerrainGeneratorsService` grades the course's
centerline `path` features as its road lines (and its paved `path` polygons
as planes).

Kerb fillets: every create/update/remove that touches a `path` (and
`removeImported`) re-derives the course's junction fillets
(`shared/features/road-junctions.ts`) into generated `path` features of source
`road-junctions` (`refreshRoadJunctions`, queued per course). A course whose
roads predate this gets them on its next road edit or import. A path's
`kerbFillets` attribute (boolean, validated; `false` = off, absent = on) opts
it out: no corner beside it is rounded; an attributes update re-derives too.
The same features carry the width tapers where a road ends in a narrower one
(made whatever `kerbFillets` says).

### `attributes` on features

### Drawable path transitions

`attributes.pathTransitions` is an optional array (unset or empty means the existing path).
It is supported on gravel/dirt centerline paths (a gravel track, gravel with a grass middle, counts as gravel). Grass tracks must first become a hard
path surface and be rebuilt through SVG/OPCD. Each entry has a stable `id`, `pattern`
(`soft-fade`, `overgrown-gravel`, `wheel-tracks`), `placement` (`start`, `end`, `section`),
`startM`, `direction` (1/-1), `transitionLengthM`, `holdLengthM`, `fadeLengthM`, `ending`
(`grass`, `continue`), `edgeIrregularity`, `dirtAmount`, `centerGrassReachM`, `trackWidthM`,
`trackSpacingM`, `variation`, and integer `seed`. Fractions are 0..1; track dimensions
fit the path width. The server checks the merged feature on every update, including
geometry-only edits. A shortened path cannot silently strand a transition beyond its end.

Stations measure the flattened Catmull-Rom spline in physical metres, tolerance 5 cm,
from its first control point. `section` begins at `startM` and progresses in `direction`.
The total extent is transition + hold + fade. `end` anchors the extent to the last point
and progresses forward; `start` anchors to the first point and progresses backward.
Endpoint placement resolves its start station automatically. `centerGrassReachM` extends
the central grass tongue longitudinally before that start, toward the solid-road side,
without moving the main transition start. Its extent must fit the path too. Overlapping
entries (including tongues and the remainder to the directional endpoint) are refused.
`ending: grass` completes the final fade at marker 3 and leaves the remainder of that
path grass. `ending: continue` holds the established pattern through the endpoint and
does not apply a final fade. The stored marker span still fits the centerline in either
case; the effective paint footprint extends to its directional endpoint. Seeds and
stable IDs make exports and paint reproducible.

Implementation: shared station/projection/default/validation helpers, structured API
attributes, an additive road sidecar entry, and `golfmap.path_transition` after the
normal path edge fade. Changes use the existing path-sidecar/shaping/Unity refresh chain;
no new geometry or terrain edit is persisted by export.

## Web

A `path` drawn in path mode (`P`) or imported from Fetch roads is a
**centerline feature**: `geometry.centerline` (`points`, with `corner` flags,
and `widthM`) is the shape, and `geometry.rings` is the corridor derived from
it by `shared/features/centerline.ts` (Catmull-Rom curve through the points,
buffered with round joins/caps). The server re-derives the rings on every
write, so every ring consumer (render, lie, surface stack, GSPro SVG, iOS) is
unchanged. In the draw tool the vertex ops run on an **edit view**
(`draw-state` `editViewOf` / `applyVertexEdit` / `fromEditView`): the control
points as one open b-spline-flavoured ring, mapped back with the corridor
re-derived. Move/offset/simplify act on the line (offset = width), the
selection panel's Width field sets `widthM`, and the terrain tool's Grade
roads grades these lines. Old polygon paths stay polygons. Path mode draws by
clicks + Enter or by a freehand press-drag (thinned to a few points); `N`
draws a plain area (a paved yard is a `path` polygon, graded as a plane).

Kerb fillets where centerline roads meet, and width tapers where a road ends
in a narrower one (`shared/features/road-junctions.ts`), are derived, never
edited: `FeaturesService.junctionFeatures` computes them
live into the map collection (not selectable), and the server's stored copies
(generated, source `road-junctions`, for export/iOS) are dropped on load.
Per road, the selection panel's "Round kerbs at junctions" box sets the
`kerbFillets` attribute (`false` = off, absent = on); a corner is rounded only
when both roads meeting there have it on. Tapers ignore it.
