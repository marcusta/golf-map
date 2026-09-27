import { Component, Computed, effect, template, untrack } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, field, glassPanel, panelTitle, selectedRow, OVERLAY_INSET } from '../css';
import { icon } from '../ui/icons';
import { EditorModeService } from '../editor/editor-mode.service';
import { CourseDetailService } from '../course-detail/course-detail.service';
import { PhotosService, previewUrl } from './photos.service';
import { PhotosToolService, PHOTOS_TOOL_ID } from './photos-tool.service';
import { distanceToNear, formatHeading, normalizeTag, option, photoYawDeg, type Photo } from './photo-filter';

const tpl = template(`
    <div class="photo-browser">
        <div bind="catalog" class="photo-catalog" data-testid="photo-catalog">
            <div bind="rows" class="photo-catalog__rows"></div>
            <div bind="empty" class="photo-catalog__empty"></div>
        </div>

        <div bind="card" class="photo-card" data-testid="photo-card">
            <button bind="cardImgBtn" type="button" class="photo-card__img" title="Open large">
                <img bind="cardImg" alt="" />
            </button>
            <div class="photo-card__body">
                <div bind="cardTitle" class="photo-card__title"></div>
                <div bind="cardMeta" class="photo-card__meta"></div>
                <div bind="cardTags" class="tag-editor"></div>
                <div class="photo-card__actions">
                    <button bind="cardPrev" type="button" class="mini-btn" title="Previous">${icon('chevron-left', 16)}</button>
                    <button bind="cardNext" type="button" class="mini-btn" title="Next">${icon('chevron-right', 16)}</button>
                    <span class="spacer"></span>
                    <button bind="cardOpen" type="button" class="mini-btn" data-testid="photo-card-open">${icon('maximize-2', 16)} Open</button>
                    <button bind="cardClose" type="button" class="mini-btn" title="Close">${icon('x', 16)}</button>
                </div>
            </div>
        </div>

        <div bind="viewer" class="photo-viewer" data-testid="photo-viewer">
            <div class="photo-viewer__stage">
                <img bind="viewerImg" alt="" />
                <div bind="viewerNoPreview" class="photo-viewer__missing">Preview not uploaded yet</div>
                <button bind="viewerPrev" type="button" class="nav nav--prev" aria-label="Previous photo">${icon('chevron-left', 24)}</button>
                <button bind="viewerNext" type="button" class="nav nav--next" aria-label="Next photo">${icon('chevron-right', 24)}</button>
            </div>
            <aside class="photo-viewer__side">
                <div class="side-head">
                    <span bind="viewerPos" class="side-pos"></span>
                    <button bind="viewerClose" type="button" class="mini-btn" aria-label="Close (Esc)" title="Close (Esc)">${icon('x', 16)}</button>
                </div>
                <div bind="viewerTitle" class="side-title"></div>
                <h4 class="section-title">Tags</h4>
                <div bind="viewerTags" class="tag-editor" data-testid="photo-tag-editor"></div>
                <input bind="newTag" type="text" class="new-tag" placeholder="Add a tag, Enter" aria-label="New tag" />
                <h4 class="section-title">Hole</h4>
                <select bind="viewerHole" aria-label="Photo hole"></select>
                <h4 class="section-title">Note</h4>
                <textarea bind="viewerNote" rows="3" aria-label="Note" placeholder="What does this photo show?"></textarea>
                <h4 class="section-title">Camera</h4>
                <dl bind="viewerMeta" class="meta"></dl>
                <div class="side-actions">
                    <button bind="viewerMap" type="button" class="mini-btn">${icon('map-pin', 16)} Show on map</button>
                    <a bind="viewerFull" class="mini-btn" target="_blank" rel="noopener">${icon('download', 16)} Full size</a>
                </div>
            </aside>
        </div>
    </div>
`);

