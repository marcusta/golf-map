import {
    Component,
    Computed,
    Router,
    Signal,
    effect,
    template,
    untrack,
} from '@basics/core/client/core';
import maplibregl from 'maplibre-gl';
import { MapService, type OverlayLayerSpec } from '../../map/map.service';
import { ElevationService } from '../../map/elevation.service';
import { TilesetService } from '../../map/tileset.service';
import { CourseDetailService } from '../../course-detail/course-detail.service';
import { FurnitureService } from '../../furniture/furniture.service';
import { PlanService } from '../../planner/plan.service';
import { ClubsService } from '../../player/clubs.service';
import {
    buildHolePlan,
    buildPlanGeojson,
    planLayers,
    legLabel,
    PLAN_OVERLAY_ID,
    type HolePlan,
} from '../../planner/plan-overlay';
import {
    bearingBetween,
    type BrowsePointTarget,
    type BrowseHazardTarget,
} from '../../planner/browse-ladder';
import {
    pointInRing,
    ringExtentAlongRay,
    type ClubSpec,
    type StrategyPoint,
    type Vec2,
} from '../../../../shared/strategy';
import { sweref99tmToWgs84, wgs84ToSweref99tm } from '../../geo/transform';
import { GeolocationService, type GpsFix } from '../gps/geolocation.service';
import { GPS_OVERLAY_ID, buildGpsGeojson, gpsLayers } from '../gps/gps-overlay';
import { WakeLock } from '../gps/wake-lock';
import { FeaturesGeojsonService } from './features-geojson.service';
import { fillColorExpression, outlineColorExpression, typeSortKeyExpression, typeZRank } from './feature-colors';
import { frameHole, type LngLatPoint } from './hole-frame';
import { hazardRingsFromGeojson, tappableRingsFromGeojson } from './hazard-rings';
import { HoleOverrideService, suggestedHole } from './hole-override.service';
import { greenRoute } from '../app/route-key';
import { buildHoleReadouts, pointDistance, type HoleReadouts } from '../gps/distances';
import { t } from '../../theme';
import { s } from '../../css';
import { icon } from '../../ui/icons';

const FEATURES_OVERLAY_ID = 'm-features';
const TAP_OVERLAY_ID = 'm-tap';
/** Keep the framed hole above the bottom sheet (sheet ≈ 46vh, capped). */
const SHEET_PADDING_PX = 240;

const tpl = template(`
    <div class="m-hole" bind="root" data-testid="m-hole">
        <div class="m-hole__map" bind="mapHost"></div>

        <div class="m-hole__msg" bind="msg"></div>

        <nav class="m-hole__strip" bind="strip" data-testid="m-hole-strip"></nav>

        <button class="m-hole__tap-pill" bind="tapPill" data-testid="m-hole-tap"></button>

        <button class="m-hole__suggest" bind="suggest" data-testid="m-hole-suggest"></button>

        <section class="m-hole__sheet" bind="sheet" data-testid="m-hole-sheet">
            <header class="m-hole__head">
                <button class="m-hole__nav" bind="prev" aria-label="Previous hole">${icon('chevron-left', 24)}</button>
                <div class="m-hole__title" bind="title"></div>
                <button class="m-hole__nav" bind="next" aria-label="Next hole">${icon('chevron-right', 24)}</button>
            </header>

            <div class="m-hole__greens" data-testid="m-hole-greens">
                <div class="m-hole__green-cell"><span class="m-hole__green-lbl">Front</span><span class="m-hole__green-val" bind="front">—</span><span class="m-hole__green-plays" bind="frontPlays"></span></div>
                <div class="m-hole__green-cell m-hole__green-cell--mid"><span class="m-hole__green-lbl">Middle</span><span class="m-hole__green-val" bind="mid">—</span><span class="m-hole__green-plays" bind="midPlays"></span></div>
                <div class="m-hole__green-cell"><span class="m-hole__green-lbl">Back</span><span class="m-hole__green-val" bind="back">—</span><span class="m-hole__green-plays" bind="backPlays"></span></div>
            </div>

            <button class="m-hole__green-link" bind="greenLink" data-testid="m-hole-green-link">Green view &amp; putt read</button>

            <div class="m-hole__gps" bind="gpsline"></div>

            <ul class="m-hole__targets" bind="targets"></ul>
            <ul class="m-hole__legs" bind="legs"></ul>
        </section>
    </div>
`);

const stripBtnTpl = template(`<button class="m-strip__btn" bind="btn"></button>`);
const targetRowTpl = template(`
    <li class="m-trow" bind="row">
        <span class="m-trow__label" bind="label"></span>
        <span class="m-trow__val" bind="val"></span>
        <span class="m-trow__plays" bind="plays"></span>
    </li>
`);
const legRowTpl = template(`
    <li class="m-leg" bind="row">
        <span class="m-leg__n" bind="n"></span>
        <span class="m-leg__txt" bind="txt"></span>
    </li>
`);

/** A plan-target / hazard row as displayed: raw distance + plays-like aside. */
interface TargetRow { id: string; label: string; value: string; plays: string }

/**
 * What the tap pill + tap overlay show: a bare point's distance, or — when
 * the tap landed inside a hazard/green shape — that shape's near ("front") /
 * far ("carry") extent along the play line, plus the geometry the overlay
 * highlights (the ring, and the two play-line edge points the figures
 * measure to).
 */
