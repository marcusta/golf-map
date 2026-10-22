// Find bunkers in the Draw mode: the bunkers the course-surface model finds on the photo that are not drawn yet,
// their edges from the photo's NIR band, each on its hole (server BunkerProposalsService, the same as
// `bun run bunkers`). They show as outlines on the map; a click on one skips it, again takes it back. Add makes the
// rest B-spline bunkers on their holes (one undo step) and remembers the skipped ones; Discard drops the proposal.

import { Signal, di } from '@basics/core/client/core';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import { api } from '../api';
import { outlineToBspline } from '../geo/outline-fit';
import type { BunkerProposal } from '../../../shared/api/bunker-proposals.gen';
import { FeaturesService } from './features.service';
import { DrawToolService } from './draw-tool.service';
import { snapshotOf } from './history';

/** The source the added bunkers carry (server BUNKER_PROPOSAL_SOURCE). */
export const BUNKER_PROPOSAL_SOURCE = 'surface-model';

/** What an outline on the map carries. */
export interface BunkerOutlineProps {
    id: string;
    skipped: boolean;
    edge: 'nir' | 'model';
    hole: number | null;
}

export class BunkerProposalsService {
    /** Course the panel is open for; null = closed. */
    readonly courseId = new Signal<string | null>(null);
    readonly proposals = new Signal<BunkerProposal[]>([]);
    /** Ids a click took out. */
    readonly skipped = new Signal<ReadonlySet<string>>(new Set());
    /** One line on the last find ('' before one). */
    readonly note = new Signal('');
    readonly busy = new Signal<'' | 'find' | 'add'>('');
    readonly error = new Signal('');
    /** What the last Add did, '' otherwise. */
    readonly done = new Signal('');

    open(courseId: string): void {
        if (this.courseId.peek() !== courseId) this.discard();
        this.courseId.set(courseId);
    }

    close(): void {
        this.discard();
        this.courseId.set(null);
    }

    /** Ask the server for the bunkers the model finds (kept there, so the skips can name them by id). */
    async find(): Promise<void> {
        const courseId = this.courseId.peek();
        if (!courseId || this.busy.peek()) return;
        this.busy.set('find');
        this.error.set('');
        this.done.set('');
        try {
            const res = await api.bunkerProposals.propose({ courseId });
            if (this.courseId.peek() !== courseId) return;
            this.proposals.set(res.proposals);
            this.skipped.set(new Set());
            const left = res.left.drawn + res.left.skipped;
            this.note.set(res.proposals.length
                ? `${res.collection}${left ? ` · ${left} drawn or skipped left out` : ''}`
                : `No new bunkers in ${res.collection}${left ? ` (${left} drawn or skipped)` : ''}`);
        } catch (e) {
            this.error.set(e instanceof Error ? e.message : String(e));
        } finally {
            this.busy.set('');
        }
    }

    /** Skip a proposed bunker, or take it back (a click on its outline). */
    toggle(id: string): void {
        if (!this.proposals.peek().some((p) => p.id === id)) return;
        const next = new Set(this.skipped.peek());
        if (next.has(id)) next.delete(id);
        else next.add(id);
        this.skipped.set(next);
    }

    /** How many bunkers Add makes. */
    addCount(): number {
        const skipped = this.skipped.get();
        return this.proposals.get().filter((p) => !skipped.has(p.id)).length;
    }

    /**
     * Make the proposals not skipped bunkers on their holes (B-splines fitted to the outline, one undo step) and
     * remember the skipped ones on the server.
     */
    async add(): Promise<void> {
        const courseId = this.courseId.peek();
        const proposals = this.proposals.peek();
        if (!courseId || proposals.length === 0 || this.busy.peek()) return;
        const skipped = this.skipped.peek();
        const features = di.get(FeaturesService);
        if (features.loadedCourse !== courseId) {
            this.error.set('Open the course in Draw first');
            return;
        }
        this.busy.set('add');
        this.error.set('');
        try {
            const items = proposals.filter((p) => !skipped.has(p.id)).flatMap((p) => {
                const geometry = outlineToBspline(p.ring.map(([x, y]) => ({ x, y })));
                return geometry ? [{ type: 'bunker', holeId: p.holeId, geometry, source: BUNKER_PROPOSAL_SOURCE }] : [];
            });
            const created = items.length ? await features.createMany(items, { select: false }) : [];
            if (items.length && !created) {
                this.error.set('Adding the bunkers failed — see the draw panel');
                return;
            }
            if (created?.length) {
                di.get(DrawToolService).history.push(created.map((c) => ({ featureId: c.id, before: null, after: snapshotOf(c), beforeVersion: null })));
            }
            const skip = proposals.filter((p) => skipped.has(p.id)).map((p) => p.id);
            if (skip.length) await api.bunkerProposals.skip({ courseId, ids: skip });
            this.discard();
            const n = created?.length ?? 0;
            this.done.set(n ? `${n} added${skip.length ? `, ${skip.length} skipped` : ''}` : `${skip.length} skipped, not offered again`);
        } catch (e) {
            this.error.set(e instanceof Error ? e.message : String(e));
        } finally {
            this.busy.set('');
        }
    }

    /** Drop the proposal: nothing is added or skipped. */
    discard(): void {
        this.proposals.set([]);
        this.skipped.set(new Set());
        this.note.set('');
        this.done.set('');
    }

    /** The proposals' outlines (WGS84 lon/lat) for the map, each with its id and whether it is skipped. */
    layer(): FeatureCollection<Polygon, BunkerOutlineProps> {
        const skipped = this.skipped.get();
        return {
            type: 'FeatureCollection',
            features: this.proposals.get().map((p): Feature<Polygon, BunkerOutlineProps> => ({
                type: 'Feature',
                properties: { id: p.id, skipped: skipped.has(p.id), edge: p.edge, hole: p.holeNumber },
                geometry: { type: 'Polygon', coordinates: [[...p.lonLat, p.lonLat[0]!]] },
            })),
        };
    }

    /** The proposal whose outline holds this point (EPSG:3006), the smallest when they overlap; null for none. */
    proposalAt(x: number, y: number): string | null {
        let best: string | null = null;
        let bestArea = Infinity;
        for (const p of this.proposals.peek()) {
            if (p.areaM2 < bestArea && inRing(x, y, p.ring)) {
                best = p.id;
                bestArea = p.areaM2;
            }
        }
        return best;
    }
}

function inRing(x: number, y: number, ring: [number, number][]): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]!, [xj, yj] = ring[j]!;
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}
