// "Assign to holes" in the Draw mode: the shapes in Others put on their holes from the holes' tees, aim points and
// green centre (server HoleAssignmentService, the same as `bun run holes:assign`). Find shows the proposal on the
// map, coloured by hole, with the play lines; a click on a proposed shape skips it (again takes it back); Accept
// writes the rest in one go and reloads the shapes.

import { Signal, di } from '@basics/core/client/core';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { api } from '../api';
import { flattenRing, pointInRing } from '../geo/bezier';
import { sweref99tmToWgs84 } from '../geo/transform';
import { FeaturesService } from './features.service';
import type { HoleAssignmentProposal, HoleProposal } from '../../../shared/api/hole-assignment.gen';
import type { CourseFeature } from '../../../shared/api/course-features.gen';

/** What a proposed shape or a play line carries on the map. */
export interface HoleAssignProps {
    /** `line` = a hole's play line; else the shape's outcome, `skipped` when a click took it out. */
    kind: 'line' | 'assign' | 'roughs' | 'skipped' | 'other';
    id: string;
    hole: number;
    /** Hole colour (hue by number) for `assign` and own lines. */
    color: string;
}

export class HoleAssignmentService {
    /** Course the panel is open for; null = closed. */
    readonly courseId = new Signal<string | null>(null);
    readonly proposal = new Signal<HoleAssignmentProposal | null>(null);
    readonly skipped = new Signal<ReadonlySet<string>>(new Set());
    readonly busy = new Signal<'' | 'find' | 'accept'>('');
    readonly error = new Signal('');
    readonly done = new Signal('');

    private features = di.get(FeaturesService);

    open(courseId: string): void {
        if (this.courseId.peek() !== courseId) this.discard();
        this.courseId.set(courseId);
        void this.find();
    }

    close(): void {
        this.discard();
        this.courseId.set(null);
    }

    async find(): Promise<void> {
        const courseId = this.courseId.peek();
        if (!courseId || this.busy.peek()) return;
        this.busy.set('find');
        this.error.set('');
        this.done.set('');
        try {
            const res = await api.holeAssignment.propose({ courseId });
            if (this.courseId.peek() !== courseId) return;
            this.proposal.set(res);
            this.skipped.set(new Set());
        } catch (e) {
            this.error.set(e instanceof Error ? e.message : String(e));
        } finally {
            this.busy.set('');
        }
    }

    /** The shapes Accept moves: onto a hole, or (ordinary roughs) into Roughs. */
    toAssign(): HoleProposal[] {
        const skipped = this.skipped.get();
        return (this.proposal.get()?.proposals ?? []).filter((p) => movable(p) && !skipped.has(p.featureId));
    }

    /** One line: what Accept does and what stays. */
    summary(): string {
        const p = this.proposal.get();
        if (!p) return '';
        const stay = p.counts.otherCourse + p.counts.ambiguous + p.counts.none + this.skipped.get().size;
        const moves = this.toAssign();
        const roughs = moves.filter((m) => m.outcome === 'roughs').length;
        const others = moves.filter((m) => m.outcome === 'others').length;
        return `${moves.length - roughs - others} onto holes${roughs ? ` · ${roughs} to Roughs` : ''}${others ? ` · ${others} out of Roughs` : ''} · ${stay} stay`;
    }

    /** Why each kind stays, for the tooltip. */
    detail(): string {
        const p = this.proposal.get();
        if (!p) return '';
        return `On another course's hole: ${p.counts.otherCourse}\nSplit between holes: ${p.counts.ambiguous}\n`
            + `Near no hole: ${p.counts.none}\nSkipped: ${this.skipped.get().size}`;
    }

    toggle(featureId: string): void {
        const p = this.proposal.peek()?.proposals.find((x) => x.featureId === featureId);
        if (!p || !movable(p)) return;
        const next = new Set(this.skipped.peek());
        if (next.has(featureId)) next.delete(featureId);
        else next.add(featureId);
        this.skipped.set(next);
    }

