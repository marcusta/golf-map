// "Clean photo" tool — interactive ortho blemish removal for GOLF-SIMULATOR
// EXPORT. Three mask/stroke modes, a pending-edit queue, and batch baking
// into a parallel "sim" photo state:
//
// ## Dual photo state
//
// Cleaning NEVER touches the planning/playing imagery: bakes write a sparse
// copy-on-write overlay (`tiles/<mapKey>/ortho-sim/`, served with per-tile
// pristine fallback and its own `?v=` stamp) and the working `.patched.tif`
// (the Unity/GSPro export source of truth). While this tool is active the
// live map's flat ortho source points at the sim layer (panel toggle flips
// back for comparison); deactivating always restores the pristine photo.
// The web planner and iOS bundles only ever see the pristine tree.
//
// ## Modes
//
//   click  → planCrop → compose crop (tiles, never the MapLibre canvas)
//          → /segment → largestPolygon → fillPolygonMask + dilate
//          → /inpaint(crop, mask) → candidate preview → accept queues it
//   ellipse→ drag defines the mask directly (works without SAM weights)
//   stamp  → clone-stamp brush (NO sidecar needed): Alt-click picks the
//          source, drag paints (live local preview by cloning tile pixels
//          on the preview surface — clean-stamp.ts, the client mirror of
//          golfpipe/stamp.py), each finished stroke queues directly.
//          Aligned ON: the source offset persists across strokes; OFF:
//          every stroke restarts from the picked source. Single clicks
//          stamp one dab; Shift-click extends a straight line from the
//          last dab; [ / ] resize the brush.
//
// ## Pending queue + batch bake
//
// Accepted edits (mask candidates AND stamp strokes) accumulate as PENDING —
// preview overlays stay on the map, nothing is sent. "Bake N edits" submits
// the whole ordered queue in ONE applyOrthoEdits call; the server appends
// them all to the log, bakes them in order against the evolving patched
// raster, retiles the union subtree once into the sim overlay, and bumps the
// sim version once — then the map refreshes the sim source in place (never
// the pristine one). Mask fills bake seam-free server-side (LaMa on source
// pixels); stamp strokes re-render byte-reproducibly (pure pixel math, no
// torch — a stamp-only queue bakes even without LaMa weights).
//
// Preview fidelity note: local previews are composed from served tiles
// (WebP-lossy, mercator-resampled) while bakes execute on source pixels —
// visually near-identical, seam-free at bake by construction. Overlapping
// pending edits preview independently; the bake applies them in order.
//
// Parked v2 ideas (deliberately NOT implemented): stamp source rotation,
// cross-vintage donor sources (cloning from another year's flight).
//
// All I/O sits behind constructor seams (sidecar clients' fetch, the
// imaging canvas work, the patches API, confirm dialogs) so the whole state
// machine runs under bun test.

import { Signal, effect } from '@basics/core/client/core';
import type { Map as MaplibreMap, MapMouseEvent } from 'maplibre-gl';
import type { GeoJSON } from 'geojson';
import type { ToolContext } from '../editor/tool';
import type { MapPointerEvent } from '../map/map.service';
import { tileUrlTemplate } from '../map/map-style';
import { deriveTileVersion } from '../map/tileset.service';
import type { OrthoPatchesApi } from '../../../shared/api/ortho-patches.gen';
import { api } from '../api';
import { lngLatToSweref99tm } from '../geo/transform';
import { SamClient, largestPolygon, SAM_CROP_SIZE } from '../sam/sam-client';
import { planCrop, cropPixelToLngLat, cropPixelToSweref, fillTileUrl, type CropPlan } from '../sam/sam-crop';
import { CleanClient } from './clean-client';
import {
    dilateMask,
    ellipseRingLngLat,
    fillEllipseMask,
    fillPolygonMask,
    groundMetersPerPixel,
    lngLatToMercator,
    maskArea,
    mercatorMetersPerPixel,
    mercatorToCropPixel,
    mercatorToLngLat,
    planBounds3857,
} from './clean-mask';
import { renderStampStroke, type PxPoint } from './clean-stamp';

/** Interaction-claim id for the Clean tool (also its registry id). */
export const CLEAN_TOOL_ID = 'clean';

/** SAM masks are dilated by this many ground meters — the blemish's soft
 * edge (anti-aliased rim, thin shadow fringe) must go with it or LaMa
 * plausibly continues it back into the hole (T54 learning). */
export const CLEAN_DILATE_M = 0.5;
/** Smallest drag-ellipse radius (ground meters) that counts as intentional. */
export const CLEAN_MIN_ELLIPSE_M = 0.3;

export const CLEAN_PREVIEW_OVERLAY_ID = 'clean-preview';
export const CLEAN_ELLIPSE_OVERLAY_ID = 'clean-ellipse';
export const CLEAN_SOURCE_OVERLAY_ID = 'clean-stamp-source';

/** Minimum crop-pixel movement before a new stroke path point is recorded. */
const STAMP_SAMPLE_PX = 2;
/** [ / ] brush resize factor. */
const STAMP_SIZE_STEP = 1.25;
export const STAMP_SIZE_MIN_M = 0.5;
export const STAMP_SIZE_MAX_M = 30;
/** Hard cap on recorded points per stroke (server rejects above 4000). */
const STAMP_MAX_PATH_POINTS = 1500;

export type CleanMode = 'click' | 'ellipse' | 'stamp';
export type CleanPhase = 'idle' | 'working' | 'preview' | 'applying';
export type CleanHealth = 'checking' | 'online' | 'offline';

/**
 * Browser-only imaging seam: crop composition and PNG encoding need canvas,
 * which bun test's happy-dom doesn't have — tests inject fakes and drive
 * the state machine with canned base64 strings / pixel buffers.
 */
export interface CleanImaging {
    /** Compose the ortho crop from tiles → base64 PNG (lossless — unmasked
     * result pixels stay byte-identical through the sidecar round trip). */
    composeCropPng(tiles: Array<{ url: string; dx: number; dy: number }>, size: number): Promise<string>;
    /** Mask bitmap → base64 PNG (white = inpaint) — sent to the sidecar for
     * the preview AND to the server on bake (the mask-edit payload). */
    encodeMaskPng(mask: Uint8Array, size: number): Promise<string>;
    /** Compose the ortho crop from tiles → flat RGBA pixels (size×size×4) —
     * the clone-stamp preview surface. */
    composeCropPixels(tiles: Array<{ url: string; dx: number; dy: number }>, size: number): Promise<Uint8ClampedArray>;
    /** Flat RGBA pixels → PNG data URL for the image overlay. */
    pixelsToPngDataUrl(pixels: Uint8ClampedArray, size: number): Promise<string>;
}

