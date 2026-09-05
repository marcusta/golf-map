/** The canonical part of a map tile id (maplibre `CanonicalTileID` shape). */
export interface CanonicalTile {
    z: number;
    x: number;
    y: number;
}

/**
 * True when two canonical tiles cover overlapping ground: the same tile, or
 * one an ancestor of the other. Ignores overscaling on purpose — a source
 * tile overscaled past its maxzoom and a deeper render-to-texture tile that
 * draws part of it overlap even though their overscaled zooms are equal.
 */
export function canonicalTilesOverlap(a: CanonicalTile, b: CanonicalTile): boolean {
    const [deep, shallow] = a.z >= b.z ? [a, b] : [b, a];
    const dz = deep.z - shallow.z;
    return (deep.x >> dz) === shallow.x && (deep.y >> dz) === shallow.y;
}
