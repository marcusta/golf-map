/**
 * Which half of the deploy split the API we're talking to is (T63, §9).
 *
 *   builder — the local Mac: raw lidar/ortho sources, the golfpipe pipeline,
 *             SAM/LaMa models. Everything is available.
 *   serve   — the lean VPS: runtime APIs, tiles, ingest. It has no `sources/`,
 *             no pipeline and no models, so every builder API is simply not
 *             mounted there and 404s.
 *
 * The UI must not offer what the box cannot do. A "Build map" button that
 * 404s is worse than no button, and the mode is knowable up front — /api/meta
 * reports it — so the affordances are gated rather than left to fail.
 *
 * The gating decisions themselves are pure functions below, exported and
 * tested directly; the service is only the signal that carries the answer.
 * Planner and analytics are untouched by any of this: they run on runtime
 * APIs that both boxes serve.
 */
import { Signal } from '@basics/core/client/core';
import { api } from '../api';
import type { EditorTool } from '../editor/tool';
import { EDITOR_TOOLS } from '../editor/tools/index';

export type ServerMode = 'builder' | 'serve';

/**
 * Routes that only exist on a builder box. Both belong to the map-build
 * wizard, which drives the pipeline end to end (lidar fetch → DEM → tiles).
 */
export const BUILDER_ROUTES = ['/new', '/set-area'] as const;

export function isBuilderRoute(route: string): boolean {
    return BUILDER_ROUTES.some((r) => route === r || route.startsWith(`${r}/`));
}

/**
 * Editor tools available in `mode`. A tool is builder-only when it edits the
 * map itself or calls a builder API:
 *
 *   draw / furniture  — author course geometry and furniture
 *   sam               — SAM segmentation assist (models live on the builder)
 *   terrain-edit      — DEM smooth/flatten (terrain-edits API + a re-terrain job)
 *   clean             — ortho patching (ortho-patches API + LaMa)
 *
 * Measure and green analysis survive: they only read tiles and the DEM, which
 * is exactly what the VPS ships.
 */
export function visibleEditorTools(mode: ServerMode): EditorTool[] {
    return mode === 'builder' ? EDITOR_TOOLS : EDITOR_TOOLS.filter((tool) => !tool.builderOnly);
}

/** Whether course-authoring entry points (new course, imports, map build) show. */
export function canAuthorCourses(mode: ServerMode): boolean {
    return mode === 'builder';
}

/**
 * Reads the server's run mode once at boot and exposes it as a signal.
 *
 * Defaults to `serve` — the restrictive answer — so a failed or in-flight
 * /api/meta hides builder affordances rather than showing ones that 404. On a
 * builder box the call is local and instant; on the VPS the honest answer and
 * the fallback agree.
 */
export class ServerModeService {
    readonly mode = new Signal<ServerMode>('serve');

    /** True on the local builder box: the full stack is available. */
    isBuilder(): boolean {
        return this.mode.get() === 'builder';
    }

    async load(): Promise<void> {
        try {
            const meta = await api.meta.get();
            this.mode.set(meta.mode === 'builder' ? 'builder' : 'serve');
        } catch {
            this.mode.set('serve');
        }
    }
}