function formatWhen(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const date = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return `${date} · ${time}`;
}

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * The Photos sub-mode's surfaces over the map canvas (spawned by
 * CourseDetailComponent into the editor canvas, like the export panel; shown
 * only while the Photos tool is active):
 *
 *  - List view: the catalog — every filtered photo as a row with its
 *    thumbnail, time, hole, direction, tags and note. Click opens the viewer.
 *  - Map view: a card for the photo selected on the map (click a marker).
 *  - The viewer: the photo large with ← / → through the filtered photos, and
 *    its tags, hole and note to edit.
 *
 * Thumbnails are the 2048 px previews loaded lazily; the server keeps no
 * smaller size.
 */
export class PhotoBrowserComponent extends Component {
    static styles = `
        .photo-browser { display: contents; }

        .photo-browser .mini-btn {
            display: inline-flex;
            align-items: center;
            gap: ${s('xs')};
            padding: ${s('xs')} ${s('sm')};
            font-size: 0.75rem;
            text-decoration: none;
            ${btn()}
        }
        .photo-browser .section-title { margin: ${s('sm')} 0 0; ${panelTitle()} }

        .photo-browser .tag-editor { display: flex; flex-wrap: wrap; gap: 6px; }
        .photo-browser .tag {
            padding: 3px 10px;
            border-radius: ${t('radius-pill')};
            border: 1px dashed ${t('color-border-default')};
            background: transparent;
            color: ${t('color-text-tertiary')};
            font: inherit;
            font-size: 0.75rem;
            cursor: pointer;
            &:hover { border-color: ${t('color-border-strong')}; color: ${t('color-text-primary')}; }
            &[aria-pressed="true"] {
                border-style: solid;
                border-color: ${t('color-accent-primary')};
                background: color-mix(in srgb, ${t('color-accent-primary')} 14%, transparent);
                color: ${t('color-text-primary')};
                font-weight: 600;
            }
        }

        /* ── catalog (list view) ── */
        .photo-catalog {
            position: absolute;
            inset: 0;
            z-index: 5;
            display: none;
            overflow-y: auto;
            padding: var(--space-4);
            background: ${t('color-surface-app')};
            &.show { display: block; }

            & .photo-catalog__rows {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(440px, 1fr));
                gap: var(--space-3);
            }
            & .photo-catalog__empty {
                color: ${t('color-text-secondary')};
                font-size: 0.9rem;
                padding: var(--space-6);
                text-align: center;
                &:empty { display: none; }
            }
        }
        .photo-row {
            display: flex;
            gap: var(--space-3);
            padding: var(--space-2);
            border: 1px solid ${t('color-border-subtle')};
            border-radius: var(--radius-md);
            background: ${t('color-surface-card')};
            box-shadow: var(--elev-1);
            cursor: pointer;
            text-align: left;
            font: inherit;
            color: ${t('color-text-primary')};
            transition: border-color var(--dur-fast) var(--ease-standard), box-shadow var(--dur-fast) var(--ease-standard);
            &:hover { border-color: ${t('color-border-strong')}; box-shadow: var(--elev-2); }
            &.is-selected { ${selectedRow()} }

            & .photo-row__thumb {
                flex: none;
                width: 176px;
                height: 132px;
                border-radius: 8px;
                overflow: hidden;
                background: ${t('color-surface-sunken')};
                display: flex;
                align-items: center;
                justify-content: center;
                color: ${t('color-text-tertiary')};
                font-size: 0.7rem;
                & img { width: 100%; height: 100%; object-fit: cover; display: block; }
            }
            & .photo-row__body {
                flex: 1;
                min-width: 0;
                display: flex;
                flex-direction: column;
                gap: 6px;
                padding: 2px 0;
                font-size: 0.8rem;
            }
            & .photo-row__title { font-weight: 600; display: flex; gap: ${s('sm')}; align-items: baseline; flex-wrap: wrap; }
            & .photo-row__meta { color: ${t('color-text-secondary')}; font-size: 0.75rem; font-variant-numeric: tabular-nums; }
            & .photo-row__tags { display: flex; flex-wrap: wrap; gap: 4px; }
            & .photo-row__tag {
                padding: 1px 8px;
                border-radius: ${t('radius-pill')};
                background: color-mix(in srgb, ${t('color-accent-primary')} 12%, transparent);
                font-size: 0.7rem;
            }
            & .photo-row__note {
                color: ${t('color-text-secondary')};
                font-style: italic;
                font-size: 0.75rem;
                overflow: hidden;
                display: -webkit-box;
                -webkit-line-clamp: 2;
                -webkit-box-orient: vertical;
            }
            & .photo-row__spacer { flex: 1; }
            & .photo-row__actions { display: flex; justify-content: flex-end; }
        }
        .photo-hole {
            font-size: 0.7rem;
            font-weight: 600;
            padding: 1px 7px;
            border-radius: ${t('radius-pill')};
            background: ${t('color-surface-sunken')};
            color: ${t('color-text-secondary')};
        }

        /* ── card (map view) ── */
        .photo-card {
            position: absolute;
            top: ${OVERLAY_INSET};
            left: ${OVERLAY_INSET};
            z-index: 6;
            width: 380px;
            max-height: calc(100% - 2 * ${OVERLAY_INSET});
            display: none;
            flex-direction: column;
            overflow: hidden auto;
            ${glassPanel()}
            padding: 0;
            font-size: 0.8rem;
            color: ${t('color-text-primary')};
            &.show { display: flex; }

            & .photo-card__img {
                border: none;
                padding: 0;
                background: ${t('color-surface-sunken')};
                cursor: zoom-in;
                display: block;
                & img { display: block; width: 100%; max-height: 300px; object-fit: contain; }
            }
            & .photo-card__body { display: flex; flex-direction: column; gap: ${s('sm')}; padding: var(--space-3); }
            & .photo-card__title { font-weight: 600; display: flex; gap: ${s('sm')}; align-items: baseline; }
            & .photo-card__meta { color: ${t('color-text-secondary')}; font-size: 0.75rem; font-variant-numeric: tabular-nums; }
            & .photo-card__actions { display: flex; gap: ${s('xs')}; align-items: center; & .spacer { flex: 1; } }
        }

        /* ── viewer ── */
        .photo-viewer {
            position: absolute;
            inset: 0;
            z-index: 8;
            display: none;
            background: rgba(10, 14, 12, 0.94);
            &.show { display: flex; }

            & .photo-viewer__stage {
                flex: 1;
                min-width: 0;
                position: relative;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: var(--space-4);
                & img { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
            }
            & .photo-viewer__missing { color: rgba(255, 255, 255, 0.6); display: none; &.show { display: block; } }
            & .nav {
                position: absolute;
                top: 50%;
                transform: translateY(-50%);
                width: 44px;
                height: 44px;
                border-radius: 999px;
                border: 1px solid rgba(255, 255, 255, 0.25);
                background: rgba(0, 0, 0, 0.45);
                color: #fff;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                &:hover { background: rgba(0, 0, 0, 0.7); }
            }
            & .nav--prev { left: var(--space-4); }
            & .nav--next { right: var(--space-4); }

            & .photo-viewer__side {
                flex: none;
                width: 300px;
                overflow-y: auto;
                display: flex;
                flex-direction: column;
                gap: ${s('sm')};
                padding: var(--space-3) var(--space-4) var(--space-4);
                background: ${t('color-surface-card')};
                color: ${t('color-text-primary')};
                font-size: 0.8rem;
            }
            & .side-head { display: flex; align-items: center; justify-content: space-between; }
            & .side-pos { color: ${t('color-text-secondary')}; font-variant-numeric: tabular-nums; }
            & .side-title { font-weight: 600; font-size: 0.95rem; display: flex; gap: ${s('sm')}; align-items: baseline; flex-wrap: wrap; }
            & select, & textarea, & .new-tag { ${field()} padding: ${s('xs')} ${s('sm')}; font: inherit; font-size: 0.8rem; }
            & textarea { resize: vertical; }
            & .meta {
                margin: 0;
                display: grid;
                grid-template-columns: auto 1fr;
                column-gap: ${s('sm')};
                row-gap: 2px;
                font-size: 0.75rem;
                & dt { color: ${t('color-text-secondary')}; }
                & dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
            }
            & .side-actions { display: flex; gap: ${s('sm')}; flex-wrap: wrap; margin-top: ${s('sm')}; }
        }
    `;

