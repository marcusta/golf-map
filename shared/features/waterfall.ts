// Waterfall: where water drops from one pond (or creek) to the next, drawn in
// Draw mode as a centerline, like a power line. It is no surface: it stays out
// of the SVG, the lie map and the surface stack. The Unity build of the
// waterfalls (golfmap.waterfalls.build, from gspro.py waterfalls) puts the
// falling water along that line, from the water above down to the water below,
// with spray where it lands.
//
// Four styles:
// - `sill`: the water runs over a weir's crest (a stone sill or a narrow earth
//   dam `sillM` wide, upstream of the lip) and drops over its whole width; the
//   line runs along the lip (the edge the water goes over), across the flow;
// - `outlet`: the water comes out from under a crossing (a dam with a pipe, a
//   path over a culvert) at the lip, a narrower spout; the line is the lip too;
// - `cascade`: the water runs down over rocks between two waters some metres
//   apart (a rockery); the line runs ALONG the flow, upstream to downstream, a
//   stream `widthM` wide;
// - `fountain`: a jet in a pond, `heightM` tall, standing at the line's
//   midpoint (a short line); topM, bottomM and the flow are not used.
// The terrain editor's Find falls (WaterStepsService, pipeline
// golfpipe.water_steps) proposes sills, outlets and cascades from the lidar and
// fills the levels. Shared by the server (type list, validation) and the web
// Draw tool; the pipeline mirrors the type name (WATERFALL_FEATURE_TYPE).

export const WATERFALL_TYPE = 'waterfall';

export const WATERFALL_STYLES = ['sill', 'outlet', 'cascade', 'fountain'] as const;
export type WaterfallStyle = (typeof WATERFALL_STYLES)[number];
export const DEFAULT_WATERFALL_STYLE: WaterfallStyle = 'sill';

/** How the water goes over: one of WATERFALL_STYLES (absent = `sill`). */
export const WATERFALL_STYLE_ATTRIBUTE = 'style';
/** The water above and below the fall, metres above sea level (absent = read from the ponds and the lidar at export). */
export const WATERFALL_TOP_ATTRIBUTE = 'topM';
export const WATERFALL_BOTTOM_ATTRIBUTE = 'bottomM';
/** The way the water falls, compass degrees (absent = towards the lower ground beside the line). */
export const WATERFALL_FLOW_ATTRIBUTE = 'flowBearingDeg';
/** A sill's crest: how far upstream of the lip the water runs over it, metres (0..5). */
export const WATERFALL_SILL_ATTRIBUTE = 'sillM';
export const DEFAULT_WATERFALL_SILL_M = 1;
/** A cascade's stream: how wide the water runs down over the rocks, metres. */
export const WATERFALL_WIDTH_ATTRIBUTE = 'widthM';
export const DEFAULT_CASCADE_WIDTH_M = 1.2;
export const CASCADE_WIDTH_RANGE_M = { min: 0.2, max: 5 } as const;
/** A fountain's jet: how high it stands above the pond, metres. */
export const WATERFALL_HEIGHT_ATTRIBUTE = 'heightM';
export const DEFAULT_FOUNTAIN_HEIGHT_M = 1.5;
export const FOUNTAIN_HEIGHT_RANGE_M = { min: 0.2, max: 6 } as const;

/**
 * Corridor a newly drawn waterfall gets, metres: the lip plus the crest
 * upstream of it and the splash below, so the line reads on the map.
 */
export const DEFAULT_WATERFALL_WIDTH_M = 2;

/** Find falls: a proposed fall this close (m) to an existing waterfall's line midpoint is that waterfall. */
export const WATERFALL_SAME_M = 3;

/** The point halfway along a line (its length, not its point count); null for no points. */
export function lineMidpoint(points: ReadonlyArray<{ x: number; y: number }>): { x: number; y: number } | null {
    if (points.length === 0) return null;
    let total = 0;
    for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    let left = total / 2;
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        if (d >= left && d > 0) return { x: a.x + ((b.x - a.x) * left) / d, y: a.y + ((b.y - a.y) * left) / d };
        left -= d;
    }
    return { x: points[0].x, y: points[0].y };
}

export function isWaterfallStyle(v: unknown): v is WaterfallStyle {
    return typeof v === 'string' && (WATERFALL_STYLES as readonly string[]).includes(v);
}

/** A waterfall's style (absent or unknown = `sill`). */
export function waterfallStyleOf(attributes: Record<string, unknown> | null | undefined): WaterfallStyle {
    const style = attributes?.[WATERFALL_STYLE_ATTRIBUTE];
    return isWaterfallStyle(style) ? style : DEFAULT_WATERFALL_STYLE;
}

/** What is wrong with a waterfall's attributes, or null. Keys not listed here are free. */
export function waterfallProblem(attributes: Record<string, unknown> | null | undefined): string | null {
    if (!attributes) return null;
    const style = attributes[WATERFALL_STYLE_ATTRIBUTE];
    if (style !== undefined && !isWaterfallStyle(style)) {
        return `attributes.${WATERFALL_STYLE_ATTRIBUTE} must be one of ${WATERFALL_STYLES.join(', ')}`;
    }
    for (const key of [WATERFALL_TOP_ATTRIBUTE, WATERFALL_BOTTOM_ATTRIBUTE]) {
        const v = attributes[key];
        if (v !== undefined && v !== null && (typeof v !== 'number' || !Number.isFinite(v))) {
            return `attributes.${key} must be a height in metres`;
        }
    }
    const top = attributes[WATERFALL_TOP_ATTRIBUTE], bottom = attributes[WATERFALL_BOTTOM_ATTRIBUTE];
    if (typeof top === 'number' && typeof bottom === 'number' && !(top > bottom)) {
        return `attributes.${WATERFALL_TOP_ATTRIBUTE} must be above ${WATERFALL_BOTTOM_ATTRIBUTE}`;
    }
    const flow = attributes[WATERFALL_FLOW_ATTRIBUTE];
    if (flow !== undefined && flow !== null && (typeof flow !== 'number' || !Number.isFinite(flow))) {
        return `attributes.${WATERFALL_FLOW_ATTRIBUTE} must be a compass bearing in degrees`;
    }
    const sill = attributes[WATERFALL_SILL_ATTRIBUTE];
    if (sill !== undefined && sill !== null && (typeof sill !== 'number' || !(sill >= 0 && sill <= 5))) {
        return `attributes.${WATERFALL_SILL_ATTRIBUTE} must be 0..5 m`;
    }
    const width = attributes[WATERFALL_WIDTH_ATTRIBUTE];
    if (width !== undefined && width !== null
        && (typeof width !== 'number' || !(width >= CASCADE_WIDTH_RANGE_M.min && width <= CASCADE_WIDTH_RANGE_M.max))) {
        return `attributes.${WATERFALL_WIDTH_ATTRIBUTE} must be ${CASCADE_WIDTH_RANGE_M.min}..${CASCADE_WIDTH_RANGE_M.max} m`;
    }
    const height = attributes[WATERFALL_HEIGHT_ATTRIBUTE];
    if (height !== undefined && height !== null
        && (typeof height !== 'number' || !(height >= FOUNTAIN_HEIGHT_RANGE_M.min && height <= FOUNTAIN_HEIGHT_RANGE_M.max))) {
        return `attributes.${WATERFALL_HEIGHT_ATTRIBUTE} must be ${FOUNTAIN_HEIGHT_RANGE_M.min}..${FOUNTAIN_HEIGHT_RANGE_M.max} m`;
    }
    return null;
}
