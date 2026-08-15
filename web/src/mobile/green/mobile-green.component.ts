import {
    Component,
    Computed,
    Router,
    Signal,
    effect,
    template,
    untrack,
} from '@basics/core/client/core';
import type { SampleGrid } from '../../../../shared/api/analysis.gen';
import type { Vec2 } from '../../../../shared/strategy';
import { MapService } from '../../map/map.service';
import { TilesetService } from '../../map/tileset.service';
import { CourseDetailService } from '../../course-detail/course-detail.service';
import { FurnitureService } from '../../furniture/furniture.service';
import {
    MIN_READ_CONFIDENCE,
    PuttReadService,
    type PuttContext,
    type PuttOverlayMode,
} from '../../planner/putt-read.service';
import { seedBallFromFix } from './ball-seed';
import {
    confidenceText,
    greenMessage,
    readAimText,
    readNoteText,
    readPaceText,
} from './green-copy';
import { PUTT_OVERLAY_ID, buildPuttGeojson, puttLayers } from '../../planner/putt-overlay';
import {
    computeSlopeGrid,
    computeStats,
    fallDirectionLabel,
    sampleFallLines,
    sampleSlopeAt,
    type AnalysisStats,
    type SlopeGrid,
    type SlopeProbe,
} from '../../analysis/analysis-math';
import { probeArrowLengthM, probeGeojson, probeLayers } from '../../analysis/probe-overlay';
import { lngLatToSweref99tm, sweref99tmToWgs84 } from '../../geo/transform';
import { pointInGeometry } from '../../geo/bezier';
import { GeolocationService } from '../gps/geolocation.service';
import { WakeLock } from '../gps/wake-lock';
import type { Bbox } from '../course/hole-frame';
import { GreenFeaturesService } from './green-features.service';
import { buildPuttContext } from './putt-context';
import { greenBounds } from './green-frame';
import {
    GREEN_ARROWS_ID,
    GREEN_BOUNDARY_ID,
    GREEN_HEAT_ID,
    GREEN_PROBE_ID,
    arrowLayers,
    arrowLengthM,
    arrowsGeojson,
    boundaryGeojson,
    boundaryLayers,
    gridCorners,
    heatImageUrl,
} from './green-overlay';
import { loadSessionStimp, saveSessionStimp } from './stimp-session';
import { t } from '../../theme';
import { s } from '../../css';
import { icon } from '../../ui/icons';

/** Camera padding around the green box, px (sheet ≈ 44vh at the bottom). */
const FRAME_PADDING = { top: 96, bottom: 300, left: 32, right: 32 };
/** Touch slop for grabbing a marker, screen px (fat-finger friendly). */
const GRAB_RADIUS_PX = 30;

const tpl = template(`
    <div class="m-green" bind="root" data-testid="m-green">
        <div class="m-green__map" bind="mapHost"></div>

        <button class="m-green__back" bind="back" aria-label="Back to the hole">${icon('chevron-left', 24)}</button>

        <div class="m-green__msg" bind="msg"></div>

        <section class="m-green__sheet" bind="sheet" data-testid="m-green-sheet">
            <div class="m-green__title" bind="title"></div>

            <div class="m-green__read" data-testid="m-green-read">
                <div class="m-green__aim" bind="aim" data-testid="m-green-aim"></div>
                <div class="m-green__pace" bind="pace" data-testid="m-green-pace"></div>
                <div class="m-green__note" bind="note" data-testid="m-green-note"></div>
                <div class="m-green__conf" bind="conf" data-testid="m-green-confidence"></div>
            </div>

            <div class="m-green__probe" bind="probeRow" data-testid="m-green-probe"></div>

            <div class="m-green__row">
                <span class="m-green__lbl">Tap places</span>
                <div class="m-green__seg">
                    <button class="m-green__segbtn" bind="placeBall" data-testid="m-green-place-ball">Ball</button>
                    <button class="m-green__segbtn" bind="placeHole" data-testid="m-green-place-hole">Hole</button>
                </div>
                <button class="m-green__btn" bind="atPin" data-testid="m-green-at-pin">At pin</button>
            </div>

            <div class="m-green__row">
                <span class="m-green__lbl">Green speed</span>
                <div class="m-green__stepper">
                    <button class="m-green__step" bind="stimpDown" data-testid="m-green-stimp-down" aria-label="Slower green">−</button>
                    <span class="m-green__stimp" bind="stimp" data-testid="m-green-stimp"></span>
                    <button class="m-green__step" bind="stimpUp" data-testid="m-green-stimp-up" aria-label="Faster green">+</button>
                </div>
            </div>

            <div class="m-green__row">
                <span class="m-green__lbl">Overlay</span>
                <div class="m-green__seg">
                    <button class="m-green__segbtn" bind="modeSlope" data-testid="m-green-mode-slope">Slope</button>
                    <button class="m-green__segbtn" bind="modeHeight" data-testid="m-green-mode-height">Height</button>
                    <button class="m-green__segbtn" bind="modeNone" data-testid="m-green-mode-none">Off</button>
                </div>
            </div>
        </section>
    </div>
`);

