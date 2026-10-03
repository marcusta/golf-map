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
import { canvasCursor } from '../editor/canvas-cursor';
import { screenDistSweref } from '../editor/screen-point';
import { isTypingTarget } from '../editor/shortcut.service';
import { api } from '../api';
import type { TerrainEdit, TerrainEditsApi } from '../../../shared/api/terrain-edits.gen';
import type { MapBuildApi, MapBuildJob } from '../../../shared/api/map-build.gen';
import type { CoursesApi } from '../../../shared/api/courses.gen';
import { STEP_LABELS } from '../map-build/map-build.service';
import type { ToolContext } from '../editor/tool';
import type { MapPointerEvent, MapService } from '../map/map.service';
import { deriveTileVersion, parseTileManifest, type TileManifest } from '../map/tileset.service';
import { buildEditorStyle, HILLSHADE_SOURCE_ID, TERRAIN_SOURCE_ID } from '../map/map-style';
import type { AnchorPoint, Point } from '../geo/bezier';
import { DrawState, MIN_RING_POINTS } from '../draw/draw-state';
import { lngLatToSweref99tm } from '../geo/transform';

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
    /**
     * Pointer position (EPSG:3006) for the rubber band from the last draft
     * point. Null while no draft is open or while a mouse button is held.
     */
    cursor: Point | null;
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

    /** Pointer position for the rubber band (see TerrainEditView.cursor). */
    readonly cursor = new Signal<Point | null>(null);

    /** Renderable overlay state (persisted edits, the live draft, the pointer). */
    readonly view = new Computed<TerrainEditView>(() => ({
        edits: this.edits.get(),
        draft: this.state.draft.get(),
        cursor: this.cursor.get(),
    }));

    private ctx: ToolContext | null = null;
    private renderer: TerrainEditRenderer | null = null;
    /** True while a render flush is queued (microtask coalescing). */
    private renderScheduled = false;
    /** Monotonic token so a stale list response never clobbers a newer one. */
    private loadSeq = 0;
    /** Aborts the running re-terrain poll (deactivate, canvas unmount). */
    private applyAbort: AbortController | null = null;

    constructor(
        private editsApi: TerrainEditsApi = api.terrainEdits,
        private mapBuildApi: MapBuildApi = api.mapBuild,
        /** Poll interval override for tests (real timers). */
        private pollMs: number = POLL_MS,
        /** Course GET for the post-apply manifest (new tile version). */
        private coursesApi: Pick<CoursesApi, 'get'> = api.courses,
    ) {}

    // ── EditorTool lifecycle (called via terrain-edit-tool.ts) ─────────────

    activate(ctx: ToolContext, renderer: TerrainEditRenderer): void {
        this.ctx = ctx;
        this.renderer = renderer;
        this.notice.set(null);

        ctx.track(ctx.map.onClick(e => this.onClick(e)));
        ctx.track(ctx.map.onMouseMove(e => this.onMouseMove(e)));

        // Draft keys (draw-tool key map). A bubbling window listener: the
        // ShortcutService dispatcher sees keys first and stops propagation
        // for the ones its layers consume (Esc chain, editor-wide keys).
        const onKeyDown = (e: KeyboardEvent) => this.onKeyDown(e);
        window.addEventListener('keydown', onKeyDown);
        ctx.track(() => window.removeEventListener('keydown', onKeyDown));

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
        ctx.track(canvasCursor(ctx.map, () => 'crosshair'));

        // The tool is always drawing — there is no select sub-mode here.
        this.state.arm();
        void this.reload();
    }

    deactivate(): void {
        this.abortApply();
        this.state.disarm();
        this.cursor.set(null);
        this.saving.set(false);
        this.ctx = null;
        this.renderer = null;
    }

    /**
     * Stop polling a running re-terrain job. The server job keeps running;
     * only this client stops waiting for it and skips the tile refresh.
     */
    abortApply(): void {
        this.applyAbort?.abort();
        this.applyAbort = null;
    }

    /**
     * True while a draft ring has points: the editor-wide sub-mode letters
     * fall through instead of switching tools and discarding the outline.
     */
    isBusy(): boolean {
        return this.state.draft.peek().length > 0;
    }

    /** ESC: cancel an in-progress draft (stay active) → deactivate. */
    onEscape(): boolean {
        if (this.state.draft.peek().length > 0) {
            this.state.disarm();
            this.state.arm(); // stay in draw mode for the next outline
            this.cursor.set(null);
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
        this.cursor.set(null);
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
     * polling contract). Applying with zero ENABLED edits is deliberate: it
     * re-tiles from the raw DEM, i.e. reverts previous applies. On success
     * the tile manifest has a new `generatedAt`, so new `?v=` URLs; tiles
     * carry year-long immutable cache headers, so the same URL would serve
     * stale bytes. See refreshTerrain for how the map picks them up.
     *
     * Deactivating the tool or unmounting the canvas aborts the poll
     * (abortApply): no further status requests, no tile refresh, no notice.
     */
    async applyToTerrain(): Promise<boolean> {
        const ctx = this.ctx;
        if (!ctx || this.applying.peek()) return false;
        const abort = new AbortController();
        this.applyAbort = abort;
        const signal = abort.signal;
        this.applying.set(true);
        this.notice.set(null);
        try {
            let job: MapBuildJob = await abortable(this.mapBuildApi.reTerrain({ courseId: ctx.courseId }), signal);
            this.applyStep.set(stepLabel(job));
            while (job.status === 'pending' || job.status === 'running') {
                await sleep(this.pollMs, signal);
                try {
                    job = await abortable(this.mapBuildApi.status({ jobId: job.id }), signal);
                    this.applyStep.set(stepLabel(job));
                } catch (e) {
                    if (signal.aborted) throw e;
                    // Transient poll failure: keep polling; a persistent one
                    // surfaces via the job row (or the reTerrain error path).
                }
            }
            if (job.status !== 'succeeded') {
                this.notice.set(`Applying to terrain failed: ${job.error ?? 'unknown error'}`);
                return false;
            }
            await this.refreshTerrain(ctx, signal);
            if (signal.aborted) return false;
            this.notice.set('Terrain re-tiled with the current edits.');
            return true;
        } catch (e) {
            if (signal.aborted) return false;
            this.notice.set(`Applying to terrain failed: ${message(e)}`);
            return false;
        } finally {
            if (this.applyAbort === abort) this.applyAbort = null;
            this.applying.set(false);
            this.applyStep.set(null);
        }
    }

    /**
     * Show the re-tiled terrain. A re-terrain job changes only the terrain
     * and hillshade tiles, so when the live map's layer set still matches the
     * new manifest, the terrain and hillshade sources are pointed at the new
     * `?v=` in place: no map re-init, no camera move, ortho and overlays
     * untouched. `displayedVersion` is set before the tileset reloads so the
     * editor canvas sees the live map already showing that version and skips
     * its re-init (the Clean-tool refreshOrthoTiles contract). The elevation
     * sampler is re-pointed at the new tiles, since the canvas only does that
     * on re-init.
     *
     * Falls back to the full re-init (tileset reload, camera restored) when
     * there is no live map or the manifest's layer set or zoom ranges changed.
     */
    private async refreshTerrain(ctx: ToolContext, signal: AbortSignal): Promise<void> {
        const course = await abortable(this.coursesApi.get({ id: ctx.courseId }), signal);
        const manifest = parseTileManifest(course.tileManifestJson);
        const mapKey = course.siteId ?? null;
        const prev = ctx.tileset.manifest.peek();
        const live = ctx.map.ready.peek() && ctx.map.map.peek() !== null;
        if (!manifest || !mapKey || !prev || !live
            || mapKey !== ctx.tileset.mapKey.peek()
            || !sameTerrainLayout(prev, manifest)) {
            await this.reloadTiles(ctx);
            return;
        }
        const version = deriveTileVersion(manifest.generatedAt);
        const { sources } = buildEditorStyle(mapKey, manifest, version);
        for (const id of [TERRAIN_SOURCE_ID, HILLSHADE_SOURCE_ID]) {
            const tiles = (sources[id] as { tiles?: string[] } | undefined)?.tiles;
            if (tiles?.[0]) ctx.map.setRasterTileUrl(id, tiles[0]);
        }
        ctx.map.displayedVersion.set(version);
        ctx.elevation?.configure({ mapKey, zoom: manifest.layers.terrain.maxzoom, version });
        await ctx.tileset.reload(ctx.courseId);
    }

    /**
     * Full re-init fallback: reload the tile manifest so the editor canvas
     * re-inits the map against the new `?v=`, keeping the camera where the
     * user was working (clean-tool reloadTiles pattern).
     */
    private async reloadTiles(ctx: ToolContext): Promise<void> {
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
        if (draft.length >= MIN_RING_POINTS && this.screenDistTo(draft[0], e.point) < CLOSE_RING_PX) {
            void this.closeDraft();
            return;
        }
        this.state.addPoint(lngLatToSweref99tm(e.lngLat));
    }

    /**
     * Rubber band: track the pointer while a draft is open. Off while any
     * mouse button is held (a pan drag), and untracked with an empty draft so
     * plain hovering never re-renders the overlay.
     */
    private onMouseMove(e: MapPointerEvent): void {
        if (this.ctx?.map.interactionMode.peek() !== TERRAIN_EDIT_TOOL_ID) return;
        if (this.state.draft.peek().length === 0 || e.originalEvent.buttons !== 0) {
            if (this.cursor.peek() !== null) this.cursor.set(null);
            return;
        }
        const p = lngLatToSweref99tm(e.lngLat);
        const prev = this.cursor.peek();
        if (prev && prev.x === p.x && prev.y === p.y) return;
        this.cursor.set({ x: p.x, y: p.y });
    }

    /**
     * Draft keys, matching the draw tool while a ring is open: Backspace and
     * Cmd/Ctrl+Z remove the last point, Cmd/Ctrl+Shift+Z and Cmd/Ctrl+Y put it
     * back, Enter closes and saves the ring. Esc stays with onEscape. With no
     * open draft nothing is consumed.
     */
    onKeyDown(e: KeyboardEvent): void {
        if (this.ctx?.map.interactionMode.peek() !== TERRAIN_EDIT_TOOL_ID) return;
        if (isTypingTarget(e.target)) return;
        if (this.state.draft.peek().length === 0) return;
        const meta = e.metaKey || e.ctrlKey;
        const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

        if (meta && !e.altKey && key === 'z') {
            e.preventDefault();
            if (e.shiftKey) this.state.redoPoint();
            else this.undoPoint();
        } else if (meta && !e.altKey && key === 'y') {
            e.preventDefault();
            this.state.redoPoint();
        } else if (!meta && !e.altKey && key === 'Backspace') {
            e.preventDefault();
            this.undoPoint();
        } else if (!meta && !e.altKey && key === 'Enter') {
            if (!this.state.canClose.peek()) return;
            e.preventDefault();
            void this.closeDraft();
        }
    }

    /**
     * Drop the last draft point. Undoing the only point clears the draft but
     * keeps the tool armed (DrawState.undoPoint would disarm it; this tool is
     * always drawing).
     */
    private undoPoint(): void {
        if (this.state.undoPoint() === 'cancelled') {
            this.state.arm();
            this.cursor.set(null);
        }
    }

    /** Flat screen-pixel distance from an EPSG:3006 point to a screen position. */
    private screenDistTo(p: AnchorPoint, screen: { x: number; y: number }): number {
        const map = this.ctx?.map.map.peek();
        return map ? screenDistSweref(map, p, screen) : Infinity;
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

function abortError(): Error {
    return new DOMException('The re-terrain poll was aborted', 'AbortError');
}

/** setTimeout as a promise; rejects (and clears the timer) on abort. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortError());
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Settle with `p`, or reject as soon as `signal` aborts. The generated API
 * clients take no AbortSignal, so an in-flight request still completes on
 * the wire; the caller just stops waiting for it.
 */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });
        p.then(
            v => { signal.removeEventListener('abort', onAbort); resolve(v); },
            e => { signal.removeEventListener('abort', onAbort); reject(e); },
        );
    });
}

/**
 * True when `next` builds the same terrain and hillshade sources as `prev`
 * apart from the tile URL version: same bounds, same zoom ranges, and the
 * same hillshade kind (baked raster vs client-side raster-dem). setTiles can
 * only swap URLs, not change any of these.
 */
function sameTerrainLayout(prev: TileManifest, next: TileManifest): boolean {
    const zooms = (l: { minzoom: number; maxzoom: number } | undefined) => (l ? `${l.minzoom}-${l.maxzoom}` : '');
    const b = (m: TileManifest) => `${m.bounds.west},${m.bounds.south},${m.bounds.east},${m.bounds.north}`;
    return b(prev) === b(next)
        && zooms(prev.layers.terrain) === zooms(next.layers.terrain)
        && zooms(prev.layers.hillshade) === zooms(next.layers.hillshade);
}

/** Progress-line label for a job's current step ("Tile terrain…"). */
function stepLabel(job: MapBuildJob): string | null {
    return job.step ? STEP_LABELS[job.step] ?? job.step : null;
}
