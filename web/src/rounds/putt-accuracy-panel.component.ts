// Putting estimation-accuracy panel — the training-loop trend that sits beside
// strokes-gained putting (feature-putting-green-reading.md §5.1, T14 UI). Same
// self-contained, pure-over-a-prop shape as round-sg-panel.component.ts: it
// renders a `RoundSgSummary`-sibling `AccuracyTrend` and does no fetching. The
// planner records samples via PuttEstimateService; a page assembles the trend
// prop and mounts this next to the SG putting row.

import { Component, template } from '@basics/core/client/core';
import type { AccuracyTrend } from '../../../shared/api/putt-estimate.gen';
import { s } from '../css';
import { t } from '../theme';
import { accuracyRows, bucketRows, type AccuracyRow } from './putt-accuracy-rows';

export interface PuttAccuracyPanelProps {
    trend: AccuracyTrend;
}

const tpl = template(`
    <div class="putt-accuracy-panel" bind="root" data-testid="putt-accuracy-panel">
        <div class="putt-accuracy-panel__section">
            <h4 class="section-title">Read accuracy — recent</h4>
            <div bind="recentTable" class="sg-table"></div>
        </div>
        <div class="putt-accuracy-panel__section">
            <h4 class="section-title">Read accuracy — all time</h4>
            <div bind="overallTable" class="sg-table"></div>
        </div>
        <div class="putt-accuracy-panel__section" bind="trendSection">
            <h4 class="section-title">Slope error over time</h4>
            <div bind="trendTable" class="sg-table"></div>
        </div>
    </div>
`);

function buildTable(rows: readonly AccuracyRow[]): HTMLElement {
    const table = document.createElement('div');
    table.className = 'sg-table__rows';
    for (const row of rows) {
        const rowEl = document.createElement('div');
        rowEl.className = 'sg-table__row';

        const label = document.createElement('span');
        label.className = 'sg-table__label';
        label.textContent = row.label;

        const count = document.createElement('span');
        count.className = 'sg-table__count';
        count.textContent = row.count > 0 ? `${row.count} putt${row.count === 1 ? '' : 's'}` : '—';

        const value = document.createElement('span');
        value.className = 'sg-table__value';
        value.textContent = row.value;

        rowEl.append(label, count, value);
        table.appendChild(rowEl);
    }
    return table;
}

/**
 * Estimation-accuracy panel: a recent-window aggregate, an all-time aggregate,
 * and a per-day slope-error trend. Pure render over an `AccuracyTrend` prop —
 * the same style as the strokes-gained panel it sits beside. No live fetch.
 */
export class PuttAccuracyPanelComponent extends Component<PuttAccuracyPanelProps> {
    static styles = `
        .putt-accuracy-panel {
            display: flex;
            flex-direction: column;
            font-size: 0.8rem;
            color: ${t('color-text-primary')};

            & .putt-accuracy-panel__section {
                padding: ${s('sm')} ${s('md')};
                border-bottom: 1px solid ${t('color-border-default')};
                display: flex;
                flex-direction: column;
                gap: ${s('sm')};
            }

            & .section-title {
                margin: 0;
                font-size: 0.7rem;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.06em;
                color: ${t('color-text-secondary')};
            }

            & .sg-table__rows {
                display: flex;
                flex-direction: column;
                gap: 2px;
            }

            & .sg-table__row {
                display: grid;
                grid-template-columns: 1fr auto auto;
                gap: ${s('sm')};
                align-items: baseline;
                font-size: 0.78rem;
            }

            & .sg-table__label { color: ${t('color-text-primary')}; }
            & .sg-table__count {
                color: ${t('color-text-secondary')};
                font-size: 0.7rem;
                text-align: right;
            }
            & .sg-table__value {
                font-variant-numeric: tabular-nums;
                font-weight: 600;
                text-align: right;
                min-width: 3.5em;
            }
        }
    `;

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            // Hide the trend section until there are buckets to show.
            trendSection: {
                style: () => this.props.trend.buckets.length > 0 ? '' : 'display:none',
            },
        });

        const recentTable = this.ref(frag, 'recentTable');
        recentTable.appendChild(buildTable(accuracyRows(this.props.trend.recent)));

        const overallTable = this.ref(frag, 'overallTable');
        overallTable.appendChild(buildTable(accuracyRows(this.props.trend.overall)));

        const trendTable = this.ref(frag, 'trendTable');
        trendTable.appendChild(buildTable(
            bucketRows(this.props.trend).map((b) => ({
                label: b.date,
                count: b.count,
                value: b.slopeError,
            })),
        ));

        return frag;
    }
}