/**
 * The green screen: a green-filling camera, the reused Green-analysis
 * Slope/Height field under the read, and a two-tap putt read (ball, then hole)
 * with drag to fine-tune. Everything the read needs comes from the SHARED
 * PuttReadService — this component only supplies the context (course features +
 * the active pin) and the touch gestures; no planner tool is involved.
 *
 * Compute cadence mirrors the desktop: drag frames move the LIVE markers only
 * (`dragBall`/`dragHole`), the integrator re-runs once on release (`commit`),
 * and the analysis stack is re-rendered on a coalesced microtask so an eager
 * signal burst never repaints the map mid-cascade.
 */
export class MobileGreenComponent extends Component {
    static styles = `
        .m-green {
            position: relative;
            height: 100%;
            overflow: hidden;
            background: ${t('color-surface-app')};
            color: ${t('color-text-primary')};

            & .m-green__map { position: absolute; inset: 0; }

            & .m-green__back {
                position: absolute;
                top: calc(var(--safe-top) + ${s('sm')});
                left: calc(var(--safe-left) + ${s('sm')});
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 44px;
                height: 44px;
                border: none;
                border-radius: ${t('radius-pill')};
                background: ${t('color-surface-card')};
                color: ${t('color-text-primary')};
                box-shadow: ${t('shadow-elevated')};
                cursor: pointer;
                z-index: 6;
            }

            & .m-green__msg {
                position: absolute;
                top: calc(var(--safe-top) + ${s('sm')});
                left: 50%;
                transform: translateX(-50%);
                display: none;
                max-width: 70%;
                padding: ${s('sm')} ${s('md')};
                border-radius: ${t('radius-pill')};
                background: ${t('color-surface-card')};
                box-shadow: ${t('shadow-elevated')};
                font-size: 0.85rem;
                color: ${t('color-text-secondary')};
                text-align: center;
                z-index: 6;
            }
            & .m-green__msg.show { display: block; }

            & .m-green__sheet {
                position: absolute;
                left: 0;
                right: 0;
                bottom: 0;
                max-height: 52vh;
                overflow-y: auto;
                -webkit-overflow-scrolling: touch;
                padding: ${s('md')} calc(${s('lg')} + var(--safe-left)) calc(${s('md')} + var(--safe-bottom)) calc(${s('lg')} + var(--safe-right));
                border-radius: 16px 16px 0 0;
                background: ${t('color-surface-card')};
                box-shadow: ${t('shadow-elevated')};
                z-index: 4;
            }

            & .m-green__title {
                margin-bottom: ${s('sm')};
                font-size: 1.1rem;
                font-weight: 700;
                text-align: center;
            }

            & .m-green__read {
                display: flex;
                flex-direction: column;
                gap: 2px;
                padding: ${s('sm')} ${s('md')};
                margin-bottom: ${s('md')};
                border-radius: 12px;
                background: ${t('color-surface-sunken')};
                text-align: center;
            }
            & .m-green__aim {
                min-height: 1.6em;
                font-size: 1.6rem;
                font-weight: 700;
                font-variant-numeric: tabular-nums;
                color: ${t('color-accent-primary')};
            }
            & .m-green__pace {
                min-height: 1.2em;
                font-size: 0.95rem;
                font-variant-numeric: tabular-nums;
                color: ${t('color-text-secondary')};
            }
            /* Softened / withheld reads speak in the caution colour — the read
               must never LOOK confident when the data isn't (MIN_READ_CONFIDENCE). */
            & .m-green__note {
                font-size: 0.8rem;
                color: ${t('color-text-tertiary')};
            }
            & .m-green__note.warn { color: ${t('color-status-caution')}; }
            & .m-green__conf {
                font-size: 0.72rem;
                color: ${t('color-text-tertiary')};
            }
            & .m-green__conf.warn { color: ${t('color-status-caution')}; }

            /* Tapped-point slope readout (slope overlay only). */
            & .m-green__probe {
                display: none;
                margin: calc(-1 * ${s('sm')}) 0 ${s('md')};
                font-size: 0.85rem;
                font-weight: 600;
                font-variant-numeric: tabular-nums;
                text-align: center;
                color: ${t('color-text-secondary')};
            }
            & .m-green__probe.show { display: block; }

            & .m-green__row {
                display: flex;
                align-items: center;
                gap: ${s('sm')};
                margin-bottom: ${s('sm')};
            }
            & .m-green__lbl {
                flex: 1;
                font-size: 0.8rem;
                color: ${t('color-text-secondary')};
            }

            & .m-green__seg {
                display: inline-flex;
                gap: 2px;
                padding: 2px;
                border-radius: ${t('radius-pill')};
                background: ${t('color-surface-sunken')};
            }
            & .m-green__segbtn {
                min-width: 56px;
                min-height: 44px;
                padding: 0 ${s('sm')};
                border: none;
                border-radius: ${t('radius-pill')};
                background: transparent;
                color: ${t('color-text-secondary')};
                font-size: 0.85rem;
                font-weight: 600;
                cursor: pointer;
            }
            & .m-green__segbtn.active {
                background: ${t('color-accent-primary')};
                color: ${t('color-on-accent')};
            }

            & .m-green__btn {
                min-height: 44px;
                padding: 0 ${s('md')};
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius-pill')};
                background: ${t('color-surface-raised')};
                color: ${t('color-text-primary')};
                font-size: 0.85rem;
                font-weight: 600;
                cursor: pointer;
            }

            & .m-green__stepper {
                display: inline-flex;
                align-items: center;
                gap: ${s('xs')};
            }
            & .m-green__step {
                width: 44px;
                height: 44px;
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius-pill')};
                background: ${t('color-surface-raised')};
                color: ${t('color-text-primary')};
                font-size: 1.2rem;
                font-weight: 700;
                cursor: pointer;
            }
            & .m-green__stimp {
                min-width: 3.5em;
                text-align: center;
                font-size: 1rem;
                font-weight: 700;
                font-variant-numeric: tabular-nums;
            }
        }
    `;

