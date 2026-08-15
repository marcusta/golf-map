import { Component, Signal, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s } from '../css';
import { icon } from '../ui/icons';
import { smoothProfile, type ProfileSample } from './elevation-profile';
import { ElevationProfileService, type ProfileMarker } from './elevation-profile.service';
import { measureRange, type RangeMeasure } from './profile-measure';

// Chart geometry, tuned to the right ctx-dock's fixed 268px column minus the
// hosting section's space-4 interior padding on each side: 268 − 2×16. Fixed
// pixel dims let the vertical-exaggeration cap work in real pixel/meter
// ratios (like the iOS sheet does from its plot frame).
const CHART_W = 236;
const CHART_H = 150;
const MARGIN = { top: 16, right: 6, bottom: 16, left: 34 };

// Larger margins for the expanded-overlay chart (bigger tick/marker type).
const MARGIN_LG = { top: 26, right: 14, bottom: 28, left: 52 };

// Max (px per vertical metre) / (px per horizontal metre). Without a cap the
// y-axis auto-fills the plot and a +4 m hole renders like a cliff (~28×);
// capping keeps perceived steepness comparable across holes. Matches iOS
// `ElevationProfileSheet.maxVerticalExaggeration`.
const MAX_VERTICAL_EXAGGERATION = 10;

// Narrowest zoom window (m) in the expanded overlay.
const MIN_WINDOW_M = 40;

/** Optional chart geometry/viewport override (default: the sidebar chart). */
export interface ChartView {
    w: number;
    h: number;
    /** Visible x window (m along the path); default the whole path. */
    window?: { x0: number; x1: number } | null;
    /** Drag-measured x range (m along the path) to highlight. */
    selection?: { x0: number; x1: number } | null;
}

const tpl = template(`
    <div class="elev-profile" bind="root" data-testid="elevation-profile">
        <div bind="stats" class="elev-profile__stats" data-testid="elevation-profile-stats"></div>
        <div bind="chartWrap" class="elev-profile__chartwrap">
            <svg bind="chart" class="elev-profile__chart" data-testid="elevation-profile-chart"
                width="${CHART_W}" height="${CHART_H}"
                viewBox="0 0 ${CHART_W} ${CHART_H}" xmlns="http://www.w3.org/2000/svg"></svg>
            <button bind="expand" type="button" class="elev-profile__expand"
                aria-label="Expand elevation profile" title="Expand"
                data-testid="elevation-profile-expand"></button>
        </div>
        <div bind="empty" class="elev-profile__empty" data-testid="elevation-profile-empty"></div>
    </div>
`);

/**
 * Side cross-section of the terrain along the hosted path (the planner's
 * tee→shots→green hole route), drawn as an inline SVG. Web port of the iOS
 * elevation-profile sheet (ios/GolfMap/Profile/ElevationProfileSheet.swift):
 * both axes carry real metre tick labels; the y-axis auto-scales to the data
 * but the vertical exaggeration is capped so flat holes don't render like
 * cliffs. The drawn curve is smoothed with a short moving average (offline
 * terrain tiles quantize elevation to 0.1 m, which stair-steps at a 2 m
 * sample interval); every printed number (total Δ, per-leg Δ, axis ticks,
 * marker dots) stays raw. Reads the ElevationProfileService DI singleton;
 * the hosting panel feeds it the path.
 *
 * The sidebar chart is a fixed small overview; the expand button opens a
 * large modal overlay (appended to <body>, above the docks) with wheel-zoom
 * and drag-pan — the y-axis rescales to the visible stretch (same cap), so
 * zooming into part of the hole makes its bumps readable.
 */
