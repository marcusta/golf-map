import { Signal, Computed, effect, untrack, di, Router } from '@basics/core/client/core';
import type { Map as MaplibreMap, MapMouseEvent } from 'maplibre-gl';
import type { ToolContext } from '../editor/tool';
import type { MapPointerEvent } from '../map/map.service';
import { CourseDetailService } from '../course-detail/course-detail.service';
import type { Hole } from '../../../shared/api/holes.gen';
import type { Tee } from '../../../shared/api/tees.gen';
import type { Pin } from '../../../shared/api/pins.gen';
import type { AimPoint } from '../../../shared/api/aim-points.gen';
import { FurnitureService, FURNITURE_TOOL_ID, defaultTeeName, greenPointFields, type GreenPoint, type Selection } from './furniture.service';
import { FURNITURE_OVERLAY_ID, buildFurnitureGeojson, furnitureLayers } from './furniture-overlay';

/** Screen-px radius for click-to-select and mousedown-to-drag hit testing. */
const MARKER_HIT_PX = 14;
/**
 * Screen-px radius around an existing SAME-kind marker within which an armed
 * placement click is reinterpreted as a select (prevents accidental dupes).
 */
const PLACEMENT_PROXIMITY_PX = 16;
const DRAG_MOVE_THRESHOLD_PX = 2;

/**
 * A hit-tested marker. Tees/pins/aims are `{ kind, id }`; green points are
 * `{ kind: 'green', holeId, point }` since all three share one row per hole.
 */
type MarkerHit =
    | { kind: 'tee'; id: string }
    | { kind: 'pin'; id: string }
    | { kind: 'aim'; id: string }
    | { kind: 'green'; holeId: string; point: GreenPoint };

interface DragTarget {
    hit: MarkerHit;
    startScreen: { x: number; y: number };
    moved: boolean;
}

