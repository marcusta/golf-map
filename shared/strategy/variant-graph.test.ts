import { describe, expect, test } from 'bun:test';
import type { ClubSpec } from './club';
import type { FlatRing } from './corridor';
import { scoreOptionChain } from './option-chain';
import {
    MAX_VARIANT_LEGS,
    MAX_VARIANT_NODES,
    type HoleHazard,
    type VariantHoleContext,
    buildVariantGraph,
    computeSignature,
    discoverVariants,
} from './variant-graph';

function box(kind: string, minX: number, minY: number, maxX: number, maxY: number, id?: string): FlatRing & { id?: string } {
    return {
        kind,
        ...(id !== undefined ? { id } : {}),
        points: [
            { x: minX, y: minY },
            { x: maxX, y: minY },
            { x: maxX, y: maxY },
            { x: minX, y: maxY },
        ],
    };
}

function hazard(kind: string, id: string, minX: number, minY: number, maxX: number, maxY: number): HoleHazard {
    return box(kind, minX, minY, maxX, maxY, id) as HoleHazard;
}

const BAG: ClubSpec[] = [
    { name: 'Driver', carryM: 230, dispersionM: 30 },
    { name: '3 wood', carryM: 210, dispersionM: 26 },
    { name: '5 iron', carryM: 175, dispersionM: 20 },
    { name: '7 iron', carryM: 150, dispersionM: 16 },
    { name: '9 iron', carryM: 125, dispersionM: 13 },
    { name: 'PW', carryM: 100, dispersionM: 11 },
    { name: 'SW', carryM: 70, dispersionM: 9 },
];

// A ~400 m par 4: wide fairway up the middle, a fairway bunker on the RIGHT of
// the drive zone (~230 m out), green at the top.
function refHole(): VariantHoleContext {
    const fairway = box('fairway', -35, 0, 35, 380);
    const green = box('green', -16, 380, 16, 404);
    const bunkerRight = hazard('bunker', 'bunkerR', 12, 210, 34, 250);
    return {
        tee: { x: 0, y: 0 },
        greenCenter: { x: 0, y: 392 },
        aimPoints: [{ x: 0, y: 230 }],
        surfaces: [bunkerRight, green, fairway], // hazards topmost (D23)
        hazards: [bunkerRight],
        clubs: BAG,
    };
}

describe('buildVariantGraph — graph shape (§V5)', () => {
    test('has a tee origin and a green terminal, capped at MAX_VARIANT_NODES', () => {
        const g = buildVariantGraph(refHole());
        expect(g.nodes[0]!.id).toBe('tee');
        expect(g.nodes.some((n) => n.id === 'green')).toBe(true);
        expect(g.nodes.length).toBeLessThanOrEqual(MAX_VARIANT_NODES);
    });

    test('every edge goes forward along the route (no backtracking)', () => {
        const g = buildVariantGraph(refHole());
        const chain = new Map(g.nodes.map((n) => [n.id, n.chainage]));
        for (const e of g.edges) {
            expect(chain.get(e.to)!).toBeGreaterThan(chain.get(e.from)!);
        }
    });

    test('generates lateral triples (left/center/right) inside the fairway', () => {
        const g = buildVariantGraph(refHole());
        // The aim band at ~230 m sits in a wide fairway → all three offsets.
        expect(g.nodes.some((n) => n.id.endsWith('-C'))).toBe(true);
        expect(g.nodes.some((n) => n.id.endsWith('-L'))).toBe(true);
        expect(g.nodes.some((n) => n.id.endsWith('-R'))).toBe(true);
    });

    test('a narrow fairway drops the lateral sides (min-offset rule)', () => {
        const ctx = refHole();
        // Squeeze the fairway to a 6 m-wide sliver: no room for ±15 m triples.
        ctx.surfaces = [ctx.surfaces[0]!, box('green', -16, 380, 16, 404), box('fairway', -3, 0, 3, 380)];
        const g = buildVariantGraph(ctx);
        expect(g.nodes.some((n) => n.id.endsWith('-L'))).toBe(false);
        expect(g.nodes.some((n) => n.id.endsWith('-R'))).toBe(false);
    });
});

