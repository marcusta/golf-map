// Filtering for the Photos sub-mode (docs/feature-reference-photos.md §7):
// which of a site's reference photos the catalog and the map show. Pure — the
// PhotosService holds the state, this decides membership and order.
//
// Distances are planar SWEREF 99 TM metres: photos carry `x3006`/`y3006` from
// the server, hole play lines are projected once when they are built.

import type { Photo } from '../../../shared/api/photos.gen';
import { lngLatToSweref99tm } from '../geo/transform';

export type { Photo };

/**
 * The tags offered on every photo, in display order. The iOS capture screen's
 * tags (`look`, `trees`, `bunker`, `green`, `water`) are all here, so its
 * photos need no mapping. Any other tag a photo carries is kept and offered too.
 */
export const PHOTO_TAGS = [
    'creek',
    'bunker',
    'vegetation',
    'trees',
    'buildings',
    'water',
    'green',
    'fairway',
    'rough',
    'path',
    'look',
] as const;

/** A photo counts as near a hole within this distance of its play line. */
export const HOLE_NEAR_M = 40;

/** Radius choices for the "near a position" filter, metres. */
export const NEAR_RADII_M = [25, 50, 100, 200] as const;

/** A hole's play line (tees → aim points → green centre), SWEREF 99 TM. */
export interface HoleLine {
    number: number;
    points: Array<{ x: number; y: number }>;
}

export type TagMode = 'any' | 'all';

export interface PhotoFilter {
    /** Hole number, or null for every hole. */
    hole: number | null;
    /** Picked map position and radius, or null for anywhere. */
    near: { lng: number; lat: number; radiusM: number } | null;
    /** Selected tags; empty = no tag filter. */
    tags: string[];
    /** `any`: a photo needs one of `tags`; `all`: it needs every one. */
    tagMode: TagMode;
    /** Only photos with no tags at all (overrides `tags`). */
    untagged: boolean;
}

export const EMPTY_FILTER: PhotoFilter = { hole: null, near: null, tags: [], tagMode: 'any', untagged: false };

export function isFilterActive(f: PhotoFilter): boolean {
    return f.hole !== null || f.near !== null || f.tags.length > 0 || f.untagged;
}

/** Lower-case, trimmed, inner whitespace as `-`; '' when nothing is left. */
export function normalizeTag(raw: string): string {
    return raw.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 64);
}

/** The camera azimuth to draw: the refined heading when there is one. */
export function photoYawDeg(photo: Photo): number {
    return photo.refinedYawDeg ?? photo.yawDeg;
}

/** Tags to offer: the fixed list first, then every other tag in use, A–Z. */
export function knownTags(photos: readonly Photo[]): string[] {
    const fixed = new Set<string>(PHOTO_TAGS);
    const extra = new Set<string>();
    for (const p of photos) for (const tag of p.tags) if (!fixed.has(tag)) extra.add(tag);
    return [...PHOTO_TAGS, ...[...extra].sort()];
}

/**
 * The play line of one hole from its furniture, projected to SWEREF 99 TM.
 * Same chain as the phone's nearest-hole pick (ios NearestHole.swift): tees
 * and aim points in their sort order, then the green centre. Null when the
 * hole has no furniture yet.
 */
export function holeLine(
    number: number,
    tees: ReadonlyArray<{ lat: number; lon: number; sortOrder: number }>,
    aims: ReadonlyArray<{ lat: number; lon: number; sortOrder: number }>,
    green: { centerLat: number; centerLon: number } | null,
): HoleLine | null {
    const bySort = (a: { sortOrder: number }, b: { sortOrder: number }) => a.sortOrder - b.sortOrder;
    const ll = [
        ...[...tees].sort(bySort).map(p => ({ lng: p.lon, lat: p.lat })),
        ...[...aims].sort(bySort).map(p => ({ lng: p.lon, lat: p.lat })),
        ...(green ? [{ lng: green.centerLon, lat: green.centerLat }] : []),
    ];
    if (ll.length === 0) return null;
    return { number, points: ll.map(p => lngLatToSweref99tm(p)) };
}

/** Shortest distance from `p` to the polyline through `points` (∞ when empty). */
export function distanceToPolyline(p: { x: number; y: number }, points: ReadonlyArray<{ x: number; y: number }>): number {
    if (points.length === 0) return Infinity;
    if (points.length === 1) return Math.hypot(points[0]!.x - p.x, points[0]!.y - p.y);
    let best = Infinity;
    for (let i = 0; i < points.length - 1; i++) {
        const a = points[i]!;
        const b = points[i + 1]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
        best = Math.min(best, Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y));
    }
    return best;
}

/** Metres from the photo to the filter's picked position (null without one). */
export function distanceToNear(photo: Photo, near: PhotoFilter['near']): number | null {
    if (!near) return null;
    const c = lngLatToSweref99tm(near);
    return Math.hypot(photo.x3006 - c.x, photo.y3006 - c.y);
}

/**
 * Near a hole: the phone tagged it with that hole at capture, or it was taken
 * within HOLE_NEAR_M of the hole's play line. A photo between two holes so
 * shows under both.
 */
export function isNearHole(photo: Photo, hole: number, lines: ReadonlyMap<number, HoleLine>): boolean {
    if (photo.hole === hole) return true;
    const line = lines.get(hole);
    if (!line) return false;
    return distanceToPolyline({ x: photo.x3006, y: photo.y3006 }, line.points) <= HOLE_NEAR_M;
}

export function matchesFilter(photo: Photo, f: PhotoFilter, lines: ReadonlyMap<number, HoleLine>): boolean {
    if (f.hole !== null && !isNearHole(photo, f.hole, lines)) return false;
    if (f.near) {
        const d = distanceToNear(photo, f.near)!;
        if (d > f.near.radiusM) return false;
    }
    if (f.untagged) return photo.tags.length === 0;
    if (f.tags.length > 0) {
        const has = (tag: string) => photo.tags.includes(tag);
        if (f.tagMode === 'all' ? !f.tags.every(has) : !f.tags.some(has)) return false;
    }
    return true;
}

/**
 * The photos the filter keeps. Newest first (the server's order), or nearest
 * first while a position is picked.
 */
export function filterPhotos(photos: readonly Photo[], f: PhotoFilter, lines: ReadonlyMap<number, HoleLine>): Photo[] {
    const kept = photos.filter(p => matchesFilter(p, f, lines));
    if (!f.near) return kept;
    const d = new Map(kept.map(p => [p.id, distanceToNear(p, f.near)!]));
    return kept.sort((a, b) => d.get(a.id)! - d.get(b.id)!);
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** `212° SSW` */
export function formatHeading(deg: number): string {
    const d = ((Math.round(deg) % 360) + 360) % 360;
    return `${d}° ${COMPASS[Math.round(d / 22.5) % 16]}`;
}

/** An `<option>` (the `Option` constructor is not global everywhere, e.g. happy-dom). */
export function option(label: string, value: string): HTMLOptionElement {
    const o = document.createElement('option');
    o.textContent = label;
    o.value = value;
    return o;
}
