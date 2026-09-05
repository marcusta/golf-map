import maplibregl from 'maplibre-gl';
import { Signal, di } from '@basics/core/client/core';
import { MapService } from '../map/map.service';
import { ElevationService } from '../map/elevation.service';
import type { TerrainMode } from '../map/map-style';
import { WalkService } from '../walk/walk.service';
import { fromTo, lerpWalkPose, tiltFromPitch, wrapHeading, type WalkPose } from '../walk/walk-camera';
import {
    FLYOVER_EASE_MS,
    FLYOVER_ENTER_MS,
    FLYOVER_EYE_HEIGHT_M,
    FLYOVER_HOLD_MS,
    FLYOVER_LOOK_AHEAD_M,
    FLYOVER_LOOK_HEIGHT_M,
    PATH_STEP_M,
    buildFlyoverPath,
    cameraPose,
    easeInOutCubic,
    eyePathLength,
    fillGroundProfile,
    flightProgress,
    flyoverDurationMs,
    groundAt,
    groundSampleStations,
    pointAlong,
    type CameraPose,
    type LngLat,
} from './flyover-path';

/** Camera restore animation, ms (natural end only; cancels snap back). */
const RESTORE_MS = 900;
/** The flight's geometric pitch is ~87°; MapLibre's hard maximum is 85 (default cap 60). */
const FLIGHT_MAX_PITCH = 85;

export interface FlyoverRequest {
    holeId: string;
    /** Tee → (aims/shots) → green centre, in order. */
    waypoints: LngLat[];
}

interface SavedCamera {
    center: maplibregl.LngLat;
    zoom: number;
    pitch: number;
    bearing: number;
    maxPitch: number;
    centerClampedToGround: boolean;
}

/** Terrain source saved on start and restored with the camera. The canopy ("Trees") toggle is left alone. */
interface SavedLidar {
    terrainMode: TerrainMode;
}

/**
 * Drives a low hole flyover over the 3D terrain: 5 m above the ground along
 * a Catmull-Rom path tee → aims → green at 225 km/h, looking 120 m ahead. The
 * path/camera maths live in `flyover-path.ts`; this service owns the run
 * loop, the map's camera state (saved on start, restored on stop) and the
 * stop triggers: pointer/wheel on the map, Escape, the map being torn down,
 * or an explicit `stop()` (second click, hole change).
 *
 * Timeline: 1.5 s blend from the current overhead camera to the start pose
 * (same blend as walk mode's enter), the flight (`flyoverDurationMs`), a
 * 2 s hold at the final pose, then an eased restore of the saved camera.
 *
 * MapLibre GL JS has no free-camera API; the equivalent is
 * `calculateCameraOptionsFromTo(from, altFrom, to, altTo)` + `jumpTo`, with
 * `centerClampedToGround` switched off for the duration so the render loop
 * does not snap the target back to the terrain surface each frame. Poses are
 * applied as (eye, altitude, heading, tilt) so the bearing is explicit: the
 * overhead camera at the start of the blend looks nearly straight down,
 * where a from→to bearing is meaningless. MapLibre clamps the geometric
 * pitch (~87°) to 85° on `jumpTo`; see `cameraPose`.
 *
 * Lidar courses: for the flight the 3D terrain switches to the `surface`
 * DSM so the ground carries the trees' height; it goes back to its pre-flight
 * value when the camera is restored. The canopy raster is not touched.
 */
export class FlyoverService {
    private mapSvc = di.get(MapService);
    private elevation = di.get(ElevationService);

    /** Hole id currently being flown, or null. */
    readonly active = new Signal<string | null>(null);
    /** Why the last start refused, for the UI. Cleared on the next start. */
    readonly notice = new Signal<string | null>(null);

    private run: { token: number; cancel: (reason: 'ended' | 'cancelled') => void } | null = null;
    private nextToken = 1;

