import { Component, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s, panelTitle, iconBtn } from '../css';
import { icon } from '../ui/icons';
import {
    TerrainEditToolService,
    OP_GLYPHS,
    paramsSummary,
    type TerrainEditOp,
} from './terrain-edit-tool.service';

const tpl = template(`
    <div class="tedit-panel" bind="root" data-testid="terrain-edit-panel">
        <div class="section">
            <h4 class="section-title">New edit</h4>
            <select bind="opSelect" class="input" data-testid="terrain-edit-op" aria-label="Operation">
                <option value="plane">Plane fit — even fall</option>
                <option value="smooth">Smooth — kill spikes</option>
            </select>
            <label class="field">
                <span>Feather (m)</span>
                <input bind="featherInput" class="input input--num" type="number" min="0" step="0.5" data-testid="terrain-edit-feather" />
            </label>
            <label bind="radiusField" class="field">
                <span>Radius (m)</span>
                <input bind="radiusInput" class="input input--num" type="number" min="0.5" step="0.5" data-testid="terrain-edit-radius" />
            </label>
            <label bind="flatField" class="field field--check">
                <input bind="flatInput" type="checkbox" data-testid="terrain-edit-flat" />
                <span>Dead flat (level pad)</span>
            </label>
        </div>
        <div bind="savingLine" class="busy-line">Saving…</div>
        <div bind="notice" class="notice" data-testid="terrain-edit-notice"></div>
        <div class="section">
            <h4 class="section-title">Edits on this site</h4>
            <div bind="list" class="edit-list" data-testid="terrain-edit-list"></div>
            <div bind="empty" class="empty">No terrain edits yet.</div>
        </div>
        <button bind="applyBtn" type="button" class="apply-btn" data-testid="terrain-edit-apply">Apply to terrain</button>
        <div bind="applyLine" class="busy-line" data-testid="terrain-edit-apply-progress"></div>
        <div class="tedit-panel__hints">
            <div><b>Click</b> to outline the area (parking lot, road, house pad…).</div>
            <div><b>Click the first point</b> to save the edit; <b>Esc</b> discards the outline.</div>
            <div>Edits replay onto the DEM at build time — the raw lidar DEM stays pristine.</div>
        </div>
    </div>
`);

const rowTpl = template(`
    <div class="edit-row" bind="row" data-testid="terrain-edit-row">
        <span bind="glyph" class="edit-row__glyph"></span>
        <span class="edit-row__text">
            <span bind="opLabel" class="edit-row__op"></span>
            <span bind="params" class="edit-row__params"></span>
        </span>
        <button bind="toggleBtn" type="button" class="edit-row__btn" data-testid="terrain-edit-toggle"></button>
        <button bind="deleteBtn" type="button" class="edit-row__btn" data-testid="terrain-edit-delete" aria-label="Delete edit">${icon('trash-2', 16)}</button>
    </div>
`);

/**
 * Dock panel for the terrain-edit tool (hosted by the contextual right dock
 * via the EditorTool `panel` contract): op/params for the next drawn edit,
 * the site's edit list with enabled toggle + delete, and the "Apply to
 * terrain" button, which starts the fast re-terrain job (T56) and shows its
 * step progress while polling. Shares the TerrainEditToolService DI
 * singleton with the tool descriptor.
 */
export class TerrainEditPanelComponent extends Component {
    static styles = `
        .tedit-panel {
            /* Flat dock body (feature-dock.component.ts hosting contract). */
            display: flex;
            flex-direction: column;
            gap: var(--space-3);
            padding: var(--space-3) var(--space-4) var(--space-4);
            font-size: 0.8rem;
            color: ${t('color-text-primary')};

            & .section { display: flex; flex-direction: column; gap: ${s('xs')}; }
            & .section-title {
                margin: 0 0 ${s('xs')};
                ${panelTitle()}
            }

            & .input {
                width: 100%;
                font: inherit;
                padding: ${s('xs')} ${s('sm')};
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius-sm')};
                background: ${t('color-surface-card')};
                color: ${t('color-text-primary')};
            }

            & .field {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: ${s('sm')};
                & span { color: ${t('color-text-secondary')}; }
                & .input--num { width: 76px; text-align: right; }
                &.hidden { display: none; }
            }
            & .field--check {
                justify-content: flex-start;
                cursor: pointer;
                & input { margin: 0; }
            }

            & .busy-line {
                display: none;
                color: ${t('color-text-secondary')};
                &.show { display: block; }
            }
            & .notice {
                display: none;
                color: var(--data-bad);
                line-height: 1.4;
                &.show { display: block; }
            }

            & .edit-list { display: flex; flex-direction: column; gap: 2px; }
            & .empty {
                display: none;
                color: ${t('color-text-tertiary')};
                &.show { display: block; }
            }

            & .edit-row {
                display: flex;
                align-items: center;
                gap: ${s('sm')};
                padding: ${s('xs')} ${s('sm')};
                border-radius: ${t('radius-sm')};
                &:hover { background: color-mix(in srgb, ${t('color-text-primary')} 5%, transparent); }
                &.disabled .edit-row__text { opacity: 0.45; }
            }
            & .edit-row__glyph { color: #b653e6; font-weight: 700; flex: none; }
            & .edit-row__text {
                flex: 1;
                min-width: 0;
                display: flex;
                flex-direction: column;
                line-height: 1.3;
            }
            & .edit-row__op { font-weight: 600; text-transform: capitalize; }
            & .edit-row__params { font-size: 0.72rem; color: ${t('color-text-secondary')}; }
            & .edit-row__btn { ${iconBtn()} flex: none; }

            & .apply-btn {
                font: inherit;
                font-weight: 600;
                padding: ${s('sm')};
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius-sm')};
                background: ${t('color-surface-raised')};
                color: ${t('color-text-primary')};
                cursor: pointer;
                &:disabled { opacity: 0.45; cursor: not-allowed; }
            }

            & .tedit-panel__hints {
                padding-top: var(--space-3);
                border-top: 1px solid ${t('color-border-default')};
                display: flex;
                flex-direction: column;
                gap: ${s('xs')};
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
                line-height: 1.4;
            }
        }
    `;

