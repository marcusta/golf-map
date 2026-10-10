import { Signal, effect } from '@basics/core/client/core';
import type { Feature, FeatureCollection } from 'geojson';
import type { Pair } from 'polygon-clipping';
import { api } from '../api';
import type { CleanupAreasApi } from '../../../shared/api/cleanup-areas.gen';
import { cleanupAreaGeoJson, validateCleanupAreas, type CleanupArea, type CleanupAreasDocument } from '../../../shared/cleanup-areas';
import type { ToolContext } from '../editor/tool';

const OVERLAY = 'clean-areas';
const SAVED = 'Areas saved. Green is eligible; purple is cleaned whatever is mapped there; orange stays unchanged.';
const DEFAULT_NAME: Record<CleanupArea['kind'], string> = { include: 'Area to clean', force: 'Clean everything', exclude: 'Keep unchanged' };
type AreaContext = Pick<ToolContext, 'map' | 'courseId' | 'track'>;
type AreaPointer = { lngLat: { lng: number; lat: number }; point: { x: number; y: number } };

/** Saved scope for external image cleanup. It never changes photo pixels. */
export class CleanupAreasController {
    readonly document = new Signal<CleanupAreasDocument | null>(null);
    readonly busy = new Signal(false);
    readonly message = new Signal('');
    readonly show = new Signal(true);
    readonly enabled = new Signal(false);
    readonly selected = new Signal('');
    readonly name = new Signal('');
    readonly kind = new Signal<CleanupArea['kind'] | null>(null);
    readonly draft = new Signal<Pair[]>([]);
    private hover = new Signal<Pair | null>(null);
    private ctx: AreaContext | null = null;
    private editingId: string | null = null;
    private overlayMap: unknown = null;
    private previous: CleanupArea[] | null = null;
    readonly canUndo = new Signal(false);
    private pen: { start: AreaPointer; last: AreaPointer; tracing: boolean } | null = null;

    constructor(private client: CleanupAreasApi = api.cleanupAreas) {}

    activate(ctx: AreaContext): void {
        this.ctx = ctx;
        this.document.set(null);
        this.selected.set('');
        this.name.set('');
        this.previous = null;
        this.canUndo.set(false);
        ctx.track(effect(() => this.render()));
        if (this.enabled.peek()) void this.reload();
    }

    deactivate(): void {
        this.ctx?.map.removeOverlayLayer(OVERLAY);
        this.ctx = null;
        this.overlayMap = null;
        this.busy.set(false);
        this.cancel();
    }

    async reload(): Promise<void> {
        const ctx = this.ctx;
        if (!ctx || this.busy.peek() || this.kind.peek()) return;
        this.busy.set(true);
        this.message.set('Loading cleanup areas…');
        try {
            const doc = await this.client.cleanupAreas({ courseId: ctx.courseId });
            if (this.ctx !== ctx) return;
            this.document.set(doc);
            this.select('');
            this.previous = null;
            this.canUndo.set(false);
            this.message.set(doc.areas.length ? SAVED : 'Draw an area to clean. Nothing is eligible until you include it.');
        } catch (e) {
            if (this.ctx === ctx) this.message.set(`Could not load areas: ${(e as Error).message}`);
        } finally { if (this.ctx === ctx) this.busy.set(false); }
    }

    select(id: string): void {
        this.selected.set(id);
        this.name.set(this.document.peek()?.areas.find(a => a.id === id)?.name ?? '');
    }

    begin(kind: CleanupArea['kind'], redraw = false): void {
        if (this.busy.peek() || !this.document.peek() || this.kind.peek()) return;
        const selected = this.document.peek()?.areas.find(a => a.id === this.selected.peek());
        if (redraw && !selected) return;
        this.editingId = redraw ? selected!.id : null;
        this.name.set(redraw ? selected!.name : DEFAULT_NAME[kind]);
        this.draft.set([]);
        this.hover.set(null);
        this.kind.set(redraw ? selected!.kind : kind);
        this.show.set(true);
        this.message.set('Drag to trace the boundary, or click separate corners. Then choose Finish area or press Enter. Hold Ctrl/Cmd to pan.');
    }

