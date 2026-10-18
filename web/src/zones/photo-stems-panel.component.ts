// Trees in photo: the Vegetation mode's panel for the photo stems (PhotoStemsService), the young trees on open
// ground the lidar missed. One line: Find, how many will be planted, Accept, Discard; the proposal shows as rings
// on the map (a click on a ring skips that tree, again takes it back). Explanations are tooltips.
//
// Spawned by CourseDetailComponent like the Planting rules panel, opened from the Vegetation mode's zone-type
// picker (PhotoStemsService.open).

import { Component, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, primaryBtn, glassPanel, panelTitle, OVERLAY_W, OVERLAY_INSET } from '../css';
import { icon } from '../ui/icons';
import { MapService } from '../map/map.service';
import { wgs84ToSweref99tm } from '../geo/transform';
import { PhotoStemsService } from './photo-stems.service';

const OVERLAY_ID = 'photo-stems';
const KEPT_COLOR = '#22d3ee';
const SKIPPED_COLOR = '#9ca3af';

const tpl = template(`
    <div bind="root" class="photo-stems" data-testid="photo-stems-panel">
        <div class="photo-stems__header">
            <h3 title="Young trees on the rough, semi, deep rough and fairway that the lidar missed, found from their shadows in the summer photo">Trees in photo</h3>
            <button bind="close" type="button" aria-label="Close" title="Close (drops the proposal)">${icon('x')}</button>
        </div>
        <div class="photo-stems__row">
            <button bind="find" type="button" data-testid="photo-stems-find"
                title="Look for young trees in the summer photo (their shadows) on open ground, where the lidar has none">${icon('search', 16)}<span bind="findLabel">Find</span></button>
            <span bind="count" class="photo-stems__count" data-testid="photo-stems-count"
                title="Trees Accept plants. Click a ring on the map to skip that tree; click it again to take it back."></span>
            <button bind="accept" type="button" class="photo-stems__accept" data-testid="photo-stems-accept"
                title="Plant these trees like lidar trees (then update the trees); the skipped ones are not offered again">${icon('check', 16)}<span>Accept</span></button>
            <button bind="discard" type="button" data-testid="photo-stems-discard"
                title="Drop the proposal: nothing is planted or skipped">${icon('x', 16)}<span>Discard</span></button>
        </div>
        <div bind="status" class="photo-stems__status"></div>
    </div>
`);

export class PhotoStemsPanelComponent extends Component {
    static styles = `
        .photo-stems {
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

            & .photo-stems__header {
                display: flex;
                align-items: center;
                gap: ${s('sm')};
                & h3 { margin: 0; flex: 1; ${panelTitle()} }
                & button { display: inline-flex; align-items: center; padding: 2px ${s('sm')}; ${btn()} }
            }
            & .photo-stems__row {
                display: flex;
                align-items: center;
                gap: ${s('sm')};
                & button { display: inline-flex; align-items: center; gap: ${s('xs')}; padding: 2px ${s('sm')}; ${btn()} }
                & button:disabled { opacity: 0.5; cursor: default; }
                & .photo-stems__accept { ${primaryBtn()} padding: 2px ${s('sm')}; }
            }
            & .photo-stems__count { flex: 1; color: ${t('color-text-secondary')}; white-space: nowrap; }
            & .photo-stems__status {
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
                &:empty { display: none; }
                &.error { color: ${t('color-status-negative')}; }
            }
        }
    `;

    private svc = this.inject(PhotoStemsService);
    private mapSvc = this.inject(MapService);

    render(): DocumentFragment {
        const svc = this.svc;
        const frag = this.wire(tpl, {
            root: { className: () => svc.courseId.get() ? 'photo-stems show' : 'photo-stems' },
            close: { onclick: () => svc.close() },
            find: { onclick: () => void svc.find(), disabled: () => !!svc.busy.get() },
            findLabel: { textContent: () => svc.busy.get() === 'find' ? 'Finding…' : 'Find' },
            count: { textContent: () => svc.proposals.get().length ? `${svc.acceptCount()} to plant` : '' },
            // Enabled with every ring skipped too: Accept then only remembers the skips.
            accept: { onclick: () => void svc.accept(), disabled: () => !!svc.busy.get() || svc.proposals.get().length === 0 },
            discard: { onclick: () => svc.discard(), disabled: () => !!svc.busy.get() || svc.proposals.get().length === 0 },
            status: {
                className: () => svc.error.get() ? 'photo-stems__status error' : 'photo-stems__status',
                textContent: () => svc.error.get() || svc.done.get() || svc.note.get()
                    || (svc.busy.get() === 'find' ? 'Reading the photo…' : ''),
            },
        });
        this.bindMap();
        return frag;
    }

    /** The rings on the map while there is a proposal, and a click on one skips (or takes back) that tree. */
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
            map.addOverlayLayer(OVERLAY_ID, data, [
                {
                    id: `${OVERLAY_ID}-kept`, type: 'line', filter: ['==', ['get', 'skipped'], false],
                    paint: { 'line-color': KEPT_COLOR, 'line-width': 2.5 },
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
            const id = this.svc.ringAt(x, y);
            if (id) this.svc.toggle(id);
        }));
        this.track(() => { if (added && map.ready.peek()) map.removeOverlayLayer(OVERLAY_ID); });
    }
}
