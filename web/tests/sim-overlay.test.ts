// Pure overlay builders for the hole simulator (feature-hole-sim-and-variants
// §5 / V7): the landing-scatter subsample + GeoJSON, and the suggest-lines
// signature labels / ghost geometry.

import { test, expect, describe } from 'bun:test';
import type { ScoredVariant, VariantSignature } from '../../shared/strategy';
import {
    SCATTER_BEFORE_LAYER_ID,
    SCATTER_DEPTH_COLORS,
    SCATTER_MAX_PER_LEG,
    buildScatterGeojson,
    buildVariantGeojson,
    disambiguateVariantLabels,
    engagementPhrase,
    pluralKind,
    scatterLayers,
    subsample,
    variantBranchId,
    variantChipText,
    variantLayers,
    variantSignatureLabel,
    type GhostVariant,
} from '../src/planner/sim-overlay';

describe('subsample', () => {
    test('keeps everything below the cap, and keeps the count at the cap above it', () => {
        expect(subsample([1, 2, 3], 10)).toEqual([1, 2, 3]);
        expect(subsample(Array.from({ length: 1000 }, (_, i) => i), 200)).toHaveLength(200);
        expect(subsample([1, 2, 3], 0)).toEqual([]);
        expect(subsample([], 10)).toEqual([]);
    });

    test('is deterministic and spread across the input, not a prefix', () => {
        const input = Array.from({ length: 1000 }, (_, i) => i);
        const a = subsample(input, 5);
        expect(a).toEqual(subsample(input, 5)); // reproducible-by-seed, like the engine
        expect(a[0]).toBe(0);
        expect(a[4]).toBeGreaterThan(700); // a stride, so the tail is represented
    });

    test('the §5 cap is ~200 per leg', () => {
        expect(SCATTER_MAX_PER_LEG).toBe(200);
    });
});

describe('buildScatterGeojson', () => {
    test('one WGS84 point per sample, carrying its lie class and leg depth', () => {
        const fc = buildScatterGeojson([
            { depth: 0, lie: 'fairway', point: { x: 500000, y: 6468000 } },
            { depth: 1, lie: 'sand', point: { x: 500050, y: 6468100 } },
        ]);
        expect(fc.features).toHaveLength(2);
        expect(fc.features[0].properties).toEqual({ lie: 'fairway', depth: 0 });
        const [lon, lat] = (fc.features[0].geometry as { coordinates: number[] }).coordinates;
        expect(lat).toBeGreaterThan(55);
        expect(lat).toBeLessThan(70);
        expect(lon).toBeGreaterThan(10);
        expect(lon).toBeLessThan(25);
    });

    test('empty input is a valid empty collection (the overlay draws nothing)', () => {
        expect(buildScatterGeojson([])).toEqual({ type: 'FeatureCollection', features: [] });
    });

    test('the dot layer colours by LEG DEPTH by default — lie colours vanish into the course', () => {
        const layers = scatterLayers();
        expect(layers).toHaveLength(1);
        const paint = layers[0].paint as Record<string, unknown>;
        const color = paint['circle-color'] as unknown as unknown[];
        expect(color[0]).toBe('match');
        expect(color[1]).toEqual(['get', 'depth']);
        expect(color).toContain(SCATTER_DEPTH_COLORS[0]);
        // Legible over fairway/green/sand: opaque enough, with a dark outline.
        expect(paint['circle-opacity'] as number).toBeGreaterThan(0.8);
        expect(paint['circle-stroke-width'] as number).toBeGreaterThan(0.5);
    });

    test('lie colouring stays available as an explicit mode', () => {
        const paint = scatterLayers({ colorBy: 'lie' })[0].paint as Record<string, unknown>;
        const color = paint['circle-color'] as unknown as unknown[];
        expect(color[1]).toEqual(['get', 'lie']);
        expect(color).toContain('fairway');
        expect(color).toContain('sand');
    });

    test('slots above the vector feature fills, below the plan overlay', () => {
        // Under `features-fill` the translucent fills washed the cloud out.
        expect(SCATTER_BEFORE_LAYER_ID).toBe('plan-ellipse-fill');
    });
});

