// "Clean photo" tool (T55) — interactive ortho blemish removal. Click a
// player/cart/shadow/stray object (SAM mask, dilated ~0.5 m) or drag an
// ellipse over it (no SAM needed), the sidecar LaMa-inpaints the 512 px
// crop, and the result shows as a georeferenced PREVIEW overlay on the map.
// Accept bakes it: the server appends the patch to a replayable log under
// data/sources/<mapKey>/patches/, replays ALL patches onto the PRISTINE
// source ortho, retiles only the affected pyramid subtree, and bumps the
// tile version so the map refetches. The pristine ortho is never modified.
//
//   click  → planCrop → compose crop (tiles, never the MapLibre canvas)
//          → /segment → largestPolygon → fillPolygonMask + dilate
//   ellipse→ drag defines the mask directly (works without SAM weights)
//   both   → /inpaint(crop, mask) → preview overlay → accept/discard
//   accept → RGBA patch png (alpha = mask) + exact EPSG:3857 crop bounds
//          → POST /ortho-patches/apply → tileset.reload (new ?v=)
//
// All I/O sits behind constructor seams (sidecar clients' fetch, the
// imaging canvas work, the patches API) so the whole state machine runs
// under bun test.

import { Signal, effect } from '@basics/core/client/core';
import type { Map as MaplibreMap, MapMouseEvent } from 'maplibre-gl';
import type { GeoJSON } from 'geojson';
import type { ToolContext } from '../editor/tool';
import type { MapPointerEvent } from '../map/map.service';
import { tileUrlTemplate } from '../map/map-style';
import type { OrthoPatchesApi } from '../../../shared/api/ortho-patches.gen';
import { api } from '../api';
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

export type CleanMode = 'click' | 'ellipse';
export type CleanPhase = 'idle' | 'working' | 'preview' | 'applying';
export type CleanHealth = 'checking' | 'online' | 'offline';

/**
 * Browser-only imaging seam: crop composition and PNG encoding need canvas,
 * which bun test's happy-dom doesn't have — tests inject fakes and drive
 * the state machine with canned base64 strings.
 */