describe('discoverVariants — pricing + composition (§V5)', () => {
    test('a variant score equals scoreOptionChain on its own legs', () => {
        const ctx = refHole();
        const variants = discoverVariants(ctx);
        expect(variants.length).toBeGreaterThan(0);
        for (const v of variants) {
            const direct = scoreOptionChain(v.legs, {
                surfaces: ctx.surfaces,
                greenCenter: ctx.greenCenter,
            });
            expect(v.score.expectedStrokes).toBeCloseTo(direct.expectedStrokes, 9);
            expect(v.score.tailStrokes).toBeCloseTo(direct.tailStrokes, 9);
            expect(v.score.penaltyProb).toBeCloseTo(direct.penaltyProb, 9);
        }
    });

    test('returns at most the top 5, ranked by EV ascending', () => {
        const variants = discoverVariants(refHole());
        expect(variants.length).toBeLessThanOrEqual(5);
        for (let i = 1; i < variants.length; i++) {
            expect(variants[i]!.score.expectedStrokes).toBeGreaterThanOrEqual(
                variants[i - 1]!.score.expectedStrokes,
            );
        }
    });

    test('every path starts at the tee and ends at the green, ≤ MAX_VARIANT_LEGS legs', () => {
        for (const v of discoverVariants(refHole())) {
            expect(v.nodes[0]!.id).toBe('tee');
            expect(v.nodes[v.nodes.length - 1]!.id).toBe('green');
            expect(v.legs.length).toBeLessThanOrEqual(MAX_VARIANT_LEGS);
            expect(v.legs.length).toBeGreaterThan(0);
        }
    });
});

describe('computeSignature — separation vs dedupe (§V5)', () => {
    // A hole with a bunker dead-center of the drive zone: lines can go left of
    // it, right of it, or carry it.
    function centerBunkerHole(): VariantHoleContext {
        const fairway = box('fairway', -50, 0, 50, 380);
        const green = box('green', -16, 380, 16, 404);
        const bunker = hazard('bunker', 'mid', -12, 200, 12, 240);
        return {
            tee: { x: 0, y: 0 },
            greenCenter: { x: 0, y: 392 },
            aimPoints: [{ x: 0, y: 230 }],
            surfaces: [bunker, green, fairway],
            hazards: [bunker],
            clubs: BAG,
        };
    }

    const ctx = centerBunkerHole();
    const tee = { id: 'tee', point: { x: 0, y: 0 }, chainage: 0, kind: 'tee' as const };
    const green = { id: 'green', point: ctx.greenCenter, chainage: 392, kind: 'green' as const };

    function landing(x: number, y: number) {
        return { id: `n${x}_${y}`, point: { x, y }, chainage: y, kind: 'aim' as const };
    }

    test('left-of-bunker and right-of-bunker are DISTINCT signatures', () => {
        const leftPath = [tee, landing(-30, 220), green];
        const rightPath = [tee, landing(30, 220), green];
        const left = computeSignature(leftPath, ctx);
        const right = computeSignature(rightPath, ctx);
        expect(left.hazards).toEqual([{ hazardId: 'mid', relation: 'passed-left' }]);
        expect(right.hazards).toEqual([{ hazardId: 'mid', relation: 'passed-right' }]);
        expect(left.key).not.toBe(right.key);
    });

    test('jiggled same-side paths DEDUPE to one signature', () => {
        const a = computeSignature([tee, landing(-30, 220), green], ctx);
        const b = computeSignature([tee, landing(-26, 224), green], ctx);
        expect(a.key).toBe(b.key);
    });

    test('carrying the bunker is distinct from going around it', () => {
        // A drive that lands beyond the bunker on the center line carries it.
        const carry = computeSignature([tee, landing(0, 260), green], ctx);
        expect(carry.hazards).toEqual([{ hazardId: 'mid', relation: 'carried' }]);
        const around = computeSignature([tee, landing(-30, 220), green], ctx);
        expect(carry.key).not.toBe(around.key);
    });

    test('shot count separates a layup line from a go-for-it line', () => {
        const twoShot = computeSignature([tee, landing(0, 260), green], ctx);
        const threeShot = computeSignature([tee, landing(0, 180), landing(0, 300), green], ctx);
        expect(twoShot.shotCount).toBe(2);
        expect(threeShot.shotCount).toBe(3);
        expect(twoShot.key).not.toBe(threeShot.key);
    });

    test('a hazard far off the corridor is not in the signature', () => {
        const farBunkerCtx: VariantHoleContext = {
            ...ctx,
            hazards: [hazard('bunker', 'far', 200, 200, 240, 240)],
            surfaces: [hazard('bunker', 'far', 200, 200, 240, 240), box('green', -16, 380, 16, 404), box('fairway', -50, 0, 50, 380)],
        };
        const sig = computeSignature([tee, landing(0, 230), green], farBunkerCtx);
        expect(sig.hazards).toEqual([]);
    });
});