describe('variantSignatureLabel', () => {
    const kinds = new Map([['h1', 'bunker'], ['h2', 'water'], ['h3', 'bunker']]);

    function signature(
        hazards: VariantSignature['hazards'],
        shotCount = 2,
    ): VariantSignature {
        return { shotCount, hazards, key: hazards.map(h => `${h.hazardId}:${h.relation}`).join('|') };
    }

    test('reads as the label V7 prefills onto an accepted branch', () => {
        expect(variantSignatureLabel(
            signature([{ hazardId: 'h1', relation: 'passed-left' }]), kinds))
            .toBe('left of the bunkers · 2 shots');
    });

    test('carry and lay-up relations get their own phrasing', () => {
        expect(engagementPhrase({ hazardId: 'h2', relation: 'carried' }, kinds))
            .toBe('over the water');
        expect(engagementPhrase({ hazardId: 'h2', relation: 'short-of' }, kinds))
            .toBe('short of the water');
        expect(engagementPhrase({ hazardId: 'h1', relation: 'passed-right' }, kinds))
            .toBe('right of the bunkers');
    });

    test('an unknown hazard id degrades to "hazard" instead of leaking an id', () => {
        expect(engagementPhrase({ hazardId: 'nope', relation: 'carried' }, kinds))
            .toBe('over the hazard');
    });

    test('a variant that engages nothing is simply the direct line', () => {
        expect(variantSignatureLabel(signature([], 3), kinds)).toBe('direct line · 3 shots');
        expect(variantSignatureLabel(signature([], 1), kinds)).toBe('direct line · 1 shot');
    });

    test('stays a name, not a sentence: deduped phrases, at most two', () => {
        const label = variantSignatureLabel(signature([
            { hazardId: 'h1', relation: 'passed-left' },
            { hazardId: 'h3', relation: 'passed-left' }, // same phrase — deduped
            { hazardId: 'h2', relation: 'carried' },
            { hazardId: 'h2', relation: 'short-of' }, // beyond the cap — dropped
        ]), kinds);
        expect(label).toBe('left of the bunkers · over the water · 2 shots');
    });

    test('pluralKind leaves mass nouns and already-plural kinds alone', () => {
        expect(pluralKind('bunker')).toBe('bunkers');
        expect(pluralKind('water')).toBe('water');
        expect(pluralKind('trees')).toBe('trees');
        expect(pluralKind('deep_rough')).toBe('deep rough');
    });
});

