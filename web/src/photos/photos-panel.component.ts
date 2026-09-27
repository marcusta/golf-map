import { Component, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, field, panelTitle, segmented, ghostBtn } from '../css';
import { icon } from '../ui/icons';
import { infoTip, infoTipStyles, attachInfoTips } from '../ui/info-tip';
import { CourseDetailService } from '../course-detail/course-detail.service';
import { PhotosService } from './photos.service';
import { HOLE_NEAR_M, NEAR_RADII_M, isFilterActive, option } from './photo-filter';

const tpl = template(`
    <div class="photos-panel" bind="root" data-testid="photos-panel">
        <div class="view-switch" role="group" aria-label="Browse as">
            <button bind="listBtn" type="button" data-testid="photos-view-list">List</button>
            <button bind="mapBtn" type="button" data-testid="photos-view-map">Map</button>
        </div>

        <div class="section">
            <h4 class="section-title">Hole ${infoTip({ text: `Photos the phone tagged with the hole, or taken within ${HOLE_NEAR_M} m of its play line (tees, aim points, green).` })}</h4>
            <select bind="holeSel" class="field-select" aria-label="Hole" data-testid="photos-filter-hole"></select>
        </div>

        <div class="section">
            <h4 class="section-title">Near a position</h4>
            <div bind="nearIdle" class="near-row">
                <button bind="pickBtn" type="button" class="mini-btn" data-testid="photos-pick-position">${icon('crosshair', 16)} Pick on map</button>
            </div>
            <div bind="nearPicking" class="near-hint">Click the map where you want photos from. <button bind="cancelPick" type="button" class="link-btn">Cancel</button></div>
            <div bind="nearSet" class="near-row">
                <label class="radius">Within
                    <select bind="radiusSel" aria-label="Radius" data-testid="photos-near-radius"></select>
                </label>
                <button bind="repickBtn" type="button" class="mini-btn" title="Pick another point">${icon('crosshair', 16)}</button>
                <button bind="clearNear" type="button" class="mini-btn" title="Clear position">${icon('x', 16)}</button>
            </div>
        </div>

        <div class="section">
            <div class="tags-head">
                <h4 class="section-title">Tags</h4>
                <div bind="modeSwitch" class="mode-switch" role="group" aria-label="Tag match">
                    <button bind="anyBtn" type="button" title="Photos with any of the chosen tags">Any</button>
                    <button bind="allBtn" type="button" title="Photos with all of the chosen tags">All</button>
                </div>
            </div>
            <div bind="tagChips" class="chips" data-testid="photos-filter-tags"></div>
        </div>

        <div class="summary">
            <span bind="count" data-testid="photos-count"></span>
            <button bind="clearAll" type="button" class="link-btn">Clear filters</button>
        </div>
        <div bind="status" class="status"></div>
    </div>
`);

/**
 * Dock panel of the Photos sub-mode (ContextDockComponent hosts it flat):
 * the List / Map switch and the filters — hole, a picked position with a
 * radius, and tags. The photos themselves show over the canvas
 * (PhotoBrowserComponent) or on the map (PhotosToolService).
 */