describe('computeSignature — rotated (non-axis-aligned) hole (§V5 regression)', () => {
    // A hole running due NE (bearing 45°): tee(0,0) → green(200,200), aim on the
    // line at (115,115), a bunker centered ON that line. The axis-aligned holes
    // above happen to hide the frame-mixing bug this module once had (route- vs
    // path-chainage) and the left/right sign convention, because "left" collapses
    // onto −x and chainage onto +y. On a rotated hole neither shortcut holds, so
    // this is the real guard for: hazardChain measured on the ROUTE and the
    // cross-sign giving the correct side FROM THE GOLFER'S PERSPECTIVE (facing NE,
    // left = NW, right = SE).
    const ROOT2 = Math.SQRT2;
    function neHole(): VariantHoleContext {
        const bunker = hazard('bunker', 'mid', 105, 105, 125, 125); // centroid (115,115), on the route
        return {
            tee: { x: 0, y: 0 },
            greenCenter: { x: 200, y: 200 },
            aimPoints: [{ x: 115, y: 115 }],
            surfaces: [bunker, box('fairway', -100, -100, 300, 300)],
            hazards: [bunker],
            clubs: BAG,
        };
    }
    // Route chainage along the NE hole = projection onto the (1,1)/√2 tangent.
    const neChainage = (x: number, y: number) => (x + y) / ROOT2;
    function neNode(x: number, y: number) {
        return { id: `n${Math.round(x)}_${Math.round(y)}`, point: { x, y }, chainage: neChainage(x, y), kind: 'aim' as const };
    }

    const ctx = neHole();
    const tee = { id: 'tee', point: { x: 0, y: 0 }, chainage: 0, kind: 'tee' as const };
    const green = { id: 'green', point: ctx.greenCenter, chainage: neChainage(200, 200), kind: 'green' as const };

    // NW of the line (golfer's LEFT) vs SE of the line (golfer's RIGHT), both at
    // the bunker's chainage — a purely lateral ±30 m offset off (115,115).
    const off = 30 / ROOT2; // component along each axis for a 30 m lateral step
    const leftLand = neNode(115 - off, 115 + off);   // (93.8, 136.2)
    const rightLand = neNode(115 + off, 115 - off);  // (136.2, 93.8)

    test('golfer-LEFT (NW) and golfer-RIGHT (SE) come out correct and DISTINCT', () => {
        const left = computeSignature([tee, leftLand, green], ctx);
        const right = computeSignature([tee, rightLand, green], ctx);
        expect(left.hazards).toEqual([{ hazardId: 'mid', relation: 'passed-left' }]);
        expect(right.hazards).toEqual([{ hazardId: 'mid', relation: 'passed-right' }]);
        expect(left.key).not.toBe(right.key);
    });

    test('jiggled same-side (NW) lines still DEDUPE on the rotated hole', () => {
        const a = computeSignature([tee, leftLand, green], ctx);
        const b = computeSignature([tee, neNode(90, 140), green], ctx); // also NW of the line
        expect(b.hazards).toEqual([{ hazardId: 'mid', relation: 'passed-left' }]);
        expect(a.key).toBe(b.key);
    });
});

describe('discoverVariants — the reference hole yields distinct lines', () => {
    test('left/right of the fairway bunker surface as separate variants', () => {
        const variants = discoverVariants(refHole());
        const keys = new Set(variants.map((v) => v.signature.key));
        // At least two genuinely different signatures (not ten near-identical).
        expect(keys.size).toBe(variants.length);
        expect(variants.length).toBeGreaterThanOrEqual(2);
    });
});
