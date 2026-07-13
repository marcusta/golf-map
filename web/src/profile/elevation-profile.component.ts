import { Component, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s } from '../css';
import { smoothProfile, type ProfileSample } from './elevation-profile';
import { ElevationProfileService, type ProfileMarker } from './elevation-profile.service';

// Chart geometry, tuned to the right ctx-dock's fixed 268px column minus the
// hosting section's space-4 interior padding on each side: 268 − 2×16. Fixed
// pixel dims keep the vertical-exaggeration caption honest (computed from
// these actual pixel/meter ratios, like the iOS sheet does from its plot
// frame).
const CHART_W = 236;
const CHART_H = 150;
const MARGIN = { top: 16, right: 6, bottom: 16, left: 34 };
const PLOT_W = CHART_W - MARGIN.left - MARGIN.right;
const PLOT_H = CHART_H - MARGIN.top - MARGIN.bottom;

const tpl = template(`
    <div class="elev-profile" bind="root" data-testid="elevation-profile">
        <div bind="stats" class="elev-profile__stats" data-testid="elevation-profile-stats"></div>
        <svg bind="chart" class="elev-profile__chart" width="${CHART_W}" height="${CHART_H}"
            viewBox="0 0 ${CHART_W} ${CHART_H}" xmlns="http://www.w3.org/2000/svg"></svg>
        <div bind="caption" class="elev-profile__caption"></div>
        <div bind="empty" class="elev-profile__empty" data-testid="elevation-profile-empty"></div>
    </div>
`);

