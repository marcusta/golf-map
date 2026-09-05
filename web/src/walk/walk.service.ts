import maplibregl from 'maplibre-gl';
import { Signal, di, effect } from '@basics/core/client/core';
import { MapService } from '../map/map.service';
import { ElevationService } from '../map/elevation.service';
import type { TerrainMode } from '../map/map-style';
import { FlyoverService } from '../flyover/flyover.service';
import { easeInOutCubic } from '../flyover/flyover-path';
import {
    WALK_ARROW_TILT_DEG_S,
    WALK_ARROW_YAW_DEG_S,
    WALK_EYE_HEIGHT_M,
    WALK_HEIGHT_RATE_M_S,
    WALK_TRANSITION_MS,
    applyLook,
    clampEyeHeight,
    clampTilt,
    entryPose,
    fromTo,
    initialHeading,
    initialLookTarget,
    lerpWalkPose,
    moveVector,
    offsetM,
    tiltFromPitch,
    walkSpeed,
    wrapHeading,
    type LngLat,
    type WalkPose,
} from './walk-camera';

/** Walk mode needs pitch 85 (tilt -5); MapLibre's default cap is 60. */
const WALK_MAX_PITCH = 85;
/** A press/release pair that moves less than this is a click, not a drag. */
const CLICK_TOLERANCE_PX = 3;
/** Frame-time cap so a background tab does not teleport the walker on resume. */
const MAX_FRAME_S = 0.1;

/** Hole context the entry points (Alt+click, armed click) need to pick the first look direction. */
export interface WalkHoleContext {
    holeId: string;
    /** Aim points in hole order. */
    aims: LngLat[];
    green: LngLat | null;
}

export interface WalkRequest extends WalkHoleContext {
    /** Where the walker stands. */
    at: LngLat;
}

interface SavedCamera {
    center: maplibregl.LngLat;
    zoom: number;
    pitch: number;
    bearing: number;
    maxPitch: number;
    centerClampedToGround: boolean;
}

/** Terrain source saved on entry and restored on exit. The canopy ("Trees") toggle is left alone. */
interface SavedLidar {
    terrainMode: TerrainMode;
}

type MapHandlerName = 'dragPan' | 'dragRotate' | 'scrollZoom' | 'keyboard' | 'doubleClickZoom' | 'touchZoomRotate' | 'boxZoom';
const MAP_HANDLERS: MapHandlerName[] = ['dragPan', 'dragRotate', 'scrollZoom', 'keyboard', 'doubleClickZoom', 'touchZoomRotate', 'boxZoom'];

interface Keys {
    forward: boolean;
    back: boolean;
    left: boolean;
    right: boolean;
    up: boolean;
    down: boolean;
    yawLeft: boolean;
    yawRight: boolean;
    tiltUp: boolean;
    tiltDown: boolean;
    fast: boolean;
}

const HUD_TEXT = 'Walk mode · WASD move · drag to look · Q/E height · Shift fast · Esc exit';

/**
 * Ground-level "walk" camera for the selected hole. The maths live in
 * `walk-camera.ts`; this service owns the run loop, the input bindings, the
 * map's saved camera/handler/lidar state, the corner HUD and the two entry
 * gestures (Alt+click on the map; an armed one-shot click from the Walk
 * button). Flyover and walk are mutually exclusive: starting one stops the
 * other.
 *
 * Camera drive: `calculateCameraOptionsFromTo(eye, eyeAlt, target, targetAlt)`
 * + `jumpTo` per frame, target = eye + 50 m along (heading, tilt). MapLibre
 * caps pitch at 85°, so the horizon is never quite level: tilt lives in
 * [-60°, -5°] (see `WalkPose.tilt`). The bearing is overridden with the pose
 * heading so the enter transition, which starts looking straight down, does
 * not spin. `centerClampedToGround` is off for the duration; MapLibre still
 * lifts the camera to the terrain surface when the eye would be under it.
 *
 * Ground under the eye comes from `ElevationService` (bare-earth DEM, the
 * same sampler the flyover uses); while a tile is still loading the last
 * known ground is kept, and 0 is the fallback before any sample exists.
 */
