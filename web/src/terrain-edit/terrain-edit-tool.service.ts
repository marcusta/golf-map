// Terrain-edit tool (T55b) — draw smooth/flatten areas onto the DEM.
//
// Edits are VECTOR features replayed onto the DEM at build time (T54/T56),
// never raster mutations: each is a polygon ring (EPSG:3006, plain straight
// segments — no bezier/b-spline anchors) plus op params, persisted site-scoped
// through the T55a terrain-edits API. Two ops (D-TE3): 'plane' (least-squares
// plane fit, optional dead-flat) and 'smooth' (circular median filter); both
// feather over an edge band.
//
// The tool owns its OWN DrawState instance for polygon drafting — terrain
// edits are deliberately NOT course features (no pseudo-type in
// FEATURE_TYPES, no FeaturesService.create): they live in a different table,
// are site- not course-scoped, and never render on players' maps. The commit
// funnel here mirrors DrawToolService.closeDraft but POSTs to the
// terrain-edits API instead.
//
// Map rendering goes through the TerrainEditRenderer seam (the real
// implementation, terrain-edit-overlay.ts, imports maplibre-gl and cannot
// load under bun test — same split as the analysis tool).

import { Signal, Computed, effect, untrack } from '@basics/core/client/core';
import { api } from '../api';
import type { TerrainEdit, TerrainEditsApi } from '../../../shared/api/terrain-edits.gen';
import type { MapBuildApi, MapBuildJob } from '../../../shared/api/map-build.gen';
import { STEP_LABELS } from '../map-build/map-build.service';
import type { ToolContext } from '../editor/tool';
import type { MapPointerEvent, MapService } from '../map/map.service';
import type { AnchorPoint } from '../geo/bezier';
import { DrawState, MIN_RING_POINTS } from '../draw/draw-state';
import { lngLatToSweref99tm, sweref99tmToWgs84 } from '../geo/transform';

/** Interaction-claim id for the terrain-edit tool (also its registry id). */
export const TERRAIN_EDIT_TOOL_ID = 'terrain-edit';

/** Screen-px radius: clicking within this of the draft's first point closes it. */
const CLOSE_RING_PX = 12;

/** Re-terrain job poll interval (map-build.service pattern). */
const POLL_MS = 1500;

/** Default edge-feather band width, meters (D-TE3; pipeline default). */
export const DEFAULT_FEATHER_M = 2;
/** Default median-filter radius for 'smooth', meters (pipeline default). */
export const DEFAULT_RADIUS_M = 2;

export type TerrainEditOp = TerrainEdit['op'];

/** Marker glyph per op (DOM markers — the editor style has no glyphs endpoint). */
export const OP_GLYPHS: Record<TerrainEditOp, string> = { plane: '▱', smooth: '∿' };

/** One-line params summary for the panel rows and the map glyph tooltips. */
export function paramsSummary(edit: TerrainEdit): string {
    const parts: string[] = [];
    if (edit.op === 'plane' && edit.params.flat) parts.push('flat');
    if (edit.op === 'smooth') parts.push(`r ${edit.params.radiusM ?? DEFAULT_RADIUS_M} m`);
    parts.push(`feather ${edit.params.featherM} m`);
    return parts.join(' · ');
}

/** Everything the renderer needs to draw one overlay state. */
export interface TerrainEditView {
    edits: TerrainEdit[];
    /** In-progress draft ring (EPSG:3006), empty when idle. */
    draft: AnchorPoint[];
}

/**
 * Map-rendering boundary for the tool (analysis-tool pattern): the real
 * implementation imports maplibre-gl, which cannot load under bun test, so
 * the service only talks to this interface and the descriptor
 * (terrain-edit-tool.ts) injects the real renderer.
 */
export interface TerrainEditRenderer {
    /** Draw/refresh the overlay for `view`. Map is ready. */
    render(map: MapService, view: TerrainEditView): void;
    /** The map was destroyed (ready → false): forget per-map state. */
    reset(): void;
    /** Remove everything from a still-live map (tool deactivation). */
    clear(map: MapService): void;
}

