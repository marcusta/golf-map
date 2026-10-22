// Furniture › Tee sets › Scorecard and Place tees: the club's scorecard into the course (server ScorecardService,
// the same as `bun run scorecard`) and the tees placed from its lengths (TeePlacementService, `bun run tees:place`).
// One panel, two steps. Scorecard: paste the card, Read shows where each of its sets goes (a select per set
// overrides it), Accept writes it and goes on to the tees. Tees: Find shows every set's spot on the map; the new
// tees are taken, a click on a spot that needs a look (off, ambiguous, missed) takes it too, again leaves it;
// Accept writes the taken ones.

import { Signal, di } from '@basics/core/client/core';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { api } from '../api';
import type { ScorecardApi, ScorecardProposal, StoredScorecard } from '../../../shared/api/scorecard.gen';
import type { TeePlacementApi, TeePlacementProposal, TeeSpot } from '../../../shared/api/tee-placement.gen';
import { FurnitureService } from './furniture.service';
import { CourseDetailService } from '../course-detail/course-detail.service';
import { teeFill } from './furniture-overlay';

export type TeeLengthsStep = 'scorecard' | 'tees';
export type CardUnit = 'auto' | 'm' | 'yd';

/** What a spot, a move or an arc carries on the map. */
export interface TeeSpotProps {
    /** `spot` = a proposed tee; `move` = from the tee there now to its spot; `arc` = the length's circle near a spot that needs a look. */
    kind: 'spot' | 'move' | 'arc';
    key: string;
    /** Taken by Accept. */
    taken: boolean;
    /** Needs a look: off, ambiguous or missed. */
    look: boolean;
    color: string;
}

/** Spot outcomes a click can take. */
const TAKEABLE: readonly TeeSpot['outcome'][] = ['place', 'off', 'ambiguous', 'missed'];

/** What the panel writes through: the two clients, and what to re-read after a write. */
export interface TeeLengthsDeps {
    scorecard: ScorecardApi;
    teePlacement: TeePlacementApi;
    /** The tee sets, the course's furniture and its holes changed on the server. */
    written(what: { sets: boolean; tees: boolean; holes: boolean }, courseId: string): Promise<void>;
}

function liveDeps(): TeeLengthsDeps {
    return {
        scorecard: api.scorecard,
        teePlacement: api.teePlacement,
        async written(what, courseId) {
            const furniture = di.get(FurnitureService);
            if (what.tees) await furniture.refresh();
            else if (what.sets) await furniture.reloadTeeSets();
            if (what.holes) await di.get(CourseDetailService).reloadHoles(courseId);
        },
    };
}

export class TeeLengthsService {
    /** Course the panel is open for; null = closed. */
    readonly courseId = new Signal<string | null>(null);
    readonly step = new Signal<TeeLengthsStep>('scorecard');

    readonly text = new Signal('');
    readonly unit = new Signal<CardUnit>('auto');
    /** Card label -> tee set id or `new`, over the server's match. */
    readonly setMap = new Signal<Readonly<Record<string, string>>>({});
    readonly card = new Signal<ScorecardProposal | null>(null);
    readonly stored = new Signal<StoredScorecard | null>(null);

    readonly tees = new Signal<TeePlacementProposal | null>(null);
    /** Spot keys Accept writes. */
    readonly taken = new Signal<ReadonlySet<string>>(new Set());

    readonly busy = new Signal<'' | 'read' | 'save' | 'find' | 'place'>('');
    readonly error = new Signal('');
    readonly done = new Signal('');

    private deps: TeeLengthsDeps;

    constructor(deps?: TeeLengthsDeps) {
        this.deps = deps ?? liveDeps();
    }

    open(courseId: string, step: TeeLengthsStep): void {
        if (this.courseId.peek() !== courseId) this.reset();
        this.courseId.set(courseId);
        this.goTo(step);
    }

    close(): void {
        this.reset();
        this.courseId.set(null);
    }

