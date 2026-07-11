import { Component, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, panelTitle, metric } from '../css';
import { AnalysisToolService, BUFFER_MIN, BUFFER_MAX } from './analysis-tool.service';
import {
    HEIGHT_STOPS,
    REL_ABOVE_STOPS,
    REL_BELOW_STOPS,
    SLOPE_BLUE,
    SLOPE_GREEN,
    SLOPE_MAGENTA,
    SLOPE_ORANGE,
    type AnalysisMode,
    type Rgb,
} from './analysis-math';

const rgb = (c: Rgb): string => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

/** CSS gradient for the slope ramp with stops proportional to 0–7%+. */
const SLOPE_GRADIENT = `linear-gradient(to right, ${rgb(SLOPE_BLUE)} 0%, ${rgb(SLOPE_BLUE)} ${100 / 7}%, ` +
    `${rgb(SLOPE_GREEN)} ${300 / 7}%, ${rgb(SLOPE_ORANGE)} ${500 / 7}%, ${rgb(SLOPE_MAGENTA)} 100%)`;

const HEIGHT_GRADIENT = `linear-gradient(to right, ${HEIGHT_STOPS.map(rgb).join(', ')})`;

/** Diverging relative ramp: deepest hollow (purple) → green level → highest mound (red). */
const RELATIVE_GRADIENT = `linear-gradient(to right, ${[...REL_BELOW_STOPS].reverse().map(rgb).join(', ')}, ` +
    `${REL_ABOVE_STOPS.slice(1).map(rgb).join(', ')})`;

const MODES: Array<{ id: AnalysisMode; label: string; hint: string }> = [
    { id: 'slope', label: 'Slope', hint: 'Slope steepness (%) with fall-line arrows' },
    { id: 'height', label: 'Height', hint: 'Elevation, normalized to this green' },
    { id: 'relative', label: 'Relative', hint: 'Height vs green level — hollows read blue/purple' },
];

const tpl = template(`
    <div class="analysis-panel" bind="root">
        <div class="analysis-panel__section">
            <h4 class="section-title">Overlay</h4>
            <div bind="modes" class="mode-row"></div>
            <div bind="modeHint" class="mode-hint"></div>
        </div>
        <div class="analysis-panel__section">
            <label class="buffer-label">Surrounds buffer <span bind="bufferValue"></span></label>
            <input bind="bufferSlider" type="range" min="${BUFFER_MIN}" max="${BUFFER_MAX}" step="5" />
        </div>
        <div class="analysis-panel__section">
            <h4 class="section-title">Legend</h4>
            <div bind="legendBar" class="legend-bar"></div>
            <div bind="legendLabels" class="legend-labels"></div>
        </div>
        <div bind="statsSection" class="analysis-panel__section stats">
            <h4 class="section-title">Green</h4>
            <div bind="greenStats" class="stats-grid"></div>
            <h4 class="section-title">Surrounds</h4>
            <div bind="surroundStats" class="stats-grid"></div>
            <button bind="clearBtn" type="button" class="clear-btn">Clear (Esc)</button>
        </div>
        <div bind="status" class="analysis-panel__status"></div>
        <div class="analysis-panel__hints">
            <div>Click a <b>green</b> to analyse it and its surrounds.</div>
            <div>Relative mode: hollows ("gropar") show blue/purple below green level.</div>
        </div>
    </div>
`);

/**
 * Side panel for the analysis tool: overlay mode toggle, surrounds-buffer
 * slider (re-fetches), the active ramp's legend, and a stats card for the
 * green + its surrounds. Shares the AnalysisToolService DI singleton with
 * the tool.
 */
export class AnalysisPanelComponent extends Component {
    static styles = `
        .analysis-panel {
            display: flex;
            flex-direction: column;
            font-size: 0.8rem;
            color: ${t('color-text-primary')};
            /* The glass shell comes from the dock (.editor-tools__panel) —
               applying the recipe here too double-stacked border, blur and
               elevation (law 06: tiered depth, one panel layer). Sections
               carry the space-4 interior rhythm (law 03). */

            & .analysis-panel__section {
                padding: var(--space-3) var(--space-4);
                border-bottom: 1px solid ${t('color-border-default')};
                display: flex;
                flex-direction: column;
                gap: var(--space-2);
            }

            & .section-title {
                margin: 0;
                ${panelTitle()}
            }

            /* Guide §04: mode switcher reads as one segmented control, not
               loose buttons — sunken track, lifted active pill. */
            & .mode-row {
                display: flex;
                gap: 4px;
                background: ${t('color-surface-sunken')};
                border: 1px solid ${t('color-border-default')};
                border-radius: 12px;
                padding: 4px;
            }

            & .mode-btn {
                flex: 1;
                padding: 4px 2px;
                font-size: 0.72rem;
                font-family: inherit;
                border: none;
                border-radius: 9px;
                background: transparent;
                color: ${t('color-text-secondary')};
                cursor: pointer;
                transition: background var(--dur-fast) var(--ease-standard),
                    color var(--dur-fast) var(--ease-standard);
                &:hover { color: ${t('color-text-primary')}; }
                &.active {
                    background: ${t('color-surface-raised')};
                    color: ${t('color-text-primary')};
                    font-weight: 600;
                    box-shadow: var(--elev-1);
                }
            }

            & .mode-hint {
                font-size: 0.68rem;
                color: ${t('color-text-secondary')};
            }

            & .buffer-label {
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
                & span {
                    color: ${t('color-text-primary')};
                    font-weight: 600;
                    font-family: var(--font-mono);
                    font-variant-numeric: tabular-nums;
                }
            }

            & input[type='range'] { width: 100%; accent-color: ${t('color-accent-primary')}; }

            & .legend-bar {
                height: 12px;
                border-radius: 3px;
                border: 1px solid rgba(0, 0, 0, 0.3);
            }

            & .legend-labels {
                display: flex;
                justify-content: space-between;
                font-size: 0.65rem;
                color: ${t('color-text-secondary')};
                font-family: var(--font-mono);
                font-variant-numeric: tabular-nums;
            }

            & .stats { display: none; }
            & .stats.show { display: flex; }

            & .stats-grid {
                display: grid;
                grid-template-columns: auto 1fr;
                gap: 1px ${s('sm')};
                font-size: 0.72rem;
                & .stat-label { color: ${t('color-text-secondary')}; }
                & .stat-value { text-align: right; ${metric()} }
            }

            & .clear-btn {
                margin-top: ${s('xs')};
                padding: ${s('xs')} ${s('sm')};
                font-size: 0.75rem;
                ${btn(t('radius-sm'))}
            }

            /* Quiet footers (law 03): tertiary, minimal height; the last
               section above already draws the major-group divider. */
            & .analysis-panel__status {
                padding: var(--space-2) var(--space-4) 0;
                font-size: 0.7rem;
                color: ${t('color-text-tertiary')};
                min-height: 1.2em;
                &.error { color: ${t('color-status-negative')}; }
            }

            & .analysis-panel__hints {
                padding: var(--space-1) var(--space-4) var(--space-3);
                font-size: 0.68rem;
                line-height: 1.5;
                color: ${t('color-text-tertiary')};
            }
        }
    `;