/**
 * The `terrain-edit` EditorTool's headless service. Click-to-place polygon
 * drafting via an OWN DrawState; closing the ring (click near the first
 * point) POSTs the edit with the currently-armed op/params, then chain-draws
 * the next one. TerrainEditPanelComponent shares this DI singleton for the
 * op/params controls and the per-site edit list (enabled toggle / delete).
 *
 * The overlay is activation-scoped — edits are builder-internal and hidden
 * outside this tool.
 */
export class TerrainEditToolService {
    /** Own drafting state machine — NOT DrawToolService's instance. */
    readonly state = new DrawState();

    /** The site's terrain edits (server order: created_at — D-TE4). */
    readonly edits = new Signal<TerrainEdit[]>([]);
    readonly loading = new Signal(false);
    readonly saving = new Signal(false);
    /** One-line panel notice (load/save failures, missing site). */
    readonly notice = new Signal<string | null>(null);

    // Params armed for the NEXT drawn edit (panel controls).
    readonly op = new Signal<TerrainEditOp>('plane');
    readonly featherM = new Signal(DEFAULT_FEATHER_M);
    readonly radiusM = new Signal(DEFAULT_RADIUS_M);
    readonly flat = new Signal(false);

    /** Renderable overlay state (persisted edits + the live draft). */
    readonly view = new Computed<TerrainEditView>(() => ({
        edits: this.edits.get(),
        draft: this.state.draft.get(),
    }));

    private ctx: ToolContext | null = null;
    private renderer: TerrainEditRenderer | null = null;
    /** True while a render flush is queued (microtask coalescing). */
    private renderScheduled = false;
    /** Monotonic token so a stale list response never clobbers a newer one. */
    private loadSeq = 0;

    constructor(
        private editsApi: TerrainEditsApi = api.terrainEdits,
        private mapBuildApi: MapBuildApi = api.mapBuild,
        /** Poll interval override for tests (real timers). */
        private pollMs: number = POLL_MS,
    ) {}

    // ── EditorTool lifecycle (called via terrain-edit-tool.ts) ─────────────

    activate(ctx: ToolContext, renderer: TerrainEditRenderer): void {
        this.ctx = ctx;
        this.renderer = renderer;
        this.notice.set(null);

        ctx.track(ctx.map.onClick(e => this.onClick(e)));

        // Overlay rendering, coalesced onto a microtask: closing a draft
        // writes draft AND edits back-to-back, and @basics/core signals are
        // push-based eager — without coalescing the effect would render the
        // mixed intermediate state too (reactive-cascade gotcha).
        ctx.track(effect(() => {
            const ready = ctx.map.ready.get();
            this.view.get(); // subscribe to the overlay-driving state
            if (!ready) {
                renderer.reset();
                return;
            }
            untrack(() => this.scheduleRender());
        }));
        ctx.track(() => {
            if (ctx.map.ready.peek()) renderer.clear(ctx.map);
            else renderer.reset();
        });

        // Crosshair while placing points.
        ctx.track(effect(() => {
            if (!ctx.map.ready.get()) return;
            const canvas = ctx.map.map.get()?.getCanvas();
            if (canvas) canvas.style.cursor = 'crosshair';
        }));
        ctx.track(() => {
            const canvas = ctx.map.map.peek()?.getCanvas();
            if (canvas) canvas.style.cursor = '';
        });

        // The tool is always drawing — there is no select sub-mode here.
        this.state.arm();
        void this.reload();
    }

    deactivate(): void {
        this.state.disarm();
        this.saving.set(false);
        this.ctx = null;
        this.renderer = null;
    }

    /** ESC: cancel an in-progress draft (stay active) → deactivate. */
    onEscape(): boolean {
        if (this.state.draft.peek().length > 0) {
            this.state.disarm();
            this.state.arm(); // stay in draw mode for the next outline
            return true;
        }
        return false;
    }

    // ── Site scoping ────────────────────────────────────────────────────────

    /**
     * Edits are site-scoped (D-TE1: the site owns the map). Resolve like the
     * map-build UI does: the loaded course's `siteId` (set-map-area /
     * tileset.service pattern), falling back to the tileset's mapKey — which
     * IS the site id (map-style.ts contract) — when the course record hasn't
     * landed yet. Null = the course has no site (no map area picked).
     */
    siteId(): string | null {
        const ctx = this.ctx;
        if (!ctx) return null;
        return ctx.courseDetail.course.peek()?.siteId ?? ctx.tileset.mapKey.peek() ?? null;
    }

