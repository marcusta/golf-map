import { Component, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, primaryBtn, field, metric, panelTitle } from '../css';
import { FurnitureService, TEE_COLORS, PIN_DIFFICULTIES, type PlacementKind, type GreenPoint } from './furniture.service';
import { FurnitureToolService } from './furniture-tool.service';
import { CourseDetailService } from '../course-detail/course-detail.service';
import { teeFill } from './furniture-overlay';
import { icon } from '../ui/icons';

const tpl = template(`
    <div class="furn-panel" bind="root">
        <div class="furn-panel__section hole-tools">
            <h4 class="section-title">Course holes</h4>
            <div class="hole-tools__actions">
                <button bind="addHole" type="button" class="mini-btn">${icon('plus')} Add hole</button>
                <button bind="deleteHole" type="button" class="delete-btn">Delete hole</button>
            </div>
        </div>

        <div class="furn-panel__section">
            <h4 class="section-title">Place</h4>
            <div class="place-grid">
                <button bind="placeTee" type="button" class="place-btn">${icon('flag')} Tee</button>
                <button bind="placePin" type="button" class="place-btn">${icon('map-pin')} Pin</button>
                <button bind="placeAim" type="button" class="place-btn">${icon('diamond')} Aim</button>
                <button bind="placeGreen" type="button" class="place-btn">${icon('circle-dot')} Green</button>
            </div>
            <div bind="greenPointRow" class="green-point-row">
                <button bind="gpCenter" type="button" class="gp-btn">C</button>
                <button bind="gpFront" type="button" class="gp-btn">F</button>
                <button bind="gpBack" type="button" class="gp-btn">B</button>
            </div>
            <div bind="hint" class="place-hint"></div>
        </div>

        <div bind="teeAttrs" class="furn-panel__section attr">
            <h4 class="section-title">Tee</h4>
            <label class="attr-field">Name
                <input bind="teeName" type="text" placeholder="e.g. Yellow" />
            </label>
            <div class="swatch-row" bind="teeColors"></div>
        </div>

        <div bind="pinAttrs" class="furn-panel__section attr">
            <h4 class="section-title">Pin</h4>
            <label class="attr-field">Name
                <input bind="pinName" type="text" placeholder="e.g. Front-left" />
            </label>
            <label class="attr-field">Difficulty
                <select bind="pinDifficulty"></select>
            </label>
        </div>

        <div bind="selection" class="furn-panel__section selection">
            <h4 class="section-title">Selection</h4>
            <div bind="selCard" class="sel-card"></div>
            <div bind="reorder" class="reorder-row">
                <button bind="upBtn" type="button" class="mini-btn">${icon('arrow-up')} Up</button>
                <button bind="downBtn" type="button" class="mini-btn">${icon('arrow-down')} Down</button>
            </div>
            <button bind="setActiveBtn" type="button" class="mini-btn set-active">Set active pin</button>
            <button bind="deleteBtn" type="button" class="delete-btn">Delete</button>
        </div>

        <div bind="summary" class="furn-panel__section summary">
            <h4 class="section-title">Hole summary</h4>
            <div bind="summaryBody" class="summary-body"></div>
        </div>

        <div bind="status" class="furn-panel__status"></div>
    </div>
`);

/**
 * Side panel for the furniture tool (spawned by the toolbar while active).
 * Shares FurnitureService / FurnitureToolService singletons. Placement-mode
 * buttons arm tee/pin/aim placement with attribute pickers; the selection
 * card shows the selected item (type, name, elevation, hole, coords) with
 * reorder / set-active / delete; the summary counts the selected hole's
 * furniture.
 */
