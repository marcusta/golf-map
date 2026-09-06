import { describe, expect, test } from 'bun:test';
import { SPECIES, VARIANTS } from '../src/map/tree-geometry';
import {
    LADDER_HEIGHTS_M, LINEUP_HEIGHT_M, lineupEntries, sceneStems, SHRUB_COUNT, STAND_COUNT, STAND_HEIGHTS_M,
} from '../src/vegetation/vegetation-stems';
import { defaultState, orbitEye, presetState, CAMERA_PRESETS_M, LINEUP_TARGET, SUN_PRESETS } from '../src/vegetation/vegetation-scene';
import { SUN_AZIMUTH_DEG, SUN_ELEVATION_DEG } from '../src/map/tree-material';

describe('vegetation scene layout', () => {
    const stems = sceneStems();
    const group = (name: string) => stems.filter(stem => stem.group === name);

    test('lineup holds every species and variant at one height plus a shrub', () => {
        const lineup = group('lineup');
        expect(lineup.length).toBe(SPECIES.length * VARIANTS + 1);
        expect(lineupEntries().map(entry => entry.label)).toContain('shrub');
        for (const species of SPECIES) for (let variant = 0; variant < VARIANTS; variant++) {
            const stem = lineup.find(s => s.species === SPECIES.indexOf(species) && s.variant === variant && !s.shrub);
            expect(stem?.height).toBe(LINEUP_HEIGHT_M);
        }
        expect(lineup.filter(stem => stem.shrub).length).toBe(1);
        // Lineup stems sit far enough apart that the stand adjustment leaves them alone.
        expect(lineup.every(stem => stem.baseRaise === 0)).toBe(true);
    });

    test('ladder shows one broadleaf and one spruce at each height, never as a shrub', () => {
        const ladder = group('ladder');
        expect(ladder.length).toBe(LADDER_HEIGHTS_M.length * 2);
        expect(ladder.every(stem => !stem.shrub)).toBe(true);
        expect(new Set(ladder.map(stem => stem.height))).toEqual(new Set(LADDER_HEIGHTS_M));
        expect(new Set(ladder.map(stem => SPECIES[stem.species]))).toEqual(new Set(['broadleaf', 'spruce']));
    });

    test('stand has 200 mixed stems in the height range with the neighbour adjustment applied', () => {
        const stand = group('stand');
        expect(stand.length).toBe(STAND_COUNT);
        expect(stand.every(stem => stem.height >= STAND_HEIGHTS_M[0] && stem.height <= STAND_HEIGHTS_M[1])).toBe(true);
        expect(new Set(stand.map(stem => stem.species)).size).toBe(3);
        expect(stand.some(stem => stem.baseRaise > 0)).toBe(true);
        expect(stand.every(stem => Number.isFinite(stem.nearestM))).toBe(true);
    });

    test('30 shrubs render as shrubs', () => {
        const shrubs = group('shrubs');
        expect(shrubs.length).toBe(SHRUB_COUNT);
        expect(shrubs.every(stem => stem.shrub)).toBe(true);
    });

    test('layout is deterministic across calls', () => {
        expect(sceneStems().map(stem => [stem.x, stem.y, stem.height])).toEqual(stems.map(stem => [stem.x, stem.y, stem.height]));
    });
});

describe('vegetation scene camera and sun', () => {
    test('presets put the eye at the requested distance from the lineup', () => {
        for (const distance of CAMERA_PRESETS_M) {
            const state = presetState(defaultState(), distance);
            expect(orbitEye(state).distanceTo(LINEUP_TARGET)).toBeCloseTo(distance, 3);
        }
    });
    test('yaw 0 looks north from south of the target, above the ground', () => {
        const eye = orbitEye({ ...defaultState(), yawDeg: 0, pitchDeg: 10, distanceM: 40 });
        expect(eye.y).toBeLessThan(0);
        expect(eye.z).toBeGreaterThan(0.5);
    });
    test('the first sun preset is the ortho-matched layer default', () => {
        expect(SUN_PRESETS[0]).toMatchObject({ azimuthDeg: SUN_AZIMUTH_DEG, elevationDeg: SUN_ELEVATION_DEG });
        expect(defaultState()).toMatchObject({ sunAzimuthDeg: SUN_AZIMUTH_DEG, sunElevationDeg: SUN_ELEVATION_DEG, lod: 'auto' });
    });
});