    goTo(step: TeeLengthsStep): void {
        this.step.set(step);
        this.error.set('');
        this.done.set('');
        if (step === 'scorecard') void this.loadStored();
        else void this.find();
    }

    // ── Scorecard ─────────────────────────────────────────────────────────

    async loadStored(): Promise<void> {
        const courseId = this.courseId.peek();
        if (!courseId) return;
        try {
            const stored = await this.deps.scorecard.get({ courseId });
            if (this.courseId.peek() === courseId) this.stored.set(stored);
        } catch (e) {
            this.error.set(message(e));
        }
    }

    /** Read the pasted card and match it to the course's sets. */
    async read(): Promise<void> {
        const courseId = this.courseId.peek();
        if (!courseId || !this.text.peek().trim() || this.busy.peek()) return;
        this.busy.set('read');
        this.error.set('');
        this.done.set('');
        try {
            const res = await this.deps.scorecard.propose({ courseId, ...this.cardInput() });
            if (this.courseId.peek() === courseId) this.card.set(res);
        } catch (e) {
            this.card.set(null);
            this.error.set(message(e));
        } finally {
            this.busy.set('');
        }
    }

    /** Send one card set to another of the course's sets (or `new`), and read again. */
    async mapSet(label: string, target: string): Promise<void> {
        this.setMap.set({ ...this.setMap.peek(), [label]: target });
        await this.read();
    }

    /** Write the card, then go on to the tees. */
    async save(): Promise<void> {
        const courseId = this.courseId.peek();
        const card = this.card.peek();
        if (!courseId || !card || this.busy.peek()) return;
        this.busy.set('save');
        this.error.set('');
        try {
            const res = await this.deps.scorecard.accept({ courseId, ...this.cardInput() });
            await this.deps.written({ sets: res.setsCreated + res.ratingsWritten > 0, tees: false, holes: res.holesChanged > 0 }, courseId);
            this.card.set(null);
            this.text.set('');
            this.setMap.set({});
            this.busy.set('');
            this.step.set('tees');
            await this.find();
            this.done.set(`Saved: ${res.lengthsWritten} lengths${res.setsCreated ? ` · ${res.setsCreated} new sets` : ''}${res.holesChanged ? ` · ${res.holesChanged} holes` : ''}`);
        } catch (e) {
            this.error.set(message(e));
        } finally {
            this.busy.set('');
        }
    }

    /** One line: what the card holds and what Accept changes. */
    cardSummary(): string {
        const p = this.card.get();
        if (!p) return '';
        const c = p.counts;
        return [
            `${c.holes} holes`,
            `${c.lengthsChanged} lengths`,
            c.parChanged || c.indexChanged ? `${Math.max(c.parChanged, c.indexChanged)} par/index` : '',
            c.ratingsChanged ? `${c.ratingsChanged} ratings` : '',
            p.unit === 'yd' ? 'yards' : '',
        ].filter(Boolean).join(' · ');
    }

    private cardInput() {
        const unit = this.unit.peek();
        const map = Object.entries(this.setMap.peek()).map(([label, teeSetId]) => ({ label, teeSetId }));
        return { text: this.text.peek(), ...(unit === 'auto' ? {} : { unit }), ...(map.length ? { map } : {}) };
    }

    // ── Tees ──────────────────────────────────────────────────────────────

    async find(): Promise<void> {
        const courseId = this.courseId.peek();
        if (!courseId || this.busy.peek()) return;
        this.busy.set('find');
        this.error.set('');
        try {
            const res = await this.deps.teePlacement.propose({ courseId });
            if (this.courseId.peek() !== courseId) return;
            this.tees.set(res);
            this.taken.set(new Set(res.spots.filter((s) => s.outcome === 'place').map((s) => s.key)));
        } catch (e) {
            this.error.set(message(e));
        } finally {
            this.busy.set('');
        }
    }

