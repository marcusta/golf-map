// Find bunkers: the Draw mode's panel for the bunker proposals (BunkerProposalsService), the bunkers the
// course-surface model finds on the photo that are not drawn yet. One line: Find, how many will be added, Add,
// Discard; the proposal shows as outlines on the map (a click on one skips it, again takes it back; dashed = its
// edge is the model's, no clear sand in the NIR band). Explanations are tooltips.
//
// Spawned by CourseDetailComponent like the Assign to holes panel, opened from the Draw stack panel
// (BunkerProposalsService.open).

import { Component, effect, template } from '@basics/core/client/core';
import type { FilterSpecification } from 'maplibre-gl';
import { t } from '../theme';
import { s, btn, primaryBtn, glassPanel, panelTitle, OVERLAY_W, OVERLAY_INSET } from '../css';
import { icon } from '../ui/icons';
import { MapService } from '../map/map.service';
import { wgs84ToSweref99tm } from '../geo/transform';
import { BunkerProposalsService } from './bunker-proposals.service';

const OVERLAY_ID = 'bunker-proposals';
const KEPT_COLOR = '#f59e0b';
const SKIPPED_COLOR = '#9ca3af';

const tpl = template(`
    <div bind="root" class="bunker-find" data-testid="bunker-find-panel">
        <div class="bunker-find__header">
            <h3 title="Bunkers the surface model finds on the photo that are not drawn yet, edges from the photo's near-infrared band, each on its hole">Find bunkers</h3>
            <button bind="close" type="button" aria-label="Close" title="Close (drops the proposal)">${icon('x')}</button>
        </div>
        <div class="bunker-find__row">
            <button bind="find" type="button" data-testid="bunker-find-find"
                title="Run the surface model over the course's photo and propose every bunker not drawn yet (a minute the first time, then seconds)">${icon('search', 16)}<span bind="findLabel">Find</span></button>
            <span bind="count" class="bunker-find__count" data-testid="bunker-find-count"
                title="Bunkers Add makes. Click an outline on the map to skip it; click it again to take it back. Dashed: no clear sand in the near-infrared, the model's own outline."></span>
            <button bind="add" type="button" class="bunker-find__add" data-testid="bunker-find-add"
                title="Add these as B-spline bunkers on their holes (one undo step); the skipped ones are not offered again">${icon('check', 16)}<span>Add</span></button>
            <button bind="discard" type="button" data-testid="bunker-find-discard"
                title="Drop the proposal: nothing is added or skipped">${icon('x', 16)}<span>Discard</span></button>
        </div>
        <div bind="status" class="bunker-find__status"></div>
    </div>
`);

export class BunkerProposalsPanelComponent extends Component {
    static styles = `
        .bunker-find {
            position: absolute;
            top: ${OVERLAY_INSET};
            right: ${OVERLAY_INSET};
            width: ${OVERLAY_W.standard};
            max-width: calc(100% - 2 * ${OVERLAY_INSET});
            z-index: 6;
            display: none;
            flex-direction: column;
            gap: ${s('sm')};
            ${glassPanel()}
            padding: var(--space-3) var(--space-4);
            font-size: 0.78rem;
            color: ${t('color-text-primary')};
            &.show { display: flex; }

            & .bunker-find__header {
                display: flex;
                align-items: center;
                gap: ${s('sm')};
                & h3 { margin: 0; flex: 1; ${panelTitle()} }
                & button { display: inline-flex; align-items: center; padding: 2px ${s('sm')}; ${btn()} }
            }
            & .bunker-find__row {
                display: flex;
                align-items: center;
                gap: ${s('sm')};
                & button { display: inline-flex; align-items: center; gap: ${s('xs')}; padding: 2px ${s('sm')}; ${btn()} }
                & button:disabled { opacity: 0.5; cursor: default; }
                & .bunker-find__add { ${primaryBtn()} padding: 2px ${s('sm')}; }
            }
            & .bunker-find__count { flex: 1; color: ${t('color-text-secondary')}; white-space: nowrap; }
            & .bunker-find__status {
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
                &:empty { display: none; }
                &.error { color: ${t('color-status-negative')}; }
            }
        }
    `;

