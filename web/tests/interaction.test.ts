import { test, expect } from 'bun:test';
import { effect } from '@basics/core/client/core';
import { InteractionClaims } from '../src/map/interaction';

test('claim sets the mode; release clears it', () => {
    const claims = new InteractionClaims();
    expect(claims.mode.get()).toBeNull();

    const release = claims.claim('measure');
    expect(claims.mode.get()).toBe('measure');

    release();
    expect(claims.mode.get()).toBeNull();
});

test('last claim wins — a new claim displaces the previous holder', () => {
    const claims = new InteractionClaims();
    claims.claim('measure');
    claims.claim('draw');
    expect(claims.mode.get()).toBe('draw');
});

test('a stale release (after being displaced) is a no-op', () => {
    const claims = new InteractionClaims();
    const releaseMeasure = claims.claim('measure');
    claims.claim('draw');

    releaseMeasure(); // measure was displaced — must NOT clear draw's claim
    expect(claims.mode.get()).toBe('draw');
});

test('release is idempotent', () => {
    const claims = new InteractionClaims();
    const releaseA = claims.claim('a');
    releaseA();
    const releaseB = claims.claim('b');
    releaseA(); // second stale release of a — still a no-op
    expect(claims.mode.get()).toBe('b');
    releaseB();
    releaseB();
    expect(claims.mode.get()).toBeNull();
});

test('re-claiming after release works and the displaced tool can observe the signal', () => {
    const claims = new InteractionClaims();
    const seen: Array<string | null> = [];
    const dispose = effect(() => seen.push(claims.mode.get()));

    const releaseA = claims.claim('a');
    claims.claim('b'); // displaces a — a's effect sees 'b' and can deactivate
    releaseA(); // stale
    expect(seen).toEqual([null, 'a', 'b']);

    dispose();
});