    private tool = this.inject(TerrainEditToolService);

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            radiusField: { className: () => this.tool.op.get() === 'smooth' ? 'field' : 'field hidden' },
            flatField: { className: () => this.tool.op.get() === 'plane' ? 'field field--check' : 'field field--check hidden' },
            savingLine: { className: () => this.tool.saving.get() ? 'busy-line show' : 'busy-line' },
            notice: {
                textContent: () => this.tool.notice.get() ?? '',
                className: () => this.tool.notice.get() ? 'notice show' : 'notice',
            },
            empty: {
                className: () => !this.tool.loading.get() && this.tool.edits.get().length === 0 ? 'empty show' : 'empty',
            },
            applyBtn: {
                disabled: () => !this.tool.canApply.get(),
                textContent: () => this.tool.applying.get() ? 'Applying…' : 'Apply to terrain',
                title: 'Re-tile terrain + hillshade with the enabled edits (fast — no lidar/ortho refetch)',
                onclick: () => void this.tool.applyToTerrain(),
            },
            applyLine: {
                textContent: () => {
                    const step = this.tool.applyStep.get();
                    return step ? `${step}…` : '';
                },
                className: () => this.tool.applying.get() ? 'busy-line show' : 'busy-line',
            },
        });

        // Op / params controls — imperative two-way wiring (range/number
        // inputs need input events; sam-panel select pattern).
        const opSelect = this.ref(frag, 'opSelect') as HTMLSelectElement;
        opSelect.addEventListener('change', () => this.tool.op.set(opSelect.value as TerrainEditOp));
        this.track(effect(() => { opSelect.value = this.tool.op.get(); }));

        const featherInput = this.ref(frag, 'featherInput') as HTMLInputElement;
        featherInput.addEventListener('input', () => {
            const v = Number(featherInput.value);
            if (Number.isFinite(v) && v >= 0) this.tool.featherM.set(v);
        });
        this.track(effect(() => { featherInput.value = String(this.tool.featherM.get()); }));

        const radiusInput = this.ref(frag, 'radiusInput') as HTMLInputElement;
        radiusInput.addEventListener('input', () => {
            const v = Number(radiusInput.value);
            if (Number.isFinite(v) && v > 0) this.tool.radiusM.set(v);
        });
        this.track(effect(() => { radiusInput.value = String(this.tool.radiusM.get()); }));

        const flatInput = this.ref(frag, 'flatInput') as HTMLInputElement;
        flatInput.addEventListener('change', () => this.tool.flat.set(flatInput.checked));
        this.track(effect(() => { flatInput.checked = this.tool.flat.get(); }));

        // Edit list — one row per edit, keyed by id.
        this.$each(this.ref(frag, 'list'), this.tool.edits, (edit, _i, track) =>
            this.wireEl(rowTpl, {
                row: {
                    className: () => {
                        const current = this.tool.edits.get().find(e => e.id === edit.id) ?? edit;
                        return current.enabled ? 'edit-row' : 'edit-row disabled';
                    },
                },
                glyph: { textContent: OP_GLYPHS[edit.op] },
                opLabel: { textContent: edit.op },
                params: {
                    textContent: () => {
                        const current = this.tool.edits.get().find(e => e.id === edit.id) ?? edit;
                        return paramsSummary(current);
                    },
                },
                toggleBtn: {
                    innerHTML: () => {
                        const current = this.tool.edits.get().find(e => e.id === edit.id) ?? edit;
                        return icon(current.enabled ? 'eye' : 'eye-off', 16);
                    },
                    title: () => {
                        const current = this.tool.edits.get().find(e => e.id === edit.id) ?? edit;
                        return current.enabled ? 'Disable (skip at build time)' : 'Enable';
                    },
                    'aria-pressed': () => {
                        const current = this.tool.edits.get().find(e => e.id === edit.id) ?? edit;
                        return String(current.enabled);
                    },
                    onclick: () => {
                        const current = this.tool.edits.peek().find(e => e.id === edit.id) ?? edit;
                        void this.tool.setEnabled(edit.id, !current.enabled);
                    },
                },
                deleteBtn: {
                    onclick: () => void this.tool.remove(edit.id),
                    title: 'Delete edit',
                },
            }, track), edit => edit.id);

        return frag;
    }
}