export class ElevationProfileComponent extends Component {
    static styles = `
        .elev-profile {
            display: flex;
            flex-direction: column;
            gap: ${s('sm')};

            & .elev-profile__stats {
                display: none;
                flex-wrap: wrap;
                gap: ${s('xs')};
                &.show { display: flex; }
            }
            & .elev-chip {
                display: inline-flex;
                align-items: baseline;
                gap: 4px;
                padding: 2px ${s('xs')};
                border-radius: 999px;
                background: ${t('color-surface-sunken')};
                border: 1px solid ${t('color-border-default')};
                font-size: 0.68rem;
                color: ${t('color-text-secondary')};
                & b {
                    font-family: var(--font-mono);
                    font-variant-numeric: tabular-nums;
                    color: ${t('color-text-primary')};
                }
            }
            & .elev-chip--total b { color: var(--map-shot-line); }

            & .elev-profile__chartwrap {
                position: relative;
                display: none;
                &.show { display: block; }
            }

            & .elev-profile__chart {
                display: block;
                max-width: 100%;
                height: auto;
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius-sm')};
                background: ${t('color-surface-card')};
            }

            & .elev-profile__expand {
                position: absolute;
                top: 4px;
                right: 4px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 22px;
                height: 22px;
                padding: 0;
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius-sm')};
                background: ${t('color-surface-card')};
                color: ${t('color-text-secondary')};
                cursor: pointer;
                opacity: 0.75;
                &:hover { opacity: 1; color: ${t('color-text-primary')}; }
            }

            & .elev-profile__empty {
                display: none;
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
                &.show { display: block; }
            }
        }

        /* Expanded overlay — appended to <body>, above docks (confirm-dialog
           sits at the same app-modal tier). */
        .elev-expanded {
            position: fixed;
            inset: 0;
            z-index: 1000;
            display: flex;
            align-items: center;
            justify-content: center;
            background: ${t('overlay-scrim')};
            backdrop-filter: blur(4px);
            -webkit-backdrop-filter: blur(4px);
            color: ${t('color-text-primary')};

            & .elev-expanded__card {
                display: flex;
                flex-direction: column;
                gap: ${s('sm')};
                padding: ${s('lg')};
                border: 1px solid ${t('color-border-subtle')};
                border-radius: var(--radius-lg);
                background: ${t('color-surface-card')};
                box-shadow: var(--elev-3);
                max-width: calc(100vw - 48px);
            }

            & .elev-expanded__header {
                display: flex;
                align-items: center;
                gap: ${s('sm')};
            }
            & .elev-expanded__title {
                font-size: 0.86rem;
                font-weight: 700;
                margin-right: auto;
            }
            & .elev-expanded__zoom {
                display: inline-flex;
                gap: ${s('xs')};
            }
            & .elev-expanded__zoom button,
            & .elev-expanded__close {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 4px;
                height: 26px;
                min-width: 26px;
                padding: 0 6px;
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius-sm')};
                background: ${t('color-surface-card')};
                color: ${t('color-text-secondary')};
                font: inherit;
                font-size: 0.72rem;
                cursor: pointer;
                &:hover { background: ${t('color-surface-sunken')}; color: ${t('color-text-primary')}; }
            }

            & .elev-expanded__stats,
            & .elev-expanded__measure {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: ${s('xs')};
            }
            & .elev-expanded__measure {
                min-height: 22px;
                font-size: 0.72rem;
                color: ${t('color-text-tertiary')};
            }
            & .elev-chip {
                display: inline-flex;
                align-items: baseline;
                gap: 4px;
                padding: 2px ${s('xs')};
                border-radius: 999px;
                background: ${t('color-surface-sunken')};
                border: 1px solid ${t('color-border-default')};
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
                & b {
                    font-family: var(--font-mono);
                    font-variant-numeric: tabular-nums;
                    color: ${t('color-text-primary')};
                }
            }
            & .elev-chip--total b { color: var(--map-shot-line); }

            & .elev-expanded__chart {
                display: block;
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius-sm')};
                background: ${t('color-surface-card')};
                cursor: grab;
                touch-action: none;
                &.is-panning { cursor: grabbing; }
            }

            & .elev-expanded__hint {
                font-size: 0.68rem;
                color: ${t('color-text-tertiary')};
            }
        }
    `;

