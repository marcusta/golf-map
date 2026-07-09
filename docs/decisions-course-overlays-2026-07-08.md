# Course overlays — 2026-07-08

**Scope:** new drawable course constraints that are not all base ground surfaces.

## Decision

Add `trees`, `penalty_yellow`, `penalty_red`, and `oob` as `course_features.type` values for
the first end-to-end slice.

This is a tracer bullet, not the final domain split. `course_features` already owns the native
Bezier/B-spline polygon editing, stack order, GeoJSON export, web rendering, and iOS bundle
rendering, so extending the feature catalogue unlocks drawing and planning without introducing
a parallel rules-zone table yet.

## Domain meaning

- `deep_rough` remains low vegetation: long grass/scrub that affects contact and ball finding.
- `trees` is vertical obstruction: it can overlap fairway, rough, or deep rough. In the current
  single-lie planner model it maps to `recovery`, but it is not the same concept as deep rough.
- `penalty_yellow` and `penalty_red` are rules areas, not water. They may overlap water, trees,
  or another visible surface.
- `oob` is a rules constraint. It maps to penalty and bounds strategy corridors.

## Current implementation contract

- Web/server/iOS palettes carry the same type strings and colors.
- The create-time insertion heuristic keeps broad surfaces low, then trees/rules overlays above
  ordinary playing surfaces.
- `lieFromFeatureType()` maps `trees` to `recovery` and maps `penalty_yellow`,
  `penalty_red`, and `oob` to `penalty`.
- `DEFAULT_HAZARD_TYPES` includes trees, red/yellow penalty areas, and OOB so corridor scans
  treat them as obstacles.

## Future direction

When planner semantics need both an underlying surface and one or more overlays at the same
point, replace the single `classifyLie()` answer with a richer classification such as
`surface + constraints`. At that point, red/yellow/OOB may move from feature types into a
dedicated rules-zone layer.

## D28 — resolved surface tints

Nice mode uses the same D24-sorted MapLibre fill layer as Draw, but at 40% opacity and with every
ordinary feature boundary hidden. This lets the satellite image read as texture beneath the surface
colors while preserving the same explicit stack ordering as Draw. Before rendering, each lower
polygon is clipped by every higher polygon, so the result has no overlapping fill pixels and the
photo/color blend occurs only once at each point.

The active Draw tool uses 86% high-contrast vector fills and visible boundaries, so surface types
are obvious before the first tracing click. Nice mode has no ordinary feature boundaries; it is a
quiet material view. Selection highlighting remains a normal MapLibre vector above either mode.

`penalty_yellow`, `penalty_red`, and `oob` use the same full-opacity color treatment as other
features, with no ordinary boundary linework in nice mode.
