import { buildTreeIndex, type TreeFeatureInput, type TreeIndex } from './tree-clearance';

/** Crown kind from the pipeline classifier (leaf-off ortho greenness). */
export const TREE_KIND_BROADLEAF = 0;
export const TREE_KIND_CONIFER = 1;
export const TREE_KIND_UNKNOWN = 2;
export type TreeKind = typeof TREE_KIND_BROADLEAF | typeof TREE_KIND_CONIFER | typeof TREE_KIND_UNKNOWN;

/** EPSG:3006 position and RH2000 ground elevation, all in metres. */
export interface TreeStem {
    x: number;
    y: number;
    heightM: number;
    crownRadiusM: number;
    groundM: number;
    /** Version 1 assets carry no kind; every stem reads as unknown. */
    kind: TreeKind;
}

export const TREE_STEM_FIELDS = ['x', 'y', 'heightM', 'crownRadiusM', 'groundM'] as const;
export const TREE_STEM_FIELDS_V2 = [...TREE_STEM_FIELDS, 'kind'] as const;

/** Reject the whole asset on corruption so callers can use polygon fallback.
 *  Accepts version 1 (five columns) and version 2 (kind appended). */
export function parseTreeStemsAsset(value: unknown): TreeStem[] {
    const asset = value as Record<string, unknown> | null;
    const fields = asset?.version === 1 ? TREE_STEM_FIELDS : asset?.version === 2 ? TREE_STEM_FIELDS_V2 : null;
    if (!asset || fields === null || asset.crs !== 'EPSG:3006'
        || JSON.stringify(asset.fields) !== JSON.stringify(fields) || !Array.isArray(asset.trees)) {
        throw new Error('Unsupported tree stems asset');
    }
    const width = fields.length;
    return asset.trees.map((row: unknown) => {
        if (!Array.isArray(row) || row.length !== width || !row.every(v => typeof v === 'number' && Number.isFinite(v))
            || row[2] <= 0 || row[3] <= 0) throw new Error('Invalid tree stem');
        const [x, y, heightM, crownRadiusM, groundM] = row;
        const kind = width === 6 ? row[5] : TREE_KIND_UNKNOWN;
        if (kind !== TREE_KIND_BROADLEAF && kind !== TREE_KIND_CONIFER && kind !== TREE_KIND_UNKNOWN) throw new Error('Invalid tree stem');
        return { x, y, heightM, crownRadiusM, groundM, kind };
    });
}

export function buildTreeStemIndex(stems: readonly TreeStem[]): TreeIndex<TreeFeatureInput> {
    return buildTreeIndex(stems.map(stem => ({type: 'trees', points: [], stem})));
}