    private router = this.inject(Router);
    private tileset = this.inject(TilesetService);
    private mapSvc = this.inject(MapService);
    private courseDetail = this.inject(CourseDetailService);
    private furniture = this.inject(FurnitureService);
    private greenFeatures = this.inject(GreenFeaturesService);
    private putt = this.inject(PuttReadService);
    private geo = this.inject(GeolocationService);

    private readonly wake = new WakeLock();
    private mapHost!: HTMLElement;

    /** Which marker the current gesture is dragging, or null. */
    private dragging: 'ball' | 'hole' | null = null;
    /** Set while a drag is settling, so its trailing click never re-places. */
    private suppressClick = false;
    private analysisScheduled = false;
    private puttDataScheduled = false;
    /** Overlay ids currently added (so teardown/re-render stays honest). */
    private heatAdded = false;
    private boundaryAdded = false;
    private arrowsAdded = false;
    private probeOverlayAdded = false;
    private puttAdded = false;
    /** Tapped-point slope readout, pinned to the grid it was sampled from. */
    private probe = new Signal<{ grid: SampleGrid; probe: SlopeProbe } | null>(null);
    /** The (grid, mode) the heat image was rendered for — skip redundant work. */
    private renderedFor: { grid: SampleGrid; mode: string } | null = null;
    private derivedCache: { grid: SampleGrid; slope: SlopeGrid; stats: AnalysisStats } | null = null;
    /** Seeded the ball from the GPS fix once already this mount. */
    private gpsSeeded = false;
    private framedFeatureId: string | null = null;
    private detachMapGestures: (() => void) | null = null;

    // ── Route ────────────────────────────────────────────────────────────────

    private courseId = new Computed<string>(() => this.router.route.get().split('/')[3] ?? '');
    private holeNo = new Computed<number>(() => {
        const n = Number(this.router.route.get().split('/')[5]);
        return Number.isFinite(n) && n > 0 ? n : 1;
    });

    private currentHole = new Computed(() =>
        this.courseDetail.holes.get().find(h => h.number === this.holeNo.get()) ?? null);

