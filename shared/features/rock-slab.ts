// Rock slab (Swedish "berghäll"): a flat bare rock in the rough that gets its
// own mesh in the course. The polygon is drawn like any surface, but it is no
// OPCD surface and stays out of the SVG: `pipeline/gspro.py shaping-global`
// writes one `golfmap.cut_out` op per slab (blender/README.md "Shaping:
// cut-outs"), and Blender cuts the outline into the course meshes and lifts the
// inside out as `Spline_hall_<number>_Rock_-_Mesh`. Shared by the server
// (validation) and the web selection panel; the pipeline mirrors the names.

export const ROCK_SLAB_TYPE = 'rock_slab';

/**
 * How far the cut-out reaches beyond the drawn outline, metres. An outline
 * traced tight to the rock in the aerial photo reads too small in game (the
 * Vreta slabs were grown 1.5 m all round), so the generator grows it.
 */
export const ROCK_SLAB_MARGIN_ATTRIBUTE = 'marginM';
export const DEFAULT_ROCK_SLAB_MARGIN_M = 1.5;
export const ROCK_SLAB_MARGIN_RANGE_M = { min: 0, max: 5 } as const;

/** Texture tile size on the slab, metres per tile (the cut-out op's `uvM`). */
export const ROCK_SLAB_TILE_ATTRIBUTE = 'uvM';
export const DEFAULT_ROCK_SLAB_TILE_M = 4;

/**
 * A rock that rises out of the ground or the water instead of lying flat (`golfmap.cut_out`'s `rise`,
 * blender/README.md "Shaping: cut-outs"), flat attributes (the feature API takes scalars only): the slab is
 * refined and lifted into a rounded klippa whose top stands `riseTopM` over `riseWaterM` (or over the highest
 * ground on its outline when there is no water), its foot `riseFootM` under the water, and the ground around it
 * within `riseApronM` is lifted into a shoal/apron that meets the foot; with water, the faces around it that end up
 * under the water join the lake. Lift only, one height per position, so the seams stay closed. `riseTopM` turns
 * it on; the rest is optional (`riseNoiseM` lumps, `riseMaxEdgeM` mesh size, `riseSeed`).
 */
export const ROCK_SLAB_RISE_ATTRIBUTES = {
    riseWaterM: 'waterM', riseTopM: 'topM', riseFootM: 'footM', riseApronM: 'apronM',
    riseNoiseM: 'noiseM', riseMaxEdgeM: 'maxEdgeM', riseSeed: 'seed',
} as const;

/** The slab's margin, the default when unset. */
export function rockSlabMarginOf(attributes: object | null | undefined): number {
    const value = (attributes as Record<string, unknown> | null | undefined)?.[ROCK_SLAB_MARGIN_ATTRIBUTE];
    return typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_ROCK_SLAB_MARGIN_M;
}

/** The slab's texture tile size, the default when unset. */
export function rockSlabTileOf(attributes: object | null | undefined): number {
    const value = (attributes as Record<string, unknown> | null | undefined)?.[ROCK_SLAB_TILE_ATTRIBUTE];
    return typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_ROCK_SLAB_TILE_M;
}

/** Why the rock slab attributes are invalid, or null when they are fine (absent keys are fine). */
export function rockSlabProblem(attributes: object | null | undefined): string | null {
    const a = (attributes ?? {}) as Record<string, unknown>;
    const { min, max } = ROCK_SLAB_MARGIN_RANGE_M;
    const margin = a[ROCK_SLAB_MARGIN_ATTRIBUTE];
    if (margin !== undefined && (typeof margin !== 'number' || !Number.isFinite(margin) || margin < min || margin > max)) {
        return `attributes.${ROCK_SLAB_MARGIN_ATTRIBUTE} must be a number between ${min} and ${max} (metres)`;
    }
    const tile = a[ROCK_SLAB_TILE_ATTRIBUTE];
    if (tile !== undefined && (typeof tile !== 'number' || !Number.isFinite(tile) || tile <= 0)) {
        return `attributes.${ROCK_SLAB_TILE_ATTRIBUTE} must be a number above 0 (metres)`;
    }
    for (const key of Object.keys(ROCK_SLAB_RISE_ATTRIBUTES)) {
        const value = a[key];
        if (value === undefined) continue;
        if (typeof value !== 'number' || !Number.isFinite(value)) return `attributes.${key} must be a number`;
        if (key === 'riseTopM' && (value <= 0 || value > 10)) return 'attributes.riseTopM must be above 0 and up to 10 (metres)';
        if (['riseFootM', 'riseApronM', 'riseNoiseM'].includes(key) && (value < 0 || value > 10)) return `attributes.${key} must be between 0 and 10 (metres)`;
        if (key === 'riseMaxEdgeM' && (value < 0.1 || value > 2)) return 'attributes.riseMaxEdgeM must be between 0.1 and 2 (metres)';
    }
    return null;
}
