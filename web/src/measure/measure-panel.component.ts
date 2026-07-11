import { Component, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, panelTitle, metric } from '../css';
import { MeasureToolService } from './measure-tool.service';
import type { SegmentStats } from './measure-state';
import { pointLabel } from './measure-tool.service';

// COLOR_PROFILE is a Canvas 2D strokeStyle — the context can't resolve a
// `var(--x)` reference, so a literal is a deliberate exception to the
// tokens-only rule (guide §02/§06). Every CSS-side colour below instead
// uses the shared --data-good/--data-bad/--map-shot-line tokens.
const COLOR_PROFILE = '#06b6d4'; // sparkline stroke — cyan

// Tuned to the right ctx-dock's fixed 268px column (feature-dock.component.ts)
// minus this panel's own space-4 interior padding on each side: 268 − 2×16.
const PROFILE_W = 236;
const PROFILE_H = 60;

const tpl = template(`
    <div class="measure-panel" bind="root" data-testid="measure-panel">
        <div bind="instruction" class="instruction"></div>
        <div bind="statsSection" class="stats-section">
            <h4 class="section-title">Segments</h4>
            <div bind="segments" class="segments"></div>
            <h4 class="section-title">Total</h4>
            <div bind="playsLikeHero" class="plays-like"></div>
            <div bind="totals" class="stats-grid totals-grid"></div>
        </div>
        <div bind="profileSection" class="profile-section">
            <h4 class="section-title">Elevation profile</h4>
            <canvas bind="profileCanvas" class="profile-canvas" width="${PROFILE_W}" height="${PROFILE_H}"></canvas>
            <div bind="profileLabels" class="profile-labels"></div>
        </div>
        <div bind="actions" class="actions">
            <button bind="clearBtn" type="button" class="clear-btn">Clear (Esc)</button>
        </div>
        <div class="measure-panel__hints">
            <div>Click to place points — <b>A</b>, <b>B</b>, then extend the path.</div>
            <div>Double-click or click near <b>A</b> to end · <b>Esc</b> clears.</div>
            <div>plays-like (simple) = horizontal + elevation Δ (full model: Phase 5).</div>
        </div>
    </div>
`);

/**
 * Side panel for the measure tool: live instruction line, per-segment +
 * total stats table (horizontal / elevation Δ / straight-line 3D / slope /
 * plays-like simple), an elevation-profile sparkline canvas, and a clear
 * button. Shares the MeasureToolService DI singleton with the tool.
 */
