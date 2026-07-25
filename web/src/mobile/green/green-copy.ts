// The green screen's words: the read lines, the guidance note, the confidence
// line and the top-of-screen message. Pure functions over the shared
// PuttReadDisplay so the phrasing is unit-testable without a map.

import { MIN_READ_CONFIDENCE, type PuttReadDisplay } from '../../planner/putt-read.service';

/** Shown in place of an aim line when there is nothing left to read. */
export const TAP_IN_AIM = 'Tap-in';
export const TAP_IN_NOTE = 'Ball is at the hole — nothing to read.';

/**
 * Ball and hole in the same spot. The engine cannot derive a read from a
 * zero-length putt (no distance, no grade, no break — `deriveTourReadGroundTruth`
 * returns null), so the status stays `ok` while the verbal read is null and the
 * panel would show three blank lines. Say "tap-in" instead.
 */
export function isTapIn(d: PuttReadDisplay): boolean {
    return (d.status === 'ok' || d.status === 'soft') && d.verbal === null;
}

export function readAimText(d: PuttReadDisplay): string {
    if (d.verbal) return d.verbal.aim;
    return isTapIn(d) ? TAP_IN_AIM : '';
}

export function readPaceText(d: PuttReadDisplay): string {
    return d.verbal?.pace ?? '';
}

/** The guidance/withhold line straight from the shared display model. */
export function readNoteText(d: PuttReadDisplay): string {
    if (d.message) return d.message;
    if (isTapIn(d)) return TAP_IN_NOTE;
    if (d.status === 'pending') return 'Reading…';
    return '';
}

export function confidenceText(d: PuttReadDisplay): string {
    const c = d.confidence;
    if (!c) return '';
    const pct = Math.round(c.confidence * 100);
    return c.confidence < MIN_READ_CONFIDENCE
        ? `Green data ${pct}% — rough read`
        : `Green data ${pct}%`;
}

export interface GreenMessageState {
    /** Tile-manifest load error message, if any. */
    tileError: string | null;
    tilesLoading: boolean;
    /** The course detail request has landed (holes are known). */
    holesLoaded: boolean;
    /** A hole with this number exists on the course. */
    holeExists: boolean;
    holeNumber: number;
    /** A green polygon was found for it (a PuttContext could be built). */
    hasGreen: boolean;
}

/** The banner across the top of the green screen, or null when all is well. */
export function greenMessage(s: GreenMessageState): string | null {
    if (s.tileError) return `Could not load tiles — ${s.tileError}`;
    if (s.tilesLoading) return 'Loading course…';
    if (!s.holesLoaded) return null;
    // A bad hole number in the URL is NOT "no green drawn" — say so plainly.
    if (!s.holeExists) return `Hole ${s.holeNumber} is not on this course.`;
    if (!s.hasGreen) return 'This hole has no green drawn yet — nothing to read.';
    return null;
}