    private svc = this.inject(PhotosService);
    private tool = this.inject(PhotosToolService);
    private mode = this.inject(EditorModeService);
    private courseDetail = this.inject(CourseDetailService);

    private active = new Computed(() => this.mode.activeToolId.get() === PHOTOS_TOOL_ID);
    /** Only the selected photo's id and preview, so tag edits don't reload images. */
    private selectedImage = new Computed(() => {
        const p = this.svc.selected.get();
        return p ? `${p.id}|${previewUrl(p) ?? ''}` : '';
    });

    render(): DocumentFragment {
        const selected = () => this.svc.selected.get();
        const frag = this.wire(tpl, {
            catalog: {
                className: () => this.active.get() && this.svc.view.get() === 'list' && !this.svc.pickingPosition.get()
                    ? 'photo-catalog show' : 'photo-catalog',
            },
            empty: () => this.emptyText(),
            card: {
                className: () => this.active.get() && this.svc.view.get() === 'map' && selected() && !this.svc.viewerOpen.get()
                    ? 'photo-card show' : 'photo-card',
            },
            cardImgBtn: { onclick: () => this.openSelected() },
            cardOpen: { onclick: () => this.openSelected() },
            cardClose: { onclick: () => this.svc.select(null) },
            cardPrev: { onclick: () => this.svc.step(-1) },
            cardNext: { onclick: () => this.svc.step(1) },
            cardTitle: { innerHTML: () => { const p = selected(); return p ? this.titleHtml(p) : ''; } },
            cardMeta: () => { const p = selected(); return p ? this.metaLine(p) : ''; },

            viewer: {
                className: () => this.active.get() && this.svc.viewerOpen.get() && selected() ? 'photo-viewer show' : 'photo-viewer',
            },
            viewerPrev: { onclick: () => this.svc.step(-1) },
            viewerNext: { onclick: () => this.svc.step(1) },
            viewerClose: { onclick: () => this.svc.closeViewer() },
            viewerPos: () => {
                const list = this.svc.filtered.get();
                const i = list.findIndex(p => p.id === this.svc.selectedId.get());
                return i < 0 ? '' : `${i + 1} / ${list.length}`;
            },
            viewerTitle: { innerHTML: () => { const p = selected(); return p ? this.titleHtml(p) : ''; } },
            viewerMap: {
                onclick: () => {
                    const id = this.svc.selectedId.peek();
                    this.svc.closeViewer();
                    if (id) this.tool.showOnMap(id);
                },
            },
            viewerHole: {
                onchange: (e: Event) => {
                    const id = this.svc.selectedId.peek();
                    const v = (e.target as HTMLSelectElement).value;
                    if (id) void this.svc.setHole(id, v ? Number(v) : null);
                },
            },
            viewerNote: {
                onblur: (e: Event) => {
                    const id = this.svc.selectedId.peek();
                    if (id) void this.svc.setNote(id, (e.target as HTMLTextAreaElement).value);
                },
            },
            newTag: {
                onkeydown: (e: KeyboardEvent) => {
                    if (e.key !== 'Enter') return;
                    const input = e.target as HTMLInputElement;
                    const id = this.svc.selectedId.peek();
                    const photo = this.svc.selected.peek();
                    const tag = normalizeTag(input.value);
                    if (id && photo && tag && !photo.tags.includes(tag)) void this.svc.toggleTag(id, tag);
                    input.value = '';
                },
            },
        });

        this.renderCatalog(this.ref(frag, 'rows'));
        this.bindImage(this.ref(frag, 'cardImg') as HTMLImageElement);
        this.bindImage(this.ref(frag, 'viewerImg') as HTMLImageElement, this.ref(frag, 'viewerNoPreview'), this.ref(frag, 'viewerFull') as HTMLAnchorElement);
        this.bindTagEditor(this.ref(frag, 'cardTags'));
        this.bindTagEditor(this.ref(frag, 'viewerTags'));
        this.bindSideFields(
            this.ref(frag, 'viewerHole') as HTMLSelectElement,
            this.ref(frag, 'viewerNote') as HTMLTextAreaElement,
            this.ref(frag, 'viewerMeta'),
        );

        return frag;
    }