export class PhotosPanelComponent extends Component {
    static styles = `
        .photos-panel {
            display: flex;
            flex-direction: column;
            gap: var(--space-4);
            padding: var(--space-3) var(--space-4) var(--space-4);
            font-size: 0.8rem;
            color: ${t('color-text-primary')};
            ${infoTipStyles()}

            & .view-switch {
                ${segmented()}
                display: flex;
                & > button { flex: 1; padding: ${s('xs')} ${s('sm')}; font-size: 0.8rem; }
            }

            & .section { display: flex; flex-direction: column; gap: ${s('sm')}; }
            & .section-title { margin: 0; display: flex; align-items: center; gap: ${s('xs')}; ${panelTitle()} }
            & select { ${field()} padding: ${s('xs')} ${s('sm')}; font-size: 0.8rem; }
            & .field-select { width: 100%; }

            & .mini-btn {
                display: inline-flex;
                align-items: center;
                gap: ${s('xs')};
                padding: ${s('xs')} ${s('sm')};
                font-size: 0.75rem;
                ${btn()}
            }
            & .link-btn {
                ${ghostBtn()}
                padding: 0 ${s('xs')};
                font-size: 0.75rem;
                text-decoration: underline;
            }

            & .near-row { display: none; align-items: center; gap: ${s('sm')}; &.show { display: flex; } }
            & .near-hint {
                display: none;
                color: ${t('color-text-secondary')};
                line-height: 1.4;
                &.show { display: block; }
            }
            & .radius {
                display: flex;
                align-items: center;
                gap: ${s('xs')};
                flex: 1;
                color: ${t('color-text-secondary')};
            }

            & .tags-head { display: flex; align-items: center; justify-content: space-between; }
            & .mode-switch {
                ${segmented()}
                padding: 2px;
                border-radius: 9px;
                & > button { padding: 1px ${s('sm')}; font-size: 0.7rem; border-radius: 7px; }
            }
            & .chips { display: flex; flex-wrap: wrap; gap: 6px; }
            & .chip {
                padding: 3px 10px;
                border-radius: ${t('radius-pill')};
                border: 1px solid ${t('color-border-default')};
                background: ${t('color-surface-raised')};
                color: ${t('color-text-secondary')};
                font: inherit;
                font-size: 0.75rem;
                cursor: pointer;
                &:hover { border-color: ${t('color-border-strong')}; color: ${t('color-text-primary')}; }
                &[aria-pressed="true"] {
                    background: color-mix(in srgb, ${t('color-accent-primary')} 14%, transparent);
                    border-color: ${t('color-accent-primary')};
                    color: ${t('color-text-primary')};
                    font-weight: 600;
                }
                & .n { margin-left: 4px; opacity: 0.6; font-variant-numeric: tabular-nums; }
                &.untagged { font-style: italic; }
            }

            & .summary {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding-top: var(--space-3);
                border-top: 1px solid ${t('color-border-default')};
                color: ${t('color-text-secondary')};
                font-variant-numeric: tabular-nums;
                & .link-btn { visibility: hidden; }
                & .link-btn.show { visibility: visible; }
            }
            & .status {
                color: ${t('color-text-secondary')};
                line-height: 1.4;
                &:empty { display: none; }
                &.error { color: ${t('color-status-negative')}; }
            }
        }
    `;

    private svc = this.inject(PhotosService);
    private courseDetail = this.inject(CourseDetailService);