export class FurniturePanelComponent extends Component {
    static styles = `
        .furn-panel {
            display: flex;
            flex-direction: column;
            font-size: 0.8rem;
            color: ${t('color-text-primary')};

            /* Law 03: space-4 interior padding, space-2 row gap; hairlines
               only between these major-group sections (dock padding is 0). */
            & .furn-panel__section {
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

            & .place-grid {
                display: grid;
                grid-template-columns: 1fr 1fr 1fr 1fr;
                gap: 2px;
            }

            & .green-point-row {
                display: none;
                gap: 2px;
                &.show { display: grid; grid-template-columns: 1fr 1fr 1fr; }
            }
            & .gp-btn {
                padding: ${s('xs')} 2px;
                font-size: 0.72rem;
                font-weight: 600;
                ${btn(t('radius-sm'))}
                &.active {
                    border-color: ${t('color-accent-primary')};
                    color: ${t('color-on-accent')};
                    background: ${t('color-accent-primary')};
                }
            }

            & .place-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 3px;
                padding: ${s('xs')} 2px;
                font-size: 0.72rem;
                ${btn(t('radius-sm'))}
                &.active {
                    border-color: ${t('color-accent-primary')};
                    color: ${t('color-on-accent')};
                    background: ${t('color-accent-primary')};
                }
            }

            & .place-hint {
                display: none;
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
                &.show { display: block; }
                &.warn { color: ${t('color-status-negative')}; }
            }

            & .attr { display: none; &.show { display: flex; } }
            & .attr-field { ${field()} }

            & .swatch-row { display: flex; gap: ${s('xs')}; flex-wrap: wrap; }
            & .swatch {
                width: 22px;
                height: 22px;
                border-radius: 50%;
                border: 2px solid transparent;
                cursor: pointer;
                &.active { border-color: ${t('color-accent-primary')}; box-shadow: 0 0 0 1px ${t('color-accent-primary')}; }
            }

            & .selection { display: none; &.show { display: flex; } }
            & .sel-card { font-size: 0.75rem; line-height: 1.5; color: ${t('color-text-primary')}; }
            & .sel-card b { color: ${t('color-text-secondary')}; font-weight: 600; }
            & .sel-card .metric { ${metric()} font-size: 0.75rem; }

            & .hole-tools__actions {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: ${s('xs')};
            }

            & .reorder-row { display: none; gap: ${s('xs')}; &.show { display: flex; } }
            & .mini-btn {
                flex: 1;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 3px;
                padding: 3px ${s('xs')};
                font-size: 0.72rem;
                ${btn(t('radius-sm'))}
                &:disabled { opacity: 0.5; cursor: default; }
            }
            & .set-active { display: none; &.show { display: block; }
                &.is-active { color: ${t('color-text-secondary')}; }
            }

            & .delete-btn {
                padding: ${s('xs')} ${s('sm')};
                font-size: 0.75rem;
                ${btn(t('radius-sm'))}
                color: ${t('color-status-negative')};
                border-color: ${t('color-status-negative')};
                &.hide { display: none; }
                &:disabled { opacity: 0.5; cursor: default; }
            }

            & .summary { display: none; &.show { display: flex; } }
            & .summary-body { font-size: 0.75rem; line-height: 1.6; color: ${t('color-text-secondary')}; }
            & .summary-body b { color: ${t('color-text-primary')}; }
            & .summary-body .metric { ${metric()} font-size: 0.75rem; }

            /* Quiet footer (law 03): tertiary, transient only (saving/errors);
               the last section above already draws the major-group divider. */
            & .furn-panel__status {
                padding: var(--space-2) var(--space-4) var(--space-3);
                font-size: 0.7rem;
                color: ${t('color-text-tertiary')};
                min-height: 1.2em;
                &.error { color: ${t('color-status-negative')}; }
            }
        }
    `;