    /** Take a spot, or leave it. */
    toggle(key: string): void {
        const spot = this.tees.peek()?.spots.find((s) => s.key === key);
        if (!spot || !spot.at || !TAKEABLE.includes(spot.outcome)) return;
        const next = new Set(this.taken.peek());
        if (next.has(key)) next.delete(key);
        else next.add(key);
        this.taken.set(next);
    }

    /** Write the taken tees. */
    async place(): Promise<void> {
        const courseId = this.courseId.peek();
        const keys = [...this.taken.peek()];
        if (!courseId || !keys.length || this.busy.peek()) return;
        this.busy.set('place');
        this.error.set('');
        try {
            const res = await this.deps.teePlacement.accept({ courseId, keys });
            await this.deps.written({ sets: true, tees: true, holes: false }, courseId);
            this.busy.set('');
            await this.find();
            this.done.set(`${res.placed} placed${res.moved ? ` · ${res.moved} moved` : ''}`);
        } catch (e) {
            this.error.set(message(e));
        } finally {
            this.busy.set('');
        }
    }

    /** One line: what Accept writes and what is left. */
    teesSummary(): string {
        const p = this.tees.get();
        if (!p) return '';
        if (!p.sets) return 'No tee lengths yet: read a scorecard';
        const taken = this.taken.get();
        const look = p.spots.filter((s) => s.outcome === 'off' || s.outcome === 'ambiguous' || s.outcome === 'missed');
        const lookTaken = look.filter((s) => taken.has(s.key)).length;
        return [
            `${taken.size} to write`,
            `${p.counts.ok} ok`,
            look.length ? `${look.length - lookTaken} to check` : '',
            p.counts.skipped ? `${p.counts.skipped} skipped` : '',
        ].filter(Boolean).join(' · ');
    }

    /** The ones to check, for the tooltip: hole, set and why. */
    teesDetail(): string {
        const p = this.tees.get();
        if (!p) return '';
        return p.spots.filter((s) => s.outcome !== 'ok' && s.outcome !== 'place')
            .map((s) => `${s.holeNumber} ${s.setName}: ${s.reason ?? s.outcome}${this.taken.get().has(s.key) ? ' (taken)' : ''}`).join('\n');
    }

    /** Spots, moves and arcs for the map. */
    layer(): FeatureCollection<Geometry, TeeSpotProps> {
        const p = this.tees.get();
        const taken = this.taken.get();
        const out: Feature<Geometry, TeeSpotProps>[] = [];
        for (const s of p?.spots ?? []) {
            if (!s.at || s.outcome === 'ok') continue;
            const props = { key: s.key, taken: taken.has(s.key), look: s.outcome !== 'place', color: teeFill(s.color) };
            if (s.arc) out.push({ type: 'Feature', properties: { ...props, kind: 'arc' }, geometry: { type: 'LineString', coordinates: s.arc } });
            if (s.from && s.outcome !== 'missed') out.push({ type: 'Feature', properties: { ...props, kind: 'move' }, geometry: { type: 'LineString', coordinates: [s.from, s.at] } });
            out.push({ type: 'Feature', properties: { ...props, kind: 'spot' }, geometry: { type: 'Point', coordinates: s.at } });
        }
        return { type: 'FeatureCollection', features: out };
    }

    /** The spot a click at `distPx` from each spot's screen position lands on (within `radiusPx`), or null. */
    spotAt(distPx: (at: [number, number]) => number, radiusPx = 10): string | null {
        let best: string | null = null;
        let bestD = Infinity;
        for (const s of this.tees.peek()?.spots ?? []) {
            if (!s.at || !TAKEABLE.includes(s.outcome)) continue;
            const d = distPx(s.at);
            if (d <= radiusPx && d < bestD) { bestD = d; best = s.key; }
        }
        return best;
    }

    private reset(): void {
        this.card.set(null);
        this.tees.set(null);
        this.taken.set(new Set());
        this.setMap.set({});
        this.error.set('');
        this.done.set('');
    }
}

function message(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}
