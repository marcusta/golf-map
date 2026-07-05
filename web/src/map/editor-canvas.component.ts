import 'maplibre-gl/dist/maplibre-gl.css';
import { Component, Router, Signal, template, effect, untrack } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn } from '../css';
import { TilesetService } from './tileset.service';
import { MapService } from './map.service';
import { ElevationService } from './elevation.service';
import { EditorToolbarComponent } from '../editor/toolbar.component';

const tpl = template(`
    <div class="map-canvas" bind="root">
        <div bind="mapHost" class="map-canvas__map"></div>
        <div bind="message" class="map-canvas__message"><span bind="messageText"></span></div>
        <div bind="tools"></div>
        <div bind="controls" class="map-canvas__controls">
            <button bind="fit" type="button" title="Fit view to course bounds">Fit course</button>
            <button bind="hillshade" type="button" title="Toggle hillshade layer">Hillshade</button>
            <button bind="exaggeration" type="button" title="Toggle terrain exaggeration"></button>
        </div>
        <div bind="status" class="map-canvas__status">
            <span bind="cursorPos" class="status-pos"></span>
            <span bind="cursorElev" class="status-elev"></span>
            <span bind="zoomLevel" class="status-zoom"></span>
        </div>
    </div>
`);

/**
 * The editor's map canvas: hosts the MapLibre map for the current course,
 * wires TilesetService (manifest) → MapService (map lifecycle) →
 * ElevationService (terrain sampling), and renders the surrounding chrome —
 * loading/no-tiles states, a top-right control cluster, and a bottom-right
 * cursor status bar (lat/lon, elevation, zoom).
 *
 * Spawned by CourseDetailComponent into the `.editor-canvas` region; $swap
 * destroys/recreates it per navigation, so one instance == one courseId.
 * Editor tools (drawing/measure/analysis/furniture) do NOT talk to this
 * component — they build on MapService/ElevationService directly.
 */
export class EditorCanvasComponent extends Component {
    static styles = `
        .map-canvas {
            position: absolute;
            inset: 0;
            overflow: hidden;

            & .map-canvas__map {
                position: absolute;
                inset: 0;

                /* Hidden until the map is live so MapLibre's canvas never
                   flashes behind the loading/empty message. */
                &.hidden { visibility: hidden; }
            }

            & .map-canvas__message {
                position: absolute;
                inset: 0;
                display: none;
                align-items: center;
                justify-content: center;
                background:
                    linear-gradient(${t('border')} 1px, transparent 1px) 0 0 / 24px 24px,
                    linear-gradient(90deg, ${t('border')} 1px, transparent 1px) 0 0 / 24px 24px,
                    ${t('bg')};
                font-size: 0.875rem;
                color: ${t('text-muted')};
                &.show { display: flex; }
            }

            & .map-canvas__controls {
                position: absolute;
                top: ${s('md')};
                right: ${s('md')};
                display: none;
                flex-direction: column;
                gap: ${s('xs')};
                &.show { display: flex; }

                & button {
                    padding: ${s('xs')} ${s('sm')};
                    font-size: 0.75rem;
                    text-align: left;
                    ${btn(t('radius-sm'))}
                    background: ${t('surface')};
                    box-shadow: ${t('shadow')};
                    &.active {
                        border-color: ${t('primary')};
                        color: ${t('primary')};
                    }
                }
            }

            & .map-canvas__status {
                position: absolute;
                bottom: ${s('md')};
                right: ${s('md')};
                display: none;
                align-items: center;
                gap: ${s('md')};
                padding: ${s('xs')} ${s('sm')};
                border: 1px solid ${t('border')};
                border-radius: ${t('radius-sm')};
                background: ${t('surface')};
                box-shadow: ${t('shadow')};
                font-size: 0.75rem;
                font-variant-numeric: tabular-nums;
                color: ${t('text-muted')};
                pointer-events: none;
                &.show { display: flex; }

                & .status-elev { color: ${t('text')}; min-width: 3.5rem; text-align: right; }
                & .status-zoom { min-width: 3rem; text-align: right; }
            }
        }
    `;

    private tileset = this.inject(TilesetService);
    private mapSvc = this.inject(MapService);
    private elevation = this.inject(ElevationService);
    private router = this.inject(Router);
    // courseId is the second path segment on every route hosting this canvas
    // (/course/:courseId for the builder, /planner/:courseId for the planner).
    private params = this.router.params<{ courseId: string }>('/:host/:courseId');

