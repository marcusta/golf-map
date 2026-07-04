import { Signal, Computed, effect, untrack, di, Router } from '@basics/core/client/core';
import type { Map as MaplibreMap, MapMouseEvent } from 'maplibre-gl';
import type { ToolContext } from '../editor/tool';
import type { MapPointerEvent } from '../map/map.service';
import { CourseDetailService } from '../course-detail/course-detail.service';
import type { Hole } from '../../../shared/api/holes.gen';
import type { Tee } from '../../../shared/api/tees.gen';
import type { Pin } from '../../../shared/api/pins.gen';
import type { AimPoint } from '../../../shared/api/aim-points.gen';
import { FurnitureService, FURNITURE_TOOL_ID } from './furniture.service';
import { FURNITURE_OVERLAY_ID, buildFurnitureGeojson, furnitureLayers } from './furniture-overlay';

const MARKER_HIT_PX = 12;
const DRAG_MOVE_THRESHOLD_PX = 3;

interface DragTarget {
    kind: 'tee' | 'pin' | 'aim';
    id: string;
    startScreen: { x: number; y: number };
    moved: boolean;
}

/**
 * Tees / pins / aim-points placement interactions. Registered as the
 * `furniture` EditorTool (furniture-tool.ts); FurniturePanelComponent shares
 * this DI singleton for its UI.
 *
 * Modes (FurnitureService.placing):
 * - select (default): click near a marker selects it; drag a marker moves it
 *   (autosave, re-samples elevation); Delete removes the selection (confirm).
 * - placing 'tee'|'pin'|'aim' (panel buttons): click places the item on the
 *   SELECTED hole (?hole= query). Requires a hole selected; pins additionally
 *   require the hole to have a green.
 */
export class FurnitureToolService {
    private svc = di.get(FurnitureService);
    private router = di.get(Router);
    private courseDetail = di.get(CourseDetailService);
    private ctx: ToolContext | null = null;
    private drag: DragTarget | null = null;
    private suppressClick = false;
    private overlayAdded = false;

    /** ?hole= carries the hole NUMBER; resolve to the Hole for the selected course. */
    private readonly selectedHoleNumber = this.router.query('hole');
    readonly selectedHole = new Computed<Hole | null>(() => {
        const num = this.selectedHoleNumber.get();
        if (num === undefined) return null;
        return this.courseDetail.holes.get().find(h => String(h.number) === num) ?? null;
    });

    /** Whether the current placement mode is actionable (hole + green as needed). */
    readonly placementHint = new Computed<string | null>(() => {
        const kind = this.svc.placing.get();
        if (kind === null) return null;
        const hole = this.selectedHole.get();
        if (!hole) return 'Select a hole first (pick one from the hole list).';
        if (kind === 'pin' && !this.svc.greenForHole(hole.id)) {
            return `Hole ${hole.number} has no green yet — draw/import one before placing pins.`;
        }
        const label = kind === 'tee' ? 'tee' : kind === 'pin' ? 'pin' : 'aim point';
        return `Click the map to place a ${label} on hole ${hole.number}.`;
    });

    // ── EditorTool lifecycle ────────────────────────────────────────────────

    /** Canvas mount: load furniture + always-on overlay. */
    attach(ctx: ToolContext): void {
        this.ctx = ctx;
        this.svc.useElevation(ctx.elevation); // wire live elevation auto-sampling
        const holeIds = this.holeIds();
        this.svc.setHoleIds(holeIds);
        // Holes may still be loading when attach runs — load once they arrive.
        ctx.track(effect(() => {
            const ids = this.courseDetail.holes.get().map(h => h.id);
            if (ids.length === 0) return;
            untrack(() => {
                this.svc.setHoleIds(ids);
                void this.svc.load(ctx.courseId, ids);
            });
        }));
        ctx.track(this.attachOverlay(ctx));
    }

    activate(ctx: ToolContext): void {
        this.ctx = ctx;

        ctx.track(ctx.map.onClick(e => this.onClick(e)));

        const onKeyDown = (e: KeyboardEvent) => this.onKeyDown(e);
        window.addEventListener('keydown', onKeyDown);
        ctx.track(() => window.removeEventListener('keydown', onKeyDown));

        // Raw handlers for marker drag (mousedown near marker → move → up).
        ctx.track(effect(() => {
            if (!ctx.map.ready.get()) return;
            const map = ctx.map.map.get();
            if (!map) return;
            untrack(() => this.bindRawHandlers(map, ctx));
        }));

        // Move handler for the in-progress drag.
        ctx.track(ctx.map.onMouseMove(e => this.onMouseMove(e)));
    }

    deactivate(): void {
        this.endDrag();
        this.svc.disarm();
        this.svc.select(null);
        this.suppressClick = false;
    }