/** A hit as a Selection (they share shape). */
function hitToSelection(hit: MarkerHit): Selection {
    return hit.kind === 'green'
        ? { kind: 'green', holeId: hit.holeId, point: hit.point }
        : { kind: hit.kind, id: hit.id };
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
        if (kind === 'tee') {
            const color = this.svc.pendingTeeColor.get();
            const name = this.svc.pendingTeeName.get().trim() || defaultTeeName(color);
            return `Placing: Tee (${name}) on hole ${hole.number} — click map to place, `
                + `Shift-click to place multiple, Esc to cancel.`;
        }
        if (kind === 'green') {
            const gp = this.svc.pendingGreenPoint.get();
            const gpLabel = gp === 'center' ? 'Center' : gp === 'front' ? 'Front' : 'Back';
            const hasGreen = !!this.svc.greenForHole(hole.id);
            if (!hasGreen && gp !== 'center') {
                return `Hole ${hole.number} has no green yet — place the green Center first `
                    + `(then Front/Back).`;
            }
            const verb = hasGreen ? 'set' : 'create';
            return `Placing green ${gpLabel} on hole ${hole.number} — click to ${verb} `
                + `${gpLabel} position, Esc to cancel.`;
        }
        const label = kind === 'pin' ? 'Pin' : 'Aim point';
        return `Placing: ${label} on hole ${hole.number} — click map to place, `
            + `Shift-click to place multiple, Esc to cancel.`;
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
        ctx.track(this.attachHoleFraming(ctx));
    }

    // ── Per-hole camera framing ───────────────────────────────────────────────

    /**
     * Ease the camera to the selected hole's furniture whenever the ?hole=
     * selection changes. Gated on a "frame key" (hole id + a loaded flag) so
     * it fires on selection — and once more when a late furniture load
     * arrives for an already-selected hole — but NOT on every tee/aim edit
     * (moving a marker keeps the key stable, so the camera stays put).
     */
    private attachHoleFraming(ctx: ToolContext): () => void {
        const frameKey = new Computed<string | null>(() => {
            const hole = this.selectedHole.get();
            if (!hole || this.svc.loading.get()) return null;
            return hole.id;
        });
        return effect(() => {
            const holeId = frameKey.get();
            if (holeId === null || !ctx.map.ready.get()) return;
            untrack(() => {
                const bounds = this.holeBounds(holeId);
                if (bounds) ctx.map.fitBounds(bounds);
            });
        });
    }

    /**
     * WGS84 bbox `[west, south, east, north]` enclosing all of a hole's
     * furniture (tees, aim points, green center/front/back, pins), or null
     * when the hole has no placed furniture yet.
     */
    private holeBounds(holeId: string): [number, number, number, number] | null {
        const pts: Array<{ lat: number; lon: number }> = [];
        for (const t of this.svc.tees.items.peek()) if (t.holeId === holeId) pts.push(t);
        for (const a of this.svc.aims.items.peek()) if (a.holeId === holeId) pts.push(a);
        const green = this.svc.greenForHole(holeId);
        if (green) {
            for (const point of ['center', 'front', 'back'] as const) {
                const pos = this.svc.greenPointPos(green, point);
                if (pos) pts.push(pos);
            }
            for (const p of this.svc.pins.items.peek()) if (p.greenId === green.id) pts.push(p);
        }
        if (pts.length === 0) return null;
        let w = pts[0]!.lon, e = pts[0]!.lon, s = pts[0]!.lat, n = pts[0]!.lat;
        for (const p of pts) {
            if (p.lon < w) w = p.lon;
            if (p.lon > e) e = p.lon;
            if (p.lat < s) s = p.lat;
            if (p.lat > n) n = p.lat;
        }
        return [w, s, e, n];
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
            this.svc.notice.set(null);
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
            const holeIds = this.courseDetail.holes.get().map(h => h.id);
            // Resolve each hole's aim-line origin tee reactively. Reads
            // activeTeeName (+ per-hole tees) so a "line from" change or any
            // tee move/place/delete re-runs this effect and re-anchors the line.
            const lineOriginByHole = new Map<string, string>();
            for (const holeId of holeIds) {
                const origin = this.svc.lineOriginTee(holeId);
                if (origin) lineOriginByHole.set(holeId, origin.id);
            }
            const data = buildFurnitureGeojson({
                tees: this.svc.tees.items.get(),
                pins: this.svc.pins.items.get(),
                greens: this.svc.greens.get(),
                aims: this.svc.aims.items.get(),
                holeIds,
                selection: this.svc.selection.get(),
                highlightHoleId: this.selectedHole.get()?.id ?? null,
                lineOriginByHole,
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
            // Proximity guard: an armed click landing on an existing marker of
            // the SAME kind selects it instead of stacking a duplicate. For
            // greens, the same-kind guard is narrowed to the SAME point (C/F/B)
            // so e.g. arming Back near an existing Back selects it.
            const near = this.hitMarker(e.point, PLACEMENT_PROXIMITY_PX);
            if (near && near.kind === kind &&
                (kind !== 'green' || (near.kind === 'green' && near.point === this.svc.pendingGreenPoint.peek()))) {
                this.svc.select(hitToSelection(near));
                return;
            }
            const keepArmed = e.originalEvent.shiftKey;
            void this.place(kind, e.lngLat, keepArmed);
            return;
        }

        // Select mode: pick the nearest marker within tolerance.
        const hit = this.hitMarker(e.point);
        this.svc.select(hit ? hitToSelection(hit) : null);
    }

    private onMouseMove(e: MapPointerEvent): void {
        if (!this.isMyClaim()) return;
        const drag = this.drag;
        if (!drag) return;
        if (!drag.moved && this.pxDist(drag.startScreen, e.point) < DRAG_MOVE_THRESHOLD_PX) return;
        drag.moved = true;
        // Local patch for instant feedback; persistence happens on mouseup.
        this.patchLocal(drag.hit, e.lngLat.lat, e.lngLat.lng);
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
        this.svc.select(hitToSelection(hit));
        this.drag = {
            hit,
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
        const pos = this.currentPos(drag.hit);
        if (!pos) return;
        const hit = drag.hit;
        if (hit.kind === 'tee') void this.svc.moveTee(hit.id, pos.lat, pos.lon);
        else if (hit.kind === 'pin') void this.svc.movePin(hit.id, pos.lat, pos.lon);
        else if (hit.kind === 'aim') void this.svc.moveAim(hit.id, pos.lat, pos.lon);
        else void this.svc.setGreenPoint(hit.holeId, hit.point, pos.lat, pos.lon);
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

    /**
     * Place the armed item at a WGS84 position on the selected hole.
     *
     * One-shot by default: after a successful placement we DISARM (back to
     * select/move). Hold Shift (`keepArmed`) to stay armed for rapid
     * multi-placement.
     */
    private async place(
        kind: 'tee' | 'pin' | 'aim' | 'green',
        lngLat: { lng: number; lat: number },
        keepArmed: boolean,
    ): Promise<void> {
        const hole = this.selectedHole.peek();
        if (!hole) return; // panel shows the hint

        let created: unknown;
        if (kind === 'green') {
            const gp = this.svc.pendingGreenPoint.peek();
            // Placing an existing point = moving it (correct semantics). Creates
            // the row on first Center placement; F/B on a green-less hole is
            // rejected inside setGreenPoint with a notice.
            created = await this.svc.setGreenPoint(hole.id, gp, lngLat.lat, lngLat.lng);
        } else if (kind === 'tee') {
            const name = this.svc.pendingTeeName.peek().trim()
                || defaultTeeName(this.svc.pendingTeeColor.peek());
            // Client-side duplicate guard: the server enforces UNIQUE(hole, name)
            // and would only surface a raw 500. Catch it here, tell the user, and
            // auto-advance the pending preset to the next free colour.
            if (this.svc.teeNameTaken(hole.id, name)) {
                this.svc.notice.set(
                    `A '${name}' tee already exists on hole ${hole.number}.`
                    + (this.svc.advancePendingTee(hole.id)
                        ? ` Switched to '${this.svc.pendingTeeName.peek() || defaultTeeName(this.svc.pendingTeeColor.peek())}'.`
                        : ' All tee colours are used on this hole.'),
                );
                return; // stay armed so the next click places the advanced preset
            }
            created = await this.svc.createTee({
                holeId: hole.id,
                name,
                color: this.svc.pendingTeeColor.peek(),
                lat: lngLat.lat,
                lon: lngLat.lng,
            });
        } else if (kind === 'pin') {
            const green = this.svc.greenForHole(hole.id);
            if (!green) return; // hint covers this
            created = await this.svc.createPin({
                greenId: green.id,
                name: this.svc.pendingPinName.peek().trim() || 'Pin',
                difficulty: this.svc.pendingPinDifficulty.peek(),
                lat: lngLat.lat,
                lon: lngLat.lng,
            });
        } else {
            const n = this.svc.aimsForHole(hole.id).length + 1;
            created = await this.svc.createAim({ holeId: hole.id, lat: lngLat.lat, lon: lngLat.lng, label: `A${n}` });
        }

        // One-shot: disarm on success unless Shift is held (rapid multi-place).
        if (created && !keepArmed) this.svc.disarm();
    }

    /** Delete the selected item after confirmation (Delete key or panel button). */
    async deleteSelected(): Promise<void> {
        const sel = this.svc.selection.peek();
        if (!sel) return;
        if (sel.kind === 'green') {
            // Green points are structural (part of the hole's green row) — no delete.
            this.svc.notice.set('Green points can\'t be deleted (they\'re part of the hole\'s green). Move it instead.');
            return;
        }
        const label = sel.kind === 'tee' ? 'tee' : sel.kind === 'pin' ? 'pin' : 'aim point';
        if (!window.confirm(`Delete this ${label}?`)) return;
        if (sel.kind === 'tee') await this.svc.removeTee(sel.id);
        else if (sel.kind === 'pin') await this.svc.removePin(sel.id);
        else await this.svc.removeAim(sel.id);
    }

    // ── Hit testing ───────────────────────────────────────────────────────────

    /** Nearest tee/pin/aim/green marker within `radiusPx` of the screen point. */
    private hitMarker(
        screen: { x: number; y: number },
        radiusPx: number = MARKER_HIT_PX,
    ): MarkerHit | null {
        const map = this.ctx?.map.map.peek();
        if (!map) return null;
        let best: MarkerHit | null = null;
        let bestDist = radiusPx;
        const consider = (hit: MarkerHit, lat: number, lon: number) => {
            const p = map.project([lon, lat]);
            const d = Math.hypot(p.x - screen.x, p.y - screen.y);
            if (d < bestDist) { bestDist = d; best = hit; }
        };
        for (const t of this.svc.tees.items.peek()) consider({ kind: 'tee', id: t.id }, t.lat, t.lon);
        for (const p of this.svc.pins.items.peek()) consider({ kind: 'pin', id: p.id }, p.lat, p.lon);
        for (const a of this.svc.aims.items.peek()) consider({ kind: 'aim', id: a.id }, a.lat, a.lon);
        for (const g of this.svc.greens.peek()) {
            for (const point of ['center', 'front', 'back'] as const) {
                const pos = this.svc.greenPointPos(g, point);
                if (pos) consider({ kind: 'green', holeId: g.holeId, point }, pos.lat, pos.lon);
            }
        }
        return best;
    }

    private currentPos(hit: MarkerHit): { lat: number; lon: number } | null {
        if (hit.kind === 'green') {
            const g = this.svc.greenForHole(hit.holeId);
            return g ? this.svc.greenPointPos(g, hit.point) : null;
        }
        const row = this.rowOf(hit.kind, hit.id);
        return row ? { lat: row.lat, lon: row.lon } : null;
    }

    private rowOf(kind: 'tee' | 'pin' | 'aim', id: string): Tee | Pin | AimPoint | undefined {
        if (kind === 'tee') return this.svc.tees.items.peek().find(t => t.id === id);
        if (kind === 'pin') return this.svc.pins.items.peek().find(p => p.id === id);
        return this.svc.aims.items.peek().find(a => a.id === id);
    }

    private patchLocal(hit: MarkerHit, lat: number, lon: number): void {
        if (hit.kind === 'tee') {
            const r = this.svc.tees.items.peek().find(t => t.id === hit.id);
            if (r) this.svc.tees.patch({ ...r, lat, lon });
        } else if (hit.kind === 'pin') {
            const r = this.svc.pins.items.peek().find(p => p.id === hit.id);
            if (r) this.svc.pins.patch({ ...r, lat, lon });
        } else if (hit.kind === 'aim') {
            const r = this.svc.aims.items.peek().find(a => a.id === hit.id);
            if (r) this.svc.aims.patch({ ...r, lat, lon });
        } else {
            const g = this.svc.greenForHole(hit.holeId);
            if (g) {
                const fields = greenPointFields(hit.point, lat, lon);
                this.svc.greens.set(this.svc.greens.peek().map(x => x.holeId === g.holeId ? { ...x, ...fields } : x));
            }
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
