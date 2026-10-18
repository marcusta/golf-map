// Photo stems in the Vegetation mode ("Find trees in photo"): the young trees on the course's open ground that the
// lidar missed, which the server finds from their shadows in the summer photo (server PhotoStemsService, the same
// as `bun run trees:photo`). The proposal shows as rings on the map; a click on a ring skips that tree; Accept
// plants the rest as photo stems and remembers the skipped ones; Discard drops the proposal.

import { Signal } from '@basics/core/client/core';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import { api } from '../api';
import { sweref99tmToWgs84 } from '../geo/transform';
import type { PhotoStemProposal } from '../../../shared/api/photo-stems.gen';

/** What a ring on the map carries. */
export interface PhotoStemRingProps {
    id: string;
    skipped: boolean;
    heightM: number;
    crownRadiusM: number;
    kind: number;
}

const RING_SIDES = 32;
/** A ring is at least this wide on the map (and to click), whatever the crown. */
export const MIN_RING_RADIUS_M = 0.8;

export class PhotoStemsService {
    /** Course the panel is open for; null = closed. */
    readonly courseId = new Signal<string | null>(null);
    readonly proposals = new Signal<PhotoStemProposal[]>([]);
    /** Ids of the proposal a click took out. */
    readonly skipped = new Signal<ReadonlySet<string>>(new Set());
    /** One line on how the photo was read (lidar stems matched, fallback), '' before a find. */
    readonly note = new Signal('');
    readonly busy = new Signal<'' | 'find' | 'accept'>('');
    readonly error = new Signal('');
    /** What the last Accept did, '' otherwise. */
    readonly done = new Signal('');

    open(courseId: string): void {
        if (this.courseId.peek() !== courseId) this.discard();
        this.courseId.set(courseId);
    }

    close(): void {
        this.discard();
        this.courseId.set(null);
    }

    /** Ask the server for the photo's young trees (kept there, so Accept can name them by id). */
    async find(): Promise<void> {
        const courseId = this.courseId.peek();
        if (!courseId || this.busy.peek()) return;
        this.busy.set('find');
        this.error.set('');
        this.done.set('');
        try {
            const res = await api.photoStems.propose({ courseId });
            if (this.courseId.peek() !== courseId) return;
            this.proposals.set(res.proposals);
            this.skipped.set(new Set());
            const c = res.calibration;
            this.note.set(`${res.summer}: ${c.matched ?? 0} lidar trees matched${c.fallback ? ', default sizes' : ''}`);
        } catch (e) {
            this.error.set(e instanceof Error ? e.message : String(e));
        } finally {
            this.busy.set('');
        }
    }

    /** Skip a proposed tree, or take it back (a click on its ring). */
    toggle(id: string): void {
        if (!this.proposals.peek().some((p) => p.id === id)) return;
        const next = new Set(this.skipped.peek());
        if (next.has(id)) next.delete(id);
        else next.add(id);
        this.skipped.set(next);
    }

    /** How many trees Accept plants. */
    acceptCount(): number {
        return splitIds(this.proposals.get(), this.skipped.get()).accept.length;
    }

    /** Plant the proposed trees not skipped; the skipped ones are not offered again. */
    async accept(): Promise<void> {
        const courseId = this.courseId.peek();
        const proposals = this.proposals.peek();
        if (!courseId || proposals.length === 0 || this.busy.peek()) return;
        const { accept, skip } = splitIds(proposals, this.skipped.peek());
        this.busy.set('accept');
        this.error.set('');
        try {
            await api.photoStems.accept({ courseId, accept, skip });
            this.discard();
            this.done.set(`${accept.length} planted${skip.length ? `, ${skip.length} skipped` : ''} — update the trees`);
        } catch (e) {
            this.error.set(e instanceof Error ? e.message : String(e));
        } finally {
            this.busy.set('');
        }
    }

    /** Drop the proposal: nothing is planted or skipped. */
    discard(): void {
        this.proposals.set([]);
        this.skipped.set(new Set());
        this.note.set('');
        this.done.set('');
    }

    /** The proposed trees as rings (crown radius, WGS84 lon/lat) for the map, each with its id and whether it is skipped. */
    layer(): FeatureCollection<Polygon, PhotoStemRingProps> {
        const skipped = this.skipped.get();
        return {
            type: 'FeatureCollection',
            features: this.proposals.get().map((p): Feature<Polygon, PhotoStemRingProps> => ({
                type: 'Feature',
                properties: { id: p.id, skipped: skipped.has(p.id), heightM: p.heightM, crownRadiusM: p.crownRadiusM, kind: p.kind },
                geometry: { type: 'Polygon', coordinates: [ringLonLat(p.x, p.y, ringRadius(p))] },
            })),
        };
    }

    /** The proposed tree whose ring holds this point (EPSG:3006), the nearest when rings overlap; null for none. */
    ringAt(x: number, y: number): string | null {
        let best: string | null = null;
        let bestD = Infinity;
        for (const p of this.proposals.peek()) {
            const d = Math.hypot(p.x - x, p.y - y);
            if (d <= ringRadius(p) && d < bestD) {
                best = p.id;
                bestD = d;
            }
        }
        return best;
    }
}

/** The proposal's ids: those Accept plants and those it remembers as skipped. */
function splitIds(proposals: PhotoStemProposal[], skipped: ReadonlySet<string>): { accept: string[]; skip: string[] } {
    const accept: string[] = [];
    const skip: string[] = [];
    for (const p of proposals) (skipped.has(p.id) ? skip : accept).push(p.id);
    return { accept, skip };
}

/** A proposal's ring radius on the map: its crown, at least MIN_RING_RADIUS_M. */
function ringRadius(p: PhotoStemProposal): number {
    return Math.max(p.crownRadiusM, MIN_RING_RADIUS_M);
}

function ringLonLat(x: number, y: number, r: number): [number, number][] {
    const ring: [number, number][] = [];
    for (let i = 0; i <= RING_SIDES; i++) {
        const a = (2 * Math.PI * (i % RING_SIDES)) / RING_SIDES;
        const { lat, lon } = sweref99tmToWgs84(x + r * Math.cos(a), y + r * Math.sin(a));
        ring.push([lon, lat]);
    }
    return ring;
}