export class WalkService {
    private mapSvc = di.get(MapService);
    private elevation = di.get(ElevationService);

    /** Hole id being walked, or null. */
    readonly active = new Signal<string | null>(null);
    /** "Click a spot" state armed by the Walk button. */
    readonly armed = new Signal(false);
    /** Eye height above ground, metres (Q/E). */
    readonly eyeHeight = new Signal(WALK_EYE_HEIGHT_M);
    /** Why the last start refused, for the UI. Cleared on the next start. */
    readonly notice = new Signal<string | null>(null);

    private run: { token: number; cancel: (animate: boolean) => void } | null = null;
    private nextToken = 1;
    private provider: (() => WalkHoleContext | null) | null = null;
    private disarm: (() => void) | null = null;

    /**
     * Install the map entry gestures for the lifetime of the returned
     * disposer: Alt+click (Option+click) anywhere enters walk mode at the
     * clicked point; a plain click enters while `armed`. Both run on the
     * canvas container in the capture phase and stop propagation, so
     * neither MapLibre nor the planner tool sees the click. `provider`
     * supplies the selected hole's aims/green at click time.
     */
    bindEntry(provider: () => WalkHoleContext | null): () => void {
        this.provider = provider;
        let unbind: (() => void) | null = null;
        const stopEffect = effect(() => {
            const map = this.mapSvc.map.get();
            const ready = this.mapSvc.ready.get();
            unbind?.();
            unbind = null;
            if (!map || !ready) return;
            unbind = this.bindEntryOn(map);
        });
        return () => {
            stopEffect();
            unbind?.();
            this.disarmClick();
            if (this.provider === provider) this.provider = null;
        };
    }