async function blobToBase64(blob: Blob): Promise<string> {
    const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
    return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

async function composeCropCanvas(
    tiles: Array<{ url: string; dx: number; dy: number }>,
    size: number,
): Promise<OffscreenCanvas> {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size, size);
    await Promise.all(tiles.map(async tile => {
        try {
            const res = await fetch(tile.url);
            if (!res.ok) return; // out-of-coverage tile — keep background
            const bitmap = await createImageBitmap(await res.blob());
            ctx.drawImage(bitmap, tile.dx, tile.dy);
            bitmap.close();
        } catch {
            // Network hiccup on one tile: clean what we have.
        }
    }));
    return canvas;
}

/** Real canvas implementation of the imaging seam. */
export const browserCleanImaging: CleanImaging = {
    async composeCropPng(tiles, size) {
        const canvas = await composeCropCanvas(tiles, size);
        return blobToBase64(await canvas.convertToBlob({ type: 'image/png' }));
    },

    async encodeMaskPng(mask, size) {
        const canvas = new OffscreenCanvas(size, size);
        const ctx = canvas.getContext('2d')!;
        const img = ctx.createImageData(size, size);
        for (let i = 0; i < mask.length; i++) {
            const v = mask[i] ? 255 : 0;
            img.data[i * 4] = v;
            img.data[i * 4 + 1] = v;
            img.data[i * 4 + 2] = v;
            img.data[i * 4 + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        return blobToBase64(await canvas.convertToBlob({ type: 'image/png' }));
    },

    async composeCropPixels(tiles, size) {
        const canvas = await composeCropCanvas(tiles, size);
        return canvas.getContext('2d')!.getImageData(0, 0, size, size).data;
    },

    async pixelsToPngDataUrl(pixels, size) {
        const canvas = new OffscreenCanvas(size, size);
        const ctx = canvas.getContext('2d')!;
        const img = ctx.createImageData(size, size);
        img.data.set(pixels);
        ctx.putImageData(img, 0, 0);
        const base64 = await blobToBase64(await canvas.convertToBlob({ type: 'image/png' }));
        return `data:image/png;base64,${base64}`;
    },
};

interface PreviewState {
    plan: CropPlan;
    mask: Uint8Array;
    /** The encoded mask png — the ONLY pixel payload the bake sends. */
    maskPngBase64: string;
    /** Sidecar inpaint of the tile crop — preview overlay only, never baked. */
    resultBase64: string;
    tool: string; // 'sam' | 'ellipse'
    /** Ground m²-ish size of the mask, for the panel line. */
    maskPixels: number;
}

interface PendingMaskEdit {
    kind: 'mask';
    maskPngBase64: string;
    bounds3857: { west: number; south: number; east: number; north: number };
    boundsSweref: { west: number; south: number; east: number; north: number };
    tool: string;
    /** The kept preview overlay showing this pending edit on the map. */
    overlayId: string;
}

interface PendingStampEdit {
    kind: 'stamp';
    brush: { sizeM: number; opacity: number; flow: number; hardness: number };
    offsetM: { dx: number; dy: number };
    path: Array<{ x: number; y: number }>;
    aligned: boolean;
    toneMatch: boolean;
    bounds3857: { west: number; south: number; east: number; north: number };
    boundsSweref: { west: number; south: number; east: number; north: number };
    /** Preview-replay data: which surface, and the stroke in surface px. */
    surfaceId: string;
    pathPx: PxPoint[];
    offsetPx: { dx: number; dy: number };
    radiusPx: number;
}

type PendingEdit = PendingMaskEdit | PendingStampEdit;

/** One clone-stamp preview surface: a tile-composed crop the pending strokes
 * of that area render onto (shown as an image overlay below the feature
 * fills, exactly like the inpaint preview). */
interface StampSurface {
    id: string;
    plan: CropPlan;
    /** Tile pixels as composed (no strokes). */
    base: Uint8ClampedArray;
    /** base + every pending stroke of this surface (+ the live stroke). */
    work: Uint8ClampedArray;
}

interface ActiveStroke {
    surface: StampSurface;
    /** Surface content BEFORE this stroke — the render/cancel baseline. */
    workBase: Uint8ClampedArray;
    pathPx: PxPoint[];
    pathSweref: Array<{ x: number; y: number }>;
    pathMerc: Array<{ x: number; y: number }>;
    offsetM: { dx: number; dy: number };
    offsetMerc: { dx: number; dy: number };
    offsetPx: { dx: number; dy: number };
    radiusPx: number;
    lastLngLat: { lng: number; lat: number };
    brush: { sizeM: number; opacity: number; flow: number; hardness: number };
    toneMatch: boolean;
    aligned: boolean;
}

/**
 * DI singleton behind the `clean` EditorTool (clean-tool.ts) and its panel
 * (clean-panel.component.ts). See the module header for the flow.
 */
export class CleanToolService {
    /** Sidecar process reachability (mask modes only — stamping is local). */
    readonly health = new Signal<CleanHealth>('checking');
    /** LaMa weights + torch ready on the sidecar (/health `inpaint`). */
    readonly inpaintReady = new Signal(false);
    /** Sidecar's reason when inpaint is unavailable. */
    readonly healthDetail = new Signal<string | null>(null);
    /** Mode: click = SAM mask; ellipse = drag mask; stamp = clone brush. */
    readonly mode = new Signal<CleanMode>('click');
    readonly phase = new Signal<CleanPhase>('idle');
    /** One-line panel notice (why the last action produced nothing). */
    readonly notice = new Signal<string | null>(null);
    /** Baked patches on this course's map (server log length). */
    readonly patchCount = new Signal(0);
    /** Pending (accepted but unbaked) edits in the queue. */
    readonly pendingCount = new Signal(0);
    /** Pre-flight: can MASK edits bake (source + LaMa deps)? */
    readonly bakeable = new Signal(true);
    /** Pre-flight: can STAMP edits bake (source only — never needs torch)? */
    readonly stampBakeable = new Signal(true);
    /** Server's reason cleaning can only preview (present when !bakeable). */
    readonly bakeReason = new Signal<string | null>(null);
    /** Dual photo state: show the cleaned (sim) photo while the tool is
     * active. Toggled from the panel for comparison; always restored to
     * pristine on deactivate. */
    readonly showCleaned = new Signal(true);

    // Stamp brush state (right-sidebar controls).
    readonly stampSizeM = new Signal(3);
    readonly stampOpacity = new Signal(1);
    readonly stampFlow = new Signal(0.7);
    readonly stampHardness = new Signal(0.7);
    readonly stampAligned = new Signal(true);
    readonly stampToneMatch = new Signal(true);
    /** A clone source has been picked (panel hint gating). */
    readonly hasStampSource = new Signal(false);

    private ctx: ToolContext | null = null;
    private preview: PreviewState | null = null;
    private drag: { start: { lng: number; lat: number }; current: { lng: number; lat: number } } | null = null;
    private ellipseOverlayLive = false;
    private rawDisposers: Array<() => void> = [];

    private pending: PendingEdit[] = [];
    private surfaces: StampSurface[] = [];
    private overlaySeq = 0;
    /** The sim overlay's version stamp (null before the first bake ever). */
    private simGeneratedAt: string | null = null;

    // Stamp interaction state.
    private source: { lngLat: { lng: number; lat: number }; sweref: { x: number; y: number }; merc: { x: number; y: number } } | null = null;
    private alignedOffset: { m: { dx: number; dy: number }; merc: { dx: number; dy: number } } | null = null;
    private lastDab: { lng: number; lat: number } | null = null;
    private stroke: ActiveStroke | null = null;
    private strokeInit: Promise<boolean> | null = null;
    private sourceOverlayLive = false;

    constructor(
        private client: CleanClient = new CleanClient(),
        private sam: SamClient = new SamClient(),
        private imaging: CleanImaging = browserCleanImaging,
        private patchesApi: OrthoPatchesApi = api.orthoPatches,
        private confirmFn: (message: string) => boolean =
            message => (typeof confirm === 'function' ? confirm(message) : true),
    ) {}

    // ── EditorTool lifecycle ────────────────────────────────────────────────

    activate(ctx: ToolContext): void {
        this.ctx = ctx;
        this.notice.set(null);
        void this.checkHealth();
        void this.refreshInfo();
        ctx.track(ctx.map.onClick(e => this.onClick(e)));
        ctx.track(ctx.map.onMouseMove(e => this.onMouseMove(e)));

        // Raw mousedown/mouseup (ellipse drags + stamp strokes) need the live
        // map instance; rebind whenever a (re)created map turns ready. The
        // photo state (sim vs pristine ortho source) is re-applied there too.
        const rebind = effect(() => {
            if (!ctx.map.ready.get()) return;
            const map = ctx.map.map.peek();
            if (map) this.bindRawHandlers(map as MaplibreMap);
            this.applyPhotoState();
        });
        ctx.track(() => {
            rebind();
            this.disposeRawHandlers();
        });

        // [ / ] resize the stamp brush (ignored while typing in inputs).
        const onKeyDown = (e: KeyboardEvent) => this.onKeyDown(e);
        window.addEventListener('keydown', onKeyDown);
        ctx.track(() => window.removeEventListener('keydown', onKeyDown));
    }

    deactivate(): void {
        const ctx = this.ctx;
        this.cancelDrag();
        this.cancelStroke();
        if (this.pending.length > 0 && ctx) {
            // Tool switch with pending edits: prompt — OK bakes them (fire
            // and forget; the server work continues past deactivation),
            // Cancel discards. Overlays are cleaned up either way below.
            const n = this.pending.length;
            if (this.confirmFn(`${n} pending clean-photo edit${n === 1 ? '' : 's'} — bake ${n === 1 ? 'it' : 'them'} now? (Cancel discards.)`)) {
                void this.bakeAll({ silent: true });
            } else {
                this.discardAllPending();
            }
        }
        this.removePreviewOverlay();
        this.removeSourceOverlay();
        for (const edit of this.pending) {
            if (edit.kind === 'mask') ctx?.map.removeOverlayLayer(edit.overlayId);
        }
        for (const surface of this.surfaces) ctx?.map.removeOverlayLayer(surface.id);
        this.surfaces = [];
        this.preview = null;
        this.phase.set('idle');
        this.notice.set(null);
        // Always hand the map back showing the PRISTINE photo.
        const pristine = ctx?.tileset.tileVersion.peek();
        if (ctx && pristine) ctx.map.setOrthoPhotoState('ortho', pristine);
        this.disposeRawHandlers();
        this.ctx = null;
    }

    /** ESC: stroke/drag → cancel; candidate preview → discard; pending queue
     * → prompt to discard all; else let the toolbar exit. */
    onEscape(): boolean {
        if (this.drag) {
            this.cancelDrag();
            return true;
        }
        if (this.stroke || this.strokeInit) {
            this.cancelStroke();
            return true;
        }
        if (this.phase.peek() === 'preview') {
            this.discard();
            return true;
        }
        if (this.pending.length > 0) {
            const n = this.pending.length;
            if (this.confirmFn(`Discard ${n} pending clean-photo edit${n === 1 ? '' : 's'}?`)) {
                this.discardAllPending();
            }
            return true;
        }
        return false;
    }

    /** Probe the sidecar's /health (activation + the panel's retry button). */
    async checkHealth(): Promise<void> {
        this.health.set('checking');
        const h = await this.client.health();
        this.health.set(h.online ? 'online' : 'offline');
        this.inpaintReady.set(h.inpaintAvailable);
        this.healthDetail.set(h.detail);
    }

    /** Refresh the baked-patch count + bake pre-flight from the server. */
    async refreshInfo(): Promise<void> {
        const ctx = this.ctx;
        if (!ctx) return;
        try {
            const info = await this.patchesApi.orthoPatchesInfo({ courseId: ctx.courseId });
            this.patchCount.set(info.count);
            this.bakeable.set(info.bakeable);
            this.stampBakeable.set(info.stampBakeable);
            this.bakeReason.set(info.reason ?? null);
            this.simGeneratedAt = info.patchesGeneratedAt;
            this.applyPhotoState();
        } catch {
            // Patch info is decorative; the tool works without it.
        }
    }

    // ── Dual photo state ────────────────────────────────────────────────────

    /** Panel toggle: cleaned (sim) vs original photo while the tool is active. */
    setShowCleaned(value: boolean): void {
        this.showCleaned.set(value);
        this.applyPhotoState();
    }

    /** Point the live flat ortho source at the sim overlay or the pristine
     * tree per the toggle. Presentation only — never touches the pristine
     * version guard (see MapService.setOrthoPhotoState). */
    private applyPhotoState(): void {
        const ctx = this.ctx;
        if (!ctx || !ctx.map.ready.peek()) return;
        const pristine = ctx.tileset.tileVersion.peek();
        if (!pristine) return;
        if (this.showCleaned.peek()) {
            ctx.map.setOrthoPhotoState('ortho-sim', this.simTileVersion(pristine));
        } else {
            ctx.map.setOrthoPhotoState('ortho', pristine);
        }
    }

    /** The ortho-sim `?v=` — its own stamp once anything ever baked, else the
     * pristine version (the sim route falls back per-tile anyway). */
    private simTileVersion(pristineVersion: string): string {
        return this.simGeneratedAt ? deriveTileVersion(this.simGeneratedAt) : pristineVersion;
    }

    // ── Click mode (SAM mask) ───────────────────────────────────────────────

    private onClick(e: MapPointerEvent): void {
        if (this.ctx?.map.interactionMode.peek() !== CLEAN_TOOL_ID) return;
        if (this.mode.peek() !== 'click') return;
        void this.clickAt(e.lngLat);
    }

    /**
     * The full click pipeline (public test seam, like SAM's segmentAt):
     * SAM mask at the click → dilate → inpaint → preview. Returns true when
     * a preview was produced.
     */
    async clickAt(lngLat: { lng: number; lat: number }): Promise<boolean> {
        const gate = this.gate();
        if (!gate) return false;
        const plan = planCrop(lngLat.lng, lngLat.lat, gate.zoom, SAM_CROP_SIZE);
        if (!plan) {
            this.notice.set('That click is outside the tiled area.');
            return false;
        }

        this.phase.set('working');
        this.notice.set(null);
        try {
            const crop = await this.composeCrop(gate, plan);
            const seg = await this.sam.segmentPoint(crop);
            const polygon = largestPolygon(seg.polygons);
            if (!polygon) {
                this.notice.set('SAM found no object there — try the ellipse mode.');
                this.phase.set('idle');
                return false;
            }
            let mask = fillPolygonMask(plan.size, polygon);
            const dilatePx = Math.max(1, Math.round(CLEAN_DILATE_M / groundMetersPerPixel(plan.zoom, lngLat.lat)));
            mask = dilateMask(mask, plan.size, dilatePx);
            return await this.runInpaint(plan, crop, mask, 'sam');
        } catch {
            this.notice.set('Sidecar request failed — check tools/sam-server.');
            void this.checkHealth();
            this.phase.set('idle');
            return false;
        }
    }

    // ── Raw pointer plumbing (ellipse drags + stamp strokes) ────────────────

    private bindRawHandlers(map: MaplibreMap): void {
        this.disposeRawHandlers();
        const onMouseDown = (e: MapMouseEvent) => this.onRawMouseDown(e, map);
        const onMouseUp = () => this.onRawMouseUp(map);
        map.on('mousedown', onMouseDown);
        map.on('mouseup', onMouseUp);
        this.rawDisposers.push(() => {
            map.off('mousedown', onMouseDown);
            map.off('mouseup', onMouseUp);
        });
    }

    private disposeRawHandlers(): void {
        for (const dispose of this.rawDisposers) dispose();
        this.rawDisposers = [];
    }

    private onRawMouseDown(e: MapMouseEvent, map: MaplibreMap): void {
        if (this.ctx?.map.interactionMode.peek() !== CLEAN_TOOL_ID) return;
        if (e.originalEvent.button !== 0) return;
        // ⌘/Ctrl-drag stays the guaranteed pan escape hatch (draw-tool convention).
        if (e.originalEvent.metaKey || e.originalEvent.ctrlKey) return;
        const mode = this.mode.peek();
        const p = { lng: e.lngLat.lng, lat: e.lngLat.lat };

        if (mode === 'stamp') {
            if (e.originalEvent.altKey) {
                e.preventDefault();
                this.pickSource(p);
                return;
            }
            if (e.originalEvent.shiftKey && this.lastDab) {
                e.preventDefault();
                void this.strokeLine(this.lastDab, p);
                return;
            }
            if (this.phase.peek() !== 'idle') return;
            e.preventDefault();
            map.dragPan.disable();
            this.strokeInit = this.beginStroke(p);
            return;
        }

        if (mode !== 'ellipse') return;
        if (this.phase.peek() !== 'idle') return;
        e.preventDefault();
        map.dragPan.disable();
        this.drag = { start: p, current: p };
    }

    private onMouseMove(e: MapPointerEvent): void {
        if (this.ctx?.map.interactionMode.peek() !== CLEAN_TOOL_ID) return;
        if (this.drag) {
            this.drag.current = e.lngLat;
            this.updateEllipseOverlay();
            return;
        }
        if (this.stroke) this.extendStroke(e.lngLat);
    }

    private onRawMouseUp(map: MaplibreMap): void {
        if (this.strokeInit || this.stroke) {
            map.dragPan.enable();
            void this.endStroke();
            return;
        }
        const drag = this.drag;
        if (!drag) return;
        this.drag = null;
        map.dragPan.enable();
        this.removeEllipseOverlay();
        void this.finishEllipse(drag.start, drag.current);
    }

    private cancelDrag(): void {
        if (!this.drag) return;
        this.drag = null;
        this.removeEllipseOverlay();
        const map = this.ctx?.map.map.peek();
        (map as MaplibreMap | null)?.dragPan.enable();
    }

    // ── Ellipse mode (SAM-free mask) ────────────────────────────────────────

    /**
     * Finish an ellipse drag `a`→`b` (opposite bbox corners): rasterize the
     * ellipse into the crop mask and inpaint. Public test seam. Returns true
     * when a preview was produced.
     */
    async finishEllipse(a: { lng: number; lat: number }, b: { lng: number; lat: number }): Promise<boolean> {
        const gate = this.gate();
        if (!gate) return false;

        const ma = lngLatToMercator(a);
        const mb = lngLatToMercator(b);
        const cosLat = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
        const rxGround = (Math.abs(mb.x - ma.x) / 2) * cosLat;
        const ryGround = (Math.abs(mb.y - ma.y) / 2) * cosLat;
        if (rxGround < CLEAN_MIN_ELLIPSE_M || ryGround < CLEAN_MIN_ELLIPSE_M) {
            return false; // accidental micro-drag — decay silently
        }

        const center = mercatorToLngLat((ma.x + mb.x) / 2, (ma.y + mb.y) / 2);
        const plan = planCrop(center.lng, center.lat, gate.zoom, SAM_CROP_SIZE);
        if (!plan) {
            this.notice.set('That area is outside the tiled area.');
            return false;
        }
        const mpp = mercatorMetersPerPixel(plan.zoom, plan.tileSize);
        const c = mercatorToCropPixel(plan, (ma.x + mb.x) / 2, (ma.y + mb.y) / 2);
        const rxPx = Math.min(plan.size / 2 - 1, Math.abs(mb.x - ma.x) / 2 / mpp);
        const ryPx = Math.min(plan.size / 2 - 1, Math.abs(mb.y - ma.y) / 2 / mpp);
        const mask = fillEllipseMask(plan.size, c.px, c.py, rxPx, ryPx);
        if (maskArea(mask) === 0) return false;

        this.phase.set('working');
        this.notice.set(null);
        try {
            const crop = await this.composeCrop(gate, plan);
            return await this.runInpaint(plan, crop, mask, 'ellipse');
        } catch {
            this.notice.set('Sidecar request failed — check tools/sam-server.');
            void this.checkHealth();
            this.phase.set('idle');
            return false;
        }
    }

    private updateEllipseOverlay(): void {
        const ctx = this.ctx;
        const drag = this.drag;
        if (!ctx || !drag) return;
        const ring = ellipseRingLngLat(drag.start, drag.current);
        const data: GeoJSON = {
            type: 'Feature',
            properties: {},
            geometry: { type: 'Polygon', coordinates: [ring] },
        };
        try {
            if (this.ellipseOverlayLive) {
                ctx.map.updateOverlayData(CLEAN_ELLIPSE_OVERLAY_ID, data);
            } else {
                ctx.map.addOverlayLayer(CLEAN_ELLIPSE_OVERLAY_ID, data, [{
                    id: `${CLEAN_ELLIPSE_OVERLAY_ID}-line`,
                    type: 'line',
                    paint: { 'line-color': '#f5c542', 'line-width': 2, 'line-dasharray': [2, 2] },
                }]);
                this.ellipseOverlayLive = true;
            }
        } catch {
            // Map mid-teardown — the outline is decorative.
        }
    }

    private removeEllipseOverlay(): void {
        if (!this.ellipseOverlayLive) return;
        this.ellipseOverlayLive = false;
        this.ctx?.map.removeOverlayLayer(CLEAN_ELLIPSE_OVERLAY_ID);
    }

    // ── Stamp mode (clone brush — no sidecar involved) ──────────────────────

    /** Alt-click: pick the clone source. Resets any aligned offset — the
     * next stroke re-establishes it from this source. Public test seam. */
    pickSource(lngLat: { lng: number; lat: number }): void {
        this.source = {
            lngLat,
            sweref: lngLatToSweref99tm(lngLat),
            merc: lngLatToMercator(lngLat),
        };
        this.alignedOffset = null;
        this.lastDab = null;
        this.hasStampSource.set(true);
        this.notice.set(null);
        this.updateSourceOverlay(this.source.merc);
    }

    /**
     * Start a clone stroke at `lngLat` (public test seam — the raw mousedown
     * handler drives this). Establishes the stroke offset per the aligned
     * semantics, finds/creates the preview surface (composing its tile crop
     * on first use), and paints the first dab. Returns false (with a notice)
     * when no source is picked or the spot is outside the tiled area.
     */
    async beginStroke(lngLat: { lng: number; lat: number }): Promise<boolean> {
        const gate = this.stampGate();
        if (!gate) return false;
        if (!this.source) {
            this.notice.set('Alt-click the photo to pick a clone source first.');
            return false;
        }
        const destSweref = lngLatToSweref99tm(lngLat);
        const destMerc = lngLatToMercator(lngLat);

        let offsetM: { dx: number; dy: number };
        let offsetMerc: { dx: number; dy: number };
        if (this.stampAligned.peek() && this.alignedOffset) {
            offsetM = this.alignedOffset.m;
            offsetMerc = this.alignedOffset.merc;
        } else {
            offsetM = { dx: this.source.sweref.x - destSweref.x, dy: this.source.sweref.y - destSweref.y };
            offsetMerc = { dx: this.source.merc.x - destMerc.x, dy: this.source.merc.y - destMerc.y };
            if (this.stampAligned.peek()) this.alignedOffset = { m: offsetM, merc: offsetMerc };
        }

        const surface = await this.surfaceFor(destMerc, offsetMerc, gate.zoom, gate);
        if (!surface) return false;

        const start = mercatorToCropPixel(surface.plan, destMerc.x, destMerc.y);
        const mpp = mercatorMetersPerPixel(surface.plan.zoom, surface.plan.tileSize);
        const radiusPx = (this.stampSizeM.peek() / 2) / groundMetersPerPixel(surface.plan.zoom, lngLat.lat);
        this.stroke = {
            surface,
            workBase: surface.work.slice(),
            pathPx: [{ x: start.px, y: start.py }],
            pathSweref: [destSweref],
            pathMerc: [destMerc],
            offsetM,
            offsetMerc,
            // Screen y grows south; mercator y grows north.
            offsetPx: { dx: offsetMerc.dx / mpp, dy: -offsetMerc.dy / mpp },
            radiusPx,
            lastLngLat: lngLat,
            brush: {
                sizeM: this.stampSizeM.peek(),
                opacity: this.stampOpacity.peek(),
                flow: this.stampFlow.peek(),
                hardness: this.stampHardness.peek(),
            },
            toneMatch: this.stampToneMatch.peek(),
            aligned: this.stampAligned.peek(),
        };
        this.notice.set(null);
        this.renderLiveStroke();
        return true;
    }

    /** Extend the live stroke to `lngLat` (mouse move / test seam). Points
     * are sampled at a minimum surface-pixel spacing. */
    extendStroke(lngLat: { lng: number; lat: number }): void {
        const stroke = this.stroke;
        if (!stroke) return;
        if (stroke.pathPx.length >= STAMP_MAX_PATH_POINTS) return;
        const merc = lngLatToMercator(lngLat);
        const px = mercatorToCropPixel(stroke.surface.plan, merc.x, merc.y);
        const last = stroke.pathPx[stroke.pathPx.length - 1];
        if (Math.hypot(px.px - last.x, px.py - last.y) < STAMP_SAMPLE_PX) return;
        stroke.pathPx.push({ x: px.px, y: px.py });
        stroke.pathSweref.push(lngLatToSweref99tm(lngLat));
        stroke.pathMerc.push(merc);
        stroke.lastLngLat = lngLat;
        this.renderLiveStroke();
        // The source ring follows the brush at the stroke's offset.
        this.updateSourceOverlay({ x: merc.x + stroke.offsetMerc.dx, y: merc.y + stroke.offsetMerc.dy });
    }

    /**
     * Finish the live stroke: it becomes a PENDING edit (queued for the next
     * batch bake) and its render is committed to the surface. Public seam.
     * A stroke that never moved is a single dab. Returns true when an edit
     * was queued.
     */
    async endStroke(): Promise<boolean> {
        if (this.strokeInit) {
            const init = this.strokeInit;
            this.strokeInit = null;
            if (!(await init)) return false;
        }
        const stroke = this.stroke;
        if (!stroke) return false;
        this.stroke = null;

        const rM = stroke.brush.sizeM / 2;
        const lat = stroke.lastLngLat.lat;
        const rMerc = rM / Math.cos((lat * Math.PI) / 180);
        const xs = stroke.pathMerc.map(p => p.x);
        const ys = stroke.pathMerc.map(p => p.y);
        const sx = stroke.pathSweref.map(p => p.x);
        const sy = stroke.pathSweref.map(p => p.y);
        const edit: PendingStampEdit = {
            kind: 'stamp',
            brush: stroke.brush,
            offsetM: stroke.offsetM,
            path: stroke.pathSweref,
            aligned: stroke.aligned,
            toneMatch: stroke.toneMatch,
            bounds3857: {
                west: Math.min(...xs) - rMerc,
                south: Math.min(...ys) - rMerc,
                east: Math.max(...xs) + rMerc,
                north: Math.max(...ys) + rMerc,
            },
            boundsSweref: {
                west: Math.min(...sx) - rM,
                south: Math.min(...sy) - rM,
                east: Math.max(...sx) + rM,
                north: Math.max(...sy) + rM,
            },
            surfaceId: stroke.surface.id,
            pathPx: stroke.pathPx,
            offsetPx: stroke.offsetPx,
            radiusPx: stroke.radiusPx,
        };
        this.pending.push(edit);
        this.pendingCount.set(this.pending.length);
        this.lastDab = stroke.lastLngLat;
        // Commit the stroke's render (work already carries it via the live
        // render) and rest the source ring per the aligned semantics.
        const rest = stroke.aligned
            ? { x: lngLatToMercator(stroke.lastLngLat).x + stroke.offsetMerc.dx, y: lngLatToMercator(stroke.lastLngLat).y + stroke.offsetMerc.dy }
            : this.source?.merc;
        if (rest) this.updateSourceOverlay(rest);
        return true;
    }

    /** Shift-click: one straight-line stroke from the last dab to `to`. */
    async strokeLine(from: { lng: number; lat: number }, to: { lng: number; lat: number }): Promise<boolean> {
        if (!(await this.beginStroke(from))) return false;
        // Sample the straight segment densely enough for the px sampler.
        const steps = 64;
        for (let i = 1; i <= steps; i++) {
            this.extendStroke({
                lng: from.lng + ((to.lng - from.lng) * i) / steps,
                lat: from.lat + ((to.lat - from.lat) * i) / steps,
            });
        }
        return this.endStroke();
    }

    /** Cancel the live stroke (ESC / teardown): restore the surface. */
    private cancelStroke(): void {
        this.strokeInit = null;
        const stroke = this.stroke;
        if (!stroke) return;
        this.stroke = null;
        stroke.surface.work = stroke.workBase;
        void this.updateSurfaceOverlay(stroke.surface);
        const map = this.ctx?.map.map.peek();
        (map as MaplibreMap | null)?.dragPan.enable();
        if (this.source) this.updateSourceOverlay(this.source.merc);
    }

    /** [ / ] brush resize. */
    private onKeyDown(e: KeyboardEvent): void {
        if (this.mode.peek() !== 'stamp') return;
        const target = e.target as HTMLElement | null;
        if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
        if (e.key !== '[' && e.key !== ']') return;
        e.preventDefault();
        const factor = e.key === ']' ? STAMP_SIZE_STEP : 1 / STAMP_SIZE_STEP;
        this.stampSizeM.set(Math.min(STAMP_SIZE_MAX_M, Math.max(STAMP_SIZE_MIN_M, this.stampSizeM.peek() * factor)));
    }

    /** Find the surface whose crop contains the stroke start, or compose a
     * new one centered between source and dest (both usually fit then). */
    private async surfaceFor(
        destMerc: { x: number; y: number },
        offsetMerc: { dx: number; dy: number },
        zoom: number,
        gate: { mapKey: string; version: string },
    ): Promise<StampSurface | null> {
        for (const surface of this.surfaces) {
            const p = mercatorToCropPixel(surface.plan, destMerc.x, destMerc.y);
            if (p.px >= 0 && p.py >= 0 && p.px < surface.plan.size && p.py < surface.plan.size) {
                return surface;
            }
        }
        const center = mercatorToLngLat(destMerc.x + offsetMerc.dx / 2, destMerc.y + offsetMerc.dy / 2);
        const plan = planCrop(center.lng, center.lat, zoom, SAM_CROP_SIZE);
        if (!plan) {
            this.notice.set('That area is outside the tiled area.');
            return null;
        }
        const template = this.orthoTemplate(gate);
        const base = await this.imaging.composeCropPixels(
            plan.tiles.map(t => ({ url: fillTileUrl(template, plan.zoom, t.x, t.y), dx: t.dx, dy: t.dy })),
            plan.size,
        );
        const surface: StampSurface = {
            id: `clean-stamp-${++this.overlaySeq}`,
            plan,
            base: base.slice(),
            work: base,
        };
        this.surfaces.push(surface);
        return surface;
    }

    /** Re-render the live stroke onto its surface from the pre-stroke state. */
    private renderLiveStroke(): void {
        const stroke = this.stroke;
        if (!stroke) return;
        const work = stroke.workBase.slice();
        renderStampStroke(work, stroke.surface.plan.size, {
            path: stroke.pathPx,
            offsetPx: stroke.offsetPx,
            radiusPx: stroke.radiusPx,
            opacity: stroke.brush.opacity,
            flow: stroke.brush.flow,
            hardness: stroke.brush.hardness,
            toneMatch: stroke.toneMatch,
        });
        stroke.surface.work = work;
        void this.updateSurfaceOverlay(stroke.surface);
    }

    private async updateSurfaceOverlay(surface: StampSurface): Promise<void> {
        const ctx = this.ctx;
        if (!ctx) return;
        try {
            const url = await this.imaging.pixelsToPngDataUrl(surface.work, surface.plan.size);
            const corner = (px: number, py: number): [number, number] => {
                const p = cropPixelToLngLat(surface.plan, px, py);
                return [p.lng, p.lat];
            };
            const size = surface.plan.size;
            ctx.map.removeOverlayLayer(surface.id);
            ctx.map.addImageOverlay(
                surface.id,
                url,
                [corner(0, 0), corner(size, 0), corner(size, size), corner(0, size)],
                // Below the feature fills, like the inpaint preview.
                { beforeId: 'features-fill' },
            );
        } catch {
            // Map mid-teardown — the preview is decorative until bake.
        }
    }

    /** The clone-source ring marker (follows the brush during a stroke). */
    private updateSourceOverlay(centerMerc: { x: number; y: number }): void {
        const ctx = this.ctx;
        if (!ctx) return;
        const lat = mercatorToLngLat(centerMerc.x, centerMerc.y).lat;
        const rMerc = (this.stampSizeM.peek() / 2) / Math.cos((lat * Math.PI) / 180);
        const ring: Array<[number, number]> = [];
        for (let i = 0; i <= 48; i++) {
            const t = (i / 48) * 2 * Math.PI;
            const p = mercatorToLngLat(centerMerc.x + rMerc * Math.cos(t), centerMerc.y + rMerc * Math.sin(t));
            ring.push([p.lng, p.lat]);
        }
        const data: GeoJSON = {
            type: 'Feature',
            properties: {},
            geometry: { type: 'Polygon', coordinates: [ring] },
        };
        try {
            if (this.sourceOverlayLive) {
                ctx.map.updateOverlayData(CLEAN_SOURCE_OVERLAY_ID, data);
            } else {
                ctx.map.addOverlayLayer(CLEAN_SOURCE_OVERLAY_ID, data, [{
                    id: `${CLEAN_SOURCE_OVERLAY_ID}-line`,
                    type: 'line',
                    paint: { 'line-color': '#7dd3fc', 'line-width': 2 },
                }]);
                this.sourceOverlayLive = true;
            }
        } catch {
            // Map mid-teardown — the marker is decorative.
        }
    }

    private removeSourceOverlay(): void {
        if (!this.sourceOverlayLive) return;
        this.sourceOverlayLive = false;
        this.ctx?.map.removeOverlayLayer(CLEAN_SOURCE_OVERLAY_ID);
    }

    // ── Shared inpaint → candidate preview path (mask modes) ────────────────

    /** Common preconditions; null (with notice) when cleaning can't start. */
    private gate(): { ctx: ToolContext; mapKey: string; version: string; zoom: number } | null {
        const base = this.baseGate();
        if (!base) return null;
        if (this.health.peek() !== 'online' || !this.inpaintReady.peek()) {
            this.notice.set(this.health.peek() !== 'online'
                ? 'Assist sidecar is offline — start tools/sam-server and retry.'
                : `Inpainting unavailable on the sidecar${this.healthDetail.peek() ? ` (${this.healthDetail.peek()})` : ''}.`);
            return null;
        }
        return base;
    }

    /** Stamp preconditions — like gate() but WITHOUT the sidecar (cloning is
     * local math + a server-side pixel bake; SAM/LaMa are never involved). */
    private stampGate(): { ctx: ToolContext; mapKey: string; version: string; zoom: number } | null {
        return this.baseGate();
    }

    private baseGate(): { ctx: ToolContext; mapKey: string; version: string; zoom: number } | null {
        const ctx = this.ctx;
        if (!ctx || this.phase.peek() === 'working' || this.phase.peek() === 'applying') return null;
        if (this.phase.peek() === 'preview') {
            this.notice.set('Accept or discard the current preview first.');
            return null;
        }
        const manifest = ctx.tileset.manifest.peek();
        const mapKey = ctx.tileset.mapKey.peek();
        const version = ctx.tileset.tileVersion.peek();
        if (!manifest || !mapKey || !version) {
            this.notice.set('No ortho tiles for this course — build the map first.');
            return null;
        }
        return { ctx, mapKey, version, zoom: manifest.layers.ortho.maxzoom };
    }

    /** Crops always compose from the SIM layer (per-tile pristine fallback):
     * cleaning is cumulative on the cleaned photo, and the bake executes
     * against the same evolving raster state. */
    private orthoTemplate(gate: { mapKey: string; version: string }): string {
        return tileUrlTemplate(gate.mapKey, 'ortho-sim', 'jpg', this.simTileVersion(gate.version));
    }

    private composeCrop(
        gate: { mapKey: string; version: string },
        plan: CropPlan,
    ): Promise<string> {
        const template = this.orthoTemplate(gate);
        return this.imaging.composeCropPng(
            plan.tiles.map(t => ({ url: fillTileUrl(template, plan.zoom, t.x, t.y), dx: t.dx, dy: t.dy })),
            plan.size,
        );
    }

    private async runInpaint(plan: CropPlan, cropBase64: string, mask: Uint8Array, tool: string): Promise<boolean> {
        const pixels = maskArea(mask);
        if (pixels === 0) {
            this.notice.set('The mask came out empty — nothing to clean.');
            this.phase.set('idle');
            return false;
        }
        const maskPng = await this.imaging.encodeMaskPng(mask, plan.size);
        const resultBase64 = await this.client.inpaint(cropBase64, maskPng);
        this.preview = { plan, mask, maskPngBase64: maskPng, resultBase64, tool, maskPixels: pixels };
        this.addPreviewOverlay(CLEAN_PREVIEW_OVERLAY_ID, plan, resultBase64);
        this.phase.set('preview');
        return true;
    }

    private addPreviewOverlay(id: string, plan: CropPlan, resultBase64: string): void {
        const ctx = this.ctx;
        if (!ctx) return;
        const corner = (px: number, py: number): [number, number] => {
            const p = cropPixelToLngLat(plan, px, py);
            return [p.lng, p.lat];
        };
        try {
            ctx.map.removeOverlayLayer(id);
            ctx.map.addImageOverlay(
                id,
                `data:image/png;base64,${resultBase64}`,
                [corner(0, 0), corner(plan.size, 0), corner(plan.size, plan.size), corner(0, plan.size)],
                // Below the feature fills: the preview replaces PHOTO pixels
                // only — water/bunker tints must stay visible across it.
                { beforeId: 'features-fill' },
            );
        } catch {
            // Map not ready (teardown race) — accept still works; the
            // preview just isn't visible.
        }
    }

    private removePreviewOverlay(): void {
        this.ctx?.map.removeOverlayLayer(CLEAN_PREVIEW_OVERLAY_ID);
    }

    /** Discard the candidate preview: overlay gone, nothing stored anywhere. */
    discard(): void {
        if (this.phase.peek() !== 'preview') return;
        this.removePreviewOverlay();
        this.preview = null;
        this.phase.set('idle');
        this.notice.set(null);
    }

    /**
     * Accept the candidate mask preview: it becomes a PENDING edit (queued
     * for the next batch bake) and its preview overlay stays on the map
     * under a per-edit id. NO server call happens here — see bakeAll().
     */
    accept(): boolean {
        const ctx = this.ctx;
        const preview = this.preview;
        if (!ctx || !preview || this.phase.peek() !== 'preview') return false;
        const { plan, maskPngBase64, resultBase64, tool } = preview;
        const sweref = [
            cropPixelToSweref(plan, 0, 0),
            cropPixelToSweref(plan, plan.size, 0),
            cropPixelToSweref(plan, plan.size, plan.size),
            cropPixelToSweref(plan, 0, plan.size),
        ];
        const overlayId = `clean-pending-${++this.overlaySeq}`;
        this.pending.push({
            kind: 'mask',
            maskPngBase64,
            bounds3857: planBounds3857(plan),
            boundsSweref: {
                west: Math.min(...sweref.map(p => p.x)),
                south: Math.min(...sweref.map(p => p.y)),
                east: Math.max(...sweref.map(p => p.x)),
                north: Math.max(...sweref.map(p => p.y)),
            },
            tool,
            overlayId,
        });
        this.pendingCount.set(this.pending.length);
        // Keep the preview visible under its own id; free the candidate slot.
        this.addPreviewOverlay(overlayId, plan, resultBase64);
        this.removePreviewOverlay();
        this.preview = null;
        this.phase.set('idle');
        this.notice.set(null);
        return true;
    }

    // ── Pending queue → batch bake ──────────────────────────────────────────

    /** True when any pending edit is a mask (needs the LaMa bake deps). */
    private pendingHasMask(): boolean {
        return this.pending.some(e => e.kind === 'mask');
    }

    /**
     * Bake the whole pending queue in ONE server call: ordered edits →
     * applyOrthoEdits → single batch bake into the SIM overlay + one sim
     * version bump — then refresh the sim source in place. On failure the
     * queue (and its previews) stays for retry. Returns true on success.
     */
    async bakeAll(opts: { silent?: boolean } = {}): Promise<boolean> {
        const ctx = this.ctx;
        if (!ctx || this.pending.length === 0) return false;
        if (!opts.silent && this.phase.peek() !== 'idle') return false;
        if (this.pendingHasMask() && !this.bakeable.peek()) {
            this.notice.set(this.bakeReason.peek()
                ?? 'Mask edits cannot bake right now — see the panel notice.');
            return false;
        }
        if (!this.stampBakeable.peek()) {
            this.notice.set(this.bakeReason.peek()
                ?? "This course's map must be rebuilt before edits can bake.");
            return false;
        }
        if (!opts.silent) this.phase.set('applying');
        this.notice.set(null);
        const edits = this.pending.map(e => e.kind === 'mask'
            ? {
                kind: 'mask' as const,
                maskPngBase64: e.maskPngBase64,
                bounds3857: e.bounds3857,
                boundsSweref: e.boundsSweref,
                tool: e.tool,
            }
            : {
                kind: 'stamp' as const,
                brush: e.brush,
                offsetM: e.offsetM,
                path: e.path,
                aligned: e.aligned,
                toneMatch: e.toneMatch,
                bounds3857: e.bounds3857,
                boundsSweref: e.boundsSweref,
            });
        try {
            const result = await this.patchesApi.applyOrthoEdits({ courseId: ctx.courseId, edits });
            this.patchCount.set(result.count);
            this.simGeneratedAt = result.patchesGeneratedAt;
            this.clearPendingPreviews();
            this.pending = [];
            this.pendingCount.set(0);
            if (!opts.silent) this.phase.set('idle');
            // The pristine version did NOT change (dual photo state) — only
            // the sim source refetches, then the manifest signal resyncs.
            this.applyPhotoState();
            await ctx.tileset.refreshTiles(ctx.courseId);
            return true;
        } catch (err) {
            // Keep the queue (and its previews) so the user can retry.
            if (!opts.silent) this.phase.set('idle');
            this.notice.set(`Baking failed: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    }

    /** Drop the most recent pending edit (mask preview or stamp stroke). */
    discardLastPending(): boolean {
        const edit = this.pending.pop();
        if (!edit) return false;
        this.pendingCount.set(this.pending.length);
        if (edit.kind === 'mask') {
            this.ctx?.map.removeOverlayLayer(edit.overlayId);
        } else {
            this.replaySurface(edit.surfaceId);
            this.lastDab = null;
        }
        return true;
    }

    /** Drop the whole pending queue and its previews. */
    discardAllPending(): void {
        this.clearPendingPreviews();
        this.pending = [];
        this.pendingCount.set(0);
        this.lastDab = null;
        this.notice.set(null);
    }

    /** Remove every pending-edit preview (mask overlays + stamp surfaces). */
    private clearPendingPreviews(): void {
        for (const edit of this.pending) {
            if (edit.kind === 'mask') this.ctx?.map.removeOverlayLayer(edit.overlayId);
        }
        for (const surface of this.surfaces) this.ctx?.map.removeOverlayLayer(surface.id);
        this.surfaces = [];
    }

    /** Re-render a stamp surface from its base + the remaining pending
     * strokes (after a discard-last). An empty surface is dropped. */
    private replaySurface(surfaceId: string): void {
        const surface = this.surfaces.find(s => s.id === surfaceId);
        if (!surface) return;
        const strokes = this.pending.filter(
            (e): e is PendingStampEdit => e.kind === 'stamp' && e.surfaceId === surfaceId);
        if (strokes.length === 0) {
            this.ctx?.map.removeOverlayLayer(surface.id);
            this.surfaces = this.surfaces.filter(s => s !== surface);
            return;
        }
        const work = surface.base.slice();
        for (const s of strokes) {
            renderStampStroke(work, surface.plan.size, {
                path: s.pathPx,
                offsetPx: s.offsetPx,
                radiusPx: s.radiusPx,
                opacity: s.brush.opacity,
                flow: s.brush.flow,
                hardness: s.brush.hardness,
                toneMatch: s.toneMatch,
            });
        }
        surface.work = work;
        void this.updateSurfaceOverlay(surface);
    }

    /** Revert v1: drop the last BAKED entry (server re-replays + retiles the
     * sim overlay; the pristine tree is untouched). */
    async revertLast(): Promise<boolean> {
        const ctx = this.ctx;
        if (!ctx || this.phase.peek() !== 'idle') return false;
        if (this.patchCount.peek() === 0) return false;
        this.phase.set('applying');
        this.notice.set(null);
        try {
            const result = await this.patchesApi.revertLastOrthoPatch({ courseId: ctx.courseId });
            this.patchCount.set(result.count);
            this.simGeneratedAt = result.patchesGeneratedAt || this.simGeneratedAt;
            this.phase.set('idle');
            this.applyPhotoState();
            await ctx.tileset.refreshTiles(ctx.courseId);
            return true;
        } catch (err) {
            this.phase.set('idle');
            this.notice.set(`Revert failed: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    }
}
