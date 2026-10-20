// The Terrain editor's Paint tool, client side: hand paint on the course meshes (vertex colours) as strokes kept in
// docs/gspro/<course>/paint.json and painted by Blender (server/services/paint.service.ts, `bun run paint`).
//
// While `active`, the Terrain editor hands its map clicks here (TerrainEditToolService): a line or a polygon is
// clicked point by point, a circle is its centre and then a point on its rim. Preview sends the drawn stroke as a dry
// run (Unity shows it at once, nothing written), Save keeps it (Unity shows it until the mesh's next FBX), Undo
// removes the last stroke saved here, and the list's Remove any stroke. DI singleton; the constructor takes the API
// client so it is testable headlessly.

import { Computed, Signal } from '@basics/core/client/core';
import { api, ApiError } from '../api';
import type { PaintApi, PaintChangeResult, PaintStroke } from '../../../shared/api/paint.gen';
import type { Point } from '../geo/bezier';

export type StrokeGeometry = PaintStroke['geometry'];
export type PaintChannel = PaintStroke['channel'];

/** The channel colours on the map (MAHS: red = grass, black = dirt). */
export const CHANNEL_COLORS: Record<PaintChannel, string> = { red: '#ef4444', green: '#22c55e', blue: '#3b82f6', black: '#111827' };
export const PAINT_CHANNELS: readonly PaintChannel[] = ['black', 'red', 'green', 'blue'];
/** Segments of a circle drawn on the map. */
const CIRCLE_SEGMENTS = 48;

/** What the map draws for the paint: the saved strokes and the one being drawn (EPSG:3006). */
export interface PaintMark {
    shapes: PaintShape[];
    /** The draft's clicked points (vertices on the map). */
    points: Point[];
}

export interface PaintShape {
    /** area = a polygon or circle ring; line = a line's centreline. */
    kind: 'area' | 'line';
    points: Point[];
    color: string;
    draft: boolean;
    /** Off strokes are drawn faint. */
    enabled: boolean;
}

/** A circle's ring (EPSG:3006), closed by the renderer. */
export function circleRing(c: Point, r: number, n = CIRCLE_SEGMENTS): Point[] {
    return Array.from({ length: n }, (_, i) => ({ x: c.x + r * Math.cos((2 * Math.PI * i) / n), y: c.y + r * Math.sin((2 * Math.PI * i) / n) }));
}