    /** Start a flyover; any running one is stopped first. */
    async start(req: FlyoverRequest): Promise<void> {
        this.stop();
        // Flyover and walk mode are mutually exclusive.
        di.get(WalkService).stop();
        this.notice.set(null);

        const map = this.mapSvc.map.peek();
        if (!map || !this.mapSvc.ready.peek()) {
            this.notice.set('Map is not ready yet.');
            return;
        }
        const path = buildFlyoverPath(req.waypoints, PATH_STEP_M);
        if (!path) {
            this.notice.set('Flyover needs a tee and a green centre.');
            return;
        }

        const token = this.nextToken++;
        let cancelled = false;
        // A cancel during the async elevation sampling only has to flip the flag.
        this.run = { token, cancel: () => { cancelled = true; } };
        this.active.set(req.holeId);

        const { s0, stations } = groundSampleStations(path, 0, 0, PATH_STEP_M);
        const raw = await Promise.all(stations.map(s => this.elevation.elevationAt(pointAlong(path, s))));
        if (cancelled || this.run?.token !== token) return;
        const profile = fillGroundProfile(s0, PATH_STEP_M, raw);
        const ground = (s: number) => groundAt(profile, s);

        const exaggeration = this.mapSvc.exaggeration.peek();
        const saved: SavedCamera = {
            center: map.getCenter(),
            zoom: map.getZoom(),
            pitch: map.getPitch(),
            bearing: map.getBearing(),
            maxPitch: map.getMaxPitch(),
            centerClampedToGround: map.getCenterClampedToGround(),
        };
        // The overhead camera as a pose: transform camera position + altitude
        // (exaggerated metres, like the flight poses), bearing, pitch as tilt.
        const overhead: WalkPose = {
            eye: (() => { const c = map.transform.getCameraLngLat(); return { lng: c.lng, lat: c.lat }; })(),
            eyeAlt: map.transform.getCameraAltitude(),
            heading: wrapHeading(map.getBearing()),
            tilt: tiltFromPitch(map.getPitch()),
        };
        map.setMaxPitch(Math.max(saved.maxPitch, FLIGHT_MAX_PITCH));
        map.setCenterClampedToGround(false);
        const savedLidar = this.enterLidarView();

        const poseOpts = {
            eyeHeightM: FLYOVER_EYE_HEIGHT_M,
            lookAheadM: FLYOVER_LOOK_AHEAD_M,
            lookHeightM: FLYOVER_LOOK_HEIGHT_M,
            exaggeration,
        };
        const eyeLength = eyePathLength(path);
        const flightMs = flyoverDurationMs(eyeLength);
        const ramp = Math.min(0.5, FLYOVER_EASE_MS / flightMs);
        const toPose = (p: CameraPose): WalkPose => ({ eye: p.from, eyeAlt: p.altFrom, heading: p.bearing, tilt: tiltFromPitch(p.pitch) });
        const startPose = toPose(cameraPose(path, 0, ground, poseOpts));
        const endPose = toPose(cameraPose(path, eyeLength, ground, poseOpts));

        const apply = (pose: WalkPose): void => {
            const ft = fromTo(pose);
            const opts = map.calculateCameraOptionsFromTo(
                maplibregl.LngLat.convert(ft.from), ft.altFrom,
                maplibregl.LngLat.convert(ft.to), ft.altTo,
            );
            opts.bearing = ft.heading;
            map.jumpTo(opts);
        };

        let frame = 0;
        let finished = false;
        let removed = false;
        const container = map.getCanvasContainer();

        const finish = (reason: 'ended' | 'cancelled'): void => {
            if (finished) return;
            finished = true;
            cancelAnimationFrame(frame);
            container.removeEventListener('pointerdown', onInteract);
            container.removeEventListener('wheel', onInteract);
            container.removeEventListener('touchstart', onInteract);
            window.removeEventListener('keydown', onKey);
            map.off('remove', onRemove);
            if (this.run?.token === token) this.run = null;
            if (this.active.peek() === req.holeId) this.active.set(null);
            this.restoreLidarView(savedLidar);
            if (removed) return;

            map.setCenterClampedToGround(saved.centerClampedToGround);
            const restore = { center: saved.center, zoom: saved.zoom, pitch: saved.pitch, bearing: saved.bearing };
            if (reason === 'ended') {
                // Ease home, then drop the pitch cap once the pitch is back
                // under it (setMaxPitch clamps the live pitch immediately).
                map.once('moveend', () => map.setMaxPitch(saved.maxPitch));
                map.easeTo({ ...restore, duration: RESTORE_MS, essential: true });
            } else {
                map.jumpTo(restore);
                map.setMaxPitch(saved.maxPitch);
            }
        };

        const onRemove = (): void => { removed = true; finish('cancelled'); };
        const onInteract = (): void => finish('cancelled');
        const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') finish('cancelled'); };
        container.addEventListener('pointerdown', onInteract);
        container.addEventListener('wheel', onInteract, { passive: true });
        container.addEventListener('touchstart', onInteract, { passive: true });
        window.addEventListener('keydown', onKey);
        map.on('remove', onRemove);
        this.run = { token, cancel: finish };

        const t0 = performance.now();
        const tick = (now: number): void => {
            if (finished) return;
            const elapsed = now - t0;
            if (elapsed < FLYOVER_ENTER_MS) {
                apply(lerpWalkPose(overhead, startPose, easeInOutCubic(elapsed / FLYOVER_ENTER_MS)));
            } else if (elapsed < FLYOVER_ENTER_MS + flightMs) {
                const s = flightProgress((elapsed - FLYOVER_ENTER_MS) / flightMs, ramp) * eyeLength;
                apply(toPose(cameraPose(path, s, ground, poseOpts)));
            } else if (elapsed < FLYOVER_ENTER_MS + flightMs + FLYOVER_HOLD_MS) {
                apply(endPose);
            } else {
                finish('ended');
                return;
            }
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
    }

    /**
     * Surface (DSM) terrain for the flight where the course has it. Returns
     * the state to restore. The canopy raster keeps whatever the user set.
     * Surface tiles may still be loading for the first frames; that is fine.
     */
    private enterLidarView(): SavedLidar {
        const saved: SavedLidar = { terrainMode: this.mapSvc.terrainMode.peek() };
        if (this.mapSvc.hasSurface.peek()) this.mapSvc.setTerrainMode('surface');
        return saved;
    }

    private restoreLidarView(saved: SavedLidar): void {
        this.mapSvc.setTerrainMode(saved.terrainMode);
    }

    /** Stop the running flyover (if any) and restore the saved camera. */
    stop(): void {
        const run = this.run;
        if (!run) return;
        this.run = null;
        run.cancel('cancelled');
        this.active.set(null);
    }
}