type TapReadout =
    | { kind: 'point'; lineM: number; playsAsM: number | null }
    | {
        kind: 'feature';
        label: string;
        frontM: number;
        carryM: number;
        ring: LngLatPoint[];
        frontPoint: LngLatPoint;
        carryPoint: LngLatPoint;
    };

/** One green readout: the raw line distance plus its plays-like companion. */
interface GreenCell { lineM: number | null; playsAsM: number | null }
interface GreenNumbers { front: GreenCell; mid: GreenCell; back: GreenCell }

const NO_CELL: GreenCell = { lineM: null, playsAsM: null };

/**
 * The "plays N" companion shown beside a raw distance — the same idiom (and
 * the same 1 m threshold) as the tap pill, so elevation-adjusted numbers read
 * identically wherever they appear. Empty string when the adjustment rounds
 * away, keeping the raw number visually primary.
 */
function playsLabel(lineM: number | null, playsAsM: number | null): string {
    if (lineM === null || playsAsM === null) return '';
    if (Math.abs(playsAsM - lineM) < 1) return '';
    return `plays ${Math.round(playsAsM)}`;
}

/**
 * The on-course hole screen: a fullscreen map framed tee→green, a top hole
 * strip, and a bottom sheet of distances. Everything is READ-ONLY — features,
 * the game plan and the GPS position are overlays with no drag handlers (the
 * editor/planner tools live in forbidden dirs and are never imported here).
 *
 * Mirrors the editor-canvas lifecycle (tileset → map init → elevation config →
 * teardown), but adds the live GPS watch, wake lock and distance readouts. GPS
 * ticks (~1 Hz) drive the overlay via a coalesced microtask so the eager
 * signal graph never repaints the map on a half-updated intermediate state.
 */
export class MobileHoleComponent extends Component {
    static styles = `
        .m-hole {
            position: relative;
            height: 100%;
            overflow: hidden;
            background: ${t('color-surface-app')};
            color: ${t('color-text-primary')};

            & .m-hole__map { position: absolute; inset: 0; }

            & .m-hole__msg {
                position: absolute;
                top: calc(var(--safe-top) + 56px);
                left: 50%;
                transform: translateX(-50%);
                display: none;
                max-width: 80%;
                padding: ${s('sm')} ${s('md')};
                border-radius: ${t('radius-pill')};
                background: ${t('color-surface-card')};
                box-shadow: ${t('shadow-elevated')};
                font-size: 0.85rem;
                color: ${t('color-text-secondary')};
                text-align: center;
                z-index: 6;
            }
            & .m-hole__msg.show { display: block; }

            & .m-hole__strip {
                position: absolute;
                top: var(--safe-top);
                left: 0;
                right: 0;
                display: flex;
                gap: ${s('xs')};
                padding: ${s('sm')} calc(${s('sm')} + var(--safe-left)) ${s('sm')} calc(${s('sm')} + var(--safe-right));
                overflow-x: auto;
                -webkit-overflow-scrolling: touch;
                scrollbar-width: none;
                background: linear-gradient(${t('color-surface-app')}, transparent);
                z-index: 5;
            }
            & .m-hole__strip::-webkit-scrollbar { display: none; }

            & .m-strip__btn {
                flex: 0 0 auto;
                min-width: 44px;
                height: 44px;
                border: none;
                border-radius: ${t('radius-pill')};
                background: ${t('color-surface-card')};
                color: ${t('color-text-secondary')};
                font-size: 1rem;
                font-weight: 600;
                box-shadow: ${t('shadow-elevated')};
                cursor: pointer;
            }
            & .m-strip__btn.active {
                background: ${t('color-accent-primary')};
                color: ${t('color-on-accent')};
            }

            & .m-hole__tap-pill,
            & .m-hole__suggest {
                position: absolute;
                left: 50%;
                transform: translateX(-50%);
                display: none;
                align-items: center;
                gap: ${s('xs')};
                min-height: 44px;
                padding: ${s('xs')} ${s('md')};
                border: none;
                border-radius: ${t('radius-pill')};
                box-shadow: ${t('shadow-elevated')};
                font-size: 0.9rem;
                font-weight: 600;
                cursor: pointer;
                z-index: 6;
            }
            & .m-hole__tap-pill {
                top: calc(var(--safe-top) + 56px);
                background: ${t('color-surface-card')};
                color: ${t('color-text-accent')};
            }
            & .m-hole__tap-pill.show { display: inline-flex; }
            & .m-hole__suggest {
                top: calc(var(--safe-top) + 108px);
                background: ${t('color-accent-primary')};
                color: ${t('color-on-accent')};
            }
            & .m-hole__suggest.show { display: inline-flex; }

            & .m-hole__sheet {
                position: absolute;
                left: 0;
                right: 0;
                bottom: 0;
                max-height: 46vh;
                overflow-y: auto;
                -webkit-overflow-scrolling: touch;
                padding: ${s('md')} calc(${s('lg')} + var(--safe-left)) calc(${s('md')} + var(--safe-bottom)) calc(${s('lg')} + var(--safe-right));
                border-radius: 16px 16px 0 0;
                background: ${t('color-surface-card')};
                box-shadow: ${t('shadow-elevated')};
                z-index: 4;
            }

            & .m-hole__head {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: ${s('sm')};
                margin-bottom: ${s('sm')};
            }
            & .m-hole__nav {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 44px;
                height: 44px;
                border: none;
                border-radius: ${t('radius-pill')};
                background: ${t('color-surface-raised')};
                color: ${t('color-text-primary')};
                cursor: pointer;
            }
            & .m-hole__title {
                flex: 1;
                text-align: center;
                font-size: 1.1rem;
                font-weight: 700;
            }

            & .m-hole__greens {
                display: grid;
                grid-template-columns: 1fr 1.3fr 1fr;
                gap: ${s('sm')};
                margin-bottom: ${s('md')};
            }
            & .m-hole__green-cell {
                display: flex;
                flex-direction: column;
                align-items: center;
                padding: ${s('sm')} ${s('xs')};
                border-radius: 12px;
                background: ${t('color-surface-raised')};
            }
            & .m-hole__green-cell--mid { background: ${t('color-surface-sunken')}; }
            & .m-hole__green-lbl {
                font-size: 0.7rem;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                color: ${t('color-text-tertiary')};
            }
            & .m-hole__green-val {
                font-size: 2rem;
                font-weight: 700;
                font-variant-numeric: tabular-nums;
                color: ${t('color-text-primary')};
            }
            & .m-hole__green-cell--mid .m-hole__green-val { color: ${t('color-accent-primary')}; }

            /* Plays-like sits UNDER the raw number, small and muted — the raw
               distance stays the primary read; this is the elevation aside. */
            & .m-hole__green-plays {
                min-height: 1em;
                font-size: 0.7rem;
                font-variant-numeric: tabular-nums;
                color: ${t('color-text-tertiary')};
            }

            /* Entry to the green screen — full-width so it is a 44px target
               even on the narrowest phone. */
            & .m-hole__green-link {
                display: block;
                width: 100%;
                min-height: 44px;
                margin-bottom: ${s('sm')};
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius-pill')};
                background: ${t('color-surface-raised')};
                color: ${t('color-text-primary')};
                font-size: 0.9rem;
                font-weight: 600;
                cursor: pointer;
            }

            & .m-hole__gps {
                min-height: 1.2em;
                margin-bottom: ${s('sm')};
                font-size: 0.8rem;
                color: ${t('color-text-tertiary')};
            }

            & .m-hole__targets,
            & .m-hole__legs {
                list-style: none;
                margin: 0 0 ${s('sm')};
                padding: 0;
                display: flex;
                flex-direction: column;
                gap: ${s('xs')};
            }
            & .m-trow, & .m-leg {
                display: flex;
                align-items: baseline;
                justify-content: space-between;
                gap: ${s('sm')};
                padding: ${s('xs')} 0;
                border-top: 1px solid ${t('color-border-subtle')};
            }
            /* label | raw | plays-like — the label takes the slack so the two
               numbers stay clustered on the right, raw first and dominant. */
            & .m-trow__label { flex: 1; color: ${t('color-text-secondary')}; }
            & .m-trow__val {
                flex: 0 0 auto;
                font-weight: 600;
                font-variant-numeric: tabular-nums;
                color: ${t('color-text-primary')};
            }
            & .m-trow__plays {
                flex: 0 0 auto;
                min-width: 4.5em;
                text-align: right;
                font-size: 0.75rem;
                font-variant-numeric: tabular-nums;
                color: ${t('color-text-tertiary')};
            }
            & .m-leg__n {
                flex: 0 0 auto;
                font-weight: 700;
                color: ${t('color-text-tertiary')};
            }
            & .m-leg__txt {
                flex: 1;
                text-align: right;
                color: ${t('color-text-secondary')};
                font-size: 0.85rem;
            }
        }
    `;