    private svc = this.inject(BunkerProposalsService);
    private mapSvc = this.inject(MapService);

    render(): DocumentFragment {
        const svc = this.svc;
        const frag = this.wire(tpl, {
            root: { className: () => svc.courseId.get() ? 'bunker-find show' : 'bunker-find' },
            close: { onclick: () => svc.close() },
            find: { onclick: () => void svc.find(), disabled: () => !!svc.busy.get() },
            findLabel: { textContent: () => svc.busy.get() === 'find' ? 'Finding…' : 'Find' },
            count: { textContent: () => svc.proposals.get().length ? `${svc.addCount()} to add` : '' },
            // Enabled with every outline skipped too: Add then only remembers the skips.
            add: { onclick: () => void svc.add(), disabled: () => !!svc.busy.get() || svc.proposals.get().length === 0 },
            discard: { onclick: () => svc.discard(), disabled: () => !!svc.busy.get() || svc.proposals.get().length === 0 },
            status: {
                className: () => svc.error.get() ? 'bunker-find__status error' : 'bunker-find__status',
                textContent: () => svc.error.get() || svc.done.get() || svc.note.get()
                    || (svc.busy.get() === 'find' ? 'Reading the photo…' : ''),
            },
        });
        this.bindMap();
        return frag;
    }

    /** The outlines on the map while there is a proposal, and a click inside one skips (or takes back) that bunker. */
    private bindMap(): void {
        const map = this.mapSvc;
        let added = false;
        this.track(effect(() => {
            const ready = map.ready.get();
            if (!ready) { added = false; return; }
            const data = this.svc.courseId.get() && this.svc.proposals.get().length ? this.svc.layer() : null;
            if (!data) {
                if (added) map.removeOverlayLayer(OVERLAY_ID);
                added = false;
                return;
            }
            if (added) {
                map.updateOverlayData(OVERLAY_ID, data);
                return;
            }
            const kept = ['==', ['get', 'skipped'], false] as FilterSpecification;
            const keptEdge = (edge: string) => ['all', kept, ['==', ['get', 'edge'], edge]] as FilterSpecification;
            map.addOverlayLayer(OVERLAY_ID, data, [
                {
                    id: `${OVERLAY_ID}-fill`, type: 'fill', filter: kept,
                    paint: { 'fill-color': KEPT_COLOR, 'fill-opacity': 0.18 },
                },
                {
                    id: `${OVERLAY_ID}-kept`, type: 'line', filter: keptEdge('nir'),
                    paint: { 'line-color': KEPT_COLOR, 'line-width': 2.5 },
                },
                {
                    id: `${OVERLAY_ID}-kept-model`, type: 'line', filter: keptEdge('model'),
                    paint: { 'line-color': KEPT_COLOR, 'line-width': 2.5, 'line-dasharray': [2, 1.5] },
                },
                {
                    id: `${OVERLAY_ID}-skipped`, type: 'line', filter: ['==', ['get', 'skipped'], true],
                    paint: { 'line-color': SKIPPED_COLOR, 'line-width': 1.5, 'line-dasharray': [2, 2] },
                },
            ], { keepOnTop: true });
            added = true;
        }));
        this.track(map.onClick((e) => {
            if (!this.svc.courseId.peek() || this.svc.proposals.peek().length === 0) return;
            const { x, y } = wgs84ToSweref99tm(e.lngLat.lat, e.lngLat.lng);
            const id = this.svc.proposalAt(x, y);
            if (id) this.svc.toggle(id);
        }));
        this.track(() => { if (added && map.ready.peek()) map.removeOverlayLayer(OVERLAY_ID); });
    }
}
