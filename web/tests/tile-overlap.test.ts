import { test, expect } from 'bun:test';
import { canonicalTilesOverlap } from '../src/map/tile-overlap';

// The field case: a geojson overlay tile (source maxzoom 18) overscaled to
// zoom 19, and the terrain render-to-texture tile that draws part of it.
// maplibre's own OverscaledTileID.isChildOf rejects this pair (equal
// overscaledZ), which is why draped overlays went stale at zoom >= 19.
const overlayZ18 = { z: 18, x: 142_318, y: 74_990 };

test('same tile overlaps itself', () => {
    expect(canonicalTilesOverlap(overlayZ18, { ...overlayZ18 })).toBe(true);
});

test('a deeper tile inside the overlay tile overlaps, in both argument orders', () => {
    const rttZ19 = { z: 19, x: overlayZ18.x * 2 + 1, y: overlayZ18.y * 2 };
    expect(canonicalTilesOverlap(rttZ19, overlayZ18)).toBe(true);
    expect(canonicalTilesOverlap(overlayZ18, rttZ19)).toBe(true);
    const rttZ21 = { z: 21, x: overlayZ18.x * 8 + 7, y: overlayZ18.y * 8 + 5 };
    expect(canonicalTilesOverlap(rttZ21, overlayZ18)).toBe(true);
});

test('a neighbouring tile at the same zoom does not overlap', () => {
    expect(canonicalTilesOverlap(overlayZ18, { ...overlayZ18, x: overlayZ18.x + 1 })).toBe(false);
    expect(canonicalTilesOverlap(overlayZ18, { ...overlayZ18, y: overlayZ18.y - 1 })).toBe(false);
});

test('a deeper tile under the neighbouring parent does not overlap', () => {
    const underNeighbour = { z: 19, x: (overlayZ18.x + 1) * 2, y: overlayZ18.y * 2 };
    expect(canonicalTilesOverlap(underNeighbour, overlayZ18)).toBe(false);
    expect(canonicalTilesOverlap(overlayZ18, underNeighbour)).toBe(false);
});

test('an ancestor several levels up overlaps', () => {
    const z14 = { z: 14, x: overlayZ18.x >> 4, y: overlayZ18.y >> 4 };
    expect(canonicalTilesOverlap(z14, overlayZ18)).toBe(true);
    expect(canonicalTilesOverlap(z14, { ...overlayZ18, x: overlayZ18.x + 16 })).toBe(false);
});