    private profile = this.inject(ElevationProfileService);
    private overlayEl: HTMLElement | null = null;
    private closeOverlay: (() => void) | null = null;

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            expand: { onclick: () => this.openExpanded() },
        });
        const stats = this.ref(frag, 'stats');
        const chartWrap = this.ref(frag, 'chartWrap');
        const chart = this.ref(frag, 'chart');
        const empty = this.ref(frag, 'empty');
        this.ref(frag, 'expand').innerHTML = icon('maximize-2', 16);

        this.track(effect(() => {
            const samples = this.profile.samples.get();
            const markers = this.profile.markers.get();
            const range = this.profile.elevationRange.get();
            const loading = this.profile.loading.get();
            const totalDistance = this.profile.totalDistance.get();
            const totalDelta = this.profile.totalDelta.get();
            const legDeltas = this.profile.legDeltas.get();
            const path = this.profile.path.get();

            const hasData = range !== null && samples.length >= 2;
            if (!hasData) {
                stats.className = 'elev-profile__stats';
                chartWrap.className = 'elev-profile__chartwrap';
                empty.className = 'elev-profile__empty show';
                empty.textContent = loading
                    ? 'Sampling terrain…'
                    : path.length < 2
                        ? 'No route on this hole to profile.'
                        : 'No terrain data along this line.';
                return;
            }

            empty.className = 'elev-profile__empty';
            stats.className = 'elev-profile__stats show';
            stats.innerHTML = statsHtml(totalDelta, legDeltas, markers);
            chartWrap.className = 'elev-profile__chartwrap show';
            chart.innerHTML = chartSvg(samples, markers, range, totalDistance);
        }));

        this.track(() => this.closeOverlay?.());
        return frag;
    }

    // ── Expanded overlay (large chart + zoom/pan) ─────────────────────────

    private openExpanded(): void {
        if (this.overlayEl) return;

        // Chart pixel size, fixed at open time (the SVG coordinate space —
        // rendered 1:1, so pointer offsets are chart pixels).
        const W = Math.max(560, Math.min(1100, window.innerWidth - 96));
        const H = Math.max(280, Math.min(480, window.innerHeight - 240));
        const plotW = W - MARGIN_LG.left - MARGIN_LG.right;

        const overlay = document.createElement('div');
        overlay.className = 'elev-expanded';
        overlay.innerHTML = `
            <section class="elev-expanded__card" role="dialog" aria-modal="true" aria-label="Elevation profile">
                <header class="elev-expanded__header">
                    <span class="elev-expanded__title">Elevation profile</span>
                    <span class="elev-expanded__zoom">
                        <button type="button" data-zoom="out" aria-label="Zoom out">${icon('zoom-out', 16)}</button>
                        <button type="button" data-zoom="in" aria-label="Zoom in">${icon('zoom-in', 16)}</button>
                        <button type="button" data-zoom="reset">Reset</button>
                    </span>
                    <button type="button" class="elev-expanded__close" aria-label="Close">${icon('x', 16)}</button>
                </header>
                <div class="elev-expanded__stats"></div>
                <svg class="elev-expanded__chart" width="${W}" height="${H}"
                    viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"></svg>
                <div class="elev-expanded__measure" data-testid="elevation-profile-measure"></div>
                <div class="elev-expanded__hint">Drag to measure a stretch · scroll to zoom · shift-scroll or trackpad to pan · double-click to reset</div>
            </section>`;
        document.body.appendChild(overlay);
        this.overlayEl = overlay;

        const statsEl = overlay.querySelector<HTMLElement>('.elev-expanded__stats')!;
        const measureEl = overlay.querySelector<HTMLElement>('.elev-expanded__measure')!;
        const svg = overlay.querySelector<SVGSVGElement>('.elev-expanded__chart')!;

        // Visible x window (m); null = whole path.
        const win = new Signal<{ x0: number; x1: number } | null>(null);
        // Drag-measured x range (m); null = no selection.
        const selection = new Signal<{ x0: number; x1: number } | null>(null);

        const total = () => Math.max(this.profile.totalDistance.peek(), 1);
        const currentWin = () => win.peek() ?? { x0: 0, x1: total() };

        const setWindow = (x0: number, span: number): void => {
            const tot = total();
            if (span >= tot) { win.set(null); return; }
            const clamped = Math.min(Math.max(0, x0), tot - span);
            win.set({ x0: clamped, x1: clamped + span });
        };

        /** Zoom by `factor` (<1 in, >1 out) around path distance `focus`. */
        const zoom = (factor: number, focus?: number): void => {
            const cur = currentWin();
            const span = cur.x1 - cur.x0;
            const newSpan = Math.min(total(), Math.max(MIN_WINDOW_M, span * factor));
            const f = focus ?? (cur.x0 + cur.x1) / 2;
            const frac = span > 0 ? (f - cur.x0) / span : 0.5;
            setWindow(f - frac * newSpan, newSpan);
        };

        /** Path distance (m) under a pointer offsetX, clamped to the window. */
        const distAt = (offsetX: number): number => {
            const cur = currentWin();
            const span = cur.x1 - cur.x0;
            return cur.x0
                + (Math.min(Math.max(offsetX - MARGIN_LG.left, 0), plotW) / plotW) * span;
        };

        // Wheel: vertical = zoom around the cursor; horizontal (trackpad or
        // shift-scroll) = pan the zoomed window.
        svg.addEventListener('wheel', (e: WheelEvent) => {
            e.preventDefault();
            const cur = currentWin();
            const span = cur.x1 - cur.x0;
            if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
                const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
                setWindow(cur.x0 + (delta * span) / plotW, span);
                return;
            }
            zoom(e.deltaY > 0 ? 1.25 : 0.8, distAt(e.offsetX));
        }, { passive: false });

        svg.addEventListener('dblclick', () => {
            selection.set(null);
            win.set(null);
        });

        // Drag to measure a stretch (distance / Δelev / plays-like readout).
        let dragStart: { px: number; d: number } | null = null;
        svg.addEventListener('pointerdown', (e: PointerEvent) => {
            svg.setPointerCapture(e.pointerId);
            dragStart = { px: e.clientX, d: distAt(e.offsetX) };
        });
        svg.addEventListener('pointermove', (e: PointerEvent) => {
            if (!dragStart) return;
            if (Math.abs(e.clientX - dragStart.px) < 3) return;
            selection.set({ x0: dragStart.d, x1: distAt(e.offsetX) });
        });
        const endDrag = (e: PointerEvent) => {
            if (dragStart && Math.abs(e.clientX - dragStart.px) < 3) {
                selection.set(null); // a plain click clears the measure
            }
            dragStart = null;
        };
        svg.addEventListener('pointerup', endDrag);
        svg.addEventListener('pointercancel', endDrag);

        overlay.querySelectorAll<HTMLButtonElement>('[data-zoom]').forEach(btn => {
            btn.onclick = () => {
                const mode = btn.dataset.zoom;
                if (mode === 'reset') {
                    selection.set(null);
                    win.set(null);
                } else {
                    zoom(mode === 'in' ? 0.6 : 1 / 0.6);
                }
            };
        });

        let disposeRender: (() => void) | null = null;
        const close = () => {
            window.removeEventListener('keydown', onKeyDown);
            disposeRender?.();
            disposeRender = null;
            overlay.remove();
            this.overlayEl = null;
            this.closeOverlay = null;
        };
        this.closeOverlay = close;

        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            close();
        };
        window.addEventListener('keydown', onKeyDown);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close();
        });
        overlay.querySelector<HTMLButtonElement>('.elev-expanded__close')!.onclick = close;

        disposeRender = effect(() => {
            const samples = this.profile.samples.get();
            const markers = this.profile.markers.get();
            const range = this.profile.elevationRange.get();
            const totalDistance = this.profile.totalDistance.get();
            const window_ = win.get();
            const sel = selection.get();
            const wind = this.profile.wind.get();
            if (range === null || samples.length < 2) {
                // The route lost its data while expanded — close, but never
                // dispose this effect from inside its own run.
                queueMicrotask(close);
                return;
            }
            statsEl.innerHTML = statsHtml(
                this.profile.totalDelta.peek(),
                this.profile.legDeltas.peek(),
                [...markers],
            );
            const measure = sel && Math.abs(sel.x1 - sel.x0) >= 1
                ? measureRange(samples, this.profile.path.peek(), wind, sel.x0, sel.x1)
                : null;
            measureEl.innerHTML = measureHtml(measure, wind !== null);
            svg.innerHTML = chartSvg(samples, markers, range, totalDistance, {
                w: W, h: H, window: window_, selection: sel,
            });
        });
    }
}

