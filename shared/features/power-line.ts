// Power line: an overhead line across the course, drawn in Draw mode as a
// centerline (one point per pole, like a path's line) with a corridor width.
// It is no surface: it stays out of the SVG, the lie map and the surface
// stack. Two things read it:
// - `pipeline/gspro.py trees` leaves out every survey stem inside the corridor
//   (the lidar reads the wires as a row of tall thin trees);
// - the line itself (poles at the points, wires between) is what a Unity build
//   of the power line follows.
// Shared by the server (type list) and the web Draw tool; the pipeline mirrors
// the type name (POWER_LINE_FEATURE_TYPE).

export const POWER_LINE_TYPE = 'power_line';

/**
 * Corridor width a newly drawn power line gets, metres: the wires' span
 * (2-4 m for a local line) plus the lidar's sideways scatter, so the false
 * trees on both sides of the line fall inside it.
 */
export const DEFAULT_POWER_LINE_WIDTH_M = 8;
