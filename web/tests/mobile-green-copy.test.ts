import { describe, expect, test } from 'bun:test';
import type { Vec2 } from '../../shared/strategy';
import type { PuttReadDisplay, PuttReadStatus } from '../src/planner/putt-read.service';
import {
    TAP_IN_AIM,
    TAP_IN_NOTE,
    confidenceText,
    greenMessage,
    isTapIn,
    readAimText,
    readNoteText,
    readPaceText,
} from '../src/mobile/green/green-copy';
import { seedBallFromFix, type BallSeedPort } from '../src/mobile/green/ball-seed';

function display(over: Partial<PuttReadDisplay> & { status: PuttReadStatus }): PuttReadDisplay {
    return {
        message: null,
        read: null,
        tour: null,
        verbal: null,
        groundTruth: null,
        confidence: null,
        ...over,
    };
}

const VERBAL = { aim: 'Aim one cup right', pace: 'Firm — plays 4.2 m', combined: 'x' };

describe('green screen copy', () => {
    test('a settled read shows the verbal aim and pace lines', () => {
        const d = display({ status: 'ok', verbal: VERBAL });
        expect(isTapIn(d)).toBe(false);
        expect(readAimText(d)).toBe(VERBAL.aim);
        expect(readPaceText(d)).toBe(VERBAL.pace);
        expect(readNoteText(d)).toBe('');
    });

    test('a zero-length putt reads as a tap-in instead of three blank lines', () => {
        // Ball on the hole: the engine derives no read (no distance, grade or
        // break) yet the status stays `ok` with a null verbal.
        const d = display({ status: 'ok', verbal: null });
        expect(isTapIn(d)).toBe(true);
        expect(readAimText(d)).toBe(TAP_IN_AIM);
        expect(readPaceText(d)).toBe('');
        expect(readNoteText(d)).toBe(TAP_IN_NOTE);
    });

    test('a softened read keeps its own message over the tap-in note', () => {
        const d = display({ status: 'soft', message: 'Low-confidence surface', verbal: VERBAL });
        expect(readNoteText(d)).toBe('Low-confidence surface');
    });

    test('withheld and placing states show no read lines', () => {
        for (const status of ['unavailable', 'place', 'no-surface', 'inactive'] as const) {
            const d = display({ status });
            expect(isTapIn(d)).toBe(false);
            expect(readAimText(d)).toBe('');
            expect(readPaceText(d)).toBe('');
        }
        expect(readNoteText(display({ status: 'pending' }))).toBe('Reading…');
    });

    test('confidence line softens its wording below the read threshold', () => {
        const row = { greenId: 'g', sampleCount: 4, source: 'scans' as const };
        expect(confidenceText(display({ status: 'ok' }))).toBe('');
        expect(confidenceText(display({ status: 'ok', confidence: { ...row, confidence: 0.82 } })))
            .toBe('Green data 82%');
        expect(confidenceText(display({ status: 'soft', confidence: { ...row, confidence: 0.31 } })))
            .toBe('Green data 31% — rough read');
    });
});

describe('green screen banner', () => {
    const base = {
        tileError: null,
        tilesLoading: false,
        holesLoaded: true,
        holeExists: true,
        holeNumber: 7,
        hasGreen: true,
    };

    test('nothing to say when the hole and its green are there', () => {
        expect(greenMessage(base)).toBeNull();
    });

    test('tile errors and loading win over everything else', () => {
        expect(greenMessage({ ...base, tileError: 'offline' })).toContain('offline');
        expect(greenMessage({ ...base, tilesLoading: true })).toBe('Loading course…');
        expect(greenMessage({ ...base, holesLoaded: false })).toBeNull();
    });

    test('a hole that is not on the course says so — not "no green drawn"', () => {
        const msg = greenMessage({ ...base, holeExists: false, holeNumber: 42, hasGreen: false });
        expect(msg).toBe('Hole 42 is not on this course.');
        expect(msg).not.toContain('green');
    });

    test('a real hole without a green polygon says the green is missing', () => {
        expect(greenMessage({ ...base, hasGreen: false }))
            .toBe('This hole has no green drawn yet — nothing to read.');
    });
});

describe('seeding the ball from the GPS fix', () => {
    function fakePutt(init: { ball?: Vec2; hole?: Vec2; placing?: 'ball' | 'hole' | 'none' } = {}) {
        const state = {
            ball: init.ball ?? null,
            hole: init.hole ?? null,
            placing: init.placing ?? ('ball' as 'ball' | 'hole' | 'none'),
        };
        const port: BallSeedPort = {
            ball: { peek: () => state.ball },
            hole: { peek: () => state.hole },
            placing: { peek: () => state.placing },
            placeBall: p => { state.ball = p; },
            setPlacing: which => { state.placing = which; },
        };
        return { state, port };
    }

    const FIX = { x: 500_000, y: 6_480_000 };

    test('seeds the ball and hands the next tap to the hole', () => {
        const { state, port } = fakePutt();
        expect(seedBallFromFix(port, FIX)).toBe(true);
        expect(state.ball).toEqual(FIX);
        expect(state.hole).toBeNull();
        expect(state.placing).toBe('hole');
    });

    test('a hole placed FIRST is never moved by the fix', () => {
        // The regression: `placeNext` would place whatever `placing` selects,
        // so a player who dropped the cup while still in hole mode had it
        // yanked to their own feet by the first in-green fix.
        const cup = { x: 500_010, y: 6_480_020 };
        const { state, port } = fakePutt({ hole: cup, placing: 'hole' });
        expect(seedBallFromFix(port, FIX)).toBe(true);
        expect(state.hole).toEqual(cup);
        expect(state.ball).toEqual(FIX);
        expect(state.placing).toBe('hole'); // selector left alone
    });

    test('seeding with the hole already down disarms placement', () => {
        const cup = { x: 500_010, y: 6_480_020 };
        const { state, port } = fakePutt({ hole: cup, placing: 'ball' });
        expect(seedBallFromFix(port, FIX)).toBe(true);
        expect(state.ball).toEqual(FIX);
        expect(state.placing).toBe('none'); // one-shot consumed, taps now probe
    });

    test('never overwrites a ball the player already placed', () => {
        const ball = { x: 500_005, y: 6_480_005 };
        const { state, port } = fakePutt({ ball, placing: 'hole' });
        expect(seedBallFromFix(port, FIX)).toBe(false);
        expect(state.ball).toEqual(ball);
        expect(state.placing).toBe('hole');
    });
});