    onMount(): void {
        // ← / → step through the photos while the viewer or the card shows.
        const onKeyDown = (e: KeyboardEvent) => {
            if (!this.active.peek() || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
            const target = e.target as HTMLElement | null;
            if (target?.closest('input, textarea, select, [contenteditable]')) return;
            if (!this.svc.viewerOpen.peek() && !(this.svc.view.peek() === 'map' && this.svc.selectedId.peek())) return;
            e.preventDefault();
            this.svc.step(e.key === 'ArrowLeft' ? -1 : 1);
        };
        window.addEventListener('keydown', onKeyDown);
        this.track(() => window.removeEventListener('keydown', onKeyDown));
    }

    private openSelected(): void {
        const id = this.svc.selectedId.peek();
        if (id) this.svc.open(id);
    }

    private emptyText(): string {
        if (this.svc.loading.get()) return 'Loading photos…';
        if (this.svc.photos.get().length === 0) return 'No photos for this course’s site yet.';
        if (this.svc.filtered.get().length === 0) return 'No photos match the filters.';
        return '';
    }

    private titleHtml(p: Photo): string {
        const hole = p.hole !== null ? `<span class="photo-hole">Hole ${p.hole}</span>` : '';
        return `<span>${escapeHtml(formatWhen(p.capturedAt))}</span>${hole}`;
    }

    private metaLine(p: Photo): string {
        const parts = [`Looking ${formatHeading(photoYawDeg(p))}`, `GPS ±${Math.round(p.hAccM)} m`];
        const d = distanceToNear(p, this.svc.filter.get().near);
        if (d !== null) parts.unshift(`${Math.round(d)} m away`);
        return parts.join(' · ');
    }

    /** The catalog rows, rebuilt when the filtered list changes. */
    private renderCatalog(host: HTMLElement): void {
        const rowsById = new Map<string, HTMLElement>();
        this.track(effect(() => {
            const photos = this.svc.filtered.get();
            this.svc.filter.get(); // distances in the meta line
            untrack(() => {
                host.innerHTML = '';
                rowsById.clear();
                for (const p of photos) {
                    const row = this.catalogRow(p);
                    rowsById.set(p.id, row);
                    host.appendChild(row);
                }
                this.markSelected(rowsById, this.svc.selectedId.peek());
            });
        }));
        this.track(effect(() => {
            const id = this.svc.selectedId.get();
            untrack(() => this.markSelected(rowsById, id));
        }));
    }

    private markSelected(rows: Map<string, HTMLElement>, id: string | null): void {
        for (const [rowId, row] of rows) row.classList.toggle('is-selected', rowId === id);
    }

    private catalogRow(p: Photo): HTMLElement {
        const row = document.createElement('div');
        row.className = 'photo-row';
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        row.dataset.testid = 'photo-row';
        row.dataset.photoId = p.id;
        const url = previewUrl(p);
        const thumb = url
            ? `<img src="${url}" alt="" loading="lazy" decoding="async" />`
            : 'No preview yet';
        const tags = p.tags.map(tag => `<span class="photo-row__tag">${escapeHtml(tag)}</span>`).join('');
        const note = p.note ? `<div class="photo-row__note">${escapeHtml(p.note)}</div>` : '';
        row.innerHTML = `<div class="photo-row__thumb">${thumb}</div>`
            + `<div class="photo-row__body">`
            + `<div class="photo-row__title">${this.titleHtml(p)}</div>`
            + `<div class="photo-row__meta">${escapeHtml(this.metaLine(p))}</div>`
            + `<div class="photo-row__tags">${tags}</div>`
            + note
            + `<div class="photo-row__spacer"></div>`
            + `<div class="photo-row__actions"><button type="button" class="mini-btn" data-k="map">${icon('map-pin', 16)} Map</button></div>`
            + `</div>`;
        row.onclick = e => {
            if ((e.target as HTMLElement).closest('[data-k="map"]')) {
                this.tool.showOnMap(p.id);
                return;
            }
            this.svc.open(p.id);
        };
        row.onkeydown = e => {
            if (e.key === 'Enter') this.svc.open(p.id);
        };
        return row;
    }

    private bindImage(img: HTMLImageElement, missing?: HTMLElement, full?: HTMLAnchorElement): void {
        this.track(effect(() => {
            this.selectedImage.get();
            untrack(() => {
                const p = this.svc.selected.peek();
                const url = p ? previewUrl(p) : null;
                img.style.display = url ? '' : 'none';
                if (url) img.src = url;
                else img.removeAttribute('src');
                missing?.classList.toggle('show', !!p && !url);
                if (full) {
                    full.style.display = url ? '' : 'none';
                    if (url) full.href = url;
                }
            });
        }));
    }

    /** Toggle chips for every known tag, pressed where the photo has it. */
    private bindTagEditor(host: HTMLElement): void {
        this.track(effect(() => {
            const p = this.svc.selected.get();
            const tags = this.svc.tags.get();
            untrack(() => {
                host.innerHTML = '';
                if (!p) return;
                for (const tag of tags) {
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.className = 'tag';
                    b.dataset.tag = tag;
                    b.textContent = tag;
                    b.setAttribute('aria-pressed', String(p.tags.includes(tag)));
                    b.onclick = () => void this.svc.toggleTag(p.id, tag);
                    host.appendChild(b);
                }
            });
        }));
    }

    private bindSideFields(hole: HTMLSelectElement, note: HTMLTextAreaElement, meta: HTMLElement): void {
        this.track(effect(() => {
            const p = this.svc.selected.get();
            const holes = this.courseDetail.holes.get();
            untrack(() => {
                hole.innerHTML = '';
                hole.appendChild(option('No hole', ''));
                for (const h of holes) hole.appendChild(option(`Hole ${h.number}`, String(h.number)));
                hole.value = p?.hole != null ? String(p.hole) : '';
                if (document.activeElement !== note) note.value = p?.note ?? '';
                meta.innerHTML = p ? this.metaHtml(p) : '';
            });
        }));
    }

    private metaHtml(p: Photo): string {
        const rows: Array<[string, string]> = [
            ['Looking', formatHeading(photoYawDeg(p))],
            ['Tilt', `${p.pitchDeg.toFixed(1)}°`],
            ['Field of view', `${p.hfovDeg.toFixed(0)}° × ${p.vfovDeg.toFixed(0)}°`],
            ['GPS accuracy', `±${Math.round(p.hAccM)} m`],
        ];
        if (p.headingAccDeg !== null) rows.push(['Compass accuracy', `±${Math.round(p.headingAccDeg)}°`]);
        rows.push(['Heading', p.refineMethod
            ? `${p.refineMethod}${p.refineResidualDeg !== null ? ` (${p.refineResidualDeg.toFixed(1)}°)` : ''}`
            : 'sensor, not refined']);
        const d = distanceToNear(p, this.svc.filter.get().near);
        if (d !== null) rows.push(['From picked point', `${Math.round(d)} m`]);
        if (p.deviceModel) rows.push(['Device', p.deviceModel]);
        return rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');
    }
}
