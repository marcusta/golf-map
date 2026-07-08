// On-map label descriptors for the putt read (feature-putting-green-reading
// §5.1). Pure — EPSG:3006 points + text only, no maplibre/transform — so the
// planner tool can place them as DOM markers (the editor map style has no
// glyphs endpoint, so symbol text layers cannot render text; DOM markers are
// the house pattern, see analysis-overlay slope labels). Testable under bun.

import { bearingToUnitVector, type PuttRead, type Vec2 } from '../../../shared/strategy';

export interface PuttLabel {
    /** Anchor point, EPSG:3006 meters. */
    point: Vec2;
    text: string;
    kind: 'dist' | 'aim' | 'slope';
}

/** Signed aim offset (m, + = right of the hole) → "45 cm left" / "straight". */
export function formatAimOffset(aimOffsetM: number): string {
    const cm = Math.round(Math.abs(aimOffsetM) * 100);
    if (cm === 0) return 'straight';
    return `${cm} cm ${aimOffsetM > 0 ? 'right' : 'left'}`;
}

export interface PuttLabelInput {
    ball: Vec2 | null;
    hole: Vec2 | null;
    /** The settled read (null mid-drag / before both points) — gates the
     *  plays-like + aim labels; the distance label shows from geometry alone. */
    read: PuttRead | null;
    /** Cross-slope readings along the line (PuttReadService.pathSlopeSamples). */
    slopeSamples: readonly { point: Vec2; crossSlopePct: number }[];
}

/**
 * Labels drawn on the green graphics: the putt distance + plays-like at the
 * line midpoint, the aim amount at the aim point, and a cross-slope % at each
 * sampled station. These live ON the graphics (where every other distance in
 * the app is), not just the sidebar.
 */
export function puttLabelDescriptors(input: PuttLabelInput): PuttLabel[] {
    const { ball, hole, read, slopeSamples } = input;
    const out: PuttLabel[] = [];

    if (ball && hole) {
        const dx = hole.x - ball.x;
        const dy = hole.y - ball.y;
        const distM = Math.hypot(dx, dy);
        const plays = read ? ` · plays ${read.playsLikeM.toFixed(1)} m` : '';
        out.push({
            point: { x: ball.x + dx * 0.5, y: ball.y + dy * 0.5 },
            text: `${distM.toFixed(1)} m${plays}`,
            kind: 'dist',
        });
        if (read) {
            // Aim label at the aim point: the start bearing carried to the
            // hole's range, offset to the side by aimOffsetM.
            const dir = bearingToUnitVector(read.aimBearingDeg);
            out.push({
                point: { x: ball.x + dir.x * distM, y: ball.y + dir.y * distM },
                text: `aim ${formatAimOffset(read.aimOffsetM)}`,
                kind: 'aim',
            });
        }
    }

    for (const s of slopeSamples) {
        const side = Math.abs(s.crossSlopePct) < 0.05
            ? ''
            : s.crossSlopePct > 0 ? ' →' : ' ←';
        out.push({
            point: s.point,
            text: `${Math.abs(s.crossSlopePct).toFixed(1)}%${side}`,
            kind: 'slope',
        });
    }

    return out;
}