    private svc = this.inject(FurnitureService);
    private tool = this.inject(FurnitureToolService);
    private courseDetail = this.inject(CourseDetailService);

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            addHole: {
                onclick: () => void this.tool.addHole(),
                disabled: () => this.courseDetail.loading.get() || this.svc.saving.get(),
            },
            deleteHole: {
                onclick: () => void this.tool.deleteSelectedHole(),
                disabled: () => !this.tool.selectedHole.get() || this.courseDetail.loading.get() || this.svc.saving.get(),
            },
            placeTee: {
                onclick: () => this.svc.arm('tee'),
                className: () => this.placeClass('tee'),
            },
            placePin: {
                onclick: () => this.svc.arm('pin'),
                className: () => this.placeClass('pin'),
            },
            placeAim: {
                onclick: () => this.svc.arm('aim'),
                className: () => this.placeClass('aim'),
            },
            placeGreen: {
                onclick: () => this.svc.arm('green'),
                className: () => this.placeClass('green'),
            },
            greenPointRow: {
                className: () => this.svc.placing.get() === 'green' ? 'green-point-row show' : 'green-point-row',
            },
            gpCenter: {
                onclick: () => this.svc.pendingGreenPoint.set('center'),
                className: () => this.gpClass('center'),
            },
            gpFront: {
                onclick: () => this.svc.pendingGreenPoint.set('front'),
                className: () => this.gpClass('front'),
            },
            gpBack: {
                onclick: () => this.svc.pendingGreenPoint.set('back'),
                className: () => this.gpClass('back'),
            },
            hint: {
                textContent: () => this.svc.notice.get() ?? this.tool.placementHint.get() ?? '',
                className: () => {
                    const notice = this.svc.notice.get();
                    if (notice) return 'place-hint show warn';
                    const hint = this.tool.placementHint.get();
                    if (!hint) return 'place-hint';
                    const warn = /first|no green/.test(hint);
                    return `place-hint show${warn ? ' warn' : ''}`;
                },
            },
            teeAttrs: { className: () => this.svc.placing.get() === 'tee' ? 'furn-panel__section attr show' : 'furn-panel__section attr' },
            pinAttrs: { className: () => this.svc.placing.get() === 'pin' ? 'furn-panel__section attr show' : 'furn-panel__section attr' },
            selection: { className: () => this.svc.selection.get() ? 'furn-panel__section selection show' : 'furn-panel__section selection' },
            selCard: { textContent: () => '' }, // filled via effect (multiline)
            reorder: { className: () => this.reorderVisible() ? 'reorder-row show' : 'reorder-row' },
            upBtn: { onclick: () => this.moveSelected(-1) },
            downBtn: { onclick: () => this.moveSelected(1) },
            setActiveBtn: {
                onclick: () => { const p = this.svc.selectedPin.peek(); if (p) void this.svc.setPinActive(p.id); },
                className: () => {
                    const pin = this.svc.selectedPin.get();
                    if (!pin) return 'mini-btn set-active';
                    return pin.active ? 'mini-btn set-active show is-active' : 'mini-btn set-active show';
                },
                innerHTML: () => this.svc.selectedPin.get()?.active ? `Active pin ${icon('check')}` : 'Set active pin',
            },
            deleteBtn: {
                onclick: () => void this.tool.deleteSelected(),
                // Green points are structural — no delete for them.
                className: () => this.svc.selection.get()?.kind === 'green' ? 'delete-btn hide' : 'delete-btn',
            },
            summary: { className: () => this.tool.selectedHole.get() ? 'furn-panel__section summary show' : 'furn-panel__section summary' },
            summaryBody: { textContent: () => '' }, // filled via effect
            status: {
                textContent: () => this.statusText(),
                className: () => this.svc.saveError.get() || this.svc.error.get() ? 'furn-panel__status error' : 'furn-panel__status',
            },
        });

        // Tee colour swatches.
        const swatchRow = this.ref(frag, 'teeColors');
        for (const color of TEE_COLORS) {
            const btnEl = document.createElement('button');
            btnEl.type = 'button';
            btnEl.title = color;
            btnEl.style.background = teeFill(color);
            btnEl.addEventListener('click', () => this.svc.pendingTeeColor.set(color));
            this.track(effect(() => {
                btnEl.className = this.svc.pendingTeeColor.get() === color ? 'swatch active' : 'swatch';
            }));
            swatchRow.appendChild(btnEl);
        }

        // Tee name input ↔ pending signal.
        const teeName = this.ref(frag, 'teeName') as HTMLInputElement;
        teeName.addEventListener('input', () => this.svc.pendingTeeName.set(teeName.value));

        // Pin name input ↔ pending signal.
        const pinName = this.ref(frag, 'pinName') as HTMLInputElement;
        pinName.addEventListener('input', () => this.svc.pendingPinName.set(pinName.value));

        // Pin difficulty select.
        const pinDiff = this.ref(frag, 'pinDifficulty') as HTMLSelectElement;
        for (const d of PIN_DIFFICULTIES) {
            const opt = document.createElement('option');
            opt.value = d;
            opt.textContent = d.charAt(0).toUpperCase() + d.slice(1);
            pinDiff.appendChild(opt);
        }
        pinDiff.addEventListener('change', () => this.svc.pendingPinDifficulty.set(pinDiff.value as never));
        this.track(effect(() => { pinDiff.value = this.svc.pendingPinDifficulty.get(); }));

        // Multiline selection card (built imperatively so it can hold rows).
        const selCard = this.ref(frag, 'selCard');
        this.track(effect(() => { selCard.innerHTML = this.selectionCardHtml(); }));

        // Multiline hole summary.
        const summaryBody = this.ref(frag, 'summaryBody');
        this.track(effect(() => { summaryBody.innerHTML = this.summaryHtml(); }));

        return frag;
    }

    private placeClass(kind: Exclude<PlacementKind, null>): string {
        return this.svc.placing.get() === kind ? 'place-btn active' : 'place-btn';
    }

    private gpClass(point: GreenPoint): string {
        return this.svc.pendingGreenPoint.get() === point ? 'gp-btn active' : 'gp-btn';
    }

    private reorderVisible(): boolean {
        return !!(this.svc.selectedTee.get() || this.svc.selectedAim.get());
    }

    /** Move the selected tee/aim up (-1) or down (+1) in its hole ordering. */
    private moveSelected(delta: number): void {
        const tee = this.svc.selectedTee.peek();
        const aim = this.svc.selectedAim.peek();
        if (tee) {
            const ordered = this.svc.teesForHole(tee.holeId).map(x => x.id);
            const next = reorderIds(ordered, tee.id, delta);
            if (next) void this.svc.reorderTees(tee.holeId, next);
        } else if (aim) {
            const ordered = this.svc.aimsForHole(aim.holeId).map(x => x.id);
            const next = reorderIds(ordered, aim.id, delta);
            if (next) void this.svc.reorderAims(aim.holeId, next);
        }
    }

    private selectionCardHtml(): string {
        const tee = this.svc.selectedTee.get();
        if (tee) return card('Tee', tee.name, tee.holeId, tee.lat, tee.lon, tee.elevation, `color ${tee.color ?? '—'}`);
        const pin = this.svc.selectedPin.get();
        if (pin) {
            const green = this.svc.greens.peek().find(g => g.id === pin.greenId);
            const holeId = green?.holeId ?? null;
            return card('Pin', pin.name, holeId, pin.lat, pin.lon, null,
                `difficulty ${pin.difficulty ?? '—'}${pin.active ? ' · <b>ACTIVE</b>' : ''}`);
        }
        const aim = this.svc.selectedAim.get();
        if (aim) {
            const idx = this.svc.aimsForHole(aim.holeId).findIndex(a => a.id === aim.id);
            return card('Aim point', aim.label ?? `#${idx + 1}`, aim.holeId, aim.lat, aim.lon, aim.elevation, `order ${idx + 1}`);
        }
        const green = this.svc.selectedGreen.get();
        if (green) {
            const { green: g, point } = green;
            const pos = this.svc.greenPointPos(g, point);
            const label = point === 'center' ? 'center' : point === 'front' ? 'front' : 'back';
            const holeNo = this.courseDetail.holes.get().find(h => h.id === g.holeId)?.number;
            const name = holeNo !== undefined ? `${label} — hole ${holeNo}` : label;
            if (!pos) return card('Green', name, g.holeId, g.centerLat, g.centerLon, g.elevation, `point ${label}`);
            return card('Green', name, g.holeId, pos.lat, pos.lon, g.elevation, `point ${label} · structural (no delete)`);
        }
        return '';
    }

    private summaryHtml(): string {
        const hole = this.tool.selectedHole.get();
        if (!hole) return 'No hole selected.';
        const tees = this.svc.teesForHole(hole.id);
        const pins = this.svc.pinsForHole(hole.id);
        const aims = this.svc.aimsForHole(hole.id);
        const activePin = pins.find(p => p.active);
        const gp = this.svc.greenPointStatus(hole.id);
        const greenLine = gp
            ? `green: C${mark(gp.center)} F${mark(gp.front)} B${mark(gp.back)}`
            : 'green: none';
        // Hole number/par live in the left hole dock — only per-hole
        // completeness is this panel's to show.
        return [
            `${metricSpan(tees.length)} tee${plural(tees.length)}`,
            `${metricSpan(pins.length)} pin${plural(pins.length)}${activePin ? ` · active: <b>${escapeHtml(activePin.name)}</b>` : ''}`,
            `${metricSpan(aims.length)} aim point${plural(aims.length)}`,
            greenLine,
        ].join('<br>');
    }

    private statusText(): string {
        if (this.svc.saving.get()) return 'Saving…';
        const saveError = this.svc.saveError.get();
        if (saveError) return `Save failed: ${saveError.message}`;
        if (this.svc.loading.get()) return 'Loading furniture…';
        const error = this.svc.error.get();
        if (error) return `Load failed: ${error.message}`;
        return '';
    }
}