    private router = this.inject(Router);
    private tileset = this.inject(TilesetService);
    private mapSvc = this.inject(MapService);
    private elevation = this.inject(ElevationService);
    private courseDetail = this.inject(CourseDetailService);
    private furniture = this.inject(FurnitureService);
    private plan = this.inject(PlanService);
    private clubs = this.inject(ClubsService);
    private features = this.inject(FeaturesGeojsonService);
    private geo = this.inject(GeolocationService);
    private overrides = this.inject(HoleOverrideService);

    private readonly wake = new WakeLock();
    private mapHost!: HTMLElement;

    /** Last tapped map point (WGS84), or null. */
    private tapPoint = new Signal<LngLatPoint | null>(null);
    private gpsRefreshScheduled = false;
    /** DOM markers carrying the tap-a-shape front/carry figures. */
    private tapEdgeMarkers: maplibregl.Marker[] = [];

    // ── Route ────────────────────────────────────────────────────────────────

    private courseId = new Computed<string>(() => this.router.route.get().split('/')[3] ?? '');
    private holeNo = new Computed<number>(() => {
        const n = Number(this.router.route.get().split('/')[5]);
        return Number.isFinite(n) && n > 0 ? n : 1;
    });

    // ── Hole geometry ──────────────────────────────────────────────────────────

    private holeNumbers = new Computed<number[]>(() =>
        this.courseDetail.holes.get().map(h => h.number).sort((a, b) => a - b));

    private currentHole = new Computed(() =>
        this.courseDetail.holes.get().find(h => h.number === this.holeNo.get()) ?? null);

    /** Ball position (GPS fix projected + elevation-sampled), or null. */
    private origin = new Computed<StrategyPoint | null>(() => {
        const fix = this.geo.fix.get();
        if (!fix) return null;
        const elevation = this.elevation.elevationAtSync({ lng: fix.lng, lat: fix.lat });
        return { x: fix.sweref.x, y: fix.sweref.y, elevation };
    });

