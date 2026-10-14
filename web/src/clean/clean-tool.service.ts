// "Clean photo" tool: retouching the cleaned photo's own pixels, for
// GOLF-SIMULATOR EXPORT.
//
// ## Two photos
//
// Cleaning NEVER touches the planning/playing imagery. The cleaned photo is
// one 8192 px image per site (server CleanedPhotoService). While this tool is
// active the live map's flat ortho source points at its tile layer
// (`tiles/<mapKey>/ortho-sim/`, served with per-tile pristine fallback and
// its own `?v=` stamp); the panel toggle flips back for comparison and
// deactivating always restores the pristine photo. The web planner and iOS
// bundles only ever see the pristine tree.
//
// ## Working on the pixels
//
// Entering the tool loads the photo's pixels into the pixel engine
// (retouch-engine.ts): PhotoCraft's retouching, compiled to WebAssembly,
// running in a worker. Every stroke changes those pixels directly:
//
//   clone   Clone Stamp: Alt-click picks the source, drag paints a copy.
//   heal    Healing Brush: like the stamp, blended into its surroundings
//           on release.
//   spot    Spot Healing: paint over a blemish, no source.
//   remove  Remove: paint over (or around) an object; it is filled from its
//           surroundings.
//
// Clone and heal preview live while the stroke is drawn; spot and remove
// show the stroke as a red band and compute on release. What an operation
// changed comes back as a rectangle of pixels. It goes two ways at once:
//
//   - onto the map, through canvas layers of 512 photo pixels each
//     (stamp-canvas-view.ts) that are transparent wherever the photo is as
//     it was loaded, so untouched ground stays the map's own tiles;
//   - to the server (`PUT /cleaned-photo/:id/pixels`), which writes it into
//     the photo file and rewrites the tiles under it. Saves run one at a
//     time in the background, in order. There is nothing to bake.
//
// Ctrl+Z / Ctrl+Shift+Z step through the engine's history; the restored
// pixels are saved like a stroke. The first save after a load asks the
// server to keep the photo from before, so the panel's "Undo last change"
// steps back a whole editing session (or an import).
//
// ## Areas and the image editor round trip
//
// `areas` mode draws the cleanup boundaries (cleanup-areas.controller.ts)
// and changes no pixels. `exportUrl()` downloads the photo as a PNG and
// `importPhoto()` uploads any image of its size to become the photo. An
// import or a server-side undo reloads the pixels. The push into Unity is
// not here: the command bar's **Update photo** runs the Photo target's whole
// chain (docs/gspro/export.md).
//
// All I/O sits behind constructor seams (the engine, the pixel save, the
// photo API, the map views, the frame clock) so the whole state machine runs
// under bun test.

import { Signal, effect } from '@basics/core/client/core';
import type { Map as MaplibreMap, MapMouseEvent } from 'maplibre-gl';
import type { GeoJSON } from 'geojson';
import type { ToolContext } from '../editor/tool';
import { bindDrag, type DragBinding } from '../editor/drag-binding';
import { FEATURE_TYPES } from '../draw/feature-palette';
import type { MapPointerEvent } from '../map/map.service';
import { deriveTileVersion } from '../map/tileset.service';
import type { CleanedPhotoApi, CleanedPhotoResult } from '../../../shared/api/cleaned-photo.gen';
import { CLEANED_IMPORT_MAX_BYTES, CLEANED_PHOTO_SIZE } from '../../../shared/cleaned-photo';
import { api, API_BASE } from '../api';
import { lngLatToSweref99tm, sweref99tmToLngLat } from '../geo/transform';
import { PhotoImportClient, PhotoImportError, cleanedPhotoExportUrl, importSummaryText } from './clean-external';
import { workerRetouchEngine, type Changed, type RetouchEngine, type RetouchEngineFactory } from './retouch-engine';
import { canvasStampView, type StampSurfaceView, type StampViewFactory } from './stamp-canvas-view';
import { CleanupAreasController } from './cleanup-areas.controller';
import { canvasCursor } from '../editor/canvas-cursor';

/** Interaction-claim id for the Clean tool (also its registry id). */
export const CLEAN_TOOL_ID = 'clean';

export const CLEAN_SOURCE_OVERLAY_ID = 'clean-stamp-source';
export const CLEAN_BRUSH_OVERLAY_ID = 'clean-stamp-brush';
export const CLEAN_STROKE_OVERLAY_ID = 'clean-stroke';

/** Edge of one map layer of changed pixels, in photo pixels. */
export const CLEAN_BLOCK_PX = 512;
/** Minimum photo-pixel movement before a new stroke point is recorded. */
const STROKE_SAMPLE_PX = 1;
/** [ / ] brush resize factor. */
const BRUSH_SIZE_STEP = 1.25;
export const BRUSH_SIZE_MIN_M = 0.5;
export const BRUSH_SIZE_MAX_M = 30;

/** The retouching tools, and `areas` (the cleanup boundaries). */
export type CleanMode = 'clone' | 'heal' | 'spot' | 'remove' | 'areas';
export type RetouchTool = Exclude<CleanMode, 'areas'>;
/** `applying`: a server-side undo or an import is running. */
export type CleanPhase = 'idle' | 'applying';
/** Where the photo's pixels are: not asked for, on their way, in the engine, or failed. */
export type PhotoLoad = 'none' | 'loading' | 'ready' | 'error';
export type SaveState = 'saved' | 'saving' | 'error';

/** PhotoCraft's command for each tool. */
const COMMAND: Record<RetouchTool, string> = {
    clone: 'paint.cloneStamp',
    heal: 'paint.healingBrush',
    spot: 'paint.spotHealing',
    remove: 'paint.remove',
};