export class MeasurePanelComponent extends Component {
    static styles = `
        .measure-panel {
            /* Flat dock body (feature-dock.component.ts hosting contract):
               the dock owns the surface + scroll bound with zero padding,
               so this panel carries its own space-4 interior rhythm and a
               single flex column — no glass wrapper, no fixed width. Law 03:
               space carries structure, so sections lean on gap rather than
               a hairline after every block; the one allowed divider sits
               above .actions, mirroring feature-stack-panel's reorder-ops. */
            display: flex;
            flex-direction: column;
            gap: var(--space-3);
            padding: var(--space-3) var(--space-4) var(--space-4);
            font-size: 0.8rem;
            color: ${t('color-text-primary')};

            & .section-title {
                margin: 0;
                ${panelTitle()}
            }

            & .instruction {
                font-size: 0.8rem;
                line-height: 1.4;
                & .accent { color: var(--map-shot-line); font-weight: 600; }
            }

            & .stats-section, & .profile-section {
                display: none;
                flex-direction: column;
                gap: ${s('sm')};
                &.show { display: flex; }
            }

            & .actions {
                display: none;
                padding-top: var(--space-3);
                border-top: 1px solid ${t('color-border-default')};
                &.show { display: flex; }
            }

            & .segments {
                display: flex;
                flex-direction: column;
                gap: ${s('sm')};
            }

            & .segment {
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius-sm')};
                padding: ${s('xs')} ${s('sm')};
            }

            & .segment__title {
                font-size: 0.72rem;
                font-weight: 600;
                color: ${t('color-text-secondary')};
                margin-bottom: 2px;
            }

            & .stats-grid {
                display: grid;
                grid-template-columns: auto 1fr;
                column-gap: ${s('sm')};
                row-gap: 1px;
                font-size: 0.75rem;
            }

            & .totals-grid { font-weight: 600; }

            & .stat-label { color: ${t('color-text-secondary')}; }
            & .stat-value { text-align: right; ${metric()} }
            & .stat-value.up { color: var(--data-good); }
            & .stat-value.down { color: var(--data-bad); }

            /* Guide §02: dark hero readout for the headline "plays-like"
               number — surface-brand at 90%, gold mono overline, large mono
               value. Scaled down from the guide's 34px demo for the narrow
               sidebar dock. */
            & .plays-like {
                display: none;
                align-items: baseline;
                gap: ${s('xs')};
                padding: ${s('sm')} ${s('md')};
                border-radius: var(--radius-md);
                background: color-mix(in srgb, ${t('color-surface-brand')} 90%, transparent);
                &.show { display: flex; }
            }
            & .plays-like__label {
                font: var(--text-overline);
                letter-spacing: var(--tracking-overline);
                text-transform: uppercase;
                color: ${t('color-accent-data')};
            }
            & .plays-like__value {
                font: var(--text-metric-l);
                font-variant-numeric: tabular-nums;
                color: ${t('overlay-text')};
                & .metric__unit { color: ${t('overlay-text-muted')}; font-size: 0.6em; }
            }

            & .profile-canvas {
                width: ${PROFILE_W}px;
                height: ${PROFILE_H}px;
                max-width: 100%;
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius-sm')};
                background: ${t('color-surface-card')};
            }

            & .profile-labels {
                display: flex;
                justify-content: space-between;
                font-size: 0.68rem;
                color: ${t('color-text-secondary')};
                font-family: var(--font-mono);
                font-variant-numeric: tabular-nums;
            }

            & .clear-btn {
                padding: ${s('xs')} ${s('sm')};
                font-size: 0.75rem;
                ${btn(t('radius-sm'))}
            }

            /* Quiet footer — the last section above already draws the one
               allowed major-group divider. */
            & .measure-panel__hints {
                padding-top: var(--space-1);
                font-size: 0.68rem;
                line-height: 1.5;
                color: ${t('color-text-tertiary')};
            }
        }
    `;