    async accept(): Promise<void> {
        const courseId = this.courseId.peek();
        const featureIds = this.toAssign().map((p) => p.featureId);
        if (!courseId || !featureIds.length || this.busy.peek()) return;
        this.busy.set('accept');
        this.error.set('');
        try {
            const res = await api.holeAssignment.accept({ courseId, featureIds });
            await this.features.reload();
            this.proposal.set(null);
            this.skipped.set(new Set());
            this.done.set(`${res.assigned} put on their holes${res.roughs ? `, ${res.roughs} into Roughs` : ''}`);
        } catch (e) {
            this.error.set(e instanceof Error ? e.message : String(e));
        } finally {
            this.busy.set('');
        }
    }

    discard(): void {
        this.proposal.set(null);
        this.skipped.set(new Set());
        this.done.set('');
        this.error.set('');
    }

    /** Play lines and the proposed shapes (outlines in lon/lat) for the map. */
    layer(): FeatureCollection<Geometry, HoleAssignProps> {
        const p = this.proposal.get();
        const skipped = this.skipped.get();
        const out: Feature<Geometry, HoleAssignProps>[] = [];
        if (!p) return { type: 'FeatureCollection', features: out };
        for (const l of p.lines) {
            const own = l.courseId === p.courseId;
            out.push({
                type: 'Feature',
                properties: { kind: 'line', id: l.holeId, hole: l.number, color: own ? holeColor(l.number) : '#9ca3af' },
                geometry: { type: 'LineString', coordinates: l.line },
            });
        }
        const byId = this.featuresById();
        for (const prop of p.proposals) {
            if (!movable(prop) && prop.outcome !== 'other-course') continue;
            const f = byId.get(prop.featureId);
            if (!f) continue;
            const kind = prop.outcome === 'other-course' ? 'other' : skipped.has(prop.featureId) ? 'skipped' : prop.outcome === 'roughs' || prop.outcome === 'others' ? 'roughs' : 'assign';
            out.push({
                type: 'Feature',
                properties: { kind, id: prop.featureId, hole: prop.holeNumber ?? 0, color: kind === 'assign' ? holeColor(prop.holeNumber ?? 0) : '#9ca3af' },
                geometry: { type: 'MultiLineString', coordinates: outlines(f) },
            });
        }
        return { type: 'FeatureCollection', features: out };
    }

    /** The proposed shape (onto a hole) under this point (EPSG:3006), the smallest when they overlap; null for none. */
    shapeAt(x: number, y: number): string | null {
        let best: string | null = null;
        let bestArea = Infinity;
        const byId = this.featuresById(true);
        for (const p of this.proposal.peek()?.proposals ?? []) {
            if (!movable(p)) continue;
            const f = byId.get(p.featureId);
            if (!f) continue;
            for (const ring of f.geometry.rings) {
                const pts = flattenRing(ring, 1, f.geometry.curveType);
                if (pts.length < 3 || !pointInRing({ x, y }, pts)) continue;
                const area = Math.abs(pts.reduce((a, [x1, y1], i) => { const [x2, y2] = pts[(i + 1) % pts.length]!; return a + x1 * y2 - x2 * y1; }, 0)) / 2;
                if (area < bestArea) { bestArea = area; best = p.featureId; }
            }
        }
        return best;
    }

    private featuresById(peek = false): Map<string, CourseFeature> {
        const items = peek ? this.features.store.items.peek() : this.features.store.items.get();
        return new Map(items.map((f) => [f.id, f]));
    }
}

const movable = (p: HoleProposal) => p.outcome === 'assign' || p.outcome === 'roughs' || p.outcome === 'others';

/** A distinct hue per hole number (golden-angle steps), so neighbouring holes differ. */
export function holeColor(n: number): string {
    return `hsl(${Math.round((n * 137.508) % 360)}, 85%, 55%)`;
}

function outlines(f: CourseFeature): [number, number][][] {
    return f.geometry.rings.map((ring) => {
        const pts = flattenRing(ring, 0.5, f.geometry.curveType);
        return [...pts, pts[0]!].filter(Boolean).map(([x, y]) => {
            const { lat, lon } = sweref99tmToWgs84(x, y);
            return [lon, lat] as [number, number];
        });
    });
}
