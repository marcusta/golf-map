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
