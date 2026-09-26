import { describe, expect, test } from 'bun:test';
import { Box3 } from 'three';
import {
    adjustStand, BROADLEAF_CARDS_MAX, BROADLEAF_CARDS_MIN, BROADLEAF_LOW_FOLIAGE_VARIANTS, BROADLEAF_STUB_VARIANTS, cardFractionAtLod,
    CONIFER_TOP_TAPER, CONIFER_LOD_MID_FRACTION,
    crownBaseFraction, impostorCell, impostorGeometry, isShrubHeight, leanFor, LOD_FULL_M, LOD_HALF_M, LOD_MID_FRACTION, lodFor, midFractionFor,
    renderCrownRadius,
    SHRUB_MAX_HEIGHT_M, shadowGeometry, shrubGeometry, SPECIES, speciesFor,
    STAND_MERGE_DISTANCE_M, STAND_SHADOW_DISTANCE_M, stemHash, treeGeometry,
    TRUNK_TOP_TAPER, trunkBaseRadius, VARIANTS, variantFor, type StandStem,
} from '../src/map/tree-geometry';
import { NEAR_FADE_FULL_M, NEAR_FADE_ZERO_M, shadowOffsetPerMetre, SUN_AZIMUTH_DEG, SUN_ELEVATION_DEG, sunDirection } from '../src/map/tree-material';

describe('stem form classification and shrub model', () => {
    test('height alone decides the split at 4 m', () => {
        expect(SHRUB_MAX_HEIGHT_M).toBe(4);
        expect([1, 1.9, 3.9].map(isShrubHeight)).toEqual([true, true, true]);
        expect([4, 4.1, 25].map(isShrubHeight)).toEqual([false, false, false]);
    });
    test('shrub geometry sits on the ground inside its unit crown radius', () => {
        for (const detailed of [false, true]) {
            const geometry = shrubGeometry(detailed);
            const box = new Box3().setFromBufferAttribute(geometry.getAttribute('position') as any);
            expect(box.min.z).toBeCloseTo(0, 5);
            expect(box.max.z).toBeLessThanOrEqual(1.0);
            expect(box.max.z).toBeGreaterThan(0.8);
            expect(Math.max(box.max.x, box.max.y, -box.min.x, -box.min.y)).toBeLessThanOrEqual(1.02);
            expect(geometry.getAttribute('color').count).toBe(geometry.getAttribute('position').count);
            geometry.dispose();
        }
    });
    test('distant shrub geometry submits less than a quarter of the close mesh triangles', () => {
        const near = shrubGeometry(true), far = shrubGeometry(false);
        expect(far.index!.count).toBeLessThan(near.index!.count * 0.25);
        for (const geometry of [near, far]) {
            const position = geometry.getAttribute('position');
            expect(Array.from(position.array).every(Number.isFinite)).toBe(true);
            expect(Array.from(geometry.getAttribute('normal').array).every(Number.isFinite)).toBe(true);
            expect(Array.from(geometry.index!.array).every(i => i >= 0 && i < position.count)).toBe(true);
            geometry.dispose();
        }
    });

});