    private greenCenter = new Computed<StrategyPoint | null>(() => {
        const hole = this.currentHole.get();
        if (!hole) return null;
        const green = this.furniture.greenForHole(hole.id);
        if (!green) return null;
        const sweref = wgs84ToSweref99tm(green.centerLat, green.centerLon);
        return { x: sweref.x, y: sweref.y, elevation: green.elevation };
    });

    private greenTargets = new Computed<BrowsePointTarget[]>(() => {
        const hole = this.currentHole.get();
        if (!hole) return [];
        const green = this.furniture.greenForHole(hole.id);
        if (!green) return [];
        const specs: Array<['front' | 'center' | 'back', BrowsePointTarget['role'], string]> = [
            ['front', 'green_front', 'Front'],
            ['center', 'green_center', 'Middle'],
            ['back', 'green_back', 'Back'],
        ];
        const out: BrowsePointTarget[] = [];
        for (const [point, role, label] of specs) {
            const pos = this.furniture.greenPointPos(green, point);
            if (!pos) continue;
            const sweref = wgs84ToSweref99tm(pos.lat, pos.lon);
            out.push({ id: `green:${point}`, label, role, point: { x: sweref.x, y: sweref.y, elevation: green.elevation } });
        }
        return out;
    });

    private planShotTargets = new Computed<BrowsePointTarget[]>(() => {
        const row = this.plan.holeRow(this.holeNo.get());
        if (!row) return [];
        return this.plan.primaryLineForHole(row.id).map((shot, i) => {
            const sweref = wgs84ToSweref99tm(shot.lat, shot.lon);
            return {
                id: `plan:${shot.id}`,
                label: shot.label ?? `Plan ${i + 1}`,
                role: 'aim' as const,
                point: { x: sweref.x, y: sweref.y, elevation: shot.elevation },
            };
        });
    });

    private hazardTargets = new Computed<BrowseHazardTarget[]>(() =>
        hazardRingsFromGeojson(this.features.data.get()));

    /** Hazards + greens — the shapes the tap-a-shape readout answers for. */
    private tappableRings = new Computed<BrowseHazardTarget[]>(() =>
        tappableRingsFromGeojson(this.features.data.get()));

    private clubSpecs = new Computed<ClubSpec[]>(() =>
        this.clubs.store.items.get().map(c => ({ name: c.name, carryM: c.carryM, dispersionM: c.dispersionM })));

    /** Reference line for front/carry intersections: ball → green centre. */
    private readoutBearing = new Computed<number>(() => {
        const origin = this.origin.get();
        const green = this.greenCenter.get();
        if (origin && green) return bearingBetween(origin, green);
        return 0;
    });

    private readouts = new Computed<HoleReadouts | null>(() => {
        const origin = this.origin.get();
        if (!origin) return null;
        return buildHoleReadouts({
            origin,
            greenTargets: this.greenTargets.get(),
            planTargets: this.planShotTargets.get(),
            hazards: this.hazardTargets.get(),
            bearingDeg: this.readoutBearing.get(),
            clubs: this.clubSpecs.get(),
        });
    });

    private greenNumbers = new Computed<GreenNumbers>(() => {
        const rows = this.readouts.get()?.green ?? [];
        const by = (kind: string): GreenCell => {
            const row = rows.find(r => r.kind === kind);
            if (!row) return NO_CELL;
            return { lineM: Math.round(row.lineM), playsAsM: row.playsAsM };
        };
        return { front: by('green_front'), mid: by('green_center'), back: by('green_back') };
    });

    /** Plan legs (primary line) for the shot list. */
    private holePlan = new Computed<HolePlan | null>(() => {
        const hole = this.currentHole.get();
        if (!hole) return null;
        const green = this.furniture.greenForHole(hole.id);
        const tee = this.furniture.lineOriginTee(hole.id);
        const row = this.plan.holeRow(this.holeNo.get());
        const shots = row ? this.plan.shotsForHole(row.id) : [];
        const primaryShots = row ? this.plan.primaryLineForHole(row.id) : [];
        return buildHolePlan({
            tee: tee ? { lat: tee.lat, lon: tee.lon, elevation: tee.elevation } : null,
            shots,
            primaryShots,
            green: green ? { lat: green.centerLat, lon: green.centerLon, elevation: green.elevation } : null,
            clubs: this.clubs.store.items.get(),
            preferredClubId: row?.preferredClubId ?? null,
            wind: null,
        });
    });

    private tapReadout = new Computed<TapReadout | null>(() => {
        const at = this.tapPoint.get();
        const origin = this.origin.get();
        if (!at || !origin) return null;
        const sweref = wgs84ToSweref99tm(at.lat, at.lng);
        const feature = this.tappedFeatureReadout(sweref, origin);
        if (feature) return feature;
        const elevation = this.elevation.elevationAtSync({ lng: at.lng, lat: at.lat });
        return {
            kind: 'point',
            ...pointDistance(origin, { x: sweref.x, y: sweref.y, elevation }, this.readoutBearing.get()),
        };
    });

