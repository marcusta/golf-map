import { di, effect, untrack } from '@basics/core/client/core';
import type { ToolContext } from '../editor/tool';
import type { MapPointerEvent } from '../map/map.service';
import { lngLatToSweref99tm } from '../geo/transform';
import { FurnitureService } from '../furniture/furniture.service';
import { holeLine, type HoleLine } from './photo-filter';
import { PhotosService } from './photos.service';
import { PHOTOS_OVERLAY_ID, photosGeojson, photosLayers } from './photos-overlay';

/** Interaction-claim id of the Photos sub-mode. */
export const PHOTOS_TOOL_ID = 'photos';

/** Screen-px radius for clicking a photo marker. */
const HIT_PX = 12;

/** Width the map-view photo card takes from the canvas's left edge (photo-browser.component.ts). */
const PHOTO_CARD_CLEARANCE_PX = 400;

/**
 * The Photos sub-mode's map side (registered as the `photos` EditorTool in
 * photos-tool.ts). The dock panel (filters, view switch) and the browser over
 * the canvas (catalog, photo card, viewer) share PhotosService with it.
 *
 * - `attach`: loads the course site's photos, and the course furniture for
 *   the hole play lines the "near hole" filter measures against.
 * - `activate`: draws the filtered photos (markers + view wedges + the picked
 *   position's circle), selects a photo on a marker click, and sets the
 *   "near position" filter on a click while picking.
 */
export class PhotosToolService {
    private svc = di.get(PhotosService);
    private furniture = di.get(FurnitureService);
    private ctx: ToolContext | null = null;
    private overlayAdded = false;

    attach(ctx: ToolContext): void {
        ctx.track(effect(() => {
            const course = ctx.courseDetail.course.get();
            if (!course || course.id !== ctx.courseId) return;
            const siteId = course.siteId;
            untrack(() => void this.svc.load(siteId));
        }));

        // Hole lines need the furniture. The Furniture tool loads it too
        // (cached per course); serve mode has no Furniture tool, so load here.
        ctx.track(effect(() => {
            const ids = ctx.courseDetail.holes.get().map(h => h.id);
            if (ids.length === 0) return;
            untrack(() => void this.furniture.load(ctx.courseId, ids));
        }));
        ctx.track(effect(() => {
            const holes = ctx.courseDetail.holes.get();
            const tees = this.furniture.tees.items.get();
            const aims = this.furniture.aims.items.get();
            const greens = this.furniture.greens.get();
            const lines = new Map<number, HoleLine>();
            for (const hole of holes) {
                const line = holeLine(
                    hole.number,
                    tees.filter(t => t.holeId === hole.id),
                    aims.filter(a => a.holeId === hole.id),
                    greens.find(g => g.holeId === hole.id) ?? null,
                );
                if (line) lines.set(hole.number, line);
            }
            untrack(() => this.svc.holeLines.set(lines));
        }));
    }

    activate(ctx: ToolContext): void {
        this.ctx = ctx;
        ctx.track(ctx.map.onClick(e => this.onClick(e)));
        ctx.track(ctx.map.onMouseMove(e => this.onMouseMove(e)));

        ctx.track(effect(() => {
            const ready = ctx.map.ready.get();
            const data = photosGeojson(
                this.svc.filtered.get(),
                this.svc.selectedId.get(),
                this.svc.filter.get().near,
                lngLatToSweref99tm,
            );
            if (!ready) {
                this.overlayAdded = false;
                return;
            }
            untrack(() => {
                if (!this.overlayAdded) {
                    ctx.map.addOverlayLayer(PHOTOS_OVERLAY_ID, data, photosLayers(), { keepOnTop: true });
                    this.overlayAdded = true;
                } else {
                    ctx.map.updateOverlayData(PHOTOS_OVERLAY_ID, data);
                }
            });
        }));
        ctx.track(() => {
            if (this.overlayAdded) {
                ctx.map.removeOverlayLayer(PHOTOS_OVERLAY_ID);
                this.overlayAdded = false;
            }
        });

        // Crosshair while picking a position.
        ctx.track(effect(() => {
            const picking = this.svc.pickingPosition.get();
            if (!ctx.map.ready.get()) return;
            const canvas = ctx.map.map.get()?.getCanvas();
            if (canvas) canvas.style.cursor = picking ? 'crosshair' : '';
        }));
        ctx.track(() => {
            const canvas = ctx.map.map.get()?.getCanvas();
            if (canvas) canvas.style.cursor = '';
        });
    }

    deactivate(): void {
        this.ctx = null;
        this.svc.pickingPosition.set(false);
        this.svc.closeViewer();
    }

    /** ESC: close the viewer, stop picking, drop the selection — then leave. */
    onEscape(): boolean {
        if (this.svc.viewerOpen.peek()) {
            this.svc.closeViewer();
            return true;
        }
        if (this.svc.pickingPosition.peek()) {
            this.svc.pickingPosition.set(false);
            return true;
        }
        if (this.svc.selectedId.peek()) {
            this.svc.select(null);
            return true;
        }
        return false;
    }

    /** Centre the map on a photo (from the catalog's "Show on map"). */
    showOnMap(id: string): void {
        const photo = this.svc.photos.peek().find(p => p.id === id);
        if (!photo) return;
        this.svc.select(id);
        this.svc.setView('map');
        const map = this.ctx?.map.map.peek();
        // Land the photo right of centre: the photo card covers the top-left.
        map?.easeTo({ center: [photo.lon, photo.lat], zoom: Math.max(map.getZoom(), 17.5), offset: [PHOTO_CARD_CLEARANCE_PX / 2, 0] });
    }

    private isMyClaim(): boolean {
        return this.ctx?.map.interactionMode.peek() === PHOTOS_TOOL_ID;
    }

    private onClick(e: MapPointerEvent): void {
        if (!this.isMyClaim()) return;
        if (this.svc.pickingPosition.peek()) {
            this.svc.pickPosition(e.lngLat);
            return;
        }
        this.svc.select(this.hitTest(e.point));
    }

    private onMouseMove(e: MapPointerEvent): void {
        if (!this.isMyClaim() || this.svc.pickingPosition.peek()) return;
        const canvas = this.ctx?.map.map.peek()?.getCanvas();
        if (canvas) canvas.style.cursor = this.hitTest(e.point) ? 'pointer' : '';
    }

    /** The nearest photo marker within HIT_PX of a screen point. */
    private hitTest(point: { x: number; y: number }): string | null {
        const map = this.ctx?.map.map.peek();
        if (!map) return null;
        let best: { id: string; d: number } | null = null;
        for (const p of this.svc.filtered.peek()) {
            const s = map.project([p.lon, p.lat]);
            const d = Math.hypot(s.x - point.x, s.y - point.y);
            if (d <= HIT_PX && (!best || d < best.d)) best = { id: p.id, d };
        }
        return best?.id ?? null;
    }
}
