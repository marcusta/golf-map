/**
 * Layout of conifer.png (2048 x 2048), shared by the texture generator
 * (scripts/gen-tree-textures.ts) and the card geometry (tree-geometry.ts).
 *
 * Sixteen 512 x 512 cells in a 4 x 4 grid, one needle-spray cluster each:
 *   rows 0 and 1   eight spruce clusters (drooping branchlets)
 *   rows 2 and 3   eight pine clusters (tufted brushes of long needles)
 *
 * A cluster is a radial view of one branch end: twigs radiate from a point near
 * the cell centre and the alpha falls off toward the cell border, so a card can
 * face any direction without showing a straight edge. Rects are PNG pixels with
 * y measured from the top; three.js flips the texture on upload, so `rectUv`
 * converts to uv with v growing upward.
 */
export const CONIFER_ATLAS_SIZE = 2048;
export const CONIFER_CELL_SIZE = 512;
export const CONIFER_CELL_COLUMNS = CONIFER_ATLAS_SIZE / CONIFER_CELL_SIZE;
/** Cluster cells per species. */
export const CONIFER_CELLS = 8;
export type ConiferSpecies = 'spruce' | 'pine';

export interface AtlasRect { x: number; y: number; w: number; h: number }

export function clusterCell(species: ConiferSpecies, index: number): AtlasRect {
    const cell = (species === 'spruce' ? 0 : CONIFER_CELLS) + index;
    return {
        x: (cell % CONIFER_CELL_COLUMNS) * CONIFER_CELL_SIZE, y: Math.floor(cell / CONIFER_CELL_COLUMNS) * CONIFER_CELL_SIZE,
        w: CONIFER_CELL_SIZE, h: CONIFER_CELL_SIZE,
    };
}

export interface CellUv { u0: number; u1: number; vTop: number; vBottom: number }

export function rectUv(rect: AtlasRect): CellUv {
    const s = CONIFER_ATLAS_SIZE;
    return { u0: rect.x / s, u1: (rect.x + rect.w) / s, vTop: 1 - rect.y / s, vBottom: 1 - (rect.y + rect.h) / s };
}