    /**
     * Tap landed inside a hazard/green shape → its near/far window along the
     * RAY from the GPS position through the tap, extended through the ring —
     * "if I hit at that shape, it's front to reach and carry to clear". The
     * edge points sit ON the shape's own lips, so the figures render at the
     * shape. Null when the tap hit no tappable ring; the topmost-painted
     * ring wins overlaps (same type z-order the map renders).
     */
    private tappedFeatureReadout(p: Vec2, origin: StrategyPoint): TapReadout | null {
        let best: BrowseHazardTarget | null = null;
        let bestRank = -Infinity;
        for (const target of this.tappableRings.get()) {
            if (!pointInRing(p, target.ring.points)) continue;
            const rank = typeZRank(target.ring.kind);
            if (rank > bestRank) {
                bestRank = rank;
                best = target;
            }
        }
        if (!best) return null;

        const extent = ringExtentAlongRay(origin, p, best.ring);
        if (!extent) return null;
        const toLngLat = (v: { x: number; y: number }): LngLatPoint => {
            const w = sweref99tmToWgs84(v.x, v.y);
            return { lng: w.lon, lat: w.lat };
        };
        return {
            kind: 'feature',
            label: best.label,
            frontM: extent.frontM,
            carryM: extent.carryM,
            ring: best.ring.points.map(toLngLat),
            frontPoint: toLngLat(extent.frontPoint),
            carryPoint: toLngLat(extent.carryPoint),
        };
    }

    // ── Nearest-hole suggestion ────────────────────────────────────────────────

    private nearestHole = new Computed<number | null>(() => {
        const origin = this.origin.get();
        if (!origin) return null;
        const numberByHoleId = new Map(this.courseDetail.holes.get().map(h => [h.id, h.number]));
        let best: { number: number; d: number } | null = null;
        for (const green of this.furniture.greens.get()) {
            const number = numberByHoleId.get(green.holeId);
            if (number === undefined) continue;
            const sweref = wgs84ToSweref99tm(green.centerLat, green.centerLon);
            const d = Math.hypot(origin.x - sweref.x, origin.y - sweref.y);
            if (!best || d < best.d) best = { number, d };
        }
        return best?.number ?? null;
    });

    private suggestion = new Computed<number | null>(() => suggestedHole({
        courseId: this.courseId.get(),
        currentHole: this.holeNo.get(),
        nearestHole: this.nearestHole.get(),
        override: this.overrides.override.get(),
    }));