    private cursor = new Signal<{ lng: number; lat: number } | null>(null);
    private cursorElevation = new Signal<number | null>(null);
    private mapHost!: HTMLElement;
    private initialized = false;
    private elevationSeq = 0;

    render(): DocumentFragment {
        const showMessage = () => this.messageText() !== null;

        const frag = this.wire(tpl, {
            mapHost: { className: () => this.initializedFor() ? 'map-canvas__map' : 'map-canvas__map hidden' },
            message: { className: () => showMessage() ? 'map-canvas__message show' : 'map-canvas__message' },
            messageText: () => this.messageText() ?? '',
            controls: { className: () => this.mapSvc.ready.get() ? 'map-canvas__controls show' : 'map-canvas__controls' },
            status: { className: () => this.mapSvc.ready.get() ? 'map-canvas__status show' : 'map-canvas__status' },
            fit: { onclick: () => this.mapSvc.fitCourse() },
            hillshade: {
                onclick: () => this.mapSvc.setHillshade(!this.mapSvc.hillshadeVisible.get()),
                className: () => this.mapSvc.hillshadeVisible.get() ? 'active' : '',
            },
            exaggeration: {
                onclick: () => this.mapSvc.setExaggeration(this.mapSvc.exaggeration.get() === 1 ? 1.5 : 1),
                textContent: () => `Terrain ×${this.mapSvc.exaggeration.get().toFixed(1)}`,
                className: () => this.mapSvc.exaggeration.get() !== 1 ? 'active' : '',
            },
            cursorPos: () => {
                const c = this.cursor.get();
                return c ? `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}` : '—';
            },
            cursorElev: () => {
                const elevation = this.cursorElevation.get();
                return elevation === null ? '— m' : `${elevation.toFixed(1)} m`;
            },
            zoomLevel: () => `z ${this.mapSvc.zoom.get().toFixed(1)}`,
        });

        this.mapHost = this.ref(frag, 'mapHost');
        // The builder toolbar (draw/furniture/measure/analysis) belongs to
        // the /course editor page only — other hosts (/planner) drive their
        // own tool directly against MapService.
        if (this.router.route.peek().startsWith('/course')) {
            this.spawn(EditorToolbarComponent, this.ref(frag, 'tools'));
        }
        return frag;
    }

    onMount(): void {
        // Resolve the course's tile manifest (cached per courseId).
        this.track(effect(() => {
            const { courseId } = this.params.get();
            if (courseId) void this.tileset.load(courseId);
        }));

        // Once the manifest for THIS course is in, create the map + point
        // the elevation service at the terrain tiles. Runs at most once —
        // $swap gives us a fresh component per navigation.
        this.track(effect(() => {
            const { courseId } = this.params.get();
            const manifest = this.tileset.manifest.get();
            const version = this.tileset.tileVersion.get();
            if (this.initialized || !manifest || !version) return;
            if (this.tileset.courseId.get() !== courseId) return; // stale manifest from previous course
            this.initialized = true;
            untrack(() => {
                this.mapSvc.init(this.mapHost, courseId, manifest, version);
                this.elevation.configure({
                    courseId,
                    zoom: manifest.layers.terrain.maxzoom,
                    version,
                });
            });
        }));

        // Cursor status bar: position immediately; elevation sync-first
        // (cached tiles), async fallback while the tile streams in.
        this.track(this.mapSvc.onMouseMove(({ lngLat }) => {
            this.cursor.set(lngLat);
            const seq = ++this.elevationSeq;
            const sync = this.elevation.elevationAtSync(lngLat);
            if (sync !== null) {
                this.cursorElevation.set(sync);
                return;
            }
            void this.elevation.elevationAt(lngLat).then(value => {
                if (this.elevationSeq === seq) this.cursorElevation.set(value);
            });
        }));

        // Teardown — $swap destroys this component on every navigation.
        this.track(() => {
            this.mapSvc.destroy();
            this.elevation.configure(null);
        });
    }

    /** True when the map has been initialized for the current course. */
    private initializedFor(): boolean {
        return this.mapSvc.map.get() !== null;
    }

    /** Message shown over the canvas, or null when the map should show. */
    private messageText(): string | null {
        const error = this.tileset.error.get();
        if (error) return `Could not load tile data — ${error.message}`;
        if (this.tileset.loading.get()) return 'Loading course tiles…';
        const { courseId } = this.params.get();
        if (this.tileset.courseId.get() === courseId && !this.tileset.hasTiles.get()) {
            return 'No map tiles for this course yet — run the tile pipeline to enable the editor map.';
        }
        return null;
    }
}