    /** The putt context for this hole's green, or null (no green drawn). */
    private context = new Computed<PuttContext | null>(() => {
        const hole = this.currentHole.get();
        if (!hole) return null;
        return buildPuttContext({
            holeId: hole.id,
            features: this.greenFeatures.items.get(),
            greens: this.furniture.greens.get(),
            pins: this.furniture.pins.items.get(),
        });
    });

    // ── Render ───────────────────────────────────────────────────────────────

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            back: { onclick: () => this.goBack() },
            msg: {
                className: () => this.messageText() ? 'm-green__msg show' : 'm-green__msg',
                textContent: () => this.messageText() ?? '',
            },
            title: () => `Hole ${this.holeNo.get()} · Green`,
            aim: () => readAimText(this.putt.display.get()),
            pace: () => readPaceText(this.putt.display.get()),
            note: {
                className: () => {
                    const status = this.putt.display.get().status;
                    return status === 'soft' || status === 'unavailable'
                        ? 'm-green__note warn' : 'm-green__note';
                },
                textContent: () => readNoteText(this.putt.display.get()),
            },
            conf: {
                className: () => {
                    const c = this.putt.display.get().confidence;
                    return c && c.confidence < MIN_READ_CONFIDENCE
                        ? 'm-green__conf warn' : 'm-green__conf';
                },
                textContent: () => confidenceText(this.putt.display.get()),
            },
            probeRow: {
                className: () => this.probeText() ? 'm-green__probe show' : 'm-green__probe',
                textContent: () => this.probeText() ?? '',
            },
            placeBall: {
                className: () => this.segClass(this.putt.placing.get() === 'ball'),
                onclick: () => this.putt.setPlacing('ball'),
            },
            placeHole: {
                className: () => this.segClass(this.putt.placing.get() === 'hole'),
                onclick: () => this.putt.setPlacing('hole'),
            },
            atPin: { onclick: () => this.putt.placeHoleAtPin() },
            stimp: () => `${this.putt.stimpFt.get()} ft`,
            stimpDown: { onclick: () => this.stepStimp(-1) },
            stimpUp: { onclick: () => this.stepStimp(1) },
            modeSlope: {
                className: () => this.segClass(this.putt.overlayMode.get() === 'slope'),
                onclick: () => this.putt.setOverlayMode('slope'),
            },
            modeHeight: {
                className: () => this.segClass(this.putt.overlayMode.get() === 'height'),
                onclick: () => this.putt.setOverlayMode('height'),
            },
            modeNone: {
                className: () => this.segClass(this.putt.overlayMode.get() === 'none'),
                onclick: () => this.putt.setOverlayMode('none'),
            },
        });

        // Presentation-tier hooks (the e2e suite polls these, never CSS).
        const root = this.ref(frag, 'root');
        this.track(effect(() => {
            root.setAttribute('data-putt-status', this.putt.display.get().status);
        }));

        this.mapHost = this.ref(frag, 'mapHost');
        return frag;
    }

    private segClass(active: boolean): string {
        return active ? 'm-green__segbtn active' : 'm-green__segbtn';
    }

    private messageText(): string | null {
        return greenMessage({
            tileError: this.tileset.error.get()?.message ?? null,
            tilesLoading: this.tileset.loading.get(),
            holesLoaded: this.courseDetail.holes.get().length > 0,
            holeExists: this.currentHole.get() !== null,
            holeNumber: this.holeNo.get(),
            hasGreen: this.context.get() !== null,
        });
    }

    /** "Slope here: 2.4% · falls NE", or null when no live probe. */
    private probeText(): string | null {
        if (this.putt.overlayMode.get() !== 'slope') return null;
        const p = this.probe.get();
        if (!p || p.grid !== this.putt.grid.get()) return null;
        const dir = fallDirectionLabel(p.probe.dirE, p.probe.dirN);
        return `Slope here: ${p.probe.slopePct.toFixed(1)}%${dir ? ` · falls ${dir}` : ''}`;
    }

    private stepStimp(delta: number): void {
        const next = this.putt.stimpFt.peek() + delta;
        this.putt.setStimp(next);
        saveSessionStimp(this.putt.stimpFt.peek());
    }

    private goBack(): void {
        this.router.navigate(`/m/course/${this.courseId.peek()}/hole/${this.holeNo.peek()}`);
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    onMount(): void {
        this.putt.setStimp(loadSessionStimp());

        this.track(effect(() => {
            const courseId = this.courseId.get();
            if (!courseId) return;
            void this.tileset.load(courseId);
            void this.courseDetail.load(courseId);
            void this.greenFeatures.load(courseId);
        }));

        this.track(effect(() => {
            const holeIds = this.courseDetail.holes.get().map(h => h.id);
            if (holeIds.length) void this.furniture.load(this.courseId.peek(), holeIds);
        }));

        // Map init once this course's manifest is in (mirrors the hole screen).
        this.track(effect(() => {
            const courseId = this.courseId.get();
            const manifest = this.tileset.manifest.get();
            const version = this.tileset.tileVersion.get();
            const mapKey = this.tileset.mapKey.get();
            if (!manifest || !version || !mapKey) return;
            if (this.tileset.courseId.get() !== courseId) return;
            if (this.mapSvc.displayedVersion.peek() === version) return;
            untrack(() => this.mapSvc.init(this.mapHost, mapKey, manifest, version));
        }));

        // Arm the shared read for this green. `activate` is idempotent per
        // green feature, so data-reload re-runs never stomp placed markers.
        this.track(effect(() => {
            const ctx = this.context.get();
            if (!ctx) {
                untrack(() => this.putt.deactivate());
                return;
            }
            untrack(() => void this.putt.activate(ctx));
        }));

        // Frame the green itself (far tighter than the hole frame).
        this.track(effect(() => {
            if (!this.mapSvc.ready.get()) return;
            const ctx = this.context.get();
            if (!ctx || ctx.greenFeatureId === this.framedFeatureId) return;
            const bbox = greenBounds(ctx.geometry);
            if (!bbox) return;
            this.framedFeatureId = ctx.greenFeatureId;
            untrack(() => this.frameCamera(bbox));
        }));

        // The read geometry overlay — added once the map is live, on top of
        // the analysis stack.
        this.track(effect(() => {
            if (!this.mapSvc.ready.get()) {
                this.heatAdded = this.boundaryAdded = this.arrowsAdded = false;
                this.probeOverlayAdded = this.puttAdded = false;
                this.renderedFor = null;
                return;
            }
            untrack(() => {
                this.mapSvc.addOverlayLayer(PUTT_OVERLAY_ID, this.puttGeojson(), puttLayers());
                this.puttAdded = true;
                this.attachMapGestures();
                this.scheduleAnalysisRender();
            });
        }));

        // Live markers + settled read → overlay data, coalesced (drag frames
        // burst the eager graph; the map repaints once per microtask).
        this.track(effect(() => {
            this.putt.ball.get();
            this.putt.hole.get();
            this.putt.display.get();
            this.schedulePuttData();
        }));

        // Analysis field: grid arrival + mode toggles + probe taps, likewise
        // coalesced.
        this.track(effect(() => {
            this.putt.grid.get();
            this.putt.overlayMode.get();
            this.putt.context.get();
            this.probe.get();
            this.scheduleAnalysisRender();
        }));

        // Seed the BALL from the GPS fix ONCE, and only when the player is
        // actually standing on this green (otherwise the tap places it). Never
        // the hole — see `seedBallFromFix`.
        this.track(effect(() => {
            const fix = this.geo.fix.get();
            const ctx = this.context.get();
            if (this.gpsSeeded || !fix || !ctx) return;
            if (this.putt.ball.peek() !== null) return;
            const p = { x: fix.sweref.x, y: fix.sweref.y };
            if (!pointInGeometry(p, ctx.geometry)) return;
            this.gpsSeeded = untrack(() => seedBallFromFix(this.putt, p));
        }));

        // Tap-to-place (the ball first, then the hole — the shared service
        // auto-advances the selector). With the slope overlay up, the same
        // tap also reads the slope at that point (sheet row + map arrow).
        this.track(this.mapSvc.onClick(({ lngLat }) => {
            if (this.suppressClick) {
                this.suppressClick = false;
                return;
            }
            const p = lngLatToSweref99tm(lngLat);
            this.putt.placeNext(p);
            this.updateProbe(p);
        }));

        this.geo.start();
        this.wake.enable();

        // Teardown runs INSIDE the parent's $swap effect (that effect calls
        // child.destroy() in its own tracked scope), and MapService.destroy
        // READS this.map — so an un-untracked teardown subscribes $swap to the
        // map signals. The next screen's map.set(map) would then re-notify
        // $swap mid-mount and remount this screen recursively (two live maps,
        // a duplicate overlay source, and a map that never reports `loaded`).
        // Untrack so a teardown can never become a dependency of the router.
        this.track(() => untrack(() => {
            this.detachMapGestures?.();
            this.detachMapGestures = null;
            this.putt.deactivate();
            this.mapSvc.destroy();
            this.geo.stop();
            this.wake.release();
        }));
    }

    // ── Map glue (untestable under bun — kept thin) ───────────────────────────

    private frameCamera(bbox: Bbox): void {
        const map = this.mapSvc.map.peek();
        if (!map) return;
        const [w, s2, e, n] = bbox;
        if (w === e && s2 === n) {
            map.flyTo({ center: [w, s2], zoom: 20, duration: 500 });
            return;
        }
        map.fitBounds([[w, s2], [e, n]], { padding: FRAME_PADDING, maxZoom: 21, duration: 500 });
    }

    private puttGeojson(): ReturnType<typeof buildPuttGeojson> {
        const display = this.putt.display.peek();
        return buildPuttGeojson({
            ball: this.putt.ball.peek(),
            hole: this.putt.hole.peek(),
            read: display.read,
            soft: display.status === 'soft',
        });
    }

    private schedulePuttData(): void {
        if (this.puttDataScheduled) return;
        this.puttDataScheduled = true;
        queueMicrotask(() => {
            this.puttDataScheduled = false;
            if (!this.mapSvc.ready.peek() || !this.puttAdded) return;
            this.mapSvc.updateOverlayData(PUTT_OVERLAY_ID, this.puttGeojson());
        });
    }

    private scheduleAnalysisRender(): void {
        if (this.analysisScheduled) return;
        this.analysisScheduled = true;
        queueMicrotask(() => {
            this.analysisScheduled = false;
            this.renderAnalysis();
        });
    }

    /**
     * Draw the reused Slope/Height field: heat image, green boundary and (in
     * slope mode) the fall-line arrows — then raise the read geometry back on
     * top, since a re-added image source always lands topmost.
     */
    private renderAnalysis(): void {
        if (!this.mapSvc.ready.peek()) return;
        const mode = this.putt.overlayMode.peek();
        const grid = this.putt.grid.peek();
        const ctx = this.putt.context.peek();

        // Vector layers are cheap GeoJSON — always redone. The heat image is
        // NOT: it is a per-cell canvas encoded to a data URL, so it is kept
        // whenever (grid, mode) is unchanged (the desktop guards the same way
        // in analysis-overlay). A features/pins refresh must not re-encode it.
        this.clearVectors();
        if (!ctx) {
            this.clearHeat();
            return;
        }

        this.mapSvc.addOverlayLayer(GREEN_BOUNDARY_ID, boundaryGeojson(ctx.geometry), boundaryLayers());
        this.boundaryAdded = true;
        // Re-adding the boundary put it above a retained heat image, which is
        // the order the beforeId below establishes on a fresh render too.

        if (grid && mode !== 'none') {
            const derived = this.derivedFor(grid);
            if (!this.heatAdded || this.renderedFor?.grid !== grid || this.renderedFor.mode !== mode) {
                this.clearHeat();
                const url = heatImageUrl(
                    grid, mode as Exclude<PuttOverlayMode, 'none'>, derived.slope, derived.stats);
                if (url) {
                    this.mapSvc.addImageOverlay(GREEN_HEAT_ID, url, gridCorners(grid), {
                        opacity: 0.9,
                        beforeId: `${GREEN_BOUNDARY_ID}-casing`,
                    });
                    this.heatAdded = true;
                    this.renderedFor = { grid, mode };
                }
            }
            if (mode === 'slope') {
                const arrows = sampleFallLines(grid, derived.slope);
                this.mapSvc.addOverlayLayer(
                    GREEN_ARROWS_ID, arrowsGeojson(arrows, arrowLengthM(grid)), arrowLayers());
                this.arrowsAdded = true;

                const probe = this.probe.peek();
                if (probe && probe.grid === grid) {
                    this.mapSvc.addOverlayLayer(
                        GREEN_PROBE_ID,
                        probeGeojson(probe.probe, probeArrowLengthM(grid)),
                        probeLayers(GREEN_PROBE_ID));
                    this.probeOverlayAdded = true;
                }
            }
        } else {
            this.clearHeat();
        }
        this.raisePuttGeometry();
    }

    /** Sample the slope under a tap; clears when off-grid or no slope data. */
    private updateProbe(p: Vec2): void {
        if (this.putt.overlayMode.peek() !== 'slope') return;
        const grid = this.putt.grid.peek();
        if (!grid) return;
        const probe = sampleSlopeAt(grid, this.derivedFor(grid).slope, p.x, p.y);
        this.probe.set(probe ? { grid, probe } : null);
    }

    private derivedFor(grid: SampleGrid): { slope: SlopeGrid; stats: AnalysisStats } {
        if (!this.derivedCache || this.derivedCache.grid !== grid) {
            const slope = computeSlopeGrid(grid);
            this.derivedCache = { grid, slope, stats: computeStats(grid, slope) };
        }
        return this.derivedCache;
    }

    private clearVectors(): void {
        if (this.probeOverlayAdded) {
            this.mapSvc.removeOverlayLayer(GREEN_PROBE_ID);
            this.probeOverlayAdded = false;
        }
        if (this.arrowsAdded) {
            this.mapSvc.removeOverlayLayer(GREEN_ARROWS_ID);
            this.arrowsAdded = false;
        }
        if (this.boundaryAdded) {
            this.mapSvc.removeOverlayLayer(GREEN_BOUNDARY_ID);
            this.boundaryAdded = false;
        }
    }

    private clearHeat(): void {
        if (this.heatAdded) {
            this.mapSvc.removeOverlayLayer(GREEN_HEAT_ID);
            this.heatAdded = false;
        }
        this.renderedFor = null;
    }

    /** Keep the read (path, aim line, markers) above the analysis field. */
    private raisePuttGeometry(): void {
        const map = this.mapSvc.map.peek();
        if (!map || !this.puttAdded) return;
        for (const spec of puttLayers()) {
            if (map.getLayer(spec.id)) map.moveLayer(spec.id); // no beforeId → top
        }
    }

    /**
     * Touch/mouse drag of the ball or hole marker. Hit-testing is done in
     * SCREEN space against a fat-finger radius rather than by querying the
     * 5 px marker circles, which are impossible to hit reliably on a phone.
     * Dragging disables the map's own pan for the gesture so the read moves
     * instead of the camera.
     */
    private attachMapGestures(): void {
        const map = this.mapSvc.map.peek();
        if (!map || this.detachMapGestures) return;

        const grabbed = (point: { x: number; y: number }): 'ball' | 'hole' | null => {
            const candidates: Array<['ball' | 'hole', Vec2 | null]> = [
                ['ball', this.putt.ball.peek()],
                ['hole', this.putt.hole.peek()],
            ];
            let best: { which: 'ball' | 'hole'; d: number } | null = null;
            for (const [which, v] of candidates) {
                if (!v) continue;
                const { lat, lon } = sweref99tmToWgs84(v.x, v.y);
                const p = map.project([lon, lat]);
                const d = Math.hypot(p.x - point.x, p.y - point.y);
                if (d <= GRAB_RADIUS_PX && (!best || d < best.d)) best = { which, d };
            }
            return best?.which ?? null;
        };

        const onDown = (e: { point: { x: number; y: number }; preventDefault: () => void }) => {
            const which = grabbed(e.point);
            if (!which) return;
            this.dragging = which;
            e.preventDefault();
            map.dragPan.disable();
        };
        const onMove = (e: { lngLat: { lng: number; lat: number }; preventDefault: () => void }) => {
            if (!this.dragging) return;
            e.preventDefault();
            const p = lngLatToSweref99tm({ lng: e.lngLat.lng, lat: e.lngLat.lat });
            if (this.dragging === 'ball') this.putt.dragBall(p);
            else this.putt.dragHole(p);
        };
        const onUp = () => {
            if (!this.dragging) return;
            this.dragging = null;
            this.suppressClick = true;
            map.dragPan.enable();
            this.putt.commit();
        };

        map.on('mousedown', onDown);
        map.on('touchstart', onDown);
        map.on('mousemove', onMove);
        map.on('touchmove', onMove);
        map.on('mouseup', onUp);
        map.on('touchend', onUp);
        map.on('touchcancel', onUp);

        this.detachMapGestures = () => {
            map.off('mousedown', onDown);
            map.off('touchstart', onDown);
            map.off('mousemove', onMove);
            map.off('touchmove', onMove);
            map.off('mouseup', onUp);
            map.off('touchend', onUp);
            map.off('touchcancel', onUp);
        };
    }
}
