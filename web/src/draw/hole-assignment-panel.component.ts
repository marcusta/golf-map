// Assign to holes: the Draw mode's panel for HoleAssignmentService. One line: how many shapes go onto holes and how
// many stay, Accept, Discard. On the map the play lines and the proposed shapes, coloured by hole (grey: on another
// course's hole, dashed: skipped); a click on a proposed shape skips it, again takes it back. Explanations are
// tooltips.
//
// Spawned by CourseDetailComponent like Trees in photo, opened from the stack panel's "Assign to holes…".

import { Component, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, primaryBtn, glassPanel, panelTitle, OVERLAY_W, OVERLAY_INSET } from '../css';
import { icon } from '../ui/icons';
import { MapService } from '../map/map.service';
import { wgs84ToSweref99tm } from '../geo/transform';
import { HoleAssignmentService } from './hole-assignment.service';

const OVERLAY_ID = 'hole-assignment';

const tpl = template(`
    <div bind="root" class="hole-assign" data-testid="hole-assign-panel">
        <div class="hole-assign__header">
            <h3 title="Shapes in Others onto their holes, from each hole's tees, aim points and green centre. Shapes on another course's hole, split between holes or near none stay in Others.">Assign to holes</h3>
            <button bind="close" type="button" aria-label="Close" title="Close (drops the proposal)">${icon('x')}</button>
        </div>
        <div class="hole-assign__row">
            <span bind="count" class="hole-assign__count" data-testid="hole-assign-count"></span>
            <button bind="accept" type="button" class="hole-assign__accept" data-testid="hole-assign-accept"
                title="Put the coloured shapes on their holes and the yellow roughs into Roughs (click one on the map to skip it)">${icon('check', 16)}<span>Accept</span></button>
            <button bind="discard" type="button" data-testid="hole-assign-discard" title="Drop the proposal: nothing changes">${icon('x', 16)}<span>Discard</span></button>
        </div>
        <div bind="status" class="hole-assign__status"></div>
    </div>
`);

export class HoleAssignmentPanelComponent extends Component {
    static styles = `
        .hole-assign {
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

            & .hole-assign__header {
                display: flex;
                align-items: center;
                gap: ${s('sm')};
                & h3 { margin: 0; flex: 1; ${panelTitle()} }
                & button { display: inline-flex; align-items: center; padding: 2px ${s('sm')}; ${btn()} }
            }
            & .hole-assign__row {
                display: flex;
                align-items: center;
                gap: ${s('sm')};
                & button { display: inline-flex; align-items: center; gap: ${s('xs')}; padding: 2px ${s('sm')}; ${btn()} }
                & button:disabled { opacity: 0.5; cursor: default; }
                & .hole-assign__accept { ${primaryBtn()} padding: 2px ${s('sm')}; }
            }
            & .hole-assign__count { flex: 1; color: ${t('color-text-secondary')}; white-space: nowrap; }
            & .hole-assign__status {
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
                &:empty { display: none; }
                &.error { color: ${t('color-status-negative')}; }
            }
        }
    `;

    private svc = this.inject(HoleAssignmentService);
    private mapSvc = this.inject(MapService);

    render(): DocumentFragment {
        const svc = this.svc;
        const frag = this.wire(tpl, {
            root: { className: () => svc.courseId.get() ? 'hole-assign show' : 'hole-assign' },
            close: { onclick: () => svc.close() },
            count: {
                textContent: () => svc.busy.get() === 'find' ? 'Finding…' : svc.summary(),
                title: () => svc.detail(),
            },
            accept: { onclick: () => void svc.accept(), disabled: () => !!svc.busy.get() || svc.toAssign().length === 0 },
            discard: { onclick: () => svc.close(), disabled: () => !!svc.busy.get() },
            status: {
                className: () => svc.error.get() ? 'hole-assign__status error' : 'hole-assign__status',
                textContent: () => svc.error.get() || svc.done.get(),
            },
        });
        this.bindMap();
        return frag;
    }

    /** Play lines and proposed shapes on the map while there is a proposal; a click on a shape skips it. */
    private bindMap(): void {
        const map = this.mapSvc;
        let added = false;
        this.track(effect(() => {
            const ready = map.ready.get();
            if (!ready) { added = false; return; }
            const data = this.svc.courseId.get() && this.svc.proposal.get() ? this.svc.layer() : null;
            if (!data) {
                if (added) map.removeOverlayLayer(OVERLAY_ID);
                added = false;
                return;
            }
            if (added) {
                map.updateOverlayData(OVERLAY_ID, data);
                return;
            }
            map.addOverlayLayer(OVERLAY_ID, data, [
                {
                    id: `${OVERLAY_ID}-lines`, type: 'line', filter: ['==', ['get', 'kind'], 'line'],
                    paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-dasharray': [3, 2] },
                },
                {
                    id: `${OVERLAY_ID}-assign`, type: 'line', filter: ['==', ['get', 'kind'], 'assign'],
                    paint: { 'line-color': ['get', 'color'], 'line-width': 2.5 },
                },
                {
                    id: `${OVERLAY_ID}-roughs`, type: 'line', filter: ['==', ['get', 'kind'], 'roughs'],
                    paint: { 'line-color': '#fbbf24', 'line-width': 1.5 },
                },
                {
                    id: `${OVERLAY_ID}-other`, type: 'line', filter: ['==', ['get', 'kind'], 'other'],
                    paint: { 'line-color': ['get', 'color'], 'line-width': 1 },
                },
                {
                    id: `${OVERLAY_ID}-skipped`, type: 'line', filter: ['==', ['get', 'kind'], 'skipped'],
                    paint: { 'line-color': '#9ca3af', 'line-width': 1.5, 'line-dasharray': [2, 2] },
                },
            ], { keepOnTop: true });
            added = true;
        }));
        this.track(map.onClick((e) => {
            if (!this.svc.courseId.peek() || !this.svc.proposal.peek()) return;
            const { x, y } = wgs84ToSweref99tm(e.lngLat.lat, e.lngLat.lng);
            const id = this.svc.shapeAt(x, y);
            if (id) this.svc.toggle(id);
        }));
        this.track(() => { if (added && map.ready.peek()) map.removeOverlayLayer(OVERLAY_ID); });
    }
}