export interface CleanImaging {
    /** Compose the ortho crop from tiles → base64 PNG (lossless — unmasked
     * result pixels stay byte-identical through the sidecar round trip). */
    composeCropPng(tiles: Array<{ url: string; dx: number; dy: number }>, size: number): Promise<string>;
    /** Mask bitmap → base64 PNG (white = inpaint) for the sidecar. */
    encodeMaskPng(mask: Uint8Array, size: number): Promise<string>;
    /** Inpainted result → base64 RGBA PNG with alpha 255 exactly on mask
     * pixels — the patch the server bakes (only masked pixels land). */
    buildPatchPng(resultBase64: string, mask: Uint8Array, size: number): Promise<string>;
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

function base64ToBlob(base64: string, type: string): Blob {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
}

/** Real canvas implementation of the imaging seam. */
export const browserCleanImaging: CleanImaging = {
    async composeCropPng(tiles, size) {
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

    async buildPatchPng(resultBase64, mask, size) {
        const bitmap = await createImageBitmap(base64ToBlob(resultBase64, 'image/png'));
        const canvas = new OffscreenCanvas(size, size);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const img = ctx.getImageData(0, 0, size, size);
        for (let i = 0; i < mask.length; i++) {
            img.data[i * 4 + 3] = mask[i] ? 255 : 0;
        }
        ctx.putImageData(img, 0, 0);
        return blobToBase64(await canvas.convertToBlob({ type: 'image/png' }));
    },
};

interface PreviewState {
    plan: CropPlan;
    mask: Uint8Array;
    resultBase64: string;
    tool: string; // 'sam' | 'ellipse'
    /** Ground m²-ish size of the mask, for the panel line. */
    maskPixels: number;
}

/**
 * DI singleton behind the `clean` EditorTool (clean-tool.ts) and its panel
 * (clean-panel.component.ts). See the module header for the flow.
 */
export class CleanToolService {
    /** Sidecar process reachability. */
    readonly health = new Signal<CleanHealth>('checking');
    /** LaMa weights + torch ready on the sidecar (/health `inpaint`). */
    readonly inpaintReady = new Signal(false);
    /** Sidecar's reason when inpaint is unavailable. */
    readonly healthDetail = new Signal<string | null>(null);
    /** Mask mode: click = SAM segmentation; ellipse = drag, no SAM needed. */
    readonly mode = new Signal<CleanMode>('click');
    readonly phase = new Signal<CleanPhase>('idle');
    /** One-line panel notice (why the last action produced nothing). */
    readonly notice = new Signal<string | null>(null);
    /** Baked patches on this course's map (server log length). */
    readonly patchCount = new Signal(0);

    private ctx: ToolContext | null = null;
    private preview: PreviewState | null = null;
    private drag: { start: { lng: number; lat: number }; current: { lng: number; lat: number } } | null = null;
    private ellipseOverlayLive = false;
    private rawDisposers: Array<() => void> = [];

    constructor(
        private client: CleanClient = new CleanClient(),
        private sam: SamClient = new SamClient(),
        private imaging: CleanImaging = browserCleanImaging,
        private patchesApi: OrthoPatchesApi = api.orthoPatches,
    ) {}

    // ── EditorTool lifecycle ────────────────────────────────────────────────

    activate(ctx: ToolContext): void {
        this.ctx = ctx;
        this.notice.set(null);
        void this.checkHealth();
        void this.refreshInfo();
        ctx.track(ctx.map.onClick(e => this.onClick(e)));
        ctx.track(ctx.map.onMouseMove(e => this.onMouseMove(e)));

        // Ellipse drags need raw mousedown/mouseup on the live map instance;
        // rebind whenever a (re)created map turns ready (e.g. after a bake's
        // tileset reload re-inits the map).
        const rebind = effect(() => {
            if (!ctx.map.ready.get()) return;
            const map = ctx.map.map.peek();
            if (map) this.bindRawHandlers(map as MaplibreMap);
        });
        ctx.track(() => {
            rebind();
            this.disposeRawHandlers();
        });
    }

    deactivate(): void {
        this.cancelDrag();
        this.removePreviewOverlay();
        this.preview = null;
        this.phase.set('idle');
        this.notice.set(null);
        this.disposeRawHandlers();
        this.ctx = null;
    }

    /** ESC: preview → discard; mid-drag → cancel; else let the toolbar exit. */
    onEscape(): boolean {
        if (this.drag) {
            this.cancelDrag();
            return true;
        }
        if (this.phase.peek() === 'preview') {
            this.discard();
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

    /** Refresh the baked-patch count from the server. */
    async refreshInfo(): Promise<void> {
        const ctx = this.ctx;
        if (!ctx) return;
        try {
            const info = await this.patchesApi.orthoPatchesInfo({ courseId: ctx.courseId });
            this.patchCount.set(info.count);
        } catch {
            // Patch info is decorative; the tool works without it.
        }
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

    // ── Ellipse mode (SAM-free mask) ────────────────────────────────────────

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
        if (this.mode.peek() !== 'ellipse') return;
        if (this.phase.peek() !== 'idle') return;
        if (e.originalEvent.button !== 0) return;
        // ⌘/Ctrl-drag stays the guaranteed pan escape hatch (draw-tool convention).
        if (e.originalEvent.metaKey || e.originalEvent.ctrlKey) return;
        e.preventDefault();
        map.dragPan.disable();
        const p = { lng: e.lngLat.lng, lat: e.lngLat.lat };
        this.drag = { start: p, current: p };
    }

    private onMouseMove(e: MapPointerEvent): void {
        if (!this.drag) return;
        if (this.ctx?.map.interactionMode.peek() !== CLEAN_TOOL_ID) return;
        this.drag.current = e.lngLat;
        this.updateEllipseOverlay();
    }

    private onRawMouseUp(map: MaplibreMap): void {
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

    // ── Shared inpaint → preview → accept path ──────────────────────────────

    /** Common preconditions; null (with notice) when cleaning can't start. */
    private gate(): { ctx: ToolContext; mapKey: string; version: string; zoom: number } | null {
        const ctx = this.ctx;
        if (!ctx || this.phase.peek() === 'working' || this.phase.peek() === 'applying') return null;
        if (this.phase.peek() === 'preview') {
            this.notice.set('Accept or discard the current preview first.');
            return null;
        }
        if (this.health.peek() !== 'online' || !this.inpaintReady.peek()) {
            this.notice.set(this.health.peek() !== 'online'
                ? 'Assist sidecar is offline — start tools/sam-server and retry.'
                : `Inpainting unavailable on the sidecar${this.healthDetail.peek() ? ` (${this.healthDetail.peek()})` : ''}.`);
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

    private composeCrop(
        gate: { mapKey: string; version: string },
        plan: CropPlan,
    ): Promise<string> {
        const template = tileUrlTemplate(gate.mapKey, 'ortho', 'jpg', gate.version);
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
        this.preview = { plan, mask, resultBase64, tool, maskPixels: pixels };
        this.addPreviewOverlay(plan, resultBase64);
        this.phase.set('preview');
        return true;
    }

    private addPreviewOverlay(plan: CropPlan, resultBase64: string): void {
        const ctx = this.ctx;
        if (!ctx) return;
        const corner = (px: number, py: number): [number, number] => {
            const p = cropPixelToLngLat(plan, px, py);
            return [p.lng, p.lat];
        };
        try {
            ctx.map.removeOverlayLayer(CLEAN_PREVIEW_OVERLAY_ID);
            ctx.map.addImageOverlay(
                CLEAN_PREVIEW_OVERLAY_ID,
                `data:image/png;base64,${resultBase64}`,
                [corner(0, 0), corner(plan.size, 0), corner(plan.size, plan.size), corner(0, plan.size)],
            );
        } catch {
            // Map not ready (teardown race) — accept still works; the
            // preview just isn't visible.
        }
    }

    private removePreviewOverlay(): void {
        this.ctx?.map.removeOverlayLayer(CLEAN_PREVIEW_OVERLAY_ID);
    }

    /** Discard the preview: overlay gone, nothing stored anywhere. */
    discard(): void {
        if (this.phase.peek() !== 'preview') return;
        this.removePreviewOverlay();
        this.preview = null;
        this.phase.set('idle');
        this.notice.set(null);
    }

    /**
     * Accept: bake the previewed patch into the course ortho + tiles. Sends
     * the RGBA patch (alpha = mask) with the crop's EXACT EPSG:3857 frame;
     * the server logs it, replays the full log, retiles the affected
     * subtree, and bumps the tile version — then the map reloads tiles.
     */
    async accept(): Promise<boolean> {
        const ctx = this.ctx;
        const preview = this.preview;
        if (!ctx || !preview || this.phase.peek() !== 'preview') return false;
        this.phase.set('applying');
        this.notice.set(null);
        try {
            const { plan, mask, resultBase64, tool } = preview;
            const pngBase64 = await this.imaging.buildPatchPng(resultBase64, mask, plan.size);
            const sweref = [
                cropPixelToSweref(plan, 0, 0),
                cropPixelToSweref(plan, plan.size, 0),
                cropPixelToSweref(plan, plan.size, plan.size),
                cropPixelToSweref(plan, 0, plan.size),
            ];
            const result = await this.patchesApi.applyOrthoPatch({
                courseId: ctx.courseId,
                pngBase64,
                bounds3857: planBounds3857(plan),
                boundsSweref: {
                    west: Math.min(...sweref.map(p => p.x)),
                    south: Math.min(...sweref.map(p => p.y)),
                    east: Math.max(...sweref.map(p => p.x)),
                    north: Math.max(...sweref.map(p => p.y)),
                },
                tool,
            });
            this.patchCount.set(result.count);
            this.removePreviewOverlay();
            this.preview = null;
            this.phase.set('idle');
            await this.reloadTiles();
            return true;
        } catch (err) {
            // Keep the preview so the user can retry or discard.
            this.phase.set('preview');
            this.notice.set(`Baking the patch failed: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    }

    /** Revert v1: drop the last baked patch (server re-replays + retiles). */
    async revertLast(): Promise<boolean> {
        const ctx = this.ctx;
        if (!ctx || this.phase.peek() !== 'idle') return false;
        if (this.patchCount.peek() === 0) return false;
        this.phase.set('applying');
        this.notice.set(null);
        try {
            const result = await this.patchesApi.revertLastOrthoPatch({ courseId: ctx.courseId });
            this.patchCount.set(result.count);
            this.phase.set('idle');
            await this.reloadTiles();
            return true;
        } catch (err) {
            this.phase.set('idle');
            this.notice.set(`Revert failed: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    }

    /**
     * After a bake/revert the tile version changed: reload the manifest so
     * the editor canvas re-inits the map against the new `?v=` (tiles carry
     * year-long immutable cache headers — same-URL refetches would serve
     * stale bytes). The camera is captured first and restored once the new
     * map is ready, so the user stays where they were working.
     */
    private async reloadTiles(): Promise<void> {
        const ctx = this.ctx;
        if (!ctx) return;
        const map = ctx.map.map.peek() as MaplibreMap | null;
        const camera = map
            ? { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() }
            : null;
        await ctx.tileset.reload(ctx.courseId);
        if (!camera) return;
        let restored = false;
        const stop = effect(() => {
            if (restored || !ctx.map.ready.get()) return;
            restored = true;
            (ctx.map.map.peek() as MaplibreMap | null)?.jumpTo(camera);
            queueMicrotask(() => stop());
        });
        // Don't leak the effect if the new map never becomes ready.
        setTimeout(() => { if (!restored) stop(); }, 15_000);
    }
}
