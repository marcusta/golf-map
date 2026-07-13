import { Signal, Computed, batch } from '@basics/core/client/core';
import {
    profileSeries,
    vertexDistances,
    type LatLon,
    type ProfileElevationSampler,
    type ProfileSample,
} from './elevation-profile';

/**
 * A labelled path vertex on the profile x-axis. `elevation` is the RAW
 * terrain sample at the vertex (never smoothed) — this is where the
 * user-facing Δ numbers come from.
 */
export interface ProfileMarker {
    label: string;
    distance: number;
    elevation: number | null;
}

/**
 * Backs the elevation-profile chart: holds the sampled series + labelled
 * vertex markers (Tee / shots / Green) for the current path, re-sampling
 * asynchronously (seq-guarded — a stale batch never lands) whenever the
 * host pushes a new path. Port of the iOS `ElevationProfileModel`
 * (ios/GolfMap/Profile/ElevationProfileModel.swift).
 *
 * DI singleton; the hosting panel binds the sampler (ElevationService) and
 * decides which path to feed (the planner feeds the hole route).
 */
export class ElevationProfileService {
    /** Sampled series along the current path (2 m interval, raw values). */
    readonly samples = new Signal<ProfileSample[]>([]);
    /** Labelled vertices (distances known synchronously; elevations patch in). */
    readonly markers = new Signal<ProfileMarker[]>([]);
    /** True while a sample batch is in flight. */
    readonly loading = new Signal(false);
    /** The path the current series belongs to (change detection / titling). */
    readonly path = new Signal<LatLon[]>([]);

    /** Terrain elevation sampler; bound by the host, stubbed in tests. */
    private sampler: ProfileElevationSampler | null = null;
    /** Monotonic token so a superseded sample batch is dropped. */
    private seq = 0;

    /** Bind the live terrain sampler (ElevationService.elevationAt). */
    useSampler(sampler: ProfileElevationSampler): void {
        this.sampler = sampler;
    }

    /**
     * Re-target the profile at a new path. `labels` must parallel `path`
     * (extras are ignored). Distances resolve synchronously; the series +
     * marker elevations land asynchronously. The returned promise resolves
     * when this batch lands or is superseded (test convenience).
     */
    async update(path: LatLon[], labels: string[]): Promise<void> {
        const token = ++this.seq;
        const distances = vertexDistances(path);
        const markers = labels
            .slice(0, distances.length)
            .map((label, i) => ({ label, distance: distances[i], elevation: null }));

        const sampler = this.sampler;
        if (path.length < 2 || !sampler) {
            batch(() => {
                this.path.set(path);
                this.markers.set(markers);
                this.samples.set([]);
                this.loading.set(false);
            });
            return;
        }

        batch(() => {
            this.path.set(path);
            this.markers.set(markers);
            this.loading.set(true);
        });

        const series = await profileSeries(path, sampler);
        if (this.seq !== token) return; // superseded — drop
        // Vertex markers coincide with per-leg endpoint samples (t = 0/1),
        // so the nearest sample IS the vertex — raw, not smoothed.
        const patched = markers.map(marker => {
            let best: ProfileSample | null = null;
            for (const sample of series) {
                if (!best || Math.abs(sample.distance - marker.distance) < Math.abs(best.distance - marker.distance)) {
                    best = sample;
                }
            }
            return { ...marker, elevation: best?.elevation ?? null };
        });
        batch(() => {
            this.samples.set(series);
            this.markers.set(patched);
            this.loading.set(false);
        });
    }

    /** Drop everything (host left the profile context). */
    clear(): void {
        this.seq++;
        batch(() => {
            this.samples.set([]);
            this.markers.set([]);
            this.path.set([]);
            this.loading.set(false);
        });
    }

    // ── Derived numbers (all RAW, never smoothed) ───────────────────────────

    /** Total elevation change end-to-end (last vertex − first vertex). */
    readonly totalDelta = new Computed<number | null>(() => {
        const markers = this.markers.get();
        const first = markers[0]?.elevation ?? null;
        const last = markers[markers.length - 1]?.elevation ?? null;
        if (first === null || last === null) return null;
        return last - first;
    });

    /** Per-leg elevation deltas between consecutive markers ("Tee→S1" …). */
    readonly legDeltas = new Computed<Array<{ label: string; delta: number | null }>>(() => {
        const markers = this.markers.get();
        if (markers.length < 2) return [];
        return markers.slice(1).map((to, i) => {
            const from = markers[i];
            const delta = from.elevation !== null && to.elevation !== null
                ? to.elevation - from.elevation
                : null;
            return { label: `${from.label}→${to.label}`, delta };
        });
    });

    /** Raw min/max over the sampled elevations (axis labels, exaggeration). */
    readonly elevationRange = new Computed<{ min: number; max: number } | null>(() => {
        const values = this.samples.get()
            .map(s => s.elevation)
            .filter((e): e is number => e !== null);
        if (values.length === 0) return null;
        return { min: Math.min(...values), max: Math.max(...values) };
    });

    /** Total path length (m) — the last sample's cumulative distance. */
    readonly totalDistance = new Computed<number>(() => {
        const samples = this.samples.get();
        if (samples.length > 0) return samples[samples.length - 1].distance;
        const markers = this.markers.get();
        return markers[markers.length - 1]?.distance ?? 0;
    });
}