    /** The tool claims this gesture, so an ordinary left drag draws instead of panning. */
    pointerDown(e: AreaPointer): boolean {
        if (!this.kind.peek() || this.busy.peek()) return false;
        this.pen = { start: e, last: e, tracing: false };
        return true;
    }

    pointerMove(e: AreaPointer): void {
        this.move(e.lngLat);
        const pen = this.pen;
        if (!pen) return;
        // Screen-space sampling keeps small hand jitter out of the boundary at any zoom.
        if (Math.hypot(e.point.x - pen.last.point.x, e.point.y - pen.last.point.y) < 6) return;
        if (!pen.tracing) { this.addPoint(pen.start.lngLat); pen.tracing = true; }
        this.addPoint(e.lngLat);
        pen.last = e;
    }

    pointerUp(e: AreaPointer): boolean {
        const pen = this.pen;
        if (!pen) return false;
        this.pointerMove(e);
        this.pen = null;
        this.addPoint(pen.tracing ? e.lngLat : pen.start.lngLat);
        this.hover.set(null);
        if (this.draft.peek().length >= 3) this.message.set('Boundary ready to review. Choose Finish area to save, or continue drawing.');
        return true;
    }

    addPoint(p: { lng: number; lat: number }): void {
        if (!this.kind.peek() || this.busy.peek()) return;
        const points = this.draft.peek();
        const last = points.at(-1);
        if (last && last[0] === p.lng && last[1] === p.lat) return;
        if (points.length >= 999) { this.message.set('Finish this area before adding more corners.'); return; }
        this.draft.set([...points, [p.lng, p.lat]]);
    }

    move(p: { lng: number; lat: number }): void {
        if (this.kind.peek()) this.hover.set([p.lng, p.lat]);
    }

    back(): void { if (!this.busy.peek()) this.draft.set(this.draft.peek().slice(0, -1)); }
    cancel(): void {
        if (this.busy.peek()) return;
        this.pen = null;
        this.kind.set(null);
        this.draft.set([]);
        this.hover.set(null);
        this.editingId = null;
    }

    async finish(): Promise<void> {
        const doc = this.document.peek();
        const kind = this.kind.peek();
        let points = this.draft.peek();
        // A traced loop or a final click on its first corner is already closed.
        if (points.length > 1 && points[0][0] === points.at(-1)![0] && points[0][1] === points.at(-1)![1]) points = points.slice(0, -1);
        if (!doc || !kind || points.length < 3 || this.busy.peek()) return;
        const area: CleanupArea = { id: this.editingId ?? crypto.randomUUID(), name: this.name.peek().trim(), kind, ring: [...points, points[0]] };
        const areas = this.editingId ? doc.areas.map(a => a.id === this.editingId ? area : a) : [...doc.areas, area];
        if (await this.save(areas)) { this.cancel(); this.select(area.id); }
    }

    async rename(): Promise<void> {
        const doc = this.document.peek();
        if (!doc || !this.selected.peek() || this.kind.peek()) return;
        await this.save(doc.areas.map(a => a.id === this.selected.peek() ? { ...a, name: this.name.peek().trim() } : a));
    }

    async remove(): Promise<void> {
        const doc = this.document.peek();
        if (!doc || !this.selected.peek() || this.kind.peek()) return;
        if (await this.save(doc.areas.filter(a => a.id !== this.selected.peek()))) this.select('');
    }

    async undo(): Promise<void> {
        if (!this.previous || this.kind.peek()) return;
        if (await this.save(this.previous)) { this.previous = null; this.canUndo.set(false); this.select(''); }
    }

