// Distance-band strokes-gained table — the headline analytics view per
// shot-capture doc §5. Self-contained: no DI service, no router wiring (T14
// scope is the view + adapter; assembling round data / mounting this into a
// page is a follow-up task). Callers build a `RoundSgSummary` via
// `shared/strategy`'s `roundStrokesGained`/`aggregateStrokesGained` fed by
// `round-sg.ts`'s adapter, and pass it straight in as a prop.

import { Component, template } from '@basics/core/client/core';
import type { RoundSgSummary } from '../../../shared/strategy';
import { s } from '../css';
import { t } from '../theme';
import {
    categoryRows,
    distanceBandRows,
    formatSg,
    totalRow,
    type SgTableRow,
} from './round-sg-table';

export interface RoundSgPanelProps {
    summary: RoundSgSummary;
}

const tpl = template(`
    <div class="round-sg-panel" bind="root">
        <div class="round-sg-panel__section">
            <h4 class="section-title">Strokes gained by distance</h4>
            <div bind="distanceTable" class="sg-table"></div>
        </div>
        <div class="round-sg-panel__section">
            <h4 class="section-title">Strokes gained by category</h4>
            <div bind="categoryTable" class="sg-table"></div>
        </div>
        <div class="round-sg-panel__section round-sg-panel__total" bind="totalRow"></div>
    </div>
`);

function buildTable(rows: readonly SgTableRow[]): HTMLElement {
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
        count.textContent = row.count > 0 ? `${row.count} shot${row.count === 1 ? '' : 's'}` : '—';

        const value = document.createElement('span');
        value.className = 'sg-table__value';
        value.textContent = formatSg(row.meanStrokesGained);
        if (row.meanStrokesGained !== null) {
            value.classList.add(row.meanStrokesGained >= 0 ? 'positive' : 'negative');
        }

        rowEl.append(label, count, value);
        table.appendChild(rowEl);
    }
    return table;
}

/**
 * Self-contained strokes-gained panel: renders the distance-band table (the
 * headline view, §5), a category breakdown, and the round total. Pure
 * render over a `RoundSgSummary` prop — no live data fetching here.
 */
export class RoundSgPanelComponent extends Component<RoundSgPanelProps> {
    static styles = `
        .round-sg-panel {
            display: flex;
            flex-direction: column;
            font-size: 0.8rem;
            color: ${t('text')};

            & .round-sg-panel__section {
                padding: ${s('sm')} ${s('md')};
                border-bottom: 1px solid ${t('border')};
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
                color: ${t('text-muted')};
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

            & .sg-table__label { color: ${t('text')}; }
            & .sg-table__count {
                color: ${t('text-muted')};
                font-size: 0.7rem;
                text-align: right;
            }
            & .sg-table__value {
                font-variant-numeric: tabular-nums;
                font-weight: 600;
                text-align: right;
                min-width: 3.5em;
                &.positive { color: ${t('primary')}; }
                &.negative { color: ${t('error')}; }
            }

            & .round-sg-panel__total {
                font-weight: 600;
            }
        }
    `;

    render(): DocumentFragment {
        const frag = this.wire(tpl, {});

        const distanceTable = this.ref(frag, 'distanceTable');
        distanceTable.appendChild(buildTable(distanceBandRows(this.props.summary)));

        const categoryTable = this.ref(frag, 'categoryTable');
        categoryTable.appendChild(buildTable(categoryRows(this.props.summary)));

        const totalEl = this.ref(frag, 'totalRow');
        totalEl.appendChild(buildTable([totalRow(this.props.summary)]));

        return frag;
    }
}