    // ── Render ─────────────────────────────────────────────────────────────────

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            msg: {
                className: () => this.messageText() ? 'm-hole__msg show' : 'm-hole__msg',
                textContent: () => this.messageText() ?? '',
            },
            title: () => {
                const hole = this.currentHole.get();
                return hole ? `Hole ${hole.number} · Par ${hole.par}` : `Hole ${this.holeNo.get()}`;
            },
            prev: { onclick: () => this.step(-1) },
            next: { onclick: () => this.step(1) },
            front: () => this.fmtGreen(this.greenNumbers.get().front.lineM),
            mid: () => this.fmtGreen(this.greenNumbers.get().mid.lineM),
            back: () => this.fmtGreen(this.greenNumbers.get().back.lineM),
            frontPlays: () => this.fmtPlays(this.greenNumbers.get().front),
            midPlays: () => this.fmtPlays(this.greenNumbers.get().mid),
            backPlays: () => this.fmtPlays(this.greenNumbers.get().back),
            greenLink: {
                onclick: () => this.router.navigate(
                    greenRoute(this.courseId.peek(), this.holeNo.peek())),
            },
            gpsline: () => this.gpsLineText(),
            tapPill: {
                className: () => this.tapReadout.get() ? 'm-hole__tap-pill show' : 'm-hole__tap-pill',
                textContent: () => {
                    const r = this.tapReadout.get();
                    if (!r) return '';
                    if (r.kind === 'feature') {
                        return `${r.label} ${Math.round(r.frontM)} / ${Math.round(r.carryM)} m  ✕`;
                    }
                    const plays = r.playsAsM !== null && Math.abs(r.playsAsM - r.lineM) >= 1
                        ? ` · plays ${Math.round(r.playsAsM)}` : '';
                    return `Point ${Math.round(r.lineM)} m${plays}  ✕`;
                },
                onclick: () => this.tapPoint.set(null),
            },
            suggest: {
                className: () => this.suggestion.get() !== null ? 'm-hole__suggest show' : 'm-hole__suggest',
                textContent: () => {
                    const n = this.suggestion.get();
                    return n !== null ? `You seem closer to hole ${n} — go?` : '';
                },
                onclick: () => {
                    const n = this.suggestion.peek();
                    if (n !== null) this.goHole(n);
                },
            },
        });

        this.$each(
            this.ref(frag, 'strip'),
            () => this.holeNumbers.get(),
            (num) => this.renderStripButton(num),
            (num) => String(num),
        );

        this.$each(
            this.ref(frag, 'targets'),
            () => this.targetRows(),
            (row) => this.renderTargetRow(row),
            (row) => row.id,
        );

        this.$each(
            this.ref(frag, 'legs'),
            () => this.holePlan.get()?.legs ?? [],
            (leg) => this.renderLegRow(leg),
            (leg) => String(leg.index),
        );

        this.mapHost = this.ref(frag, 'mapHost');
        return frag;
    }

    private renderStripButton(num: number): HTMLElement {
        const btn = this.wireEl(stripBtnTpl, {
            btn: {
                textContent: () => String(num),
                className: () => num === this.holeNo.get() ? 'm-strip__btn active' : 'm-strip__btn',
                'data-hole': String(num),
                onclick: () => this.goHole(num),
            },
        });
        return btn;
    }

    private renderTargetRow(row: TargetRow): HTMLElement {
        return this.wireEl(targetRowTpl, {
            label: () => row.label,
            val: () => row.value,
            plays: () => row.plays,
            row: { 'data-target-id': row.id },
        });
    }

    private renderLegRow(leg: HolePlan['legs'][number]): HTMLElement {
        return this.wireEl(legRowTpl, {
            n: () => `Shot ${leg.index + 1}`,
            txt: () => legLabel(leg),
            row: { 'data-leg': String(leg.index) },
        });
    }

    /** Plan targets + hazard carries as flat display rows, nearest first. */
    private targetRows(): TargetRow[] {
        const r = this.readouts.get();
        if (!r) return [];
        const rows: TargetRow[] = [];
        for (const row of r.targets) {
            rows.push({
                id: row.id,
                label: row.label,
                value: `${Math.round(row.lineM)} m`,
                plays: playsLabel(row.lineM, row.playsAsM),
            });
        }
        for (const row of r.hazards) {
            const edge = row.kind === 'hazard_carry' ? 'carry' : 'front';
            rows.push({
                id: row.id,
                label: `${row.label} (${edge})`,
                value: `${Math.round(row.lineM)} m`,
                plays: playsLabel(row.lineM, row.playsAsM),
            });
        }
        return rows;
    }

    private fmtGreen(value: number | null): string {
        return value === null ? '—' : String(value);
    }

    private fmtPlays(cell: GreenCell): string {
        return playsLabel(cell.lineM, cell.playsAsM);
    }

    private gpsLineText(): string {
        const status = this.geo.status.get();
        if (status === 'insecure' || status === 'unsupported' || status === 'denied') {
            return this.geo.message.get() ?? 'Location unavailable.';
        }
        const fix = this.geo.fix.get();
        if (!fix) return this.geo.message.get() ?? 'Waiting for a GPS fix…';
        const stale = this.geo.stale.get() ? ' · stale' : '';
        return `GPS ±${Math.round(fix.accuracyM)} m${stale}`;
    }

    private messageText(): string | null {
        const error = this.tileset.error.get();
        if (error) return `Could not load tiles — ${error.message}`;
        if (this.tileset.loading.get()) return 'Loading course…';
        return null;
    }

    private step(delta: number): void {
        const nums = this.holeNumbers.peek();
        const idx = nums.indexOf(this.holeNo.peek());
        const next = nums[idx + delta];
        if (next !== undefined) this.goHole(next);
    }

    private goHole(num: number): void {
        // Remember the choice in the DI singleton, NOT on this component —
        // $swap destroys us on the very navigation below, so component-local
        // state could never survive to suppress the banner it dismissed.
        this.overrides.note(this.courseId.peek(), this.nearestHole.peek());
        this.tapPoint.set(null);
        this.router.navigate(`/m/course/${this.courseId.peek()}/hole/${num}`);
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    onMount(): void {
        // Course + plan + clubs (cached per id; safe to call repeatedly).
        this.track(effect(() => {
            const courseId = this.courseId.get();
            if (!courseId) return;
            void this.tileset.load(courseId);
            void this.courseDetail.load(courseId);
            void this.plan.load(courseId);
            void this.features.load(courseId);
        }));
        void this.clubs.load();

        // Furniture (tees/greens/pins) needs the hole id list — load once holes arrive.
        this.track(effect(() => {
            const holeIds = this.courseDetail.holes.get().map(h => h.id);
            if (holeIds.length) void this.furniture.load(this.courseId.peek(), holeIds);
        }));

        // Map init once this course's manifest is in (mirrors editor-canvas).
        this.track(effect(() => {
            const courseId = this.courseId.get();
            const manifest = this.tileset.manifest.get();
            const version = this.tileset.tileVersion.get();
            const mapKey = this.tileset.mapKey.get();
            if (!manifest || !version || !mapKey) return;
            if (this.tileset.courseId.get() !== courseId) return;
            if (this.mapSvc.displayedVersion.peek() === version) return;
            untrack(() => {
                this.mapSvc.init(this.mapHost, mapKey, manifest, version);
                this.elevation.configure({ mapKey, zoom: manifest.layers.terrain.maxzoom, version });
            });
        }));

        // Add the read-only overlays once, bottom→top: features, plan, gps, tap.
        this.track(effect(() => {
            if (!this.mapSvc.ready.get()) return;
            untrack(() => {
                this.mapSvc.addOverlayLayer(FEATURES_OVERLAY_ID, this.features.data.peek() ?? emptyFc(), featureLayers());
                this.mapSvc.addOverlayLayer(PLAN_OVERLAY_ID, this.planData(), planLayers());
                this.mapSvc.addOverlayLayer(GPS_OVERLAY_ID, buildGpsGeojson(this.geo.fix.peek()), gpsLayers());
                this.mapSvc.addOverlayLayer(TAP_OVERLAY_ID, this.tapData(), tapLayers());
            });
        }));

        // Frame the hole tee→green whenever the hole (or its furniture) changes.
        this.track(effect(() => {
            if (!this.mapSvc.ready.get()) return;
            const hole = this.currentHole.get();
            if (!hole) return;
            const green = this.furniture.greenForHole(hole.id);
            const tee = this.furniture.lineOriginTee(hole.id);
            const teePt: LngLatPoint | null = tee ? { lng: tee.lon, lat: tee.lat } : null;
            const greenPt: LngLatPoint | null = green ? { lng: green.centerLon, lat: green.centerLat } : null;
            const frame = frameHole(teePt, greenPt);
            if (!frame.bbox) return;
            untrack(() => this.frameCamera(frame.bbox!, frame.bearingDeg ?? 0));
        }));

        // Overlay data — features / plan react to their own signals.
        this.track(effect(() => {
            const data = this.features.data.get() ?? emptyFc();
            if (this.mapSvc.ready.get()) this.mapSvc.updateOverlayData(FEATURES_OVERLAY_ID, data);
        }));
        this.track(effect(() => {
            const data = this.planData();
            if (this.mapSvc.ready.get()) this.mapSvc.updateOverlayData(PLAN_OVERLAY_ID, data);
        }));
        this.track(effect(() => {
            const data = this.tapData();
            if (this.mapSvc.ready.get()) this.mapSvc.updateOverlayData(TAP_OVERLAY_ID, data);
        }));

        // GPS overlay: coalesce the ~1 Hz tick into a microtask so the map
        // repaints once on the settled fix, never mid-cascade.
        this.track(effect(() => {
            this.geo.fix.get();
            this.scheduleGpsRefresh();
        }));

        // Tap-anywhere: set the point; the readout + overlay derive from it.
        this.track(this.mapSvc.onClick(({ lngLat }) => this.tapPoint.set({ lng: lngLat.lng, lat: lngLat.lat })));

        // Tap-a-shape edge figures: the front/carry numbers printed AT the two
        // measured play-line points — DOM markers (the map style has no glyphs
        // endpoint, so symbol text layers can't render). Two nodes, recreated
        // on change.
        this.track(effect(() => {
            const ready = this.mapSvc.ready.get();
            const raw = this.mapSvc.map.get();
            const readout = this.tapReadout.get();
            for (const m of this.tapEdgeMarkers) m.remove();
            this.tapEdgeMarkers = [];
            if (!ready || !raw || readout?.kind !== 'feature') return;
            // Nudge each figure a few meters outward along the ray (front
            // toward the player, carry past the far lip) so the two labels
            // never collide over a narrow shape.
            const frontP = wgs84ToSweref99tm(readout.frontPoint.lat, readout.frontPoint.lng);
            const carryP = wgs84ToSweref99tm(readout.carryPoint.lat, readout.carryPoint.lng);
            const dx = carryP.x - frontP.x;
            const dy = carryP.y - frontP.y;
            const len = Math.hypot(dx, dy);
            const nudge = 8;
            const ux = len > 1e-9 ? dx / len : 0;
            const uy = len > 1e-9 ? dy / len : 1;
            const toLngLat = (x: number, y: number): LngLatPoint => {
                const w = sweref99tmToWgs84(x, y);
                return { lng: w.lon, lat: w.lat };
            };
            const labels = [
                {
                    at: toLngLat(frontP.x - ux * nudge, frontP.y - uy * nudge),
                    text: String(Math.round(readout.frontM)),
                },
                {
                    at: toLngLat(carryP.x + ux * nudge, carryP.y + uy * nudge),
                    text: String(Math.round(readout.carryM)),
                },
            ];
            for (const l of labels) {
                const el = document.createElement('div');
                el.className = 'm-tap-edge-label';
                el.textContent = l.text;
                el.style.cssText = TAP_EDGE_LABEL_CSS;
                this.tapEdgeMarkers.push(
                    new maplibregl.Marker({ element: el, anchor: 'center', offset: [0, -14] })
                        .setLngLat([l.at.lng, l.at.lat]).addTo(raw),
                );
            }
        }));

        this.geo.start();
        this.wake.enable();

        // Teardown — $swap destroys this component on every navigation.
        // Untracked: this teardown runs inside the parent's $swap effect, and
        // MapService.destroy READS this.map. Tracked, that read would make the
        // router's swap effect a dependent of the map signals — the NEXT
        // screen's map.set(map) would then re-enter $swap mid-mount and remount
        // it recursively (two live maps over one container). See the same guard
        // on the green screen.
        this.track(() => untrack(() => {
            for (const m of this.tapEdgeMarkers) m.remove();
            this.tapEdgeMarkers = [];
            this.mapSvc.destroy();
            this.elevation.configure(null);
            this.geo.stop();
            this.wake.release();
        }));
    }

    private planData(): ReturnType<typeof buildPlanGeojson> {
        return buildPlanGeojson({
            plan: this.holePlan.get(),
            gates: [],
            selectedShotId: null,
            selectedGateId: null,
        });
    }

    private tapData(): ReturnType<typeof buildGpsGeojson> {
        const at = this.tapPoint.get();
        if (!at) return emptyFc();
        const features: ReturnType<typeof buildGpsGeojson>['features'] = [{
            type: 'Feature',
            properties: { role: 'tap' },
            geometry: { type: 'Point', coordinates: [at.lng, at.lat] },
        }];

        // Tap landed in a shape: highlight the ring, run the measuring line
        // GPS position → front edge → far edge, and print both figures at
        // the edge points they measure to.
        const readout = this.tapReadout.get();
        const fix = this.geo.fix.get();
        if (readout?.kind === 'feature' && fix) {
            const ringCoords = readout.ring.map(p => [p.lng, p.lat] as [number, number]);
            if (ringCoords.length >= 3) {
                ringCoords.push(ringCoords[0]);
                features.unshift({
                    type: 'Feature',
                    properties: { role: 'ring' },
                    geometry: { type: 'Polygon', coordinates: [ringCoords] },
                });
            }
            features.unshift({
                type: 'Feature',
                properties: { role: 'line' },
                geometry: {
                    type: 'LineString',
                    // The ray from the GPS position through the shape to its
                    // far lip (the front point lies on it).
                    coordinates: [
                        [fix.lng, fix.lat],
                        [readout.carryPoint.lng, readout.carryPoint.lat],
                    ],
                },
            });
            features.push({
                type: 'Feature',
                properties: { role: 'edge', label: String(Math.round(readout.frontM)) },
                geometry: { type: 'Point', coordinates: [readout.frontPoint.lng, readout.frontPoint.lat] },
            });
            features.push({
                type: 'Feature',
                properties: { role: 'edge', label: String(Math.round(readout.carryM)) },
                geometry: { type: 'Point', coordinates: [readout.carryPoint.lng, readout.carryPoint.lat] },
            });
        }
        return { type: 'FeatureCollection', features };
    }

    private scheduleGpsRefresh(): void {
        if (this.gpsRefreshScheduled) return;
        this.gpsRefreshScheduled = true;
        queueMicrotask(() => {
            this.gpsRefreshScheduled = false;
            if (this.mapSvc.ready.peek()) {
                this.mapSvc.updateOverlayData(GPS_OVERLAY_ID, buildGpsGeojson(this.geo.fix.peek()));
            }
        });
    }

    private frameCamera(bbox: [number, number, number, number], bearingDeg: number): void {
        const map = this.mapSvc.map.peek();
        if (!map) return;
        const [w, s, e, n] = bbox;
        if (w === e && s === n) {
            map.flyTo({ center: [w, s], zoom: 17, bearing: bearingDeg, duration: 600 });
            return;
        }
        map.fitBounds([[w, s], [e, n]], {
            bearing: bearingDeg,
            padding: { top: 96, bottom: SHEET_PADDING_PX, left: 40, right: 40 },
            maxZoom: 18,
            duration: 600,
        });
    }
}