describe('buildVariantGeojson', () => {
    const CLUB = { name: '3w', carryM: 200, dispersionM: 30 };

    function ghost(id: string, expectedStrokes = 4.2, withLegs = false): GhostVariant {
        const variant = {
            nodes: [
                { id: 'tee', point: { x: 500000, y: 6468000 }, chainage: 0, kind: 'tee' },
                { id: 'a', point: { x: 500000, y: 6468200 }, chainage: 200, kind: 'aim' },
                { id: 'g', point: { x: 500000, y: 6468400 }, chainage: 400, kind: 'green' },
            ],
            legs: withLegs
                ? [
                    {
                        origin: { x: 500000, y: 6468000 },
                        landing: { x: 500000, y: 6468200 },
                        club: CLUB,
                    },
                    {
                        origin: { x: 500000, y: 6468200 },
                        landing: { x: 500000, y: 6468400 },
                        club: null,
                    },
                ]
                : [],
            score: { expectedStrokes, penaltyProb: 0.12, worstCaseStrokes: 6, legs: [] },
            signature: { shotCount: 2, hazards: [], key: id },
        } as unknown as ScoredVariant;
        return { id, label: `line ${id}`, variant };
    }

    test('one line plus one label point per ghost, label anchored at the first LANDING', () => {
        const fc = buildVariantGeojson([ghost('v1')]);
        expect(fc.features).toHaveLength(2);
        expect(fc.features[0].geometry.type).toBe('LineString');
        expect(fc.features[1].geometry.type).toBe('Point');
        const line = fc.features[0].geometry as { coordinates: number[][] };
        const label = fc.features[1].geometry as { coordinates: number[] };
        // Not the tee: several variants fanning out of one tee would otherwise
        // stack every label on the same pixel.
        expect(label.coordinates).toEqual(line.coordinates[1]);
        expect(fc.features[0].properties).toMatchObject({ variantId: 'v1', label: 'line v1', hovered: false });
    });

    test('hover marks exactly the hovered ghost (paint-only, no geometry change)', () => {
        const fc = buildVariantGeojson([ghost('v1'), ghost('v2')], { hoveredId: 'v2' });
        const hovered = fc.features.filter(f => f.properties?.hovered === true);
        expect(hovered).toHaveLength(2); // the line + its label
        expect(hovered.every(f => f.properties?.variantId === 'v2')).toBe(true);
    });

    test('chips speak the option-chip vocabulary', () => {
        expect(variantChipText(ghost('v1', 4.23))).toBe('prob. 4.2 · 12% pen');
    });

    test('ghosts render dashed and dimmed, brightening on hover OR selection', () => {
        const line = variantLayers().find(l => l.id === 'plan-variants-line')!;
        const paint = line.paint as Record<string, unknown>;
        expect(paint['line-dasharray']).toEqual([2, 2]);
        // Hover and selection share one emphasis state — the map never shows
        // two competing "this one" treatments.
        const emphasised = ['any', ['get', 'hovered'], ['get', 'selected']];
        // Idle ghosts stay readable over the ortho — dimmer than the
        // emphasised one, never invisible.
        expect(paint['line-opacity']).toEqual(['case', emphasised, 0.95, 0.7]);
    });

    test('selection marks the pinned ghost, and survives hover moving elsewhere', () => {
        const fc = buildVariantGeojson([ghost('v1'), ghost('v2')],
            { hoveredId: 'v1', selectedId: 'v2' });
        const selected = fc.features.filter(f => f.properties?.selected === true);
        expect(selected).toHaveLength(2); // the line + its label
        expect(selected.every(f => f.properties?.variantId === 'v2')).toBe(true);
        expect(fc.features.filter(f => f.properties?.hovered === true)
            .every(f => f.properties?.variantId === 'v1')).toBe(true);
    });

    test('the SELECTED ghost gets a dispersion ellipse per clubbed leg + leg labels', () => {
        const fc = buildVariantGeojson([ghost('v1', 4.2, true)], { selectedId: 'v1' });
        const ellipses = fc.features.filter(f => f.properties?.role === 'ellipse');
        const legLabels = fc.features.filter(f => f.properties?.role === 'leg-label');
        // Two legs, one clubbed: an ellipse needs a club, a distance label does not.
        expect(ellipses).toHaveLength(1);
        expect(ellipses[0].geometry.type).toBe('Polygon');
        expect(legLabels).toHaveLength(2);
        expect(legLabels[0].properties?.legText).toBe('200 m · 3w');
        expect(legLabels[1].properties?.legText).toBe('200 m');
    });

    test('an UNSELECTED ghost stays a bare line + label — no ellipse clutter', () => {
        const fc = buildVariantGeojson([ghost('v1', 4.2, true)]);
        expect(fc.features.map(f => f.properties?.role)).toEqual(['line', 'label']);
    });

    test('only the emphasised ghost names itself on the map', () => {
        const label = variantLayers().find(l => l.id === 'plan-variants-label') as
            unknown as { filter: unknown };
        expect(label.filter).toEqual(['all',
            ['==', ['get', 'role'], 'label'],
            ['any', ['get', 'hovered'], ['get', 'selected']],
        ] as never);
    });

    test('a ghost branch id can never collide with a plan shot id', () => {
        expect(variantBranchId('2|h1:passed-left')).toBe('variant:2|h1:passed-left');
    });
});

describe('disambiguateVariantLabels', () => {
    function ghost(id: string, label: string, teeDistanceM: number, club?: string): GhostVariant {
        return {
            id,
            label,
            variant: {
                nodes: [],
                legs: [{
                    origin: { x: 500000, y: 6468000 },
                    landing: { x: 500000, y: 6468000 + teeDistanceM },
                    ...(club ? { club: { name: club, carryM: teeDistanceM, dispersionM: 30 } } : {}),
                }],
                score: { expectedStrokes: 4, penaltyProb: 0, worstCaseStrokes: 5, legs: [] },
                signature: { shotCount: 2, hazards: [], key: id },
            } as unknown as GhostVariant['variant'],
        };
    }

    test('collisions get their tee leg appended; unique labels are untouched', () => {
        const out = disambiguateVariantLabels([
            ghost('a', 'right of the bunkers · 2 shots', 245, '3w'),
            ghost('b', 'right of the bunkers · 2 shots', 210),
            ghost('c', 'over the water · 2 shots', 230, 'dr'),
        ]);
        expect(out[0].label).toBe('right of the bunkers · 2 shots · 245 m 3w off the tee');
        expect(out[1].label).toBe('right of the bunkers · 2 shots · 210 m off the tee');
        expect(out[2].label).toBe('over the water · 2 shots'); // already unique
    });
});