    /** ESC: cancel placement → drop selection → (unconsumed) deactivate. */
    onEscape(): boolean {
        if (this.svc.placing.peek() !== null) {
            this.svc.disarm();
            return true;
        }
        if (this.svc.selection.peek()) {
            this.svc.select(null);
            return true;
        }
        return false;
    }

    // ── Overlay ─────────────────────────────────────────────────────────────

    private attachOverlay(ctx: ToolContext): () => void {
        const disposeEffect = effect(() => {
            const ready = ctx.map.ready.get();
            const data = buildFurnitureGeojson({
                tees: this.svc.tees.items.get(),
                pins: this.svc.pins.items.get(),
                greens: this.svc.greens.get(),
                aims: this.svc.aims.items.get(),
                holeIds: this.courseDetail.holes.get().map(h => h.id),
                selection: this.svc.selection.get(),
            });
            if (!ready) {
                this.overlayAdded = false; // overlay died with the map
                return;
            }
            if (!this.overlayAdded) {
                ctx.map.addOverlayLayer(FURNITURE_OVERLAY_ID, data, furnitureLayers());
                this.overlayAdded = true;
            } else {
                ctx.map.updateOverlayData(FURNITURE_OVERLAY_ID, data);
            }
        });
        return () => {
            disposeEffect();
            if (this.overlayAdded) {
                ctx.map.removeOverlayLayer(FURNITURE_OVERLAY_ID);
                this.overlayAdded = false;
            }
        };
    }

    // ── Event handling ──────────────────────────────────────────────────────

    private isMyClaim(): boolean {
        return this.ctx?.map.interactionMode.peek() === FURNITURE_TOOL_ID;
    }

    private onClick(e: MapPointerEvent): void {
        if (!this.isMyClaim()) return;
        if (this.suppressClick) return;

        const kind = this.svc.placing.peek();
        if (kind !== null) {
            void this.place(kind, e.lngLat);
            return;
        }

        // Select mode: pick the nearest marker within tolerance.
        const hit = this.hitMarker(e.point);
        this.svc.select(hit);
    }

    private onMouseMove(e: MapPointerEvent): void {
        if (!this.isMyClaim()) return;
        const drag = this.drag;
        if (!drag) return;
        if (!drag.moved && this.pxDist(drag.startScreen, e.point) < DRAG_MOVE_THRESHOLD_PX) return;
        drag.moved = true;
        // Local patch for instant feedback; persistence happens on mouseup.
        this.patchLocal(drag.kind, drag.id, e.lngLat.lat, e.lngLat.lng);
    }

    private bindRawHandlers(map: MaplibreMap, ctx: ToolContext): void {
        const onMouseDown = (e: MapMouseEvent) => this.onMouseDown(e, map);
        const onMouseUp = () => this.onMouseUp(map);
        map.on('mousedown', onMouseDown);
        map.on('mouseup', onMouseUp);
        ctx.track(() => {
            map.off('mousedown', onMouseDown);
            map.off('mouseup', onMouseUp);
        });
    }

    private onMouseDown(e: MapMouseEvent, map: MaplibreMap): void {
        if (!this.isMyClaim()) return;
        if (e.originalEvent.button !== 0) return;
        if (this.svc.placing.peek() !== null) return;

        const hit = this.hitMarker(e.point);
        if (!hit) return;
        e.preventDefault(); // stops the map's drag-pan for this gesture
        map.dragPan.disable();
        this.svc.select(hit);
        this.drag = {
            kind: hit.kind,
            id: hit.id,
            startScreen: { x: e.point.x, y: e.point.y },
            moved: false,
        };
    }

    private onMouseUp(map: MaplibreMap): void {
        const drag = this.drag;
        if (!drag) return;
        this.endDrag(map);

        // Swallow the click MapLibre synthesizes right after this mouseup.
        this.suppressClick = true;
        setTimeout(() => { this.suppressClick = false; }, 0);

        if (!drag.moved) return;
        const pos = this.currentPos(drag.kind, drag.id);
        if (!pos) return;
        if (drag.kind === 'tee') void this.svc.moveTee(drag.id, pos.lat, pos.lon);
        else if (drag.kind === 'pin') void this.svc.movePin(drag.id, pos.lat, pos.lon);
        else void this.svc.moveAim(drag.id, pos.lat, pos.lon);
    }

