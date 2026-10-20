// The GSPro board's R.A.M. roads row, its Propose step, client side: which
// roads could be drawn in Unity as R.A.M. splines on the ground meshes
// instead of OPCD road meshes (shared/features/path-render.ts). The server
// owns the rules (roads far enough from play, with a centerline, not
// bridges); this holds the proposal, what is ticked, and the accept:
//
//   - `propose(courseId)`  GET .../gspro/ram-roads/proposal for the min
//                          distance, every candidate ticked
//   - `accept(courseId)`   POST .../gspro/ram-roads/render = ram on the ticked
//                          roads; they leave the SVG, so the Course shapes row
//                          goes stale (a new OPCD build)
//
// DI singleton; the constructor takes the API client so it is testable headlessly.

import { Signal } from '@basics/core/client/core';
import { api } from '../api';
import type { GsproExportApi, RamRoadCandidate, RamRoadsProposal } from '../../../shared/api/gspro-export.gen';

/** The proposal's default: roads at least this far from play (m). */
export const RAM_ROADS_MIN_DISTANCE_M = 30;

/** The two calls the step makes. */
export type RamRoadsClient = Pick<GsproExportApi, 'ramRoadsProposal' | 'setRoadRender'>;

export class RamRoadsService {
    /** Roads at least this far from play are proposed (m). */
    readonly minDistanceM = new Signal<number>(RAM_ROADS_MIN_DISTANCE_M);
    /** The last proposal; null before Propose and after Accept. */
    readonly proposal = new Signal<RamRoadsProposal | null>(null);
    /** The candidates (feature ids) Accept sets. */
    readonly ticked = new Signal<ReadonlySet<string>>(new Set());
    readonly busy = new Signal<boolean>(false);
    readonly error = new Signal<string>('');
    /** How many roads the last Accept set to R.A.M.; null until one ran. */
    readonly accepted = new Signal<number | null>(null);

    constructor(private readonly client: RamRoadsClient = api.gsproExport) {}

    /** Ask for the proposal; every candidate starts ticked. */
    async propose(courseId: string): Promise<void> {
        if (this.busy.peek()) return;
        this.busy.set(true);
        this.error.set('');
        this.accepted.set(null);
        try {
            const proposal = await this.client.ramRoadsProposal({ courseId, minDistanceM: this.minDistanceM.peek() });
            this.proposal.set(proposal);
            this.ticked.set(new Set(proposal.candidates.map(c => c.featureId)));
        } catch (e) {
            this.error.set(messageOf(e, 'The proposal failed'));
        } finally {
            this.busy.set(false);
        }
    }

    toggle(featureId: string, on: boolean): void {
        const next = new Set(this.ticked.peek());
        if (on) next.add(featureId);
        else next.delete(featureId);
        this.ticked.set(next);
    }

    /** Set the ticked roads to R.A.M. True when it went through. */
    async accept(courseId: string): Promise<boolean> {
        const featureIds = [...this.ticked.peek()];
        if (this.busy.peek() || featureIds.length === 0) return false;
        this.busy.set(true);
        this.error.set('');
        try {
            const result = await this.client.setRoadRender({ courseId, featureIds, render: 'ram' });
            this.accepted.set(result.changed.length);
            this.proposal.set(null);
            this.ticked.set(new Set());
            return true;
        } catch (e) {
            this.error.set(messageOf(e, 'Setting the roads to R.A.M. failed'));
            return false;
        } finally {
            this.busy.set(false);
        }
    }

    /** Fold the step away (a course switch). */
    reset(): void {
        this.proposal.set(null);
        this.ticked.set(new Set());
        this.error.set('');
        this.accepted.set(null);
    }
}

/** `path 38`, or the id's start for a road without a number. */
export function roadName(featureNo: number | null, featureId: string): string {
    return featureNo !== null ? `path ${featureNo}` : `path ${featureId.slice(0, 8)}`;
}

/** "path 38 · gravel · 465 m · 41 m from play". */
export function candidateLabel(c: RamRoadCandidate): string {
    return [
        roadName(c.featureNo, c.featureId),
        c.surface || 'unknown surface',
        `${Math.round(c.lengthM)} m`,
        c.distanceToPlayM !== null ? `${Math.round(c.distanceToPlayM)} m from play` : 'no play near',
    ].join(' · ');
}

function messageOf(e: unknown, fallback: string): string {
    return e instanceof Error && e.message ? e.message : fallback;
}
