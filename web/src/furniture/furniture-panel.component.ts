import { Component, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, field, metric } from '../css';
import { sectionTitle } from '../editor/panel-recipes.css';
import { FurnitureService, TEE_COLORS, PIN_DAYS, PIN_DIFFICULTIES, defaultTeeName, type PlacementKind, type GreenPoint, type TeeSetPatch } from './furniture.service';
import type { TeeSet } from '../../../shared/api/tee-sets.gen';
import { FurnitureToolService } from './furniture-tool.service';
import { PIN_RING_RADIUS_M, type PinTerrainMode } from './pin-terrain';
import { slopeColor } from '../analysis/analysis-math';
import { HEIGHT_GRADIENT, SLOPE_GRADIENT } from '../analysis/analysis-panel.component';
import { CourseDetailService } from '../course-detail/course-detail.service';
import { teeFill } from './furniture-overlay';
import { icon } from '../ui/icons';
import { FeaturesService } from '../draw/features.service';
import { FEATURE_STYLES, RULES_TYPES, isRulesType, type FeatureType } from '../draw/feature-palette';

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
            <div class="tee-pick" bind="teeSetPick" data-testid="furniture-tee-set-pick"></div>
        </div>

        <div bind="pinAttrs" class="furn-panel__section attr">
            <h4 class="section-title">Pin</h4>
            <div class="pin-days" bind="pinDay" data-testid="furniture-pin-day"></div>
            <label class="attr-field">Difficulty
                <select bind="pinDifficulty"></select>
            </label>
            <label class="attr-field">Show on the green
                <select bind="pinTerrain" data-testid="furniture-pin-terrain">
                    <option value="slope">Slope</option>
                    <option value="height">Height</option>
                    <option value="off">Nothing</option>
                </select>
            </label>
            <div bind="pinLegend" class="pin-legend">
                <div bind="pinLegendBar" class="pin-legend__bar"></div>
                <div bind="pinLegendLabels" class="pin-legend__labels"></div>
            </div>
            <div bind="pinTerrainNote" class="place-hint"></div>
            <div bind="pinActions" class="reorder-row">
                <button bind="pinSetActive" type="button" class="mini-btn"></button>
                <button bind="pinDelete" type="button" class="delete-btn">Delete pin</button>
            </div>
        </div>

        <div class="furn-panel__section">
            <h4 class="section-title">Rules lines</h4>
            <div bind="ruleButtons" class="place-grid rules-grid"></div>
            <div bind="ruleHint" class="place-hint"></div>
        </div>

        <div bind="ruleSelection" class="furn-panel__section selection">
            <h4 class="section-title">Selected line</h4>
            <div bind="ruleCard" class="sel-card"></div>
            <div bind="ruleRetype" class="rules-grid"></div>
            <button bind="ruleDelete" type="button" class="delete-btn">Delete</button>
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

        <div class="furn-panel__section">
            <h4 class="section-title">Tee sets</h4>
            <div bind="teeSetRows" class="tee-sets" data-testid="furniture-tee-sets"></div>
            <div class="tee-set__head tee-set__new">
                <span bind="newSetSwatch" class="tee-set__dot"></span>
                <input bind="newSetName" class="tee-set__name" type="text" placeholder="New set" aria-label="New tee set name" />
                <select bind="newSetColor" class="tee-set__color" aria-label="Colour"></select>
                <button bind="addSet" type="button" class="mini-btn tee-set__add" data-testid="furniture-tee-set-add">Add</button>
            </div>
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

            ${sectionTitle('0')}

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

            & .rules-grid {
                display: grid;
                grid-template-columns: 1fr 1fr 1fr;
                gap: 2px;
            }
            & .rule-dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                flex: none;
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
            /* One button per pin day: the day, then how steep its pin lies. */
            & .pin-days { display: grid; grid-template-columns: 1fr 1fr; gap: ${s('xs')}; }
            & .pin-day {
                display: flex;
                flex-direction: column;
                align-items: flex-start;
                gap: 1px;
                padding: 3px ${s('sm')};
                font-size: 0.72rem;
                ${btn(t('radius-sm'))}
                &.active { border-color: ${t('color-accent-primary')}; box-shadow: 0 0 0 1px ${t('color-accent-primary')}; }
            }
            & .pin-day__slope {
                display: inline-flex;
                align-items: center;
                gap: ${s('xs')};
                font-size: 0.68rem;
                color: ${t('color-text-secondary')};
                font-variant-numeric: tabular-nums;
            }
            & .pin-day__dot { width: 8px; height: 8px; border-radius: 50%; flex: none; &.hide { display: none; } }
            /* The ramp the green is shaded by while pins are placed. */
            & .pin-legend { display: flex; flex-direction: column; gap: 2px; &.hide { display: none; } }
            & .pin-legend__bar { height: 8px; border-radius: 2px; border: 1px solid ${t('color-border-default')}; }
            & .pin-legend__labels {
                display: flex;
                justify-content: space-between;
                font-size: 0.68rem;
                color: ${t('color-text-secondary')};
                font-variant-numeric: tabular-nums;
            }

            & .swatch-row { display: flex; gap: ${s('xs')}; flex-wrap: wrap; }
            & .swatch {
                width: 22px;
                height: 22px;
                border-radius: 50%;
                border: 2px solid transparent;
                cursor: pointer;
                &.active { border-color: ${t('color-accent-primary')}; box-shadow: 0 0 0 1px ${t('color-accent-primary')}; }
            }

            & .tee-pick { display: flex; flex-wrap: wrap; gap: ${s('xs')}; }
            & .tee-pick__btn {
                display: inline-flex;
                align-items: center;
                gap: ${s('xs')};
                padding: 3px ${s('sm')};
                font-size: 0.72rem;
                ${btn(t('radius-sm'))}
                &.active { border-color: ${t('color-accent-primary')}; box-shadow: 0 0 0 1px ${t('color-accent-primary')}; }
            }
            & .tee-sets { display: flex; flex-direction: column; gap: var(--space-2); &:empty { display: none; } }
            /* One card per set: what the club calls it, its two ratings, then the quiet facts. */
            & .tee-set {
                display: flex;
                flex-direction: column;
                gap: ${s('xs')};
                padding: ${s('sm')};
                border: 1px solid ${t('color-border-subtle')};
                border-radius: ${t('radius-sm')};
                background: ${t('color-surface-card')};
            }
            & .tee-set__head, & .tee-set__ratings, & .tee-set__foot {
                display: flex;
                align-items: center;
                gap: ${s('xs')};
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
                & input[type=text], & select { min-width: 0; font-size: 0.72rem; padding: 2px ${s('xs')}; }
            }
            & .tee-set__new { padding: 0 ${s('sm')}; }
            & .tee-set .tee-set__name { font-weight: 600; color: ${t('color-text-primary')}; }
            /* One line per gender: label, course rating / slope. */
            & .tee-set__ratings {
                display: grid;
                grid-template-columns: 3.4rem 1fr auto 1fr;
                gap: ${s('xs')};
                & input[type=text] { width: 100%; box-sizing: border-box; text-align: right; font-variant-numeric: tabular-nums; }
            }
            & .tee-set__foot { justify-content: space-between; font-size: 0.7rem; color: ${t('color-text-tertiary')}; }
            & .tee-set__only { display: inline-flex; align-items: center; gap: ${s('xs')}; color: ${t('color-text-secondary')}; cursor: pointer; }
            & .tee-set__dot { width: 12px; height: 12px; border-radius: 50%; flex: none; border: 1px solid ${t('color-border-default')}; }
            & .tee-set__name { flex: 1; }
            & .tee-set__color { flex: none; width: 4.6rem; }
            & .tee-set__count { font-variant-numeric: tabular-nums; }
            & .tee-set__add, & .tee-set__del { flex: none; }
            & .tee-set__del { padding: 0 ${s('xs')}; background: none; border: none; cursor: pointer; color: ${t('color-text-secondary')}; }

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
    private features = this.inject(FeaturesService);
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
                onclick: () => this.tool.armPin(),
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
            pinTerrain: {
                value: () => this.tool.pinTerrain.mode.get(),
                onchange: (e: Event) => this.tool.pinTerrain.mode.set((e.target as HTMLSelectElement).value as PinTerrainMode),
            },
            pinLegend: { className: () => (this.tool.pinTerrain.mode.get() === 'off' ? 'pin-legend hide' : 'pin-legend') },
            pinLegendBar: {
                style: () => `background: ${this.tool.pinTerrain.mode.get() === 'height' ? HEIGHT_GRADIENT : SLOPE_GRADIENT}`,
            },
            pinLegendLabels: {
                innerHTML: () => (this.tool.pinTerrain.mode.get() === 'height' ? ['Low', 'High'] : ['0%', '1%', '3%', '5%', '7%+'])
                    .map(label => `<span>${label}</span>`).join(''),
            },
            pinTerrainNote: {
                textContent: () => (this.tool.pinTerrain.loading.get() ? 'Reading the green…' : this.tool.pinTerrain.note.get()),
                className: () => (this.tool.pinTerrain.loading.get() || this.tool.pinTerrain.note.get() ? 'place-hint show' : 'place-hint'),
            },
            // A pin is picked and read in the Pin section's day buttons, not here.
            selection: {
                className: () => {
                    const sel = this.svc.selection.get();
                    return sel && sel.kind !== 'pin' ? 'furn-panel__section selection show' : 'furn-panel__section selection';
                },
            },
            pinActions: { className: () => (this.svc.selectedPin.get() ? 'reorder-row show' : 'reorder-row') },
            pinSetActive: {
                onclick: () => { const p = this.svc.selectedPin.peek(); if (p) void this.svc.setPinActive(p.id); },
                disabled: () => !!this.svc.selectedPin.get()?.active,
                innerHTML: () => (this.svc.selectedPin.get()?.active ? `Active pin ${icon('check')}` : 'Set active pin'),
            },
            pinDelete: { onclick: () => void this.tool.deleteSelected() },
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
            ruleHint: {
                textContent: () => this.ruleHint(),
                className: () => (this.tool.drawingRule.get() ? 'place-hint show' : 'place-hint'),
            },
            ruleSelection: {
                className: () => (this.selectedRules().length > 0 ? 'furn-panel__section selection show' : 'furn-panel__section selection'),
            },
            ruleCard: { textContent: () => '' }, // filled via effect (multiline)
            ruleDelete: { onclick: () => void this.tool.rules.deleteSelected() },
            summary: { className: () => this.tool.selectedHole.get() ? 'furn-panel__section summary show' : 'furn-panel__section summary' },
            summaryBody: { textContent: () => '' }, // filled via effect
            status: {
                textContent: () => this.statusText(),
                className: () => this.svc.saveError.get() || this.svc.error.get() ? 'furn-panel__status error' : 'furn-panel__status',
            },
        });

        // Tee placement: which of the course's tee sets the next tee goes on.
        const teeSetPick = this.ref(frag, 'teeSetPick');
        this.track(effect(() => {
            const picked = this.svc.pendingTeeSet()?.id;
            teeSetPick.replaceChildren(...this.svc.teeSets.get().map(set => {
                const btnEl = document.createElement('button');
                btnEl.type = 'button';
                btnEl.className = set.id === picked ? 'tee-pick__btn active' : 'tee-pick__btn';
                btnEl.innerHTML = '<span class="tee-set__dot"></span>';
                (btnEl.firstChild as HTMLElement).style.background = teeFill(set.color);
                btnEl.append(set.name);
                btnEl.addEventListener('click', () => this.svc.pendingTeeSetId.set(set.id));
                return btnEl;
            }));
        }));

        // The course's tee sets. Rows are kept per set and only refreshed in
        // place, so a save answering while the next field is being typed in
        // does not take that field away.
        const teeSetRows = this.ref(frag, 'teeSetRows');
        const rows = new Map<string, { el: HTMLElement; show: (set: TeeSet) => void }>();
        this.track(effect(() => {
            const sets = this.svc.teeSets.get();
            for (const [id, row] of rows) {
                if (!sets.some(s => s.id === id)) { row.el.remove(); rows.delete(id); }
            }
            for (const set of sets) {
                let row = rows.get(set.id);
                if (!row) {
                    row = this.teeSetRow(set.id);
                    rows.set(set.id, row);
                }
                teeSetRows.appendChild(row.el);  // (re)places it in the course's order
                row.show(set);
            }
        }));

        // New tee set: colour + name; the name defaults to the colour's.
        const newSetColor = this.ref(frag, 'newSetColor') as HTMLSelectElement;
        const newSetName = this.ref(frag, 'newSetName') as HTMLInputElement;
        const newSetSwatch = this.ref(frag, 'newSetSwatch') as HTMLElement;
        fillColors(newSetColor);
        const showNewColor = () => {
            newSetSwatch.style.background = teeFill(newSetColor.value || null);
            newSetName.placeholder = newSetColor.value ? defaultTeeName(newSetColor.value) : 'New set';
        };
        newSetColor.addEventListener('change', showNewColor);
        const addSet = async () => {
            const name = newSetName.value.trim() || (newSetColor.value ? defaultTeeName(newSetColor.value) : '');
            if (!name) { this.svc.notice.set('Name the tee set, or pick its colour.'); return; }
            if (await this.svc.createTeeSet(name, newSetColor.value || null)) {
                newSetName.value = '';
                // On to the next colour the course has no set of.
                const used = new Set(this.svc.teeSets.peek().map(s => s.color));
                newSetColor.value = TEE_COLORS.find(c => !used.has(c)) ?? '';
                showNewColor();
            }
        };
        this.ref(frag, 'addSet').addEventListener('click', () => void addSet());
        newSetName.addEventListener('keydown', e => { if (e.key === 'Enter') void addSet(); });
        this.track(effect(() => {
            if (document.activeElement === newSetName || document.activeElement === newSetColor) return;
            const used = new Set(this.svc.teeSets.get().map(s => s.color));
            newSetColor.value = TEE_COLORS.find(c => !used.has(c)) ?? '';
            showNewColor();
        }));

        // Pin day select: the four positions GreenKeeper/GSPro keep per green.
        // One button per day; a day the hole's green already has a pin for is
        // marked, since placing it again moves that pin.
        const pinDay = this.ref(frag, 'pinDay');
        for (const day of PIN_DAYS) {
            const dayBtn = document.createElement('button');
            dayBtn.type = 'button';
            dayBtn.innerHTML = '<span></span><span class="pin-day__slope"><span class="pin-day__dot"></span><span></span></span>';
            const [name, slopeRow] = [...dayBtn.children] as HTMLElement[];
            const [dot, slopeText] = [...slopeRow.children] as HTMLElement[];
            dayBtn.addEventListener('click', () => this.svc.pendingPinDay.set(day));
            this.track(effect(() => {
                const hole = this.tool.selectedHole.get();
                const green = hole ? this.svc.greens.get().find(g => g.holeId === hole.id) : undefined;
                this.svc.pins.items.get();  // re-read once that day's pin exists, or moves
                const pin = green ? this.svc.pinForDay(green.id, day) : undefined;
                const slope = pin ? this.tool.pinTerrain.slopeAt(pin.lat, pin.lon) : null;
                dayBtn.className = this.svc.pendingPinDay.get() === day ? 'pin-day active' : 'pin-day';
                name.textContent = day;
                dot.className = slope ? 'pin-day__dot' : 'pin-day__dot hide';
                if (slope) dot.style.background = `rgb(${slopeColor(slope.atPin).join(', ')})`;
                slopeText.textContent = !pin ? 'not placed'
                    : slope ? `${slope.atPin.toFixed(1)}% · max ${slope.maxInRing.toFixed(1)}%` : 'placed';
                dayBtn.title = !pin ? `Place ${day}'s pin`
                    : `${day}'s pin is placed: a click on the map moves it.`
                        + (slope ? ` Slope ${slope.atPin.toFixed(1)}% at the hole, ${slope.maxInRing.toFixed(1)}% at the steepest within ${PIN_RING_RADIUS_M} m.` : '');
            }));
            pinDay.appendChild(dayBtn);
        }

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

        // Rules-line arm buttons (toggle) and the selected line's retype row.
        const ruleButtons = this.ref(frag, 'ruleButtons');
        const ruleRetype = this.ref(frag, 'ruleRetype');
        for (const type of RULES_TYPES) {
            const arm = ruleButton(type);
            arm.addEventListener('click', () => this.tool.armRule(type));
            this.track(effect(() => {
                arm.className = this.tool.drawingRule.get() === type ? 'place-btn active' : 'place-btn';
            }));
            ruleButtons.appendChild(arm);

            const retype = ruleButton(type);
            retype.addEventListener('click', () => this.tool.rules.retypeSelection(type));
            this.track(effect(() => {
                const selected = this.selectedRules();
                retype.className = selected.length > 0 && selected.every(f => f.type === type) ? 'place-btn active' : 'place-btn';
            }));
            ruleRetype.appendChild(retype);
        }
        const ruleCard = this.ref(frag, 'ruleCard');
        this.track(effect(() => { ruleCard.innerHTML = this.ruleCardHtml(); }));

        // Multiline selection card (built imperatively so it can hold rows).
        const selCard = this.ref(frag, 'selCard');
        this.track(effect(() => { selCard.innerHTML = this.selectionCardHtml(); }));

        // Multiline hole summary.
        const summaryBody = this.ref(frag, 'summaryBody');
        this.track(effect(() => { summaryBody.innerHTML = this.summaryHtml(); }));

        return frag;
    }

    /** The selected rules lines (the rules engine only ever selects those here). */
    private selectedRules() {
        return this.features.selectedFeatures.get().filter(f => isRulesType(f.type));
    }

    private holeLabel(holeId: string | null): string {
        if (!holeId) return 'course level';
        const hole = this.courseDetail.holes.get().find(h => h.id === holeId);
        return hole ? `hole ${hole.number}` : 'a hole';
    }

    private ruleHint(): string {
        const type = this.tool.drawingRule.get();
        if (!type) return '';
        return `Drawing ${FEATURE_STYLES[type].label} on ${this.holeLabel(this.tool.rules.drawHoleId.get())} — click to add points, `
            + 'click the first point or Enter to close, press-drag to trace, Esc to cancel.';
    }

    private ruleCardHtml(): string {
        const selected = this.selectedRules();
        if (selected.length === 0) return '';
        if (selected.length > 1) return `<b>${selected.length} lines</b>`;
        const f = selected[0]!;
        const points = f.geometry.rings.reduce((n, ring) => n + ring.points.length, 0);
        return [
            `<b>${escapeHtml(FEATURE_STYLES[f.type as FeatureType]?.label ?? f.type)}</b> · ${this.holeLabel(f.holeId)}`,
            `${metricSpan(points)} point${plural(points)}`,
        ].join('<br>');
    }

    /**
     * One tee set's card: name, colour, the men's and women's course rating
     * and slope, how many holes have a tee of it, and whether it exists for
     * GSPro alone. Every field saves on change. What GSPro calls the set and
     * which rating it shows are the GSPro export panel's.
     */
    private teeSetRow(id: string): { el: HTMLElement; show: (set: TeeSet) => void } {
        const el = document.createElement('div');
        el.className = 'tee-set';
        el.dataset.testid = 'furniture-tee-set';
        el.innerHTML = `
            <div class="tee-set__head">
                <span class="tee-set__dot"></span>
                <input class="tee-set__name" type="text" aria-label="Name" />
                <select class="tee-set__color" aria-label="Colour"></select>
                <button type="button" class="tee-set__del" title="Delete the tee set" aria-label="Delete the tee set">×</button>
            </div>
            <div class="tee-set__ratings" title="Course rating / slope">
                <span>Men</span>
                <input data-k="ratingMen" type="text" inputmode="decimal" placeholder="CR" aria-label="Course rating, men" />
                <span>/</span>
                <input data-k="slopeMen" type="text" inputmode="numeric" placeholder="slope" aria-label="Slope, men" />
                <span>Women</span>
                <input data-k="ratingWomen" type="text" inputmode="decimal" placeholder="CR" aria-label="Course rating, women" />
                <span>/</span>
                <input data-k="slopeWomen" type="text" inputmode="numeric" placeholder="slope" aria-label="Slope, women" />
            </div>
            <div class="tee-set__foot">
                <span class="tee-set__count" title="Holes with a tee of this set"></span>
                <label class="tee-set__only" title="A set only GSPro has, like Junior or Par3: left out of the course guide">
                    <input type="checkbox" data-testid="furniture-tee-set-gspro-only" /> GSPro only
                </label>
            </div>`;
        const dot = el.querySelector('.tee-set__dot') as HTMLElement;
        const color = el.querySelector('.tee-set__color') as HTMLSelectElement;
        const name = el.querySelector('.tee-set__name') as HTMLInputElement;
        const count = el.querySelector('.tee-set__count') as HTMLElement;
        const gsproOnly = el.querySelector('.tee-set__only input') as HTMLInputElement;
        const numbers = [...el.querySelectorAll<HTMLInputElement>('input[data-k]')];
        fillColors(color);
        let shown: TeeSet | null = null;
        const save = (patch: TeeSetPatch) => { void this.svc.updateTeeSet(id, patch).then(ok => { if (!ok && shown) show(shown, true); }); };

        color.addEventListener('change', () => save({ color: color.value || null }));
        name.addEventListener('change', () => {
            if (name.value.trim()) save({ name: name.value.trim() });
            else if (shown) name.value = shown.name;
        });
        gsproOnly.addEventListener('change', () => save({ gsproOnly: gsproOnly.checked }));
        for (const input of numbers) {
            const key = input.dataset.k as 'ratingMen' | 'slopeMen' | 'ratingWomen' | 'slopeWomen';
            input.addEventListener('change', () => {
                const value = parseRating(input.value, key.startsWith('slope'));
                if (value === undefined) {
                    this.svc.notice.set(key.startsWith('slope')
                        ? 'A slope is a whole number between 55 and 155.'
                        : 'A course rating is a number between 40 and 90, e.g. 71.5.');
                    if (shown) input.value = shown[key]?.toString() ?? '';
                    return;
                }
                this.svc.notice.set(null);
                save({ [key]: value });
            });
        }
        el.querySelector('.tee-set__del')!.addEventListener('click', () => void this.svc.removeTeeSet(id));

        const show = (set: TeeSet, force = false) => {
            shown = set;
            const idle = (field: HTMLElement) => force || document.activeElement !== field;
            dot.style.background = teeFill(set.color);
            if (idle(color)) color.value = set.color && TEE_COLORS.includes(set.color as never) ? set.color : '';
            if (idle(name)) name.value = set.name;
            count.textContent = `${set.teeCount} tee${set.teeCount === 1 ? '' : 's'}`;
            gsproOnly.checked = set.gsproOnly;
            for (const input of numbers) {
                if (idle(input)) input.value = set[input.dataset.k as 'ratingMen']?.toString() ?? '';
            }
        };
        return { el, show };
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

/** The colour options of a tee set: none, then the presets. */
function fillColors(select: HTMLSelectElement): void {
    for (const value of ['', ...TEE_COLORS]) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = value ? defaultTeeName(value) : 'No colour';
        select.appendChild(opt);
    }
}

/**
 * A typed course rating (40–90, one decimal) or slope (55–155, whole): the
 * number, null for blank (clear it), undefined when it is neither.
 */
function parseRating(text: string, slope: boolean): number | null | undefined {
    const trimmed = text.trim().replace(',', '.');
    if (!trimmed) return null;
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return undefined;
    if (slope) return Number.isInteger(n) && n >= 55 && n <= 155 ? n : undefined;
    return n >= 40 && n <= 90 ? Math.round(n * 10) / 10 : undefined;
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

/** A rules-type button: its line colour as a dot, then the short label. */
function ruleButton(type: FeatureType): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'place-btn';
    const dot = document.createElement('span');
    dot.className = 'rule-dot';
    dot.style.background = FEATURE_STYLES[type].outline;
    button.append(dot, FEATURE_STYLES[type].label.replace(' penalty', ''));
    button.title = FEATURE_STYLES[type].label;
    return button;
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