    private onKeyDown(e: KeyboardEvent): void {
        if (!this.isMyClaim()) return;
        const target = e.target as HTMLElement | null;
        if (
            target instanceof HTMLInputElement ||
            target instanceof HTMLSelectElement ||
            target instanceof HTMLTextAreaElement
        ) return;

        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (this.svc.selection.peek()) {
                e.preventDefault();
                void this.deleteSelected();
            }
        }
    }

    // ── Actions ──────────────────────────────────────────────────────────────

    /** Place the armed item at a WGS84 position on the selected hole. */
    private async place(kind: 'tee' | 'pin' | 'aim', lngLat: { lng: number; lat: number }): Promise<void> {
        const hole = this.selectedHole.peek();
        if (!hole) return; // panel shows the hint
        if (kind === 'tee') {
            await this.svc.createTee({
                holeId: hole.id,
                name: this.svc.pendingTeeName.peek() || defaultTeeName(this.svc.pendingTeeColor.peek()),
                color: this.svc.pendingTeeColor.peek(),
                lat: lngLat.lat,
                lon: lngLat.lng,
            });
        } else if (kind === 'pin') {
            const green = this.svc.greenForHole(hole.id);
            if (!green) return; // hint covers this
            await this.svc.createPin({
                greenId: green.id,
                name: this.svc.pendingPinName.peek() || 'Pin',
                difficulty: this.svc.pendingPinDifficulty.peek(),
                lat: lngLat.lat,
                lon: lngLat.lng,
            });
        } else {
            const n = this.svc.aimsForHole(hole.id).length + 1;
            await this.svc.createAim({ holeId: hole.id, lat: lngLat.lat, lon: lngLat.lng, label: `A${n}` });
        }
    }

    /** Delete the selected item after confirmation (Delete key or panel button). */
    async deleteSelected(): Promise<void> {
        const sel = this.svc.selection.peek();
        if (!sel) return;
        const label = sel.kind === 'tee' ? 'tee' : sel.kind === 'pin' ? 'pin' : 'aim point';
        if (!window.confirm(`Delete this ${label}?`)) return;
        if (sel.kind === 'tee') await this.svc.removeTee(sel.id);
        else if (sel.kind === 'pin') await this.svc.removePin(sel.id);
        else await this.svc.removeAim(sel.id);
    }

    // ── Hit testing ───────────────────────────────────────────────────────────

    /** Nearest tee/pin/aim marker within MARKER_HIT_PX of the screen point. */
    private hitMarker(screen: { x: number; y: number }): { kind: 'tee' | 'pin' | 'aim'; id: string } | null {
        const map = this.ctx?.map.map.peek();
        if (!map) return null;
        let best: { kind: 'tee' | 'pin' | 'aim'; id: string } | null = null;
        let bestDist = MARKER_HIT_PX;
        const consider = (kind: 'tee' | 'pin' | 'aim', id: string, lat: number, lon: number) => {
            const p = map.project([lon, lat]);
            const d = Math.hypot(p.x - screen.x, p.y - screen.y);
            if (d < bestDist) { bestDist = d; best = { kind, id }; }
        };
        for (const t of this.svc.tees.items.peek()) consider('tee', t.id, t.lat, t.lon);
        for (const p of this.svc.pins.items.peek()) consider('pin', p.id, p.lat, p.lon);
        for (const a of this.svc.aims.items.peek()) consider('aim', a.id, a.lat, a.lon);
        return best;
    }

    private currentPos(kind: 'tee' | 'pin' | 'aim', id: string): { lat: number; lon: number } | null {
        const row = this.rowOf(kind, id);
        return row ? { lat: row.lat, lon: row.lon } : null;
    }

    private rowOf(kind: 'tee' | 'pin' | 'aim', id: string): Tee | Pin | AimPoint | undefined {
        if (kind === 'tee') return this.svc.tees.items.peek().find(t => t.id === id);
        if (kind === 'pin') return this.svc.pins.items.peek().find(p => p.id === id);
        return this.svc.aims.items.peek().find(a => a.id === id);
    }

    private patchLocal(kind: 'tee' | 'pin' | 'aim', id: string, lat: number, lon: number): void {
        if (kind === 'tee') {
            const r = this.svc.tees.items.peek().find(t => t.id === id);
            if (r) this.svc.tees.patch({ ...r, lat, lon });
        } else if (kind === 'pin') {
            const r = this.svc.pins.items.peek().find(p => p.id === id);
            if (r) this.svc.pins.patch({ ...r, lat, lon });
        } else {
            const r = this.svc.aims.items.peek().find(a => a.id === id);
            if (r) this.svc.aims.patch({ ...r, lat, lon });
        }
    }

    private endDrag(map?: MaplibreMap): void {
        if (!this.drag) return;
        this.drag = null;
        (map ?? this.ctx?.map.map.peek())?.dragPan.enable();
    }

    private pxDist(a: { x: number; y: number }, b: { x: number; y: number }): number {
        return Math.hypot(a.x - b.x, a.y - b.y);
    }

    private holeIds(): string[] {
        return this.courseDetail.holes.peek().map(h => h.id);
    }
}

function defaultTeeName(color: string): string {
    return color.charAt(0).toUpperCase() + color.slice(1);
}