describe('species, variants and hashing', () => {
    test('asset kind maps to species; unknown and absent kinds render as broadleaf', () => {
        expect(speciesFor(0, 0.1)).toBe('broadleaf');
        expect(speciesFor(2, 0.9)).toBe('broadleaf');
        expect(speciesFor(undefined, 0.5)).toBe('broadleaf');
        expect(speciesFor(1, 0.2)).toBe('spruce');
        expect(speciesFor(1, 0.8)).toBe('pine');
        expect(speciesFor(1, 0.29999)).toBe('spruce');
        expect(speciesFor(1, 0.3)).toBe('pine');
        const mixture = Array.from({ length: 100 }, (_, i) => speciesFor(1, i / 100));
        expect(mixture.filter(species => species === 'pine')).toHaveLength(70);
    });
    test('stem hash is deterministic, in [0,1), and differs per salt and position', () => {
        const a = stemHash(541450.25, 6469150.5), b = stemHash(541450.25, 6469150.5);
        expect(a).toBe(b);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThan(1);
        expect(stemHash(541450.25, 6469150.5, 1)).not.toBe(a);
        expect(stemHash(541451, 6469150.5)).not.toBe(a);
        const values = new Set<number>();
        for (let i = 0; i < 2000; i++) values.add(variantFor(stemHash(541000 + i * 3.7, 6469000 + i * 1.3)));
        expect([...values].sort()).toEqual([0, 1, 2, 3]);
        expect(VARIANTS).toBe(4);
    });
    test('crown base fraction stays inside the documented bands', () => {
        for (let v = 0; v < VARIANTS; v++) {
            const b = crownBaseFraction('broadleaf', v), s = crownBaseFraction('spruce', v), p = crownBaseFraction('pine', v);
            expect(b).toBeGreaterThanOrEqual(0.35); expect(b).toBeLessThanOrEqual(0.45);
            expect(s).toBeGreaterThanOrEqual(0.12); expect(s).toBeLessThanOrEqual(0.30);
            expect(p).toBeGreaterThanOrEqual(0.46); expect(p).toBeLessThanOrEqual(0.68);
        }
    });
    test('render crown radius follows height with the data radius as a floor and a cap', () => {
        // A 17 m stand broadleaf with a 2.9 m watershed radius renders at a quarter of its height.
        expect(renderCrownRadius('broadleaf', 17, 2.9)).toBeCloseTo(4.25, 5);
        // A measured radius above the floor is kept until the cap.
        expect(renderCrownRadius('broadleaf', 17, 6)).toBe(6);
        // A data radius above the pipeline's 0.35 * height cap is a measured flat crown (willow): drawn as given, to 10 m.
        expect(renderCrownRadius('broadleaf', 10, 6)).toBe(6);
        expect(renderCrownRadius('broadleaf', 9.5, 7.3)).toBe(7.3);
        expect(renderCrownRadius('broadleaf', 10, 3.5)).toBeCloseTo(3.5, 5);
        expect(renderCrownRadius('spruce', 20, 1.5)).toBeCloseTo(2.8, 5);
        expect(renderCrownRadius('spruce', 20, 7)).toBe(6);
        expect(renderCrownRadius('pine', 20, 1.5)).toBeCloseTo(3.6, 5);
        for (const species of SPECIES) expect(renderCrownRadius(species, 12, 20)).toBe(10);
    });
    test('trunk base radius and lean stay in their bands', () => {
        expect(trunkBaseRadius(17)).toBeCloseTo(0.304, 5);
        expect(trunkBaseRadius(5)).toBeCloseTo(0.16, 5);
        expect(TRUNK_TOP_TAPER).toBe(0.3);
        for (const h of [0, 0.5, 0.999]) {
            const degrees = Math.atan(leanFor(h)) * 180 / Math.PI;
            expect(degrees).toBeGreaterThanOrEqual(2); expect(degrees).toBeLessThanOrEqual(4);
        }
    });
});

describe('stand adjustment', () => {
    const stem = (x: number, y: number, radius: number, height = 16): StandStem => ({ x, y, radius, height, shrub: false, baseRaise: 0, nearestM: Infinity });
    test('close pairs shrink the smaller crown and raise its base; distant trees are untouched', () => {
        expect(STAND_MERGE_DISTANCE_M).toBe(2.5);
        const stems = [stem(0, 0, 4), stem(1.8, 0, 3.5), stem(40, 40, 3.5), stem(0, 7, 4)];
        adjustStand(stems);
        expect(stems[0].radius).toBe(4);
        expect(stems[0].baseRaise).toBe(0);
        expect(stems[1].radius).toBeCloseTo(3.5 * 0.65, 5);
        expect(stems[1].baseRaise).toBeGreaterThan(0);
        expect(stems[1].baseRaise).toBeLessThanOrEqual(0.2);
        expect(stems[2].radius).toBe(3.5);
        expect(stems[2].nearestM).toBe(Infinity);
        expect(stems[3].radius).toBe(4);
        expect(stems[3].nearestM).toBeCloseTo(7, 5);
    });
    test('a crown hemmed in by several neighbours never shrinks below 45 percent', () => {
        const stems = [stem(0, 0, 3), stem(2, 0, 5), stem(-2, 0, 5), stem(0, 2, 5), stem(0, -2, 5)];
        adjustStand(stems);
        expect(stems[0].radius).toBeCloseTo(3 * 0.45, 5);
        for (let i = 1; i < 5; i++) expect(stems[i].radius).toBe(5);
    });
    test('nearest neighbour distance is found across hash cells and ignores shrubs', () => {
        expect(STAND_SHADOW_DISTANCE_M).toBe(8);
        const stems = [stem(7.9, 7.9, 3), stem(8.1, 8.1, 3), { ...stem(20, 20, 1, 2), shrub: true }, stem(20.5, 20.5, 3)];
        adjustStand(stems);
        expect(stems[0].nearestM).toBeCloseTo(Math.hypot(0.2, 0.2), 5);
        expect(stems[1].radius).toBeLessThan(3);
        expect(stems[2].nearestM).toBe(Infinity);
        expect(stems[3].nearestM).toBeGreaterThan(STAND_SHADOW_DISTANCE_M); // adjacent cell, 17.5 m: recorded but no stand shadow
    });
});

