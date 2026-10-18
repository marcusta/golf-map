// Waterfall: where water drops from one pond (or creek) to the next, drawn in
// Draw mode as a short centerline along the fall's lip (the edge the water
// goes over), like a power line. It is no surface: it stays out of the SVG,
// the lie map and the surface stack. The Unity build of the waterfalls
// (golfmap.waterfalls.build, from gspro.py waterfalls) puts the falling water
// along that line, from the water above down to the water below, with spray
// where it lands.
//
// Two styles:
// - `sill`: the water runs over a weir's crest (a stone sill or a narrow earth
//   dam `sillM` wide, upstream of the lip) and drops over its whole width;
// - `outlet`: the water comes out from under a crossing (a dam with a pipe, a
//   path over a culvert) at the lip, a narrower spout.
// The terrain editor's Find falls (WaterStepsService, pipeline
// golfpipe.water_steps) proposes them from the lidar and fills the levels.
// Shared by the server (type list, validation) and the web Draw tool; the
// pipeline mirrors the type name (WATERFALL_FEATURE_TYPE).

export const WATERFALL_TYPE = 'waterfall';

export const WATERFALL_STYLES = ['sill', 'outlet'] as const;
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

/**
 * Corridor a newly drawn waterfall gets, metres: the lip plus the crest
 * upstream of it and the splash below, so the line reads on the map.
 */
export const DEFAULT_WATERFALL_WIDTH_M = 2;

export function isWaterfallStyle(v: unknown): v is WaterfallStyle {
    return typeof v === 'string' && (WATERFALL_STYLES as readonly string[]).includes(v);
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
    return null;
}
