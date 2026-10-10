import { describe, expect, test } from 'bun:test';
import { fitTransition, transitionPreview, markerTransition, transitionGap } from '../src/draw/path-transitions-panel';
import { pathTransitionDefaults, pathTransitionsError, transitionRange } from '../../shared/features/path-transitions';

describe('transition placement bounds', () => {
    test('start-end marker drags preserve the actual reversed direction and fixed start anchor', () => {
        const t = {...pathTransitionDefaults('wheel-tracks'), id: 'a', placement: 'start' as const};
        const r = transitionRange(t, 50);
        const movedStart = markerTransition(t, 50, 0, 25);
        expect(movedStart.direction).toBe(-1);
        expect(movedStart.startM).toBe(25);
        const established = markerTransition(t, 50, 1, r.startM - 4);
        expect(established.startM).toBe(r.startM);
        expect(established.transitionLengthM).toBe(4);
        const end = markerTransition(t, 50, 2, 2);
        expect(end.startM).toBe(r.startM);
        expect(transitionRange(end, 50).endM).toBe(2);
    });
    const line = { points: [{x: 0, y: 0}, {x: 10, y: 0}], widthM: 1 };
    test('short narrow paths accept a fitted default with its dimensions inside the path', () => {
        const t = fitTransition({...pathTransitionDefaults('wheel-tracks'), id: 'a'}, 10, 1);
        expect(pathTransitionsError([t], line, 'path', 'gravel')).toBeNull();
        expect(transitionRange(t, 10).endM).toBe(10);
    });
    test('section drags at either endpoint leave a positive on-path transition', () => {
        for (const direction of [1, -1] as const) {
            const t = fitTransition({...pathTransitionDefaults('soft-fade'), id: 'a', placement: 'section', direction, startM: direction === 1 ? 100 : -100}, 10, 1);
            expect(pathTransitionsError([t], line, 'path', 'dirt')).toBeNull();
        }
    });
    test('hold and final fade shrink after an enlarged transition without moving its section start', () => {
        const t = fitTransition({...pathTransitionDefaults('overgrown-gravel'), id: 'a', placement: 'section', startM: 2, transitionLengthM: 6, holdLengthM: 6, fadeLengthM: 4}, 10, 1);
        expect(t.startM).toBe(2);
        expect(t.holdLengthM).toBe(2);
        expect(t.fadeLengthM).toBe(0);
        expect(pathTransitionsError([t], line, 'path', 'gravel')).toBeNull();
    });
    test('wheel tracks produce stable curved three-material preview and continue reaches farther than fade', () => {
        const curved = {points: [{x: 530000, y: 6470000}, {x: 530020, y: 6470020}, {x: 530040, y: 6470000}], widthM: 4};
        const t = {...pathTransitionDefaults('wheel-tracks'), id: 'a', placement: 'section' as const, startM: 2};
        const preview = transitionPreview(curved, t);
        expect(transitionPreview(curved, t)).toEqual(preview);
        expect(new Set(preview.features.map(f => f.properties?.color)).size).toBe(3);
        expect(transitionPreview(curved, {...t, ending: 'continue'}).features.length).toBeGreaterThan(preview.features.length);
    });
    test('free section excludes the full grass tail and the longitudinal tongue', () => {
        const t = {...pathTransitionDefaults('wheel-tracks'), id: 'a', placement:'section' as const, startM:30, centerGrassReachM:5};
        expect(transitionGap([t],100)).toEqual([0,25]);
        const opposing = {...t,id:'b',startM:25,direction:-1 as const,centerGrassReachM:0};
        expect(transitionGap([t,opposing],100)).toBeUndefined();
    });
});