/** A saved stroke as a map shape. */
export function strokeShape(s: PaintStroke, draft = false): PaintShape {
    const color = CHANNEL_COLORS[s.channel];
    const enabled = s.enabled !== false;
    if (s.geometry === 'circle' && s.centre3006) {
        return { kind: 'area', points: circleRing({ x: s.centre3006[0], y: s.centre3006[1] }, s.radiusM ?? 0), color, draft, enabled };
    }
    const points = (s.points3006 ?? []).map(([x, y]) => ({ x, y }));
    return { kind: s.geometry === 'polygon' ? 'area' : 'line', points, color, draft, enabled };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** One short line for a change: what was done and where Unity shows it. */
export function changeSummary(r: PaintChangeResult): string {
    const p = r.preview;
    const what = r.dryRun ? 'Preview' : r.action === 'remove' ? `Removed ${r.id}` : `Saved ${r.id}`;
    const where = p.status === 'shown'
        ? `${p.previewed.length} mesh${p.previewed.length === 1 ? '' : 'es'}${p.cleared.length ? `, ${p.cleared.length} back` : ''}`
        : p.status === 'skipped' ? 'Unity closed' : 'preview failed';
    return `${what} · ${where}`;
}

function messageOf(e: unknown): string {
    if (e instanceof ApiError) return e.message;
    return e instanceof Error ? e.message : String(e);
}

export class PaintToolService {
    /** Paint mode: the Terrain editor's map clicks draw paint strokes. */
    readonly active = new Signal(false);
    readonly geometry = new Signal<StrokeGeometry>('line');
    readonly channel = new Signal<PaintChannel>('black');
    /** A line's full width, m. */
    readonly widthM = new Signal(1);
    readonly featherM = new Signal(0.5);
    readonly strength = new Signal(1);
    /** The stroke being drawn: a line's or polygon's points; a circle's centre, then a point on its rim. */
    readonly draft = new Signal<Point[]>([]);
    /** The pointer while a draft is open (rubber band, circle radius). */
    readonly cursor = new Signal<Point | null>(null);
    /** The course's saved strokes (paint.json order). */
    readonly strokes = new Signal<PaintStroke[]>([]);
    /** Whether a save regenerates Blender's paint layer yet (PAINT_LAYER_LIVE on the server). */
    readonly layerLive = new Signal(false);
    readonly busy = new Signal<'load' | 'preview' | 'save' | 'undo' | 'remove' | null>(null);
    /** One line: the last change's outcome, or what went wrong. */
    readonly notice = new Signal<string | null>(null);
    /** The last change's warnings (a tooltip). */
    readonly warnings = new Signal<string[]>([]);
    /** The strokes saved here, newest last: Undo removes them in turn. */
    private readonly saved = new Signal<string[]>([]);
    private courseId: string | null = null;

    /** The drawn stroke, ready to send; null while it is not complete. */
    readonly pending = new Computed<Omit<PaintStroke, 'id'> | null>(() => {
        const pts = this.draft.get();
        const geometry = this.geometry.get();
        const base = {
            geometry, channel: this.channel.get(), featherM: this.featherM.get(), strength: this.strength.get(),
        };
        if (geometry === 'circle') {
            if (pts.length < 2) return null;
            const r = Math.hypot(pts[1]!.x - pts[0]!.x, pts[1]!.y - pts[0]!.y);
            if (r <= 0) return null;
            return { ...base, centre3006: [round2(pts[0]!.x), round2(pts[0]!.y)] as [number, number], radiusM: round2(r) };
        }
        if (pts.length < (geometry === 'line' ? 2 : 3)) return null;
        const points3006 = pts.map(p => [round2(p.x), round2(p.y)] as [number, number]);
        return geometry === 'line' ? { ...base, points3006, widthM: this.widthM.get() } : { ...base, points3006 };
    });

    readonly canUndo = new Computed(() => this.saved.get().length > 0);

    /** The map's paint shapes; null while paint mode is off. */
    readonly mark = new Computed<PaintMark | null>(() => {
        if (!this.active.get()) return null;
        const shapes = this.strokes.get().map(s => strokeShape(s));
        const pts = this.draft.get();
        const cursor = this.cursor.get();
        const color = CHANNEL_COLORS[this.channel.get()];
        if (pts.length > 0) {
            if (this.geometry.get() === 'circle') {
                const rim = pts[1] ?? cursor;
                if (rim) shapes.push({ kind: 'area', points: circleRing(pts[0]!, Math.hypot(rim.x - pts[0]!.x, rim.y - pts[0]!.y)), color, draft: true, enabled: true });
            } else {
                const line = cursor ? [...pts, cursor] : pts;
                shapes.push({ kind: this.geometry.get() === 'polygon' && line.length >= 3 ? 'area' : 'line', points: line, color, draft: true, enabled: true });
            }
        }
        return { shapes, points: pts };
    });

    constructor(private readonly client: PaintApi = api.paint) {}

    /** The Terrain editor's course (no request: the strokes are read when paint mode goes on). */
    setCourse(courseId: string): void {
        if (courseId === this.courseId) return;
        this.courseId = courseId;
        this.saved.set([]);
        this.strokes.set([]);
        this.cancel();
        if (this.active.peek()) void this.load(courseId);
    }

    /** Paint mode on (the course's strokes read) or off (the draft dropped). */
    setActive(on: boolean): void {
        this.active.set(on);
        if (!on) this.cancel();
        else if (this.courseId) void this.load(this.courseId);
    }

    /** Read the course's strokes. */
    async load(courseId: string): Promise<void> {
        if (courseId !== this.courseId) this.saved.set([]);
        this.courseId = courseId;
        this.busy.set('load');
        try {
            const list = await this.client.list({ courseId });
            this.strokes.set(list.strokes);
            this.layerLive.set(list.layerLive);
        } catch (e) {
            this.notice.set(messageOf(e));
        } finally {
            this.busy.set(null);
        }
    }

    /** A map click (EPSG:3006). A complete draft starts over; a circle takes its centre, then its rim. */
    click(p: Point): void {
        const pts = this.draft.peek();
        const geometry = this.geometry.peek();
        if (geometry === 'circle' && pts.length >= 2) this.draft.set([p]);
        else this.draft.set([...pts, { x: p.x, y: p.y }]);
    }

    /** The pointer moved (rubber band, circle radius); ignored with no draft. */
    move(p: Point | null): void {
        if (this.draft.peek().length === 0) {
            if (this.cursor.peek()) this.cursor.set(null);
            return;
        }
        this.cursor.set(p);
    }

    /** Backspace: drop the last point. False when there was none. */
    undoPoint(): boolean {
        const pts = this.draft.peek();
        if (pts.length === 0) return false;
        this.draft.set(pts.slice(0, -1));
        return true;
    }

    /** Esc: drop the draft. False when there was none. */
    cancel(): boolean {
        if (this.draft.peek().length === 0) return false;
        this.draft.set([]);
        this.cursor.set(null);
        return true;
    }

    setGeometry(g: StrokeGeometry): void {
        if (g === this.geometry.peek()) return;
        this.geometry.set(g);
        this.cancel();
    }

    /** Show the drawn stroke in Unity (a dry run: nothing written). */
    preview(): Promise<boolean> {
        const stroke = this.pending.peek();
        if (!stroke || !this.courseId) return Promise.resolve(false);
        return this.run('preview', () => this.client.stroke({ courseId: this.courseId!, stroke, dryRun: true }));
    }

    /** Keep the drawn stroke: saved to paint.json, shown in Unity. The draft is cleared. */
    async save(): Promise<boolean> {
        const stroke = this.pending.peek();
        if (!stroke || !this.courseId) return false;
        const ok = await this.run('save', () => this.client.stroke({ courseId: this.courseId!, stroke }), r => {
            this.saved.set([...this.saved.peek(), r.id]);
            this.draft.set([]);
            this.cursor.set(null);
        });
        return ok;
    }

    /** Remove the last stroke saved here. */
    async undo(): Promise<boolean> {
        const id = this.saved.peek().at(-1);
        if (!id || !this.courseId) return false;
        return this.run('undo', () => this.client.remove({ courseId: this.courseId!, id }), () => {
            this.saved.set(this.saved.peek().slice(0, -1));
        });
    }

    /** Remove a stroke by id. */
    remove(id: string): Promise<boolean> {
        if (!this.courseId) return Promise.resolve(false);
        return this.run('remove', () => this.client.remove({ courseId: this.courseId!, id }), () => {
            this.saved.set(this.saved.peek().filter(x => x !== id));
        });
    }

    private async run(kind: 'preview' | 'save' | 'undo' | 'remove', call: () => Promise<PaintChangeResult>, done?: (r: PaintChangeResult) => void): Promise<boolean> {
        if (this.busy.peek()) return false;
        this.busy.set(kind);
        this.notice.set(null);
        try {
            const r = await call();
            done?.(r);
            this.notice.set(changeSummary(r));
            this.warnings.set(r.warnings);
            if (!r.dryRun) {
                const list = await this.client.list({ courseId: this.courseId! });
                this.strokes.set(list.strokes);
                this.layerLive.set(list.layerLive);
            }
            return true;
        } catch (e) {
            this.notice.set(messageOf(e));
            this.warnings.set([]);
            return false;
        } finally {
            this.busy.set(null);
        }
    }
}