function card(
    type: string,
    name: string,
    holeId: string | null,
    lat: number,
    lon: number,
    elevation: number | null,
    extra: string,
): string {
    const elev = elevation !== null ? metricSpan(elevation.toFixed(1), 'm') : '—';
    return [
        `<b>${type}</b> · ${escapeHtml(name)}`,
        `${extra}`,
        `elevation ${elev}`,
        holeId ? `hole ${escapeHtml(holeId).slice(0, 8)}…` : 'no hole',
        `<span class="metric">${lat.toFixed(6)}, ${lon.toFixed(6)}</span>`,
    ].join('<br>');
}

/** Mono tabular numeric readout (guide §02) — optional unit dropped via `.metric__unit`. */
function metricSpan(value: string | number, unit?: string): string {
    return `<span class="metric">${value}${unit ? `<span class="metric__unit"> ${unit}</span>` : ''}</span>`;
}

/** Return a new ordering with `id` moved by `delta`, or null if it can't move. */
function reorderIds(ids: string[], id: string, delta: number): string[] | null {
    const i = ids.indexOf(id);
    if (i < 0) return null;
    const j = i + delta;
    if (j < 0 || j >= ids.length) return null;
    const next = [...ids];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
}

function plural(n: number): string {
    return n === 1 ? '' : 's';
}

/** ✓ when a green point is present, – when absent. */
function mark(present: boolean): string {
    return present ? '✓' : '–';
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