describe('level of detail', () => {
    test('distance bands select full cards, half cards, then impostors', () => {
        expect(lodFor(0)).toBe(0);
        expect(lodFor(LOD_FULL_M - 1)).toBe(0);
        expect(lodFor(LOD_FULL_M)).toBe(1);
        expect(lodFor(LOD_HALF_M - 1)).toBe(1);
        expect(lodFor(LOD_HALF_M)).toBe(2);
        expect(lodFor(1199)).toBe(2);
        expect([0, 1, 2].map(lod => cardFractionAtLod(lod as 0 | 1 | 2))).toEqual([1, LOD_MID_FRACTION, 0]);
        expect(midFractionFor('broadleaf')).toBe(LOD_MID_FRACTION);
        for (const species of ['spruce', 'pine'] as const) {
            expect(midFractionFor(species)).toBe(CONIFER_LOD_MID_FRACTION);
            expect([0, 1, 2].map(lod => cardFractionAtLod(lod as 0 | 1 | 2, species))).toEqual([1, CONIFER_LOD_MID_FRACTION, 0]);
        }
    });
    test('impostor cells are unique per species and variant', () => {
        const cells = SPECIES.flatMap(s => Array.from({ length: VARIANTS }, (_, v) => impostorCell(s, v)));
        expect(new Set(cells).size).toBe(SPECIES.length * VARIANTS);
        expect(Math.max(...cells)).toBe(SPECIES.length * VARIANTS - 1);
        const quad = impostorGeometry();
        expect(quad.getAttribute('aCorner').count).toBe(8);
        expect(quad.index!.count).toBe(12);
    });
});