function emptyFc(): ReturnType<typeof buildGpsGeojson> {
    return { type: 'FeatureCollection', features: [] };
}

/**
 * Read-only surface fills + outlines (colours by feature `type`). Both layers
 * carry the type z-order as a MapLibre sort key, so overlapping surfaces stack
 * the way they do in the desktop editor (bunkers and water over fairway, not in
 * arbitrary GeoJSON order) without needing a layer per type.
 */
function featureLayers(): OverlayLayerSpec[] {
    const sortKey = typeSortKeyExpression();
    return [
        {
            id: `${FEATURES_OVERLAY_ID}-fill`,
            type: 'fill',
            layout: { 'fill-sort-key': sortKey as never },
            paint: { 'fill-color': fillColorExpression() as never, 'fill-opacity': 0.5 },
        },
        {
            id: `${FEATURES_OVERLAY_ID}-outline`,
            type: 'line',
            layout: { 'line-sort-key': sortKey as never },
            paint: { 'line-color': outlineColorExpression() as never, 'line-width': 1, 'line-opacity': 0.7 },
        },
    ];
}

/**
 * The tap-anywhere marker (a single accent dot), plus the tap-a-shape
 * feedback: an accent wash + outline on the tapped ring, the measuring line
 * from the GPS position through the near edge to the far edge, and the two
 * edge markers labelled with the front/carry figures.
 */