    private async save(areas: CleanupArea[]): Promise<boolean> {
        const ctx = this.ctx, doc = this.document.peek();
        if (!ctx || !doc || this.busy.peek()) return false;
        try { validateCleanupAreas(areas); } catch (e) { this.message.set((e as Error).message); return false; }
        this.busy.set(true);
        this.message.set('Saving areas…');
        try {
            const saved = await this.client.saveCleanupAreas({ courseId: ctx.courseId, version: doc.version, areas });
            if (this.ctx !== ctx) return false;
            this.previous = doc.areas;
            this.canUndo.set(true);
            this.document.set(saved);
            this.message.set(SAVED);
            return true;
        } catch (e) {
            if (this.ctx === ctx) this.message.set(`Could not save: ${(e as Error).message}. If areas changed elsewhere, cancel drawing and reload areas.`);
            return false;
        } finally { if (this.ctx === ctx) this.busy.set(false); }
    }

    canExport(): boolean {
        const doc = this.document.get();
        return !!doc && !this.busy.get() && !this.kind.get() && cleanupAreaGeoJson(doc).features.length > 0;
    }

    download(): void {
        const doc = this.document.peek();
        if (!doc || !this.canExport()) return;
        const url = URL.createObjectURL(new Blob([JSON.stringify(cleanupAreaGeoJson(doc), null, 2)], { type: 'application/geo+json' }));
        const a = document.createElement('a');
        a.href = url; a.download = `cleanup-area-${doc.siteId}.geojson`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    private render(): void {
        const ctx = this.ctx;
        if (!ctx || !ctx.map.ready.get()) { this.overlayMap = null; return; }
        const map = ctx.map.map.get();
        const doc = this.document.get();
        const show = this.show.get() && this.enabled.get();
        const selected = this.selected.get();
        const points = this.draft.get(), hover = this.hover.get();
        const features: Feature[] = [];
        if (doc && show) {
            for (const f of cleanupAreaGeoJson(doc).features) features.push({ ...f, properties: { role: f.properties.type === 'cleanup-force' ? 'forced' : 'effective' } });
            for (const a of doc.areas) features.push({ type: 'Feature', properties: { role: a.kind, selected: a.id === selected }, geometry: { type: 'Polygon', coordinates: [a.ring] } });
        }
        if (points.length) {
            const line = hover ? [...points, hover, points[0]] : [...points, points[0]];
            features.push({ type: 'Feature', properties: { role: 'draft' }, geometry: { type: 'LineString', coordinates: line } });
            for (const p of points) features.push({ type: 'Feature', properties: { role: 'vertex' }, geometry: { type: 'Point', coordinates: p } });
        }
        const data: FeatureCollection = { type: 'FeatureCollection', features };
        if (this.overlayMap === map && map) { ctx.map.updateOverlayData(OVERLAY, data); return; }
        ctx.map.addOverlayLayer(OVERLAY, data, [
            { id: `${OVERLAY}-fill`, type: 'fill', filter: ['==', ['get', 'role'], 'effective'], paint: { 'fill-color': '#39b878', 'fill-opacity': 0.27 } },
            { id: `${OVERLAY}-forced`, type: 'fill', filter: ['==', ['get', 'role'], 'forced'], paint: { 'fill-color': '#b06cf0', 'fill-opacity': 0.3 } },
            { id: `${OVERLAY}-keep`, type: 'fill', filter: ['==', ['get', 'role'], 'exclude'], paint: { 'fill-color': '#f4a340', 'fill-opacity': 0.25 } },
            { id: `${OVERLAY}-line`, type: 'line', filter: ['!', ['in', ['get', 'role'], ['literal', ['effective', 'forced']]]], paint: {
                'line-color': ['case', ['==', ['get', 'role'], 'draft'], '#ffffff', ['==', ['get', 'selected'], true], '#73dfff', ['==', ['get', 'role'], 'exclude'], '#f4a340', ['==', ['get', 'role'], 'force'], '#b06cf0', '#39b878'],
                'line-width': ['case', ['==', ['get', 'selected'], true], 3, 2],
            } },
            { id: `${OVERLAY}-points`, type: 'circle', filter: ['==', ['get', 'role'], 'vertex'], paint: { 'circle-radius': 4, 'circle-color': '#ffffff', 'circle-stroke-width': 1, 'circle-stroke-color': '#26372e' } },
        ]);
        this.overlayMap = map;
    }
}
