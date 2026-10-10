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
    return null;
}