function tapLayers(): OverlayLayerSpec[] {
    return [
        {
            id: `${TAP_OVERLAY_ID}-ring-fill`,
            type: 'fill',
            filter: ['==', ['get', 'role'], 'ring'],
            paint: { 'fill-color': '#BF6A3E', 'fill-opacity': 0.18 },
        },
        {
            id: `${TAP_OVERLAY_ID}-ring-outline`,
            type: 'line',
            filter: ['==', ['get', 'role'], 'ring'],
            layout: { 'line-join': 'round' },
            paint: { 'line-color': '#BF6A3E', 'line-width': 2.5, 'line-opacity': 0.95 },
        },
        {
            id: `${TAP_OVERLAY_ID}-line`,
            type: 'line',
            filter: ['==', ['get', 'role'], 'line'],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
                'line-color': '#BF6A3E',
                'line-width': 2,
                'line-opacity': 0.9,
                'line-dasharray': [2, 1.5] as never,
            },
        },
        {
            id: `${TAP_OVERLAY_ID}-dot`,
            type: 'circle',
            filter: ['==', ['get', 'role'], 'tap'],
            paint: {
                'circle-radius': 6,
                'circle-color': '#BF6A3E',
                'circle-stroke-color': '#FFFFFF',
                'circle-stroke-width': 2,
            },
        },
        {
            id: `${TAP_OVERLAY_ID}-edge`,
            type: 'circle',
            filter: ['==', ['get', 'role'], 'edge'],
            paint: {
                'circle-radius': 5,
                'circle-color': '#BF6A3E',
                'circle-stroke-color': '#FFFFFF',
                'circle-stroke-width': 2,
            },
        },
        // The edge figures themselves are DOM markers (the map style has no
        // glyphs endpoint, so symbol text layers can't render) — see the
        // tap-edge label effect in onMount().
    ];
}

/**
 * Inline style for a tap-edge figure ("96" / "112") DOM marker — tap-accent
 * pill, mirroring the desktop planner's edge labels.
 */
const TAP_EDGE_LABEL_CSS = 'font: 600 12px/1.3 system-ui, sans-serif;'
    + ' padding: 1px 6px; border-radius: 6px; pointer-events: none;'
    + ' white-space: nowrap; background: rgba(191, 106, 62, 0.94); color: #fff;';