    private bindEntryOn(map: maplibregl.Map): () => void {
        const container = map.getCanvasContainer();
        let down: { x: number; y: number } | null = null;
        const onDown = (e: MouseEvent): void => { down = { x: e.clientX, y: e.clientY }; };
        const onClick = (e: MouseEvent): void => {
            if (this.run || e.button !== 0) return;
            if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_TOLERANCE_PX) return;
            const alt = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
            if (!alt && !this.armed.peek()) return;
            const ctx = this.provider?.();
            if (!ctx) {
                this.disarmClick();
                return;
            }
            e.stopPropagation();
            e.preventDefault();
            this.disarmClick();
            const rect = container.getBoundingClientRect();
            const ll = map.unproject([e.clientX - rect.left, e.clientY - rect.top]);
            void this.start({ ...ctx, at: { lng: ll.lng, lat: ll.lat } });
        };
        container.addEventListener('mousedown', onDown, true);
        container.addEventListener('click', onClick, true);
        return () => {
            container.removeEventListener('mousedown', onDown, true);
            container.removeEventListener('click', onClick, true);
        };
    }

    /** Arm the one-shot "click a spot" state; Escape or a second call disarms. */
    armClick(): void {
        if (this.armed.peek()) {
            this.disarmClick();
            return;
        }
        const container = this.mapSvc.map.peek()?.getCanvasContainer();
        const prevCursor = container?.style.cursor ?? '';
        if (container) container.style.cursor = 'crosshair';
        const onKey = (e: KeyboardEvent): void => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            this.disarmClick();
        };
        window.addEventListener('keydown', onKey, true);
        this.disarm = () => {
            window.removeEventListener('keydown', onKey, true);
            if (container) container.style.cursor = prevCursor;
        };
        this.armed.set(true);
    }

    disarmClick(): void {
        this.disarm?.();
        this.disarm = null;
        this.armed.set(false);
    }

    /** Enter walk mode at `req.at`. Any running walk or flyover stops first. */
    async start(req: WalkRequest): Promise<void> {
        this.stop();
        di.get(FlyoverService).stop();
        this.notice.set(null);

        const map = this.mapSvc.map.peek();
        if (!map || !this.mapSvc.ready.peek()) {
            this.notice.set('Map is not ready yet.');
            return;
        }

        const token = this.nextToken++;
        let cancelled = false;
        this.run = { token, cancel: () => { cancelled = true; } };
        this.active.set(req.holeId);

        const groundSample = await this.elevation.elevationAt(req.at);
        if (cancelled || this.run?.token !== token) return;
        let ground = groundSample ?? 0;

        const heading = initialHeading(req.at, initialLookTarget(req.at, req.aims, req.green), map.getBearing());
        this.eyeHeight.set(WALK_EYE_HEIGHT_M);
        let pose: WalkPose = entryPose(req.at, ground, heading, WALK_EYE_HEIGHT_M);

        const saved: SavedCamera = {
            center: map.getCenter(),
            zoom: map.getZoom(),
            pitch: map.getPitch(),
            bearing: map.getBearing(),
            maxPitch: map.getMaxPitch(),
            centerClampedToGround: map.getCenterClampedToGround(),
        };
        const exaggeration = () => this.mapSvc.exaggeration.peek();
        // Current camera as a walk pose: the transform's camera position and
        // altitude (exaggerated metres), bearing, and pitch as a tilt.
        const startPose: WalkPose = {
            eye: (() => { const c = map.transform.getCameraLngLat(); return { lng: c.lng, lat: c.lat }; })(),
            eyeAlt: map.transform.getCameraAltitude() / exaggeration(),
            heading: wrapHeading(map.getBearing()),
            tilt: tiltFromPitch(map.getPitch()),
        };

        map.setMaxPitch(Math.max(saved.maxPitch, WALK_MAX_PITCH));
        map.setCenterClampedToGround(false);
        const savedLidar = this.enterLidarView();
        const savedHandlers = MAP_HANDLERS.filter(h => map[h].isEnabled());
        for (const h of savedHandlers) map[h].disable();

        const container = map.getCanvasContainer();
        const savedCursor = container.style.cursor;
        container.style.cursor = 'grab';
        const hud = this.buildHud(map.getContainer());

        const apply = (p: WalkPose): void => {
            const ex = exaggeration();
            const ft = fromTo(p);
            const opts = map.calculateCameraOptionsFromTo(
                maplibregl.LngLat.convert(ft.from), ft.altFrom * ex,
                maplibregl.LngLat.convert(ft.to), ft.altTo * ex,
            );
            // Straight-down (transition start) has no horizontal reach, so the
            // computed bearing is meaningless; the pose heading is always right.
            opts.bearing = ft.heading;
            map.jumpTo(opts);
        };

        const keys: Keys = {
            forward: false, back: false, left: false, right: false,
            up: false, down: false, yawLeft: false, yawRight: false, tiltUp: false, tiltDown: false, fast: false,
        };
        let drag: { x: number; y: number } | null = null;
        let dirty = true;
        let frame = 0;
        let finished = false;
        let removed = false;
        let entering = true;
        const t0 = performance.now();
        let prev = t0;

        const isTextTarget = (e: Event): boolean => {
            const t = e.target;
            return t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;
        };
        const setKey = (e: KeyboardEvent, pressed: boolean): boolean => {
            switch (e.code) {
                case 'KeyW': keys.forward = pressed; return true;
                case 'KeyS': keys.back = pressed; return true;
                case 'KeyA': keys.left = pressed; return true;
                case 'KeyD': keys.right = pressed; return true;
                case 'KeyQ': keys.up = pressed; return true;
                case 'KeyE': keys.down = pressed; return true;
                case 'ArrowLeft': keys.yawLeft = pressed; return true;
                case 'ArrowRight': keys.yawRight = pressed; return true;
                case 'ArrowUp': keys.tiltUp = pressed; return true;
                case 'ArrowDown': keys.tiltDown = pressed; return true;
                case 'ShiftLeft':
                case 'ShiftRight': keys.fast = pressed; return true;
                default: return false;
            }
        };
        const onKeyDown = (e: KeyboardEvent): void => {
            if (isTextTarget(e)) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                finish(true);
                return;
            }
            keys.fast = e.shiftKey;
            if (setKey(e, true)) {
                e.preventDefault();
                e.stopPropagation();
            }
        };
        const onKeyUp = (e: KeyboardEvent): void => {
            keys.fast = e.shiftKey;
            if (setKey(e, false)) e.stopPropagation();
        };
        const onBlur = (): void => {
            for (const k of Object.keys(keys) as Array<keyof Keys>) keys[k] = false;
        };
        const swallow = (e: Event): void => { e.stopPropagation(); };
        const onWheel = (e: WheelEvent): void => {
            e.preventDefault();
            e.stopPropagation();
        };
        const onPointerDown = (e: PointerEvent): void => {
            e.stopPropagation();
            if (e.button !== 0) return;
            e.preventDefault();
            drag = { x: e.clientX, y: e.clientY };
            container.style.cursor = 'grabbing';
        };
        const onPointerMove = (e: PointerEvent): void => {
            if (!drag || entering) return;
            const dx = e.clientX - drag.x;
            const dy = e.clientY - drag.y;
            drag = { x: e.clientX, y: e.clientY };
            pose = applyLook(pose, dx, dy);
            dirty = true;
        };
        const onPointerUp = (): void => {
            if (!drag) return;
            drag = null;
            container.style.cursor = 'grab';
        };

        const finish = (animate: boolean): void => {
            if (finished) return;
            finished = true;
            cancelAnimationFrame(frame);
            window.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('keyup', onKeyUp, true);
            window.removeEventListener('blur', onBlur);
            window.removeEventListener('pointermove', onPointerMove, true);
            window.removeEventListener('pointerup', onPointerUp, true);
            window.removeEventListener('pointercancel', onPointerUp, true);
            container.removeEventListener('pointerdown', onPointerDown, true);
            container.removeEventListener('mousedown', swallow, true);
            container.removeEventListener('mouseup', swallow, true);
            container.removeEventListener('click', swallow, true);
            container.removeEventListener('dblclick', swallow, true);
            container.removeEventListener('touchstart', swallow, true);
            container.removeEventListener('wheel', onWheel, true);
            map.off('remove', onRemove);
            hud.remove();
            if (this.run?.token === token) this.run = null;
            if (this.active.peek() === req.holeId) this.active.set(null);
            this.restoreLidarView(savedLidar);
            if (removed) return;

            container.style.cursor = savedCursor;
            for (const h of savedHandlers) map[h].enable();
            map.setCenterClampedToGround(saved.centerClampedToGround);
            const restore = { center: saved.center, zoom: saved.zoom, pitch: saved.pitch, bearing: saved.bearing };
            if (animate) {
                // Ease home, then drop the pitch cap once the pitch is back
                // under it (setMaxPitch clamps the live pitch immediately).
                map.once('moveend', () => map.setMaxPitch(saved.maxPitch));
                map.easeTo({ ...restore, duration: WALK_TRANSITION_MS, essential: true });
            } else {
                map.jumpTo(restore);
                map.setMaxPitch(saved.maxPitch);
            }
        };
        const onRemove = (): void => { removed = true; finish(false); };

        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('keyup', onKeyUp, true);
        window.addEventListener('blur', onBlur);
        window.addEventListener('pointermove', onPointerMove, true);
        window.addEventListener('pointerup', onPointerUp, true);
        window.addEventListener('pointercancel', onPointerUp, true);
        container.addEventListener('pointerdown', onPointerDown, true);
        container.addEventListener('mousedown', swallow, true);
        container.addEventListener('mouseup', swallow, true);
        container.addEventListener('click', swallow, true);
        container.addEventListener('dblclick', swallow, true);
        container.addEventListener('touchstart', swallow, true);
        container.addEventListener('wheel', onWheel, { capture: true, passive: false });
        map.on('remove', onRemove);
        this.run = { token, cancel: finish };

        const tick = (now: number): void => {
            if (finished) return;
            const dt = Math.min(MAX_FRAME_S, (now - prev) / 1000);
            prev = now;

            if (entering) {
                const t = (now - t0) / WALK_TRANSITION_MS;
                if (t >= 1) {
                    entering = false;
                    apply(pose);
                } else {
                    apply(lerpWalkPose(startPose, pose, easeInOutCubic(t)));
                }
                frame = requestAnimationFrame(tick);
                return;
            }

            // Movement on the ground plane, then re-seat the eye on the terrain.
            const mv = moveVector(pose.heading, keys, walkSpeed(keys.fast), dt);
            if (mv.east !== 0 || mv.north !== 0) {
                pose = { ...pose, eye: offsetM(pose.eye, mv.east, mv.north) };
                dirty = true;
            }
            if (keys.up !== keys.down) {
                this.eyeHeight.set(clampEyeHeight(this.eyeHeight.peek() + (keys.up ? 1 : -1) * WALK_HEIGHT_RATE_M_S * dt));
                dirty = true;
            }
            if (keys.yawLeft !== keys.yawRight) {
                pose = { ...pose, heading: wrapHeading(pose.heading + (keys.yawRight ? 1 : -1) * WALK_ARROW_YAW_DEG_S * dt) };
                dirty = true;
            }
            if (keys.tiltUp !== keys.tiltDown) {
                pose = { ...pose, tilt: clampTilt(pose.tilt + (keys.tiltUp ? 1 : -1) * WALK_ARROW_TILT_DEG_S * dt) };
                dirty = true;
            }
            const sampled = this.elevation.elevationAtSync(pose.eye);
            if (sampled === null) void this.elevation.elevationAt(pose.eye);
            else if (sampled !== ground) {
                ground = sampled;
                dirty = true;
            }
            if (dirty) {
                dirty = false;
                pose = { ...pose, eyeAlt: ground + this.eyeHeight.peek() };
                apply(pose);
                hud.setHeight(this.eyeHeight.peek());
            }
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
    }

    /** Leave walk mode (if active), easing the camera back to where it was. */
    stop(): void {
        const run = this.run;
        if (!run) return;
        this.run = null;
        run.cancel(true);
        this.active.set(null);
    }

    /**
     * Surface (DSM) terrain for the walk where the course has it, same rule
     * as the flyover. The canopy raster is not touched: the user's Trees
     * toggle stays as it was, on or off.
     */
    private enterLidarView(): SavedLidar {
        const saved: SavedLidar = { terrainMode: this.mapSvc.terrainMode.peek() };
        if (this.mapSvc.hasSurface.peek()) this.mapSvc.setTerrainMode('surface');
        return saved;
    }

    private restoreLidarView(saved: SavedLidar): void {
        this.mapSvc.setTerrainMode(saved.terrainMode);
    }

    /** Corner HUD inside the map container; removed on exit. */
    private buildHud(host: HTMLElement): { remove: () => void; setHeight: (m: number) => void } {
        const el = document.createElement('div');
        el.dataset.testid = 'walk-hud';
        el.style.cssText = [
            'position:absolute', 'left:12px', 'top:12px', 'z-index:5', 'pointer-events:none',
            'padding:6px 10px', 'border-radius:6px', 'font:12px/1.4 system-ui, sans-serif',
            'color:#fff', 'background:rgba(0,0,0,0.55)', 'display:flex', 'flex-direction:column', 'gap:2px',
        ].join(';');
        const line = document.createElement('div');
        line.textContent = HUD_TEXT;
        const height = document.createElement('div');
        height.dataset.testid = 'walk-hud-height';
        height.style.opacity = '0.8';
        el.append(line, height);
        host.appendChild(el);
        const setHeight = (m: number): void => { height.textContent = `Eye height ${m.toFixed(1)} m`; };
        setHeight(this.eyeHeight.peek());
        return { remove: () => el.remove(), setHeight };
    }
}
