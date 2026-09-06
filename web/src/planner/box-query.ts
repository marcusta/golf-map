/**
 * "Where do you mean?" helper for the planner: press B, drag a box on the
 * map, and the box's EPSG:3006 bounds land on the clipboard in the form the
 * pipeline and analysis scripts take (`--bbox e_min,n_min,e_max,n_max`).
 * A click without a drag copies the single point instead.
 *
 * Pure: takes the dragged rectangle's corners already converted to
 * SWEREF 99 TM (all four, since a pitched camera makes the screen box a
 * trapezoid on the ground) and returns the text to copy and show.
 */
export interface Sweref99Point { x: number; y: number }

export interface BoxQuery {
    /** Text for the clipboard. */
    text: string;
    /** [e_min, n_min, e_max, n_max] rounded to whole metres, or a point when the box is degenerate. */
    bbox: [number, number, number, number] | null;
    point: Sweref99Point | null;
}

/** A drag under this many metres on both axes is a point pick. */
export const BOX_QUERY_POINT_MAX_M = 2;

export function describeBoxQuery(corners: Sweref99Point[]): BoxQuery {
    const xs = corners.map(c => c.x);
    const ys = corners.map(c => c.y);
    const eMin = Math.round(Math.min(...xs));
    const eMax = Math.round(Math.max(...xs));
    const nMin = Math.round(Math.min(...ys));
    const nMax = Math.round(Math.max(...ys));
    if (eMax - eMin < BOX_QUERY_POINT_MAX_M && nMax - nMin < BOX_QUERY_POINT_MAX_M) {
        const x = Math.round((eMin + eMax) / 2);
        const y = Math.round((nMin + nMax) / 2);
        return { text: `EPSG:3006 point ${x},${y}`, bbox: null, point: { x, y } };
    }
    return {
        text: `EPSG:3006 bbox ${eMin},${nMin},${eMax},${nMax} (${eMax - eMin} x ${nMax - nMin} m)`,
        bbox: [eMin, nMin, eMax, nMax],
        point: null,
    };
}