    // ── Actions (clicks, the panel, and tests) ──────────────────────────────

    /** (Re)load the site's edits. */
    async reload(): Promise<void> {
        const siteId = this.siteId();
        if (!siteId) {
            this.notice.set('This course has no site/map yet — set a map area first.');
            return;
        }
        const seq = ++this.loadSeq;
        this.loading.set(true);
        try {
            const edits = await this.editsApi.list({ siteId });
            if (seq !== this.loadSeq) return; // superseded
            this.edits.set(edits);
            this.notice.set(null);
        } catch (e) {
            if (seq !== this.loadSeq) return;
            this.notice.set(`Loading terrain edits failed: ${message(e)}`);
        } finally {
            if (seq === this.loadSeq) this.loading.set(false);
        }
    }

    /**
     * Close the draft ring and persist it as a terrain edit with the armed
     * op/params — the tool's OWN commit funnel (DrawToolService.closeDraft
     * precedent; deliberately not FeaturesService.create). Corner flags are
     * dropped: rings are plain straight-segment `{x,y}[][]` (T55a storage).
     * Chain-draw: on success drawing stays armed for the next outline.
     */
    async closeDraft(): Promise<TerrainEdit | undefined> {
        const ring = this.state.closeDraft();
        if (!ring) return undefined;
        const siteId = this.siteId();
        if (!siteId) {
            this.notice.set('This course has no site/map yet — set a map area first.');
            return undefined;
        }
        const op = this.op.peek();
        const params = op === 'plane'
            ? { featherM: this.featherM.peek(), ...(this.flat.peek() ? { flat: true } : {}) }
            : { featherM: this.featherM.peek(), radiusM: this.radiusM.peek() };
        this.saving.set(true);
        try {
            const created = await this.editsApi.create({
                siteId,
                op,
                params,
                rings: [ring.points.map(p => ({ x: p.x, y: p.y }))],
            });
            this.edits.update(list => [...list, created]);
            this.notice.set(null);
            return created;
        } catch (e) {
            this.notice.set(`Saving the terrain edit failed: ${message(e)}`);
            return undefined;
        } finally {
            this.saving.set(false);
        }
    }

    /** Toggle an edit's enabled flag (disabled edits are skipped at build time). */
    async setEnabled(id: string, enabled: boolean): Promise<void> {
        const edit = this.edits.peek().find(e => e.id === id);
        if (!edit) return;
        try {
            const updated = await this.editsApi.update({ id, version: edit.version, enabled });
            this.edits.update(list => list.map(e => (e.id === id ? updated : e)));
        } catch (e) {
            // Version conflict (edited elsewhere) or transient failure:
            // resync from the server so the list shows current versions,
            // THEN set the notice (reload clears it on success).
            await this.reload();
            this.notice.set(`Updating the edit failed: ${message(e)}`);
        }
    }

