// Pure overlay builders for the hole simulator (feature-hole-sim-and-variants
// §5 / V7): the landing-scatter subsample + GeoJSON, and the suggest-lines
// signature labels / ghost geometry.

import { test, expect, describe } from 'bun:test';
import type { ScoredVariant, VariantSignature } from '../../shared/strategy';
import {
    SCATTER_MAX_PER_LEG,
    buildScatterGeojson,
    buildVariantGeojson,
    engagementPhrase,
    pluralKind,
    scatterLayers,
    subsample,
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

    test('the dot layer colours by lie and stays translucent', () => {
        const layers = scatterLayers();
        expect(layers).toHaveLength(1);
        const paint = layers[0].paint as Record<string, unknown>;
        const color = paint['circle-color'] as unknown as unknown[];
        expect(color[0]).toBe('match');
        expect(color).toContain('fairway');
        expect(color).toContain('sand');
        expect(paint['circle-opacity']).toBeLessThan(1);
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
    function ghost(id: string, expectedStrokes = 4.2): GhostVariant {
        const variant = {
            nodes: [
                { id: 'tee', point: { x: 500000, y: 6468000 }, chainage: 0, kind: 'tee' },
                { id: 'a', point: { x: 500000, y: 6468200 }, chainage: 200, kind: 'aim' },
                { id: 'g', point: { x: 500000, y: 6468400 }, chainage: 400, kind: 'green' },
            ],
            legs: [],
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

    test('ghosts render dashed and dimmed, brightening on hover', () => {
        const line = variantLayers().find(l => l.id.endsWith('-line'))!;
        const paint = line.paint as Record<string, unknown>;
        expect(paint['line-dasharray']).toEqual([2, 2]);
        expect(paint['line-opacity']).toEqual(['case', ['get', 'hovered'], 0.9, 0.45]);
    });
});