    private tool = this.inject(AnalysisToolService);

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            modeHint: () => MODES.find(m => m.id === this.tool.mode.get())?.hint ?? '',
            bufferValue: () => `${this.tool.bufferM.get()} m`,
            legendBar: {
                'style': () => `background: ${this.legendGradient()}`,
            },
            statsSection: {
                className: () => this.tool.stats.get()
                    ? 'analysis-panel__section stats show'
                    : 'analysis-panel__section stats',
            },
            clearBtn: { onclick: () => this.tool.clear() },
            status: {
                textContent: () => this.statusText(),
                className: () => this.tool.error.get() ? 'analysis-panel__status error' : 'analysis-panel__status',
            },
        });

        // Mode toggle buttons.
        const modes = this.ref(frag, 'modes');
        for (const mode of MODES) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = mode.label;
            button.title = mode.hint;
            button.addEventListener('click', () => this.tool.setMode(mode.id));
            this.track(effect(() => {
                button.className = this.tool.mode.get() === mode.id ? 'mode-btn active' : 'mode-btn';
            }));
            modes.appendChild(button);
        }

        // Buffer slider → re-fetch on release (input events only move the label).
        const slider = this.ref(frag, 'bufferSlider') as HTMLInputElement;
        slider.addEventListener('change', () => void this.tool.setBuffer(Number(slider.value)));
        this.track(effect(() => {
            slider.value = String(this.tool.bufferM.get());
        }));

        // Legend labels per mode.
        const legendLabels = this.ref(frag, 'legendLabels');
        this.track(effect(() => {
            legendLabels.textContent = '';
            for (const label of this.legendLabelTexts()) {
                const span = document.createElement('span');
                span.textContent = label;
                legendLabels.appendChild(span);
            }
        }));

        // Stats grids.
        const greenStats = this.ref(frag, 'greenStats');
        const surroundStats = this.ref(frag, 'surroundStats');
        this.track(effect(() => {
            const stats = this.tool.stats.get();
            greenStats.textContent = '';
            surroundStats.textContent = '';
            if (!stats) return;
            const row = (host: Element, label: string, value: string) => {
                const l = document.createElement('span');
                l.className = 'stat-label';
                l.textContent = label;
                const v = document.createElement('span');
                v.className = 'stat-value';
                v.textContent = value;
                host.append(l, v);
            };
            const g = stats.green;
            row(greenStats, 'Elevation', `${g.minHeight.toFixed(1)}–${g.maxHeight.toFixed(1)} m`);
            row(greenStats, 'Δ height', `${g.deltaHeight.toFixed(2)} m`);
            row(greenStats, 'Max slope', `${g.maxSlopePct.toFixed(1)} %`);
            row(greenStats, 'Avg slope', `${g.avgSlopePct.toFixed(1)} %`);
            row(surroundStats, 'Max slope', `${stats.surrounds.maxSlopePct.toFixed(1)} %`);
            row(surroundStats, 'Deepest hollow', stats.surrounds.deepestHollowM > 0.05
                ? `${stats.surrounds.deepestHollowM.toFixed(2)} m below green`
                : 'none');
        }));

        return frag;
    }

    private legendGradient(): string {
        switch (this.tool.mode.get()) {
            case 'slope': return SLOPE_GRADIENT;
            case 'height': return HEIGHT_GRADIENT;
            case 'relative': return RELATIVE_GRADIENT;
        }
    }

    private legendLabelTexts(): string[] {
        switch (this.tool.mode.get()) {
            case 'slope':
                return ['0%', '1%', '3%', '5%', '7%+'];
            case 'height':
                return ['Low', 'High'];
            case 'relative': {
                const scale = this.tool.stats.get()?.relScaleM;
                const label = scale ? `${scale.toFixed(1)} m` : '';
                return [`−${label} hollow`, 'green level', `+${label} mound`];
            }
        }
    }

    private statusText(): string {
        if (this.tool.loading.get()) return 'Sampling DEM…';
        const error = this.tool.error.get();
        if (error) return `Analysis failed: ${error.message}`;
        const grid = this.tool.grid.get();
        if (grid) return `${grid.width}×${grid.height} cells @ ${grid.resolution} m`;
        return 'Click a green to analyse.';
    }
}