    /** Delete an edit permanently. */
    async remove(id: string): Promise<void> {
        const edit = this.edits.peek().find(e => e.id === id);
        if (!edit) return;
        try {
            await this.editsApi.remove({ id, version: edit.version });
            this.edits.update(list => list.filter(e => e.id !== id));
        } catch (e) {
            await this.reload(); // resync (order per setEnabled)
            this.notice.set(`Deleting the edit failed: ${message(e)}`);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // "Apply to terrain" (T56) — the fast re-terrain job: the server exports
    // the site's enabled edits (D-TE5 GeoJSON) → `apply-dem-edits` →
    // tile-terrain/tile-hillshade → partial install + manifest refresh,
    // reusing the map-build job plumbing (job row + progress polling).
    // ─────────────────────────────────────────────────────────────────────────

    /** True while the re-terrain job is starting/running. */
    readonly applying = new Signal(false);
    /** Human label of the running re-terrain step (panel progress line). */
    readonly applyStep = new Signal<string | null>(null);
    /** Whether "Apply to terrain" can start (no job already in flight). */
    readonly canApply = new Computed(() => !this.applying.get());

    /**
     * Start the fast re-terrain job and poll it to completion (map-build
     * polling contract). Applying with zero ENABLED edits is deliberate — it
     * re-tiles from the raw DEM, i.e. reverts previous applies. On success
     * the tile manifest changed (`generatedAt` → new `?v=`), so the tileset
     * is reloaded to re-init the map — tiles carry year-long immutable cache
     * headers and same-URL refetches would serve stale bytes (clean-tool
     * precedent).
     */
    async applyToTerrain(): Promise<boolean> {
        const ctx = this.ctx;
        if (!ctx || this.applying.peek()) return false;
        this.applying.set(true);
        this.notice.set(null);
        try {
            let job: MapBuildJob = await this.mapBuildApi.reTerrain({ courseId: ctx.courseId });
            this.applyStep.set(stepLabel(job));
            while (job.status === 'pending' || job.status === 'running') {
                await sleep(this.pollMs);
                try {
                    job = await this.mapBuildApi.status({ jobId: job.id });
                    this.applyStep.set(stepLabel(job));
                } catch {
                    // Transient poll failure — keep polling; a persistent one
                    // surfaces via the job row (or the reTerrain error path).
                }
            }
            if (job.status !== 'succeeded') {
                this.notice.set(`Applying to terrain failed: ${job.error ?? 'unknown error'}`);
                return false;
            }
            await this.reloadTiles();
            this.notice.set('Terrain re-tiled with the current edits.');
            return true;
        } catch (e) {
            this.notice.set(`Applying to terrain failed: ${message(e)}`);
            return false;
        } finally {
            this.applying.set(false);
            this.applyStep.set(null);
        }
    }

    /**
     * Reload the tile manifest so the editor canvas re-inits the map against
     * the new `?v=`, keeping the camera where the user was working
     * (clean-tool reloadTiles pattern).
     */
    private async reloadTiles(): Promise<void> {
        const ctx = this.ctx;
        if (!ctx) return;
        const map = ctx.map.map.peek();
        const camera = map
            ? { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() }
            : null;
        await ctx.tileset.reload(ctx.courseId);
        if (!camera) return;
        let restored = false;
        const stop = effect(() => {
            if (restored || !ctx.map.ready.get()) return;
            restored = true;
            ctx.map.map.peek()?.jumpTo(camera);
            queueMicrotask(() => stop());
        });
        // Don't leak the effect if the new map never becomes ready.
        setTimeout(() => { if (!restored) stop(); }, 15_000);
    }

    // ── Map event handling ──────────────────────────────────────────────────

    private onClick(e: MapPointerEvent): void {
        // Interaction contract (map/interaction.ts): bail unless we hold the claim.
        if (this.ctx?.map.interactionMode.peek() !== TERRAIN_EDIT_TOOL_ID) return;
        const draft = this.state.draft.peek();
        if (draft.length >= MIN_RING_POINTS && this.screenDist(draft[0], e.point) < CLOSE_RING_PX) {
            void this.closeDraft();
            return;
        }
        this.state.addPoint(lngLatToSweref99tm(e.lngLat));
    }

    /** Screen-pixel distance from an EPSG:3006 point to a screen position. */
    private screenDist(p: AnchorPoint, screen: { x: number; y: number }): number {
        const map = this.ctx?.map.map.peek();
        if (!map) return Infinity;
        const { lat, lon } = sweref99tmToWgs84(p.x, p.y);
        const projected = map.project([lon, lat]);
        return Math.hypot(projected.x - screen.x, projected.y - screen.y);
    }

    // ── Overlay flush (microtask-coalesced) ────────────────────────────────

    private scheduleRender(): void {
        if (this.renderScheduled) return;
        this.renderScheduled = true;
        queueMicrotask(() => {
            this.renderScheduled = false;
            const ctx = this.ctx;
            const renderer = this.renderer;
            if (!ctx || !renderer) return; // deactivated before the flush
            if (!ctx.map.ready.peek()) return; // map died before the flush
            renderer.render(ctx.map, this.view.peek());
        });
    }
}

function message(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Progress-line label for a job's current step ("Tile terrain…"). */
function stepLabel(job: MapBuildJob): string | null {
    return job.step ? STEP_LABELS[job.step] ?? job.step : null;
}