describe('tree card geometry', () => {
    test('broadleaf variants carry 24 to 34 cards each, three quarters of them ranked for the mid level', () => {
        const { geometry, cards } = treeGeometry('broadleaf');
        const info = geometry.getAttribute('aInfo');
        const perVariant = new Map<number, { cards: number; kept: number }>();
        for (let i = 0; i < info.count; i++) {
            if (info.getZ(i) < 0.5) continue; // trunk
            if (i % 4 !== 0) continue;        // one entry per card (4 vertices)
            const v = info.getX(i);
            const entry = perVariant.get(v) ?? { cards: 0, kept: 0 };
            entry.cards++;
            if (info.getY(i) <= LOD_MID_FRACTION) entry.kept++;
            perVariant.set(v, entry);
        }
        expect(perVariant.size).toBe(VARIANTS);
        let total = 0;
        for (const { cards: n, kept } of perVariant.values()) {
            expect(n).toBeGreaterThanOrEqual(BROADLEAF_CARDS_MIN);
            expect(n).toBeLessThanOrEqual(BROADLEAF_CARDS_MAX);
            expect(Math.abs(kept - n * LOD_MID_FRACTION)).toBeLessThanOrEqual(1);
            total += n;
        }
        expect(total).toBe(cards);
        geometry.dispose();
    });
    test('broadleaf cards fill the lower crown, and marked variants add low sprouts and branch stubs', () => {
        const { geometry } = treeGeometry('broadleaf');
        const centre = geometry.getAttribute('aCenter'), info = geometry.getAttribute('aInfo');
        for (let v = 0; v < VARIANTS; v++) {
            const base = crownBaseFraction('broadleaf', v);
            let lowerCrown = 0, upperCrown = 0, sprouts = 0, stubs = 0;
            for (let i = 0; i < centre.count; i += 4) {
                if (info.getX(i) !== v) continue;
                const z = centre.getZ(i);
                if (info.getZ(i) < 0.5) {
                    // Trunk rings have corner (0,0,0) and sit on a circle; stub vertices reach out past 2 trunk radii.
                    if (Math.hypot(centre.getX(i), centre.getY(i)) > 2) stubs++;
                    continue;
                }
                if (z < base * 0.9) sprouts++;
                else if (z < base + 0.25 * (1 - base)) lowerCrown++;
                else if (z > base + 0.75 * (1 - base)) upperCrown++;
            }
            expect(lowerCrown).toBeGreaterThanOrEqual(5);
            expect(upperCrown).toBeGreaterThanOrEqual(2);
            expect(sprouts > 0).toBe(BROADLEAF_LOW_FOLIAGE_VARIANTS.includes(v));
            expect(stubs > 0).toBe(BROADLEAF_STUB_VARIANTS.includes(v));
        }
        geometry.dispose();
    });
    test('trunks flare at ground level and conifer leaders taper to a fine tip', () => {
        for (const species of SPECIES) {
            const { geometry } = treeGeometry(species);
            const centre = geometry.getAttribute('aCenter'), corner = geometry.getAttribute('aCorner'), info = geometry.getAttribute('aInfo');
            let groundR = 0, topR = Infinity, topZ = 0;
            for (let i = 0; i < centre.count; i++) {
                if (info.getZ(i) > 0.5 || corner.getX(i) !== 0 || info.getX(i) !== 0) continue;
                const r = Math.hypot(centre.getX(i), centre.getY(i)), z = centre.getZ(i);
                if (r > 2) continue; // branch stub
                if (z === 0) groundR = Math.max(groundR, r);
                if (z > topZ) { topZ = z; topR = r; } else if (z === topZ) topR = Math.min(topR, r);
            }
            expect(groundR).toBeGreaterThan(1);
            expect(groundR).toBeLessThan(1.2);
            expect(topR).toBeCloseTo(species === 'broadleaf' ? TRUNK_TOP_TAPER : CONIFER_TOP_TAPER, 5);
            expect(topZ).toBeGreaterThan(species === 'broadleaf' ? 0.6 : 0.95);
            geometry.dispose();
        }
    });
    test('cards stay inside the unit crown and below the top; conifers taper to a spire', () => {
        for (const species of SPECIES) {
            const { geometry } = treeGeometry(species);
            const centre = geometry.getAttribute('aCenter'), corner = geometry.getAttribute('aCorner'), info = geometry.getAttribute('aInfo');
            let maxZ = 0, topRadius = 1;
            for (let i = 0; i < centre.count; i++) {
                if (info.getZ(i) < 0.5) continue;
                const r = Math.hypot(centre.getX(i), centre.getY(i));
                expect(r).toBeLessThanOrEqual(1.25);
                expect(Math.hypot(corner.getX(i), corner.getY(i), corner.getZ(i))).toBeLessThanOrEqual(1.2);
                maxZ = Math.max(maxZ, centre.getZ(i));
                if (centre.getZ(i) > 0.9) topRadius = Math.min(topRadius, r);
            }
            expect(maxZ).toBeLessThanOrEqual(1.1);
            // Spruce spires; the pine dome stays wide to the top.
            if (species === 'spruce') expect(topRadius).toBeLessThan(0.35);
            if (species === 'pine') expect(topRadius).toBeLessThan(0.85);
            geometry.dispose();
        }
    });
    test('conifer geometry has finite vertices, valid indices and a bounded triangle cost per form', () => {
        for (const species of ['spruce', 'pine'] as const) for (let variant = 0; variant < VARIANTS; variant++) {
            const { geometry } = treeGeometry(species, variant);
            const info = geometry.getAttribute('aInfo');
            for (const attribute of Object.values(geometry.attributes)) {
                expect(attribute.count).toBe(info.count);
                expect(Array.from(attribute.array).every(Number.isFinite)).toBe(true);
            }
            expect(Array.from(geometry.index!.array).every(i => i >= 0 && i < info.count)).toBe(true);
            expect(geometry.index!.count / 3).toBeLessThan(12000);
            expect(new Set(Array.from({ length: info.count }, (_, i) => info.getX(i)))).toEqual(new Set([variant]));
            expect(new Set(Array.from({ length: info.count }, (_, i) => info.getZ(i)))).toEqual(new Set([0, 1, 2]));
            geometry.dispose();
        }
    });

    test('conifer branches connect to wood and sprays follow those branches', () => {
        type Point = [number, number, number];
        const distanceToSegment = (p: Point, a: Point, b: Point): number => {
            const d = b.map((x, i) => x - a[i]), q = p.map((x, i) => x - a[i]);
            const t = Math.max(0, Math.min(1, d.reduce((n, x, i) => n + x * q[i], 0) / d.reduce((n, x) => n + x * x, 0)));
            return Math.hypot(...p.map((x, i) => x - a[i] - t * d[i]));
        };
        for (const species of ['spruce', 'pine'] as const) for (let variant = 0; variant < VARIANTS; variant++) {
            const { geometry } = treeGeometry(species, variant);
            const centre = geometry.getAttribute('aCenter'), info = geometry.getAttribute('aInfo');
            const point = (i: number): Point => [centre.getX(i), centre.getY(i), centre.getZ(i)];
            const segments: [Point, Point][] = [];
            for (let i = 0; i < info.count;) {
                if (info.getZ(i) !== 2) { i++; continue; }
                const root = point(i);
                const main = Math.hypot(root[0], root[1]) < 1e-6;
                // Main tubes have three rings; lateral shoots have two. Each ring closes after five sides.
                if (!main) expect(Math.min(...segments.map(([a, b]) => distanceToSegment(root, a, b)))).toBeLessThan(1e-6);
                const rings = main ? 3 : 2;
                for (let r = 1; r < rings; r++) segments.push([point(i + (r - 1) * 6), point(i + r * 6)]);
                i += rings * 6;
            }
            expect(segments.length).toBeGreaterThan(100);
            for (let i = 0; i < info.count; i++) {
                if (info.getZ(i) !== 1) continue;
                const p = point(i);
                if (Math.hypot(p[0], p[1]) < 1e-6) continue; // needled leader on the trunk
                expect(Math.min(...segments.map(([a, b]) => distanceToSegment(p, a, b)))).toBeLessThan(1e-6);
            }
            geometry.dispose();
        }
    });

    test('medium conifers keep every foliage attachment and retain depth from every horizontal viewing angle', () => {
        for (const species of ['spruce', 'pine'] as const) for (let variant = 0; variant < VARIANTS; variant++) {
            const { geometry } = treeGeometry(species, variant);
            const centre = geometry.getAttribute('aCenter'), corner = geometry.getAttribute('aCorner'), info = geometry.getAttribute('aInfo');
            const attachments = new Map<string, { full: number[][]; mid: number[][] }>();
            for (let i = 0; i < info.count; i++) {
                if (info.getZ(i) !== 1) continue;
                const key = [centre.getX(i), centre.getY(i), centre.getZ(i)].join(',');
                const entry = attachments.get(key) ?? { full: [], mid: [] };
                const p = [corner.getX(i), corner.getY(i), corner.getZ(i)];
                entry.full.push(p);
                if (info.getY(i) <= CONIFER_LOD_MID_FRACTION) entry.mid.push(p);
                attachments.set(key, entry);
            }
            for (const { full, mid } of attachments.values()) {
                expect(mid.length).toBeGreaterThan(0);
                for (let angle = 0; angle < Math.PI; angle += Math.PI / 8) {
                    const span = (points: number[][]) => {
                        const x = points.map(p => p[0] * Math.cos(angle) + p[1] * Math.sin(angle));
                        return Math.max(...x) - Math.min(...x);
                    };
                    expect(span(mid) / span(full)).toBeGreaterThan(0.55);
                }
                const z = mid.map(p => p[2]);
                expect(Math.max(...z) - Math.min(...z)).toBeGreaterThan(0.01);
            }
            geometry.dispose();
        }
    });
    test('the near fade removes cards under 1.5 m from the eye and is complete by the full distance', () => {
        expect(NEAR_FADE_ZERO_M).toBe(1.5);
        expect(NEAR_FADE_FULL_M).toBeGreaterThan(NEAR_FADE_ZERO_M);
    });
    test('shadow decal is a unit quad', () => {
        const box = new Box3().setFromArray(Array.from(shadowGeometry().getAttribute('aCorner').array).flatMap((v, i, a) => (i % 2 ? [] : [v, a[i + 1], 0])));
        expect(box.min.x).toBe(-1); expect(box.max.y).toBe(1);
    });
});

describe('sun placement', () => {
    test('sun sits in the north-east morning sky so decals fall south-west like the ortho', () => {
        expect(SUN_AZIMUTH_DEG).toBe(50);
        expect(SUN_ELEVATION_DEG).toBe(42);
        const sun = sunDirection();
        expect(sun.x).toBeGreaterThan(0); expect(sun.y).toBeGreaterThan(0); expect(sun.z).toBeGreaterThan(0.6);
        const offset = shadowOffsetPerMetre();
        expect(offset.x).toBeLessThan(0); expect(offset.y).toBeLessThan(0);
        expect(offset.length()).toBeCloseTo(0.5 / Math.tan(42 * Math.PI / 180), 5);
    });
});