// ── Rendering (pure string builders — exported for unit tests) ────────────

function esc(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Signed metres with one decimal, minus sign typographic (matches iOS). */
export function signedMeters(value: number | null): string {
    if (value === null) return '—';
    const sign = value >= 0 ? '+' : '−';
    return `${sign}${Math.abs(value).toFixed(1)} m`;
}

export function statsHtml(
    totalDelta: number | null,
    legDeltas: Array<{ label: string; delta: number | null }>,
    markers: ProfileMarker[],
): string {
    const first = markers[0];
    const last = markers[markers.length - 1];
    const totalLabel = first && last && first.label !== last.label
        ? `Δ ${esc(last.label)}−${esc(first.label)}`
        : 'Total Δ';
    const chips = [
        `<span class="elev-chip elev-chip--total">${totalLabel} <b>${signedMeters(totalDelta)}</b></span>`,
    ];
    // Per-leg chips only add information on multi-leg routes.
    if (legDeltas.length > 1) {
        for (const leg of legDeltas) {
            chips.push(`<span class="elev-chip">${esc(leg.label)} <b>${signedMeters(leg.delta)}</b></span>`);
        }
    }
    return chips.join('');
}

/**
 * Readout for a drag-measured stretch: actual distance, plays-like, and the
 * elevation / wind contributions to it (iOS card composition — see
 * profile-measure.ts). `windActive` distinguishes calm-by-choice from
 * no-wind-set.
 */
export function measureHtml(measure: RangeMeasure | null, windActive: boolean): string {
    if (!measure) return 'Drag on the chart to measure a stretch.';
    const chips = [
        `<span class="elev-chip">Distance <b>${Math.round(measure.distanceM)} m</b></span>`,
        `<span class="elev-chip elev-chip--total">Plays like <b>${Math.round(measure.playsLikeM)} m</b></span>`,
        `<span class="elev-chip">Δ elev <b>${signedMeters(measure.elevationDeltaM)}</b></span>`,
    ];
    if (measure.windAdjM !== null) {
        chips.push(`<span class="elev-chip">wind <b>${signedMeters(measure.windAdjM)}</b></span>`);
    } else if (!windActive) {
        chips.push('<span>no wind set</span>');
    }
    return chips.join('');
}

/**
 * Y domain from the RAW range with a little headroom, then widened (equally
 * on both sides) until the vertical exaggeration stays under the cap for the
 * given plot geometry (iOS parity). `xSpan` is the VISIBLE distance span —
 * zooming in shrinks it, which relaxes the minimum y-span and lets bumps
 * grow.
 */
function yDomain(
    range: { min: number; max: number },
    xSpan: number,
    plotW: number,
    plotH: number,
): { min: number; max: number } {
    const pad = Math.max(0.5, (range.max - range.min) * 0.15);
    let min = range.min - pad;
    let max = range.max + pad;
    const minSpan = (Math.max(xSpan, 1) * (plotH / plotW)) / MAX_VERTICAL_EXAGGERATION;
    if (max - min < minSpan) {
        const center = (min + max) / 2;
        min = center - minSpan / 2;
        max = center + minSpan / 2;
    }
    return { min, max };
}

/** 1/2/5×10^k step giving roughly `target` ticks over `span`. */
function niceStep(span: number, target: number): number {
    const raw = span / Math.max(target, 1);
    const mag = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
    for (const m of [1, 2, 5, 10]) {
        if (mag * m >= raw) return mag * m;
    }
    return mag * 10;
}

/** Contiguous runs of non-null samples (null coverage → visible gap). */
function elevationRuns(samples: readonly ProfileSample[]): ProfileSample[][] {
    const runs: ProfileSample[][] = [];
    let current: ProfileSample[] = [];
    for (const sample of samples) {
        if (sample.elevation !== null) {
            current.push(sample);
        } else if (current.length > 0) {
            runs.push(current);
            current = [];
        }
    }
    if (current.length > 0) runs.push(current);
    return runs;
}

export function chartSvg(
    rawSamples: readonly ProfileSample[],
    markers: readonly ProfileMarker[],
    range: { min: number; max: number },
    totalDistance: number,
    view?: ChartView,
): string {
    const W = view?.w ?? CHART_W;
    const H = view?.h ?? CHART_H;
    const big = W >= 400;
    const M = big ? MARGIN_LG : MARGIN;
    const plotW = W - M.left - M.right;
    const plotH = H - M.top - M.bottom;

    // Visible x window (default: the whole path).
    const total = Math.max(totalDistance, 1);
    const x0 = Math.max(0, view?.window?.x0 ?? 0);
    const x1 = Math.min(total, view?.window?.x1 ?? total);
    const xSpan = Math.max(x1 - x0, 1);
    const windowed = x0 > 0 || x1 < total;

    // When zoomed, the y domain follows the RAW range of the visible stretch
    // (falls back to the full-path range if the window has no coverage).
    let visibleRange = range;
    if (windowed) {
        let lo = Infinity;
        let hi = -Infinity;
        for (const sample of rawSamples) {
            if (sample.elevation === null) continue;
            if (sample.distance < x0 || sample.distance > x1) continue;
            if (sample.elevation < lo) lo = sample.elevation;
            if (sample.elevation > hi) hi = sample.elevation;
        }
        if (lo <= hi) visibleRange = { min: lo, max: hi };
    }

    const dom = yDomain(visibleRange, xSpan, plotW, plotH);
    const ySpan = dom.max - dom.min;
    const x = (d: number) => M.left + ((d - x0) / xSpan) * plotW;
    const y = (e: number) => M.top + (1 - (e - dom.min) / ySpan) * plotH;
    const baseY = M.top + plotH;
    const fmt = (v: number) => v.toFixed(1);
    const gid = big ? 'elev-area-lg' : 'elev-area';

    const parts: string[] = [];

    // Gradient def for the area fill (amber → transparent, iOS parity).
    parts.push(
        `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">`
        + '<stop offset="0" stop-color="var(--map-shot-line)" stop-opacity="0.35"/>'
        + '<stop offset="1" stop-color="var(--map-shot-line)" stop-opacity="0.05"/>'
        + '</linearGradient></defs>',
    );

    // Y grid + tick labels (elevation is always metric — see iOS sheet doc).
    const yStep = niceStep(ySpan, big ? 6 : 4);
    const yDecimals = ySpan < 8 ? 1 : 0;
    const tickDy = big ? 3.5 : 2.5;
    for (let v = Math.ceil(dom.min / yStep) * yStep; v <= dom.max + 1e-9; v += yStep) {
        const py = y(v);
        parts.push(
            `<line x1="${M.left}" y1="${fmt(py)}" x2="${M.left + plotW}" y2="${fmt(py)}" class="grid"/>`,
            `<text x="${M.left - 5}" y="${fmt(py + tickDy)}" class="tick tick--y">${v.toFixed(yDecimals)} m</text>`,
        );
    }

    // X grid + tick labels (the window edges stay implicit).
    const xStep = niceStep(xSpan, big ? 8 : 4);
    for (let v = Math.ceil(x0 / xStep) * xStep; v < x1 - xStep / 4; v += xStep) {
        if (v <= x0 + xStep / 4) continue;
        const px = x(v);
        parts.push(
            `<line x1="${fmt(px)}" y1="${M.top}" x2="${fmt(px)}" y2="${baseY}" class="grid"/>`,
            `<text x="${fmt(px)}" y="${H - (big ? 8 : 4)}" class="tick tick--x">${Math.round(v)} m</text>`,
        );
    }

    // Smoothed area + line per contiguous run (gaps stay gaps), clipped to
    // the visible window.
    const visible = windowed
        ? rawSamples.filter(p => p.distance >= x0 && p.distance <= x1)
        : rawSamples;
    for (const run of elevationRuns(smoothProfile([...visible]))) {
        if (run.length < 2) continue;
        const pts = run.map(p => `${fmt(x(p.distance))},${fmt(y(p.elevation!))}`);
        const area = `M${pts[0]} L${pts.slice(1).join(' L')} `
            + `L${fmt(x(run[run.length - 1].distance))},${baseY} L${fmt(x(run[0].distance))},${baseY} Z`;
        parts.push(
            `<path d="${area}" fill="url(#${gid})" stroke="none"/>`,
            `<polyline points="${pts.join(' ')}" class="curve"/>`,
        );
    }

    // Drag-measure selection highlight (clipped to the visible window).
    const sel = view?.selection;
    if (sel) {
        const s0 = Math.max(Math.min(sel.x0, sel.x1), x0);
        const s1 = Math.min(Math.max(sel.x0, sel.x1), x1);
        if (s1 > s0) {
            const px0 = x(s0);
            const px1 = x(s1);
            parts.push(
                `<rect x="${fmt(px0)}" y="${M.top}" width="${fmt(px1 - px0)}" height="${plotH}" class="sel"/>`,
                `<line x1="${fmt(px0)}" y1="${M.top}" x2="${fmt(px0)}" y2="${baseY}" class="sel-edge"/>`,
                `<line x1="${fmt(px1)}" y1="${M.top}" x2="${fmt(px1)}" y2="${baseY}" class="sel-edge"/>`,
            );
        }
    }

    // Labelled verticals at the path vertices inside the window, with the
    // RAW vertex elevation dot when it resolved.
    for (const marker of markers) {
        if (marker.distance < x0 || marker.distance > x1) continue;
        const px = x(marker.distance);
        // Clamp the label so edge markers (Tee/Green) stay inside the SVG.
        const labelX = Math.min(Math.max(px, M.left + 10), M.left + plotW - 10);
        parts.push(
            `<line x1="${fmt(px)}" y1="${M.top}" x2="${fmt(px)}" y2="${baseY}" class="rule"/>`,
            `<text x="${fmt(labelX)}" y="${M.top - 5}" class="marker-label">${esc(marker.label)}</text>`,
        );
        if (marker.elevation !== null) {
            parts.push(`<circle cx="${fmt(px)}" cy="${fmt(y(marker.elevation))}" r="${big ? 4 : 3}" class="dot"/>`);
        }
    }

    // Scoped presentation — inline so the string is self-contained (an SVG
    // <style> only reaches this chart's elements).
    parts.push(`<style>
        .grid { stroke: ${t('color-border-default')}; stroke-width: 0.5; }
        .rule { stroke: ${t('color-border-default')}; stroke-width: 1; stroke-dasharray: 3 3; }
        .curve { fill: none; stroke: var(--map-shot-line); stroke-width: ${big ? 2.5 : 2};
            stroke-linecap: round; stroke-linejoin: round; }
        .dot { fill: ${t('color-text-primary')}; stroke: ${t('color-surface-card')}; stroke-width: 1; }
        .sel { fill: var(--map-shot-line); fill-opacity: 0.12; }
        .sel-edge { stroke: var(--map-shot-line); stroke-width: 1.5; stroke-dasharray: 4 3; }
        .tick { fill: ${t('color-text-secondary')}; font-size: ${big ? 11 : 7.5}px;
            font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
        .tick--y { text-anchor: end; }
        .tick--x { text-anchor: middle; }
        .marker-label { fill: ${t('color-text-secondary')}; font-size: ${big ? 12 : 8}px;
            font-weight: 600; text-anchor: middle; }
    </style>`);

    return parts.join('');
}