/**
 * Side cross-section of the terrain along the hosted path (the planner's
 * tee→shots→green hole route), drawn as an inline SVG. Web port of the iOS
 * elevation-profile sheet (ios/GolfMap/Profile/ElevationProfileSheet.swift):
 * both axes carry real metre tick labels; the y-axis auto-scales to fill the
 * plot and the resulting vertical exaggeration is printed as an honest
 * caption. The drawn curve is smoothed with a short moving average (offline
 * terrain tiles quantize elevation to 0.1 m, which stair-steps at a 2 m
 * sample interval); every printed number (total Δ, per-leg Δ, axis ticks,
 * marker dots) stays raw. Reads the ElevationProfileService DI singleton;
 * the hosting panel feeds it the path.
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

            & .elev-profile__chart {
                display: none;
                max-width: 100%;
                height: auto;
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius-sm')};
                background: ${t('color-surface-card')};
                &.show { display: block; }
            }

            & .elev-profile__caption {
                display: none;
                font-size: 0.65rem;
                line-height: 1.4;
                color: ${t('color-text-tertiary')};
                &.show { display: block; }
            }

            & .elev-profile__empty {
                display: none;
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
                &.show { display: block; }
            }
        }
    `;

    private profile = this.inject(ElevationProfileService);

    render(): DocumentFragment {
        const frag = this.wire(tpl, {});
        const stats = this.ref(frag, 'stats');
        const chart = this.ref(frag, 'chart');
        const caption = this.ref(frag, 'caption');
        const empty = this.ref(frag, 'empty');

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
                chart.setAttribute('class', 'elev-profile__chart');
                caption.className = 'elev-profile__caption';
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
            chart.setAttribute('class', 'elev-profile__chart show');
            chart.innerHTML = chartSvg(samples, markers, range, totalDistance);
            caption.className = 'elev-profile__caption show';
            caption.textContent = captionText(range, totalDistance);
        }));

        return frag;
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

/** Y domain from the RAW range with a little headroom (iOS parity). */
function yDomain(range: { min: number; max: number }): { min: number; max: number } {
    const pad = Math.max(0.5, (range.max - range.min) * 0.15);
    return { min: range.min - pad, max: range.max + pad };
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
): string {
    const dom = yDomain(range);
    const ySpan = dom.max - dom.min;
    const xSpan = Math.max(totalDistance, 1);
    const x = (d: number) => MARGIN.left + (d / xSpan) * PLOT_W;
    const y = (e: number) => MARGIN.top + (1 - (e - dom.min) / ySpan) * PLOT_H;
    const baseY = MARGIN.top + PLOT_H;
    const fmt = (v: number) => v.toFixed(1);

    const parts: string[] = [];

    // Gradient def for the area fill (amber → transparent, iOS parity).
    parts.push(
        '<defs><linearGradient id="elev-area" x1="0" y1="0" x2="0" y2="1">'
        + '<stop offset="0" stop-color="var(--map-shot-line)" stop-opacity="0.35"/>'
        + '<stop offset="1" stop-color="var(--map-shot-line)" stop-opacity="0.05"/>'
        + '</linearGradient></defs>',
    );

    // Y grid + tick labels (elevation is always metric — see iOS sheet doc).
    const yStep = niceStep(ySpan, 4);
    const yDecimals = ySpan < 8 ? 1 : 0;
    for (let v = Math.ceil(dom.min / yStep) * yStep; v <= dom.max + 1e-9; v += yStep) {
        const py = y(v);
        parts.push(
            `<line x1="${MARGIN.left}" y1="${fmt(py)}" x2="${MARGIN.left + PLOT_W}" y2="${fmt(py)}" class="grid"/>`,
            `<text x="${MARGIN.left - 4}" y="${fmt(py + 2.5)}" class="tick tick--y">${v.toFixed(yDecimals)} m</text>`,
        );
    }

    // X grid + tick labels (0 and the right edge stay implicit).
    const xStep = niceStep(xSpan, 4);
    for (let v = xStep; v < xSpan - xStep / 4; v += xStep) {
        const px = x(v);
        parts.push(
            `<line x1="${fmt(px)}" y1="${MARGIN.top}" x2="${fmt(px)}" y2="${baseY}" class="grid"/>`,
            `<text x="${fmt(px)}" y="${CHART_H - 4}" class="tick tick--x">${Math.round(v)} m</text>`,
        );
    }

    // Smoothed area + line per contiguous run (gaps stay gaps).
    for (const run of elevationRuns(smoothProfile([...rawSamples]))) {
        if (run.length < 2) continue;
        const pts = run.map(p => `${fmt(x(p.distance))},${fmt(y(p.elevation!))}`);
        const area = `M${pts[0]} L${pts.slice(1).join(' L')} `
            + `L${fmt(x(run[run.length - 1].distance))},${baseY} L${fmt(x(run[0].distance))},${baseY} Z`;
        parts.push(
            `<path d="${area}" fill="url(#elev-area)" stroke="none"/>`,
            `<polyline points="${pts.join(' ')}" class="curve"/>`,
        );
    }

    // Labelled verticals at the path vertices, with the RAW vertex elevation
    // dot when it resolved.
    for (const marker of markers) {
        const px = x(marker.distance);
        // Clamp the label so edge markers (Tee/Green) stay inside the SVG.
        const labelX = Math.min(Math.max(px, MARGIN.left + 10), MARGIN.left + PLOT_W - 10);
        parts.push(
            `<line x1="${fmt(px)}" y1="${MARGIN.top}" x2="${fmt(px)}" y2="${baseY}" class="rule"/>`,
            `<text x="${fmt(labelX)}" y="${MARGIN.top - 5}" class="marker-label">${esc(marker.label)}</text>`,
        );
        if (marker.elevation !== null) {
            parts.push(`<circle cx="${fmt(px)}" cy="${fmt(y(marker.elevation))}" r="3" class="dot"/>`);
        }
    }

    // Scoped presentation — inline so the string is self-contained (an SVG
    // <style> only reaches this chart's elements).
    parts.push(`<style>
        .grid { stroke: ${t('color-border-default')}; stroke-width: 0.5; }
        .rule { stroke: ${t('color-border-default')}; stroke-width: 1; stroke-dasharray: 3 3; }
        .curve { fill: none; stroke: var(--map-shot-line); stroke-width: 2;
            stroke-linecap: round; stroke-linejoin: round; }
        .dot { fill: ${t('color-text-primary')}; stroke: ${t('color-surface-card')}; stroke-width: 1; }
        .tick { fill: ${t('color-text-secondary')}; font-size: 7.5px;
            font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
        .tick--y { text-anchor: end; }
        .tick--x { text-anchor: middle; }
        .marker-label { fill: ${t('color-text-secondary')}; font-size: 8px;
            font-weight: 600; text-anchor: middle; }
    </style>`);

    return parts.join('');
}

export function captionText(range: { min: number; max: number }, totalDistance: number): string {
    const dom = yDomain(range);
    const ySpan = dom.max - dom.min;
    const xSpan = Math.max(totalDistance, 1);
    // (px per vertical metre) / (px per horizontal metre) — honest, from the
    // fixed plot dims.
    const factor = (PLOT_H / ySpan) / (PLOT_W / xSpan);
    return `Vertical exaggeration ~${Math.round(factor)}× · terrain sampled every 2 m `
        + '(0.1 m steps), curve smoothed ~10 m; Δ values are raw';
}