    private tool = this.inject(MeasureToolService);
    private profileCanvas!: HTMLCanvasElement;

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            statsSection: {
                className: () => this.tool.state.hasPath.get()
                    ? 'stats-section show'
                    : 'stats-section',
            },
            profileSection: {
                className: () => this.tool.state.hasPath.get()
                    ? 'profile-section show'
                    : 'profile-section',
            },
            actions: {
                className: () => this.tool.state.count.get() > 0
                    ? 'actions show'
                    : 'actions',
            },
            clearBtn: { onclick: () => this.tool.clear() },
        });

        // Instruction line (matches the prototype's state text).
        const instruction = this.ref(frag, 'instruction');
        this.track(effect(() => {
            const count = this.tool.state.count.get();
            const ended = this.tool.state.ended.get();
            instruction.innerHTML = this.instructionHtml(count, ended);
        }));

        // Per-segment stats cards.
        const segments = this.ref(frag, 'segments');
        this.track(effect(() => {
            const segs = this.tool.state.segments.get();
            segments.textContent = '';
            segs.forEach((seg, i) => {
                segments.appendChild(this.segmentCard(seg, i));
            });
        }));

        // Totals grid.
        const totals = this.ref(frag, 'totals');
        this.track(effect(() => {
            const totalsData = this.tool.state.totals.get();
            totals.textContent = '';
            if (totalsData.totalSegments === 0) return;
            this.fillStatsGrid(totals, totalsData, true);
        }));

        // Hero "plays-like" readout (guide §02) — the headline number for the
        // whole path, shown only once elevation data makes it meaningful.
        const playsLikeHero = this.ref(frag, 'playsLikeHero');
        this.track(effect(() => {
            const playsLike = this.tool.state.totals.get().playsLikeSimple;
            if (playsLike === null) {
                playsLikeHero.className = 'plays-like';
                return;
            }
            playsLikeHero.className = 'plays-like show';
            playsLikeHero.innerHTML = '<span class="plays-like__label">Plays like</span>'
                + `<span class="plays-like__value">${playsLike.toFixed(1)}<span class="metric__unit">m</span></span>`;
        }));

        // Elevation-profile sparkline.
        this.profileCanvas = this.ref(frag, 'profileCanvas') as HTMLCanvasElement;
        this.track(effect(() => {
            const profile = this.tool.profile.get();
            const range = this.tool.profileRange.get();
            this.drawProfile(profile, range);
        }));

        const profileLabels = this.ref(frag, 'profileLabels');
        this.track(effect(() => {
            const range = this.tool.profileRange.get();
            profileLabels.textContent = '';
            const loading = this.tool.profileLoading.get();
            const left = document.createElement('span');
            const right = document.createElement('span');
            if (!range) {
                left.textContent = loading ? 'sampling…' : 'no elevation data';
                right.textContent = '';
            } else {
                left.textContent = `min ${range.min.toFixed(1)} m`;
                right.textContent = `max ${range.max.toFixed(1)} m`;
            }
            profileLabels.append(left, right);
        }));

        return frag;
    }

    // ── Rendering helpers ─────────────────────────────────────────────────

    private instructionHtml(count: number, ended: boolean): string {
        if (count === 0) return 'Click the map to set point <span class="accent">A</span>.';
        if (count === 1) return 'Point <span class="accent">A</span> set — click to set point <span class="accent">B</span>.';
        if (ended) {
            return `Path ended (${count} points). Click anywhere to start a new measurement.`;
        }
        const next = pointLabel(count);
        return `${count} points — click to add <span class="accent">${next}</span>, ` +
            `or double-click / click near <span class="accent">A</span> to end.`;
    }

    private segmentCard(seg: SegmentStats, i: number): HTMLElement {
        const card = document.createElement('div');
        card.className = 'segment';
        const title = document.createElement('div');
        title.className = 'segment__title';
        title.textContent = `${pointLabel(i)} → ${pointLabel(i + 1)}`;
        card.appendChild(title);
        const grid = document.createElement('div');
        grid.className = 'stats-grid';
        this.fillStatsGrid(grid, seg, false);
        card.appendChild(grid);
        return card;
    }

    /** Fill a stats grid with horizontal / elevation Δ / straight-line / slope / plays-like. */
    private fillStatsGrid(host: Element, seg: SegmentStats, isTotal: boolean): void {
        const row = (label: string, value: string, cls = '') => {
            const l = document.createElement('span');
            l.className = 'stat-label';
            l.textContent = label;
            const v = document.createElement('span');
            v.className = `stat-value${cls ? ' ' + cls : ''}`;
            v.textContent = value;
            host.append(l, v);
        };
        const dash = '—';

        row('Horizontal', `${seg.horizontal.toFixed(1)} m`);

        if (seg.elevationDelta === null) {
            row('Elevation Δ', dash);
            row(isTotal ? 'Draped 3D' : 'Straight line', dash);
            row('Slope', dash);
            row('Plays-like', dash);
            return;
        }

        const delta = seg.elevationDelta;
        const sign = delta >= 0 ? '+' : '−';
        row('Elevation Δ', `${sign}${Math.abs(delta).toFixed(2)} m`, delta >= 0 ? 'up' : 'down');
        row(isTotal ? 'Draped 3D' : 'Straight line', `${seg.straightLine!.toFixed(1)} m`);
        row('Slope', `${seg.slopeDeg!.toFixed(1)}° (${seg.slopePct!.toFixed(1)} %)`);
        row('Plays-like', `${seg.playsLikeSimple!.toFixed(1)} m`);
    }

    private drawProfile(
        profile: Array<{ distance: number; elevation: number | null }>,
        range: { min: number; max: number } | null,
    ): void {
        const canvas = this.profileCanvas;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        // Render at device pixels for crispness.
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== PROFILE_W * dpr) {
            canvas.width = PROFILE_W * dpr;
            canvas.height = PROFILE_H * dpr;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, PROFILE_W, PROFILE_H);

        if (!range || profile.length < 2) return;

        const pad = 4;
        const w = PROFILE_W - pad * 2;
        const h = PROFILE_H - pad * 2;
        const maxDist = profile[profile.length - 1].distance || 1;
        const span = range.max - range.min || 1;
        const x = (d: number) => pad + (d / maxDist) * w;
        const y = (e: number) => pad + (1 - (e - range.min) / span) * h;

        ctx.strokeStyle = COLOR_PROFILE;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        let penDown = false;
        for (const sample of profile) {
            if (sample.elevation === null) {
                penDown = false; // gap over missing coverage
                continue;
            }
            const px = x(sample.distance);
            const py = y(sample.elevation);
            if (!penDown) {
                ctx.moveTo(px, py);
                penDown = true;
            } else {
                ctx.lineTo(px, py);
            }
        }
        ctx.stroke();
    }
}