/** Clone Stamp and Healing Brush: a source, and a live preview. */
const isLive = (tool: CleanMode): tool is 'clone' | 'heal' => tool === 'clone' || tool === 'heal';

/** Animation-frame seam: the live stroke sends points at most once per frame. */
export interface FrameScheduler {
    request(cb: () => void): number;
    cancel(handle: number): void;
}

export const browserFrames: FrameScheduler = {
    request: cb => (typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(() => cb())
        : (setTimeout(cb, 16) as unknown as number)),
    cancel: handle => {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
        else clearTimeout(handle);
    },
};

/** Map-side seams: the block views (canvas sources) and the frame clock. */
export interface CleanLiveSeams {
    views?: StampViewFactory;
    frames?: FrameScheduler;
}

/** Writes changed pixels into the photo file on the server. `snapshot` keeps
 * the photo from before as an undo step. */
export type PixelSaver = (courseId: string, changed: Changed, snapshot: boolean) => Promise<CleanedPhotoResult>;

export const fetchPixelSaver: PixelSaver = async (courseId, changed, snapshot) => {
    const { x, y, w, h } = changed.rect;
    const url = `${API_BASE}/cleaned-photo/${encodeURIComponent(courseId)}/pixels?x=${x}&y=${y}&w=${w}&h=${h}${snapshot ? '&snapshot=1' : ''}`;
    const res = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: changed.rgba as Uint8ClampedArray<ArrayBuffer>,
    });
    if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
            message = ((await res.json()) as { error?: string }).error ?? message;
        } catch {
            // Not a JSON error body.
        }
        throw new Error(message);
    }
    return (await res.json()) as CleanedPhotoResult;
};

/** Where the photo's raw pixels load from. */
export function cleanedPhotoPixelsUrl(courseId: string, baseUrl: string = API_BASE): string {
    return `${baseUrl}/cleaned-photo/${encodeURIComponent(courseId)}/pixels.rgb`;
}

/** The photo on the ground: its north-west corner (EPSG:3006) and pixel size. */
interface PhotoGeo {
    west: number;
    north: number;
    /** Metres per pixel. */
    res: number;
    /** Pixels per side. */
    size: number;
}

interface Px {
    x: number;
    y: number;
}

interface ActiveStroke {
    tool: RetouchTool;
    /** Every point so far, in photo pixels. */
    points: Px[];
    /** How many of them the engine has (live tools). */
    sent: number;
    /** Brush params as PhotoCraft takes them. */
    params: Record<string, unknown>;
    /** Path on the map, for the red band of spot / remove. */
    lngLats: Array<[number, number]>;
    last: { lng: number; lat: number };
}

/**
 * DI singleton behind the `clean` EditorTool (clean-tool.ts) and its panel
 * (clean-panel.component.ts). See the module header for the flow.
 */
export class CleanToolService {
    readonly areas = new CleanupAreasController();

    setMode(mode: CleanMode): void {
        if (this.areas.kind.peek() || (this.mode.peek() === 'areas' && this.areas.busy.peek()) || this.phase.peek() !== 'idle') return;
        if (this.stroke) return;
        this.mode.set(mode);
        if (mode === 'areas') {
            this.removeRing(CLEAN_BRUSH_OVERLAY_ID);
            this.removeRing(CLEAN_SOURCE_OVERLAY_ID);
            if (!this.areas.document.peek()) void this.areas.reload();
        } else {
            this.updateRings();
        }
    }

    readonly mode = new Signal<CleanMode>('clone');
    readonly phase = new Signal<CleanPhase>('idle');
    /** One-line panel notice (why the last action produced nothing). */
    readonly notice = new Signal<string | null>(null);
    /** The photo's pixels in the engine. */
    readonly photo = new Signal<PhotoLoad>('none');
    /** 0..1 while the pixels load. */
    readonly loadProgress = new Signal(0);
    /** Why the photo could not be loaded (state `error`). */
    readonly loadError = new Signal<string | null>(null);
    /** A spot heal or a removal is computing. */
    readonly working = new Signal(false);
    /** Whether everything painted has reached the photo file. */
    readonly saveState = new Signal<SaveState>('saved');
    readonly saveError = new Signal<string | null>(null);
    /** Steps Ctrl+Z / Ctrl+Shift+Z can take in this session. */
    readonly undoSteps = new Signal(0);
    readonly redoSteps = new Signal(0);
    /** Server-side undo steps: editing sessions and imports. */
    readonly undoDepth = new Signal(0);
    /** Whether the cleaned photo exists yet (the first load, save or import makes it). */
    readonly photoExists = new Signal(false);
    /** Dual photo state: show the cleaned photo while the tool is active.
     * Toggled from the panel for comparison; always restored to pristine on
     * deactivate. */
    readonly showCleaned = new Signal(true);

    // Import / undo state.
    /** Which long operation holds the 'applying' phase, if any. */
    readonly externalBusy = new Signal<'import' | 'undo' | null>(null);
    /** Upload progress 0..1 while importing; 1 means "sent, server working". */
    readonly uploadProgress = new Signal<number | null>(null);
    /** What the last import did, in one line. */
    readonly importSummary = new Signal<string | null>(null);
    /** One line for the import section: an error or a plain status. */
    readonly externalMessage = new Signal<{ kind: 'error' | 'info'; text: string } | null>(null);