    render(): DocumentFragment {
        const near = () => this.svc.filter.get().near;
        const picking = () => this.svc.pickingPosition.get();
        const frag = this.wire(tpl, {
            listBtn: {
                onclick: () => this.svc.setView('list'),
                'aria-pressed': () => (this.svc.view.get() === 'list'),
            },
            mapBtn: {
                onclick: () => this.svc.setView('map'),
                'aria-pressed': () => (this.svc.view.get() === 'map'),
            },
            holeSel: {
                onchange: (e: Event) => {
                    const v = (e.target as HTMLSelectElement).value;
                    this.svc.patchFilter({ hole: v ? Number(v) : null });
                },
            },
            nearIdle: { className: () => (!near() && !picking() ? 'near-row show' : 'near-row') },
            nearPicking: { className: () => (picking() ? 'near-hint show' : 'near-hint') },
            nearSet: { className: () => (near() && !picking() ? 'near-row show' : 'near-row') },
            pickBtn: { onclick: () => this.svc.pickingPosition.set(true) },
            repickBtn: { onclick: () => this.svc.pickingPosition.set(true) },
            cancelPick: { onclick: () => this.svc.pickingPosition.set(false) },
            clearNear: { onclick: () => this.svc.patchFilter({ near: null }) },
            radiusSel: {
                onchange: (e: Event) => {
                    const current = this.svc.filter.peek().near;
                    if (current) this.svc.patchFilter({ near: { ...current, radiusM: Number((e.target as HTMLSelectElement).value) } });
                },
            },
            anyBtn: {
                onclick: () => this.svc.patchFilter({ tagMode: 'any' }),
                'aria-pressed': () => (this.svc.filter.get().tagMode === 'any'),
            },
            allBtn: {
                onclick: () => this.svc.patchFilter({ tagMode: 'all' }),
                'aria-pressed': () => (this.svc.filter.get().tagMode === 'all'),
            },
            count: () => {
                const total = this.svc.photos.get().length;
                const shown = this.svc.filtered.get().length;
                return shown === total ? `${total} photo${total === 1 ? '' : 's'}` : `${shown} of ${total} photos`;
            },
            clearAll: {
                onclick: () => this.svc.clearFilter(),
                className: () => (isFilterActive(this.svc.filter.get()) || picking() ? 'link-btn show' : 'link-btn'),
            },
            status: {
                className: () => (this.svc.error.get() || this.svc.saveError.get() ? 'status error' : 'status'),
                textContent: () => this.statusText(),
            },
        });

        const holeSel = this.ref(frag, 'holeSel') as HTMLSelectElement;
        this.track(effect(() => {
            const holes = this.courseDetail.holes.get();
            const selected = this.svc.filter.get().hole;
            holeSel.innerHTML = '';
            holeSel.appendChild(option('All holes', ''));
            for (const hole of holes) holeSel.appendChild(option(`Hole ${hole.number}`, String(hole.number)));
            holeSel.value = selected === null ? '' : String(selected);
        }));

        const radiusSel = this.ref(frag, 'radiusSel') as HTMLSelectElement;
        for (const r of NEAR_RADII_M) radiusSel.appendChild(option(`${r} m`, String(r)));
        this.track(effect(() => {
            const r = this.svc.filter.get().near?.radiusM;
            if (r !== undefined) radiusSel.value = String(r);
        }));

        const chips = this.ref(frag, 'tagChips');
        this.track(effect(() => {
            const tags = this.svc.tags.get();
            const photos = this.svc.photos.get();
            const f = this.svc.filter.get();
            const counts = new Map<string, number>();
            for (const p of photos) for (const tag of p.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
            chips.innerHTML = '';
            for (const tag of tags) {
                chips.appendChild(this.chip(tag, counts.get(tag) ?? 0, !f.untagged && f.tags.includes(tag), () => this.svc.toggleFilterTag(tag)));
            }
            const untagged = photos.filter(p => p.tags.length === 0).length;
            const u = this.chip('untagged', untagged, f.untagged, () => this.svc.patchFilter({ untagged: !f.untagged, tags: [] }));
            u.classList.add('untagged');
            chips.appendChild(u);
        }));

        this.track(attachInfoTips(this.ref(frag, 'root')));
        return frag;
    }

    private chip(label: string, n: number, pressed: boolean, onclick: () => void): HTMLButtonElement {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.dataset.tag = label;
        b.setAttribute('aria-pressed', String(pressed));
        b.innerHTML = `${label}<span class="n">${n}</span>`;
        b.onclick = onclick;
        return b;
    }

    private statusText(): string {
        const err = this.svc.saveError.get() ?? this.svc.error.get();
        if (err) return err.code === 'conflict' ? 'The photo changed elsewhere; reloaded. Try again.' : err.message;
        if (this.svc.loading.get()) return 'Loading photos…';
        if (!this.courseDetail.course.get()) return '';
        if (!this.svc.siteId.get()) return 'This course has no site. Photos belong to a site.';
        if (this.svc.photos.get().length === 0) {
            return 'No photos yet. Take them with the camera button on the course screen in the iPhone app; the builder pulls them from the VPS (bun run photos-pull).';
        }
        return '';
    }
}