    // Brush (right-sidebar controls).
    readonly brushSizeM = new Signal(3);
    readonly brushOpacity = new Signal(1);
    readonly brushFlow = new Signal(1);
    readonly brushHardness = new Signal(0.7);
    readonly cloneAligned = new Signal(true);
    /** A clone source has been picked (panel hint gating). */
    readonly hasSource = new Signal(false);

    private ctx: ToolContext | null = null;
    /** Kept after deactivation: saves still in flight belong to it. */
    private courseId: string | null = null;
    private dragBinding: DragBinding | null = null;

    private engine: RetouchEngine | null = null;
    private geo: PhotoGeo | null = null;
    /** Engine calls run one after another, in the order they were made. */
    private ops: Promise<void> = Promise.resolve();
    private readonly blocks = new Map<string, StampSurfaceView>();
    /** Blocks a change of this load has reached. */
    private readonly touched = new Set<string>();

    /** The tile version the map shows (null before the first change ever). */
    private shownSimGeneratedAt: string | null = null;

    private saves: Changed[] = [];
    private saving: Promise<void> | null = null;
    /** A save of this load has asked the server to keep the photo from before. */
    private sessionSaved = false;

    private source: Px | null = null;
    /** Clone offset in photo pixels, once an aligned stroke has set it. */
    private alignedOffset: [number, number] | null = null;
    private lastDab: { lng: number; lat: number } | null = null;
    private stroke: ActiveStroke | null = null;
    private pumping = false;
    /** Last pointer position, in photo pixels: the brush ring. */
    private hover: Px | null = null;
    private readonly rings = new Set<string>();
    private strokeOverlayLive = false;
    private frame: number | null = null;
    private readonly views: StampViewFactory;
    private readonly frames: FrameScheduler;

    constructor(
        private engines: RetouchEngineFactory = workerRetouchEngine,
        private photoApi: CleanedPhotoApi = api.cleanedPhoto,
        private savePixels: PixelSaver = fetchPixelSaver,
        live: CleanLiveSeams = {},
        private importClient: PhotoImportClient = new PhotoImportClient(),
    ) {
        this.views = live.views ?? canvasStampView;
        this.frames = live.frames ?? browserFrames;
    }

    // ── EditorTool lifecycle ────────────────────────────────────────────────

    activate(ctx: ToolContext): void {
        this.ctx = ctx;
        this.courseId = ctx.courseId;
        this.areas.activate(ctx);
        ctx.track(effect(() => this.areas.enabled.set(this.mode.get() === 'areas')));
        ctx.track(canvasCursor(ctx.map, () =>
            this.mode.get() === 'areas' && this.areas.kind.get() ? 'crosshair' : ''));
        this.notice.set(null);
        void this.open();
        // Cleaning works on the bare photo: every feature fill and outline
        // is off the map for the tool's span (restored in `deactivate`).
        ctx.features?.modeHiddenTypes.set(new Set(FEATURE_TYPES));
        ctx.track(ctx.map.onClick(e => this.onClick(e)));
        ctx.track(ctx.map.onMouseMove(e => this.onMouseMove(e)));

        // Raw mousedown/mouseup (strokes, area tracing) need the live map
        // instance; the drag binding rebinds whenever a (re)created map
        // turns ready.
        this.dragBinding = bindDrag(ctx, {
            toolId: CLEAN_TOOL_ID,
            onDown: (e, map) => this.onRawMouseDown(e, map),
            onUp: (e, map) => {
                if (this.areas.pointerUp(e)) {
                    this.dragBinding?.suppressNextClick();
                    this.releasePan(map);
                    return;
                }
                this.onRawMouseUp(map);
            },
        });
        // Re-apply the photo state (sim vs pristine ortho source) whenever
        // a (re)created map turns ready.
        ctx.track(effect(() => {
            if (!ctx.map.ready.get()) return;
            this.applyPhotoState();
        }));

        const onKeyDown = (e: KeyboardEvent) => this.onKeyDown(e);
        window.addEventListener('keydown', onKeyDown);
        ctx.track(() => window.removeEventListener('keydown', onKeyDown));
    }

    deactivate(): void {
        const ctx = this.ctx;
        this.areas.deactivate();
        this.cancelStroke();
        this.cancelFrame();
        ctx?.features?.resetModeView();
        this.removeRing(CLEAN_SOURCE_OVERLAY_ID);
        this.removeRing(CLEAN_BRUSH_OVERLAY_ID);
        this.hover = null;
        this.closePhoto();
        this.phase.set('idle');
        this.notice.set(null);
        this.externalBusy.set(null);
        this.uploadProgress.set(null);
        this.importSummary.set(null);
        this.externalMessage.set(null);
        // Always hand the map back showing the PRISTINE photo.
        const pristine = ctx?.tileset.tileVersion.peek();
        if (ctx && pristine) ctx.map.setOrthoPhotoState('ortho', pristine);
        this.dragBinding = null;
        this.ctx = null;
        // Saves still in flight carry on; `courseId` stays for them.
    }

    /** ESC: a stroke or an area draft is cancelled; else the toolbar exits. */
    onEscape(): boolean {
        if (this.mode.peek() === 'areas' && this.areas.busy.peek()) return true;
        if (this.areas.kind.peek()) { this.areas.cancel(); this.releasePan(); return true; }
        if (this.stroke) {
            this.cancelStroke();
            return true;
        }
        return false;
    }

    /** Settles when every engine call made so far has run and every change is saved (or a save failed). */
    async settled(): Promise<void> {
        await this.ops;
        while (this.saving) await this.saving;
        await this.ops;
    }

    // ── The photo: info, pixels, map layers ─────────────────────────────────

    /** On activation: where the photo lies, then its pixels. */
    private async open(): Promise<void> {
        await this.refreshInfo();
        await this.loadPhoto();
    }

    /**
     * Refresh the undo count and the photo's place from the server. `resync`
     * also loads the pixels and the tiles again (the panel's Refresh: an
     * import that outlived its request finished in the background).
     */
    async refreshInfo(opts: { resync?: boolean } = {}): Promise<void> {
        const ctx = this.ctx;
        if (!ctx) return;
        try {
            const info = await this.photoApi.cleanedPhotoInfo({ courseId: ctx.courseId });
            if (this.ctx !== ctx) return;
            this.undoDepth.set(info.undoDepth);
            this.photoExists.set(info.exists);
            const b = info.bounds3006;
            this.geo = b ? { west: b.west, north: b.north, res: (b.east - b.west) / info.size, size: info.size } : null;
            if (!b) {
                this.photo.set('error');
                this.loadError.set(info.reason ?? "This course's map must be built before its photo can be cleaned.");
            }
            if (opts.resync && b) {
                await this.settled();
                if (this.ctx === ctx) await this.reloadPhoto(info.patchesGeneratedAt);
            } else if (!this.engine) {
                this.shownSimGeneratedAt = info.patchesGeneratedAt;
                this.applyPhotoState();
            }
        } catch {
            // The tool says what is wrong when the pixels fail to load.
        }
    }

    /** Load the photo's pixels into a fresh engine. */
    private async loadPhoto(): Promise<void> {
        const ctx = this.ctx;
        if (!ctx || !this.geo || this.engine) return;
        const engine = this.engines();
        this.engine = engine;
        this.ops = Promise.resolve();
        this.photo.set('loading');
        this.loadProgress.set(0);
        this.loadError.set(null);
        this.undoSteps.set(0);
        this.redoSteps.set(0);
        this.sessionSaved = false;
        try {
            await engine.load(cleanedPhotoPixelsUrl(ctx.courseId), f => {
                if (this.engine === engine) this.loadProgress.set(f);
            });
            if (this.engine !== engine) return;
            this.photoExists.set(true);
            this.photo.set('ready');
        } catch (err) {
            if (this.engine !== engine) return;
            engine.dispose();
            this.engine = null;
            this.photo.set('error');
            this.loadError.set(`The photo could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    /** Retry after a failed load (panel button). */
    retryLoad(): Promise<void> {
        return this.open();
    }

    /** Drop the engine and its map layers. */
    private closePhoto(): void {
        this.engine?.dispose();
        this.engine = null;
        this.ops = Promise.resolve();
        for (const view of this.blocks.values()) view.remove();
        this.blocks.clear();
        this.touched.clear();
        this.photo.set('none');
        this.working.set(false);
        this.undoSteps.set(0);
        this.redoSteps.set(0);
        this.alignedOffset = null;
    }

    /** The photo file changed under the engine (server undo, import): show
     * the new tiles and load the pixels again. */
    private async reloadPhoto(generatedAt: string | null): Promise<void> {
        const ctx = this.ctx;
        if (!ctx) return;
        this.closePhoto();
        this.shownSimGeneratedAt = generatedAt;
        this.applyPhotoState();
        await ctx.tileset.refreshTiles(ctx.courseId);
        await this.loadPhoto();
    }

    /** Panel toggle: cleaned vs original photo while the tool is active. */
    setShowCleaned(value: boolean): void {
        this.showCleaned.set(value);
        this.applyPhotoState();
        if (!value) {
            for (const view of this.blocks.values()) view.remove();
            this.blocks.clear();
            return;
        }
        // Put the session's changes back on the map.
        const engine = this.engine;
        const geo = this.geo;
        if (!engine || !geo) return;
        const B = CLEAN_BLOCK_PX;
        for (const key of this.touched) {
            const [bx, by] = key.split('/').map(Number);
            const rect = { x: bx * B, y: by * B, w: Math.min(B, geo.size - bx * B), h: Math.min(B, geo.size - by * B) };
            void this.enqueue(async () => {
                const rgba = await engine.read(rect);
                if (this.engine === engine) this.show({ rect, rgba });
            });
        }
    }

    /** Point the live flat ortho source at the cleaned layer or the pristine
     * tree per the toggle. Presentation only — never touches the pristine
     * version guard (see MapService.setOrthoPhotoState). */
    private applyPhotoState(): void {
        const ctx = this.ctx;
        if (!ctx || !ctx.map.ready.peek()) return;
        const pristine = ctx.tileset.tileVersion.peek();
        if (!pristine) return;
        if (this.showCleaned.peek()) {
            ctx.map.setOrthoPhotoState('ortho-sim', this.shownSimGeneratedAt ? deriveTileVersion(this.shownSimGeneratedAt) : pristine);
        } else {
            ctx.map.setOrthoPhotoState('ortho', pristine);
        }
    }

    /** Draw changed pixels on the map, block by block. */
    private show(changed: Changed | null): void {
        const ctx = this.ctx;
        const geo = this.geo;
        if (!changed || !ctx || !geo) return;
        const B = CLEAN_BLOCK_PX;
        const { rect, rgba } = changed;
        for (let by = Math.floor(rect.y / B); by * B < rect.y + rect.h; by++) {
            for (let bx = Math.floor(rect.x / B); bx * B < rect.x + rect.w; bx++) {
                const key = `${bx}/${by}`;
                this.touched.add(key);
                if (!this.showCleaned.peek()) continue;
                const x0 = Math.max(rect.x, bx * B);
                const x1 = Math.min(rect.x + rect.w, (bx + 1) * B);
                const y0 = Math.max(rect.y, by * B);
                const y1 = Math.min(rect.y + rect.h, (by + 1) * B);
                const w = x1 - x0;
                const h = y1 - y0;
                const patch = new Uint8ClampedArray(w * h * 4);
                let any = false;
                for (let y = y0; y < y1; y++) {
                    const from = ((y - rect.y) * rect.w + (x0 - rect.x)) * 4;
                    const row = rgba.subarray(from, from + w * 4);
                    patch.set(row, (y - y0) * w * 4);
                    if (!any) for (let i = 3; i < row.length; i += 4) if (row[i]) { any = true; break; }
                }
                let view = this.blocks.get(key);
                if (!view) {
                    // Nothing to show and no layer yet: leave the map alone.
                    if (!any) continue;
                    const corner = (px: number, py: number): [number, number] => {
                        const p = this.toLngLat({ x: px, y: py });
                        return [p.lng, p.lat];
                    };
                    const x = bx * B;
                    const y = by * B;
                    view = this.views(ctx.map, `clean-photo-${bx}-${by}`, B,
                        [corner(x, y), corner(x + B, y), corner(x + B, y + B), corner(x, y + B)]);
                    this.blocks.set(key, view);
                }
                view.put(patch, x0 - bx * B, y0 - by * B, w, h);
            }
        }
    }

    private toPx(lngLat: { lng: number; lat: number }): Px {
        const geo = this.geo!;
        const s = lngLatToSweref99tm(lngLat);
        return { x: (s.x - geo.west) / geo.res, y: (geo.north - s.y) / geo.res };
    }

    private toLngLat(p: Px): { lng: number; lat: number } {
        const geo = this.geo!;
        return sweref99tmToLngLat(geo.west + p.x * geo.res, geo.north - p.y * geo.res);
    }

    /** Queue an engine call behind the ones already made. Never rejects. */
    private enqueue(fn: () => Promise<void>): Promise<void> {
        this.ops = this.ops.then(fn).catch(err => {
            this.notice.set(err instanceof Error ? err.message : String(err));
        });
        return this.ops;
    }

    // ── Saving ──────────────────────────────────────────────────────────────

    /** Queue changed pixels for the photo file and start saving. */
    private save(changed: Changed | null): void {
        if (!changed) return;
        this.saves.push(changed);
        this.startSaving();
    }

    private startSaving(): void {
        if (this.saving || this.saves.length === 0) return;
        const courseId = this.courseId;
        if (!courseId) return;
        this.saveState.set('saving');
        this.saveError.set(null);
        this.saving = (async () => {
            try {
                while (this.saves.length > 0) {
                    const result = await this.savePixels(courseId, this.saves[0], !this.sessionSaved);
                    this.sessionSaved = true;
                    this.saves.shift();
                    this.undoDepth.set(result.undoDepth);
                }
                this.saveState.set('saved');
            } catch (err) {
                // The queue stays: the next stroke, or Retry, sends it again.
                this.saveState.set('error');
                this.saveError.set(`Saving failed: ${err instanceof Error ? err.message : String(err)}`);
            } finally {
                this.saving = null;
            }
        })();
    }

    /** Send what a failed save left behind (panel button). */
    retrySave(): void {
        this.startSaving();
    }

    // ── Pointer plumbing ────────────────────────────────────────────────────

    private onClick(e: MapPointerEvent): void {
        if (this.ctx?.map.interactionMode.peek() !== CLEAN_TOOL_ID) return;
        if (this.mode.peek() !== 'areas') return;
        if (this.dragBinding?.clickSuppressed) return;
        if (!e.originalEvent.ctrlKey && !e.originalEvent.metaKey) this.areas.addPoint(e.lngLat);
    }

    /**
     * Left press under the clean claim. Cmd/Ctrl-drag stays the pan escape:
     * the drag binding filters that press before it gets here.
     */
    private onRawMouseDown(e: MapMouseEvent, map: MaplibreMap): void {
        const mode = this.mode.peek();
        const p = { lng: e.lngLat.lng, lat: e.lngLat.lat };
        if (mode === 'areas') {
            if (this.areas.pointerDown(e)) this.dragBinding?.claim(e, map);
            return;
        }
        if (e.originalEvent.altKey && isLive(mode)) {
            e.preventDefault();
            this.pickSource(p);
            return;
        }
        if (e.originalEvent.shiftKey && this.lastDab) {
            e.preventDefault();
            void this.strokeLine(this.lastDab, p);
            return;
        }
        this.dragBinding?.claim(e, map);
        this.beginStroke(p);
    }

    private onMouseMove(e: MapPointerEvent): void {
        if (this.ctx?.map.interactionMode.peek() !== CLEAN_TOOL_ID) return;
        if (this.mode.peek() === 'areas') { this.areas.pointerMove(e); return; }
        if (!this.geo) return;
        if (this.stroke) this.extendStroke(e.lngLat);
        this.hover = this.toPx(e.lngLat);
        this.scheduleFrame();
    }

    private onRawMouseUp(map: MaplibreMap): void {
        if (this.mode.peek() === 'areas') return;
        // Also a press that started no stroke (no source yet) claimed the pan.
        this.releasePan(map);
        void this.endStroke();
    }

    private releasePan(map?: MaplibreMap): void {
        this.dragBinding?.release(map);
    }

    // ── Strokes ─────────────────────────────────────────────────────────────

    /** Alt-click: pick the clone source. Resets the aligned offset: the
     * next stroke sets it from this source. Public test seam. */
    pickSource(lngLat: { lng: number; lat: number }): void {
        if (!this.geo) return;
        this.source = this.toPx(lngLat);
        this.alignedOffset = null;
        this.lastDab = null;
        this.hasSource.set(true);
        this.notice.set(null);
        this.updateRings();
    }

    /** PhotoCraft's brush params for a stroke of `tool` starting at `start`. */
    private brushParams(tool: RetouchTool, start: Px): Record<string, unknown> {
        const geo = this.geo!;
        const params: Record<string, unknown> = {
            points: [[start.x, start.y]],
            size: Math.max(1, Math.round(this.brushSizeM.peek() / geo.res)),
            hardness: Math.round(this.brushHardness.peek() * 100),
        };
        if (!isLive(tool)) return params;
        params.opacity = Math.max(1, Math.round(this.brushOpacity.peek() * 100));
        params.flow = Math.max(1, Math.round(this.brushFlow.peek() * 100));
        const aligned = this.cloneAligned.peek();
        params.aligned = aligned;
        if (aligned && this.alignedOffset) params.offset = this.alignedOffset;
        else params.source = [this.source!.x, this.source!.y];
        return params;
    }

    /**
     * Start a stroke of the current tool at `lngLat` (public test seam: the
     * raw mousedown handler drives this). Returns false, with a notice, when
     * the photo is not ready, a fill is still computing, or the tool needs a
     * source and none is picked.
     */
    beginStroke(lngLat: { lng: number; lat: number }): boolean {
        if (this.stroke) void this.endStroke();
        const mode = this.mode.peek();
        const engine = this.engine;
        if (mode === 'areas' || !this.ctx) return false;
        if (!engine || !this.geo || this.photo.peek() !== 'ready') {
            this.notice.set(this.photo.peek() === 'loading' ? 'The photo is still loading.' : this.loadError.peek());
            return false;
        }
        if (this.phase.peek() !== 'idle' || this.working.peek()) return false;
        if (isLive(mode) && !this.source) {
            this.notice.set('Alt-click the photo to pick a source first.');
            return false;
        }
        const start = this.toPx(lngLat);
        const stroke: ActiveStroke = {
            tool: mode,
            points: [start],
            sent: 1,
            params: this.brushParams(mode, start),
            lngLats: [[lngLat.lng, lngLat.lat]],
            last: lngLat,
        };
        this.stroke = stroke;
        this.hover = start;
        this.notice.set(null);
        if (isLive(mode)) {
            // The first dab shows on the press.
            void this.enqueue(async () => {
                const changed = await engine.begin(COMMAND[mode], stroke.params);
                if (this.engine === engine) this.show(changed);
            });
        } else {
            this.updateStrokeOverlay(stroke);
        }
        this.updateRings();
        return true;
    }

    /** Extend the live stroke to `lngLat` (mouse move / test seam). */
    extendStroke(lngLat: { lng: number; lat: number }): void {
        const stroke = this.stroke;
        if (!stroke || !this.geo) return;
        const p = this.toPx(lngLat);
        const last = stroke.points[stroke.points.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) < STROKE_SAMPLE_PX) return;
        stroke.points.push(p);
        stroke.lngLats.push([lngLat.lng, lngLat.lat]);
        stroke.last = lngLat;
        this.hover = p;
        this.scheduleFrame();
    }

    /** One update on the next animation frame (no-op if pending). */
    private scheduleFrame(): void {
        if (this.frame !== null) return;
        this.frame = this.frames.request(() => {
            this.frame = null;
            const stroke = this.stroke;
            if (stroke) {
                if (isLive(stroke.tool)) this.pump(stroke);
                else this.updateStrokeOverlay(stroke);
            }
            this.updateRings();
        });
    }

    private cancelFrame(): void {
        if (this.frame === null) return;
        this.frames.cancel(this.frame);
        this.frame = null;
    }

    /** Send the points the engine has not seen. One batch is on its way at
     * a time; what arrives meanwhile goes in the next. */
    private pump(stroke: ActiveStroke): void {
        const engine = this.engine;
        if (!engine || this.pumping || stroke.sent >= stroke.points.length) return;
        const batch = stroke.points.slice(stroke.sent).map(p => [p.x, p.y]);
        stroke.sent = stroke.points.length;
        this.pumping = true;
        void this.enqueue(async () => {
            try {
                const changed = await engine.push(batch);
                if (this.engine === engine) this.show(changed);
            } finally {
                this.pumping = false;
            }
            if (this.stroke === stroke) this.pump(stroke);
        });
    }

    /**
     * Finish the stroke: the engine commits it as one undo step and the
     * changed pixels go to the photo file. Public seam. Resolves true when
     * the stroke changed the photo.
     */
    async endStroke(): Promise<boolean> {
        const stroke = this.stroke;
        const engine = this.engine;
        if (!stroke || !engine) return false;
        this.stroke = null;
        this.cancelFrame();
        this.lastDab = stroke.last;
        const tool = stroke.tool;
        let done = false;
        if (isLive(tool)) {
            const rest = stroke.points.slice(stroke.sent).map(p => [p.x, p.y]);
            stroke.sent = stroke.points.length;
            await this.enqueue(async () => {
                if (rest.length > 0) await engine.push(rest);
                const out = await engine.end();
                if (this.engine !== engine) return;
                if (this.cloneAligned.peek() && out.offset) this.alignedOffset = out.offset;
                done = this.committed(out.changed);
            });
        } else {
            this.working.set(true);
            await this.enqueue(async () => {
                try {
                    const out = await engine.run(COMMAND[tool], { ...stroke.params, points: stroke.points.map(p => [p.x, p.y]) });
                    if (this.engine === engine) done = this.committed(out.changed);
                } finally {
                    this.working.set(false);
                    this.removeStrokeOverlay();
                }
            });
        }
        this.updateRings();
        return done;
    }

    /** A command went into the history: show it, count it, save it. */
    private committed(changed: Changed | null): boolean {
        this.show(changed);
        if (!changed) return false;
        this.undoSteps.set(this.undoSteps.peek() + 1);
        this.redoSteps.set(0);
        this.save(changed);
        return true;
    }

    /** Shift-click: one straight stroke from the last dab to `to`. */
    async strokeLine(from: { lng: number; lat: number }, to: { lng: number; lat: number }): Promise<boolean> {
        if (!this.beginStroke(from)) return false;
        const steps = 64;
        for (let i = 1; i <= steps; i++) {
            this.extendStroke({
                lng: from.lng + ((to.lng - from.lng) * i) / steps,
                lat: from.lat + ((to.lat - from.lat) * i) / steps,
            });
        }
        return this.endStroke();
    }

    /** Cancel the stroke being drawn (ESC / teardown): nothing changes. */
    private cancelStroke(): void {
        const stroke = this.stroke;
        if (!stroke) return;
        this.stroke = null;
        this.cancelFrame();
        this.removeStrokeOverlay();
        this.releasePan();
        const engine = this.engine;
        if (engine && isLive(stroke.tool)) {
            void this.enqueue(async () => {
                const changed = await engine.cancel();
                if (this.engine === engine) this.show(changed);
            });
        }
        this.updateRings();
    }

    /** Step back in this session's strokes (Ctrl+Z). */
    undoStroke(): Promise<void> {
        return this.step('undo');
    }

    /** Step forward again (Ctrl+Shift+Z). */
    redoStroke(): Promise<void> {
        return this.step('redo');
    }

    private step(dir: 'undo' | 'redo'): Promise<void> {
        const engine = this.engine;
        const steps = dir === 'undo' ? this.undoSteps : this.redoSteps;
        const other = dir === 'undo' ? this.redoSteps : this.undoSteps;
        if (!engine || this.stroke || this.working.peek() || this.phase.peek() !== 'idle' || steps.peek() === 0) return Promise.resolve();
        // Counted now, so a second Ctrl+Z before the first returns still works.
        steps.set(steps.peek() - 1);
        other.set(other.peek() + 1);
        return this.enqueue(async () => {
            const changed = dir === 'undo' ? await engine.undo() : await engine.redo();
            if (this.engine !== engine) return;
            this.show(changed);
            this.save(changed);
        });
    }

    private onKeyDown(e: KeyboardEvent): void {
        const typing = e.target as HTMLElement | null;
        if (typing && (typing.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(typing.tagName))) return;
        if (this.mode.peek() === 'areas') {
            if (!this.areas.kind.peek()) return;
            if (e.key === 'Enter') { e.preventDefault(); void this.areas.finish(); }
            if (e.key === 'Backspace') { e.preventDefault(); this.areas.back(); }
            return;
        }
        if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'z' || e.key === 'Z' || e.key === 'y')) {
            e.preventDefault();
            e.stopPropagation();
            void (e.key === 'y' || e.shiftKey ? this.redoStroke() : this.undoStroke());
            return;
        }
        if (e.key !== '[' && e.key !== ']') return;
        e.preventDefault();
        const factor = e.key === ']' ? BRUSH_SIZE_STEP : 1 / BRUSH_SIZE_STEP;
        this.brushSizeM.set(Math.min(BRUSH_SIZE_MAX_M, Math.max(BRUSH_SIZE_MIN_M, this.brushSizeM.peek() * factor)));
        this.updateRings();
    }

    // ── Rings and the stroke band ───────────────────────────────────────────

    /**
     * The brush rings: the brush under the pointer and, for the tools with a
     * source, where it copies from. The source ring rides beside the brush
     * once an offset is set (aligned strokes after the first), else it marks
     * the picked source.
     */
    private updateRings(): void {
        const mode = this.mode.peek();
        if (mode === 'areas' || !this.geo) return;
        const hover = this.hover;
        if (hover) this.setRing(CLEAN_BRUSH_OVERLAY_ID, hover);
        if (!isLive(mode)) {
            this.removeRing(CLEAN_SOURCE_OVERLAY_ID);
            return;
        }
        const offset = this.cloneAligned.peek() ? this.alignedOffset : null;
        if (hover && offset) this.setRing(CLEAN_SOURCE_OVERLAY_ID, { x: hover.x + offset[0], y: hover.y + offset[1] });
        else if (this.source) this.setRing(CLEAN_SOURCE_OVERLAY_ID, this.source);
    }

    /** Show ring overlay `id` (brush-sized) centred on photo pixel `center`. */
    private setRing(id: string, center: Px): void {
        const ctx = this.ctx;
        const geo = this.geo;
        if (!ctx || !geo) return;
        const r = this.brushSizeM.peek() / 2 / geo.res;
        const ring: Array<[number, number]> = [];
        for (let i = 0; i <= 48; i++) {
            const t = (i / 48) * 2 * Math.PI;
            const p = this.toLngLat({ x: center.x + r * Math.cos(t), y: center.y + r * Math.sin(t) });
            ring.push([p.lng, p.lat]);
        }
        const data: GeoJSON = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
        try {
            if (this.rings.has(id)) {
                ctx.map.updateOverlayData(id, data);
            } else {
                ctx.map.addOverlayLayer(id, data, [{
                    id: `${id}-line`,
                    type: 'line',
                    paint: { 'line-color': id === CLEAN_BRUSH_OVERLAY_ID ? '#ffffff' : '#7dd3fc', 'line-width': 2 },
                }]);
                this.rings.add(id);
            }
        } catch {
            // Map mid-teardown: the marker is decorative.
        }
    }

    private removeRing(id: string): void {
        if (!this.rings.delete(id)) return;
        this.ctx?.map.removeOverlayLayer(id);
    }

    /** The red band of a spot heal or a removal while it is drawn (and while
     * it computes): the stroke at brush width. */
    private updateStrokeOverlay(stroke: ActiveStroke): void {
        const ctx = this.ctx;
        if (!ctx) return;
        const first = stroke.lngLats[0];
        const pts = stroke.lngLats.length > 1 ? stroke.lngLats : [first, [first[0] + 1e-9, first[1]] as [number, number]];
        const data: GeoJSON = { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts } };
        // Brush width in screen pixels at this zoom (512 px world tiles).
        const zoom = (ctx.map.map.peek() as MaplibreMap | null)?.getZoom?.() ?? 18;
        const metresPerPx = (40075016.686 * Math.cos((stroke.last.lat * Math.PI) / 180)) / (512 * 2 ** zoom);
        const width = Math.max(2, this.brushSizeM.peek() / metresPerPx);
        try {
            if (this.strokeOverlayLive) {
                ctx.map.updateOverlayData(CLEAN_STROKE_OVERLAY_ID, data);
                return;
            }
            ctx.map.addOverlayLayer(CLEAN_STROKE_OVERLAY_ID, data, [{
                id: `${CLEAN_STROKE_OVERLAY_ID}-line`,
                type: 'line',
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: { 'line-color': '#ef4444', 'line-opacity': 0.45, 'line-width': width },
            }]);
            this.strokeOverlayLive = true;
        } catch {
            // Map mid-teardown: the band is decorative.
        }
    }

    private removeStrokeOverlay(): void {
        if (!this.strokeOverlayLive) return;
        this.strokeOverlayLive = false;
        this.ctx?.map.removeOverlayLayer(CLEAN_STROKE_OVERLAY_ID);
    }

    // ── Undo last change (server side) ──────────────────────────────────────

    /** Put back the photo from before the last editing session or import. */
    async undoLast(): Promise<boolean> {
        const ctx = this.ctx;
        if (!ctx || this.phase.peek() !== 'idle' || this.stroke) return false;
        if (this.undoDepth.peek() === 0) return false;
        this.phase.set('applying');
        this.externalBusy.set('undo');
        this.notice.set(null);
        try {
            await this.settled();
            const result = await this.photoApi.undoPhotoChange({ courseId: ctx.courseId });
            this.undoDepth.set(result.undoDepth);
            if (this.ctx === ctx) await this.reloadPhoto(result.patchesGeneratedAt || null);
            return true;
        } catch (err) {
            this.notice.set(`Undo failed: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        } finally {
            this.externalBusy.set(null);
            this.phase.set('idle');
        }
    }

    // ── Out to an image editor and back ────────────────────────────────────

    /** Download URL of the cleaned photo as a PNG; null while the tool is inactive. */
    exportUrl(): string | null {
        return this.ctx ? cleanedPhotoExportUrl(this.ctx.courseId) : null;
    }

    /**
     * Upload an image to become the cleaned photo: any PNG, JPEG or TIFF of
     * the photo's pixel size, whatever it shows. Nothing has to be exported
     * first. On a change the pixels load again and "Undo last change" covers
     * it. Returns true when the server took the file (including "nothing
     * changed").
     */
    async importPhoto(file: File): Promise<boolean> {
        const ctx = this.ctx;
        if (!ctx || this.phase.peek() !== 'idle' || this.stroke) return false;
        this.importSummary.set(null);
        this.externalMessage.set(null);
        if (file.size === 0) {
            this.externalMessage.set({ kind: 'error', text: 'The file is empty.' });
            return false;
        }
        if (file.size > CLEANED_IMPORT_MAX_BYTES) {
            const mb = Math.round(CLEANED_IMPORT_MAX_BYTES / (1024 * 1024));
            this.externalMessage.set({
                kind: 'error',
                text: `The file is ${(file.size / (1024 * 1024)).toFixed(0)} MB; the limit is ${mb} MB. Save it as a PNG or JPEG of ${CLEANED_PHOTO_SIZE} × ${CLEANED_PHOTO_SIZE} px.`,
            });
            return false;
        }
        this.phase.set('applying');
        this.externalBusy.set('import');
        this.uploadProgress.set(0);
        try {
            await this.settled();
            const result = await this.importClient.importPhoto(
                ctx.courseId, file,
                (loaded, total) => this.uploadProgress.set(total > 0 ? loaded / total : null),
            );
            this.importSummary.set(importSummaryText(result));
            this.undoDepth.set(result.undoDepth);
            this.photoExists.set(true);
            this.uploadProgress.set(null);
            if (result.changed && this.ctx === ctx) await this.reloadPhoto(result.patchesGeneratedAt);
            return true;
        } catch (err) {
            this.uploadProgress.set(null);
            if (err instanceof PhotoImportError && err.status === 504) {
                // The retile outlasted the request; it carries on server-side.
                this.externalMessage.set({
                    kind: 'info',
                    text: 'The server is still working on the import. Press Refresh to load the photo when it is done.',
                });
                await this.refreshInfo({ resync: true });
            } else {
                this.externalMessage.set({
                    kind: 'error',
                    text: `Import failed: ${err instanceof Error ? err.message : String(err)}`,
                });
            }
            return false;
        } finally {
            this.externalBusy.set(null);
            this.phase.set('idle');
        }
    }
}
