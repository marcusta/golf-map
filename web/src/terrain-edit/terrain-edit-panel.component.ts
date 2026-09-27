import { Component, Computed, Signal, effect, template, untrack } from '@basics/core/client/core';
import { t } from '../theme';
import { s, panelTitle, iconBtn } from '../css';
import { icon } from '../ui/icons';
import {
    TerrainEditToolService,
    OP_GLYPHS,
    DEFAULT_RADIUS_M,
    paramsSummary,
    type DigSettings,
    type EditGroup,
    type TerrainEditOp,
} from './terrain-edit-tool.service';
import type { TerrainEdit } from '../../../shared/api/terrain-edits.gen';
import {
    BUNKER_DIG, CREEK_DIG_PRESETS, DEFAULT_CREEK_DIG_PRESET, DEFAULT_WATER_DIG_PRESET, WATER_DIG_PRESETS,
} from '../../../shared/features/dig-presets';

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
        <div class="section">
            <h4 class="section-title">Generate</h4>
            <button bind="genPadsBtn" type="button" class="gen-btn" data-testid="terrain-edit-gen-pads"></button>
            <button bind="genRoadsBtn" type="button" class="gen-btn" data-testid="terrain-edit-gen-roads"></button>
            <button bind="genPondsBtn" type="button" class="gen-btn" data-testid="terrain-edit-gen-ponds"></button>
            <button bind="genBunkersBtn" type="button" class="gen-btn" data-testid="terrain-edit-gen-bunkers"></button>
            <button bind="genCreeksBtn" type="button" class="gen-btn" data-testid="terrain-edit-gen-creeks"></button>
            <div class="hint">Building pads: every OSM building footprint in the map area, measured on the lidar, gets a flat pad. Road grades: every OSM road, smoothed along and levelled across. Each run replaces its own previous edits only — yours stay. Then Apply to terrain.</div>
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
    <div class="edit-item" bind="item">
        <div class="edit-row" bind="row" data-testid="terrain-edit-row">
            <span bind="glyph" class="edit-row__glyph"></span>
            <span bind="text" class="edit-row__text" title="Show on the map">
                <span bind="name" class="edit-row__name" data-testid="terrain-edit-name"></span>
                <span bind="params" class="edit-row__params"></span>
            </span>
            <button bind="editBtn" type="button" class="edit-row__btn" data-testid="terrain-edit-change" aria-label="Change edit">${icon('pencil', 16)}</button>
            <button bind="toggleBtn" type="button" class="edit-row__btn" data-testid="terrain-edit-toggle"></button>
            <button bind="deleteBtn" type="button" class="edit-row__btn" data-testid="terrain-edit-delete" aria-label="Delete edit">${icon('trash-2', 16)}</button>
        </div>
        <div bind="form" class="edit-form" data-testid="terrain-edit-form"></div>
    </div>
`);

const groupTpl = template(`
    <button bind="head" type="button" class="edit-group" data-testid="terrain-edit-group">
        <span bind="chevron" class="edit-group__chevron"></span>
        <span bind="label" class="edit-group__label"></span>
        <span bind="count" class="edit-group__count"></span>
    </button>
`);

/** One entry of the edit list: a group's header, or one of its edits. */
type ListItem = { kind: 'group'; group: EditGroup } | { kind: 'edit'; edit: TerrainEdit; group: string };

/** The dig profiles a generated dig's form offers (bunkers have one fixed profile). */
function digPresetsOf(edit: TerrainEdit): { presets: Record<string, { label: string; depthM: number; bankSlopeDeg: number }>; fallback: string } | null {
    if (edit.origin === 'creek-digs') return { presets: CREEK_DIG_PRESETS, fallback: DEFAULT_CREEK_DIG_PRESET };
    if (edit.origin === 'water-digs') return { presets: WATER_DIG_PRESETS, fallback: DEFAULT_WATER_DIG_PRESET };
    return null;
}

const FEATURE_NOUNS: Record<string, string> = { 'creek-digs': 'creek', 'water-digs': 'pond', 'bunker-digs': 'bunker' };

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

            /* Name and buttons on one line, the summary across the whole row under them. */
            & .edit-row {
                display: grid;
                grid-template-columns: auto minmax(0, 1fr) auto auto auto;
                align-items: center;
                column-gap: ${s('sm')};
                padding: ${s('xs')} ${s('sm')};
                border-radius: ${t('radius-sm')};
                line-height: 1.3;
                &:hover { background: color-mix(in srgb, ${t('color-text-primary')} 5%, transparent); }
                &.disabled .edit-row__name, &.disabled .edit-row__params { opacity: 0.45; }
            }
            & .edit-row__glyph { color: #b653e6; font-weight: 700; grid-row: 1; }
            & .edit-row__text { display: contents; cursor: pointer; }
            & .edit-item.hidden { display: none; }
            & .edit-row__name { font-weight: 600; grid-column: 2; grid-row: 1; cursor: pointer; }
            & .edit-row__params { grid-column: 2 / -1; grid-row: 2; cursor: pointer; }
            & .edit-row__btn { grid-row: 1; }
            & .edit-row.highlight { background: color-mix(in srgb, #b653e6 12%, transparent); }
            & .edit-group {
                display: flex;
                align-items: center;
                gap: ${s('xs')};
                margin-top: ${s('xs')};
                padding: ${s('xs')} ${s('sm')};
                font: inherit;
                font-weight: 600;
                text-align: left;
                border: none;
                border-radius: ${t('radius-sm')};
                background: color-mix(in srgb, ${t('color-text-primary')} 6%, transparent);
                color: ${t('color-text-primary')};
                cursor: pointer;
            }
            & .edit-group__chevron { display: inline-flex; color: ${t('color-text-secondary')}; }
            & .edit-group__label { flex: 1; }
            & .edit-group__count { color: ${t('color-text-secondary')}; font-weight: 400; }
            & .edit-row__params { font-size: 0.72rem; color: ${t('color-text-secondary')}; }
            & .edit-row__btn { ${iconBtn()} flex: none; &.hidden { display: none; } }

            & .edit-form {
                display: none;
                flex-direction: column;
                gap: ${s('xs')};
                margin: 2px 0 ${s('sm')} 22px;
                padding: ${s('sm')};
                border-left: 2px solid #b653e6;
                background: color-mix(in srgb, ${t('color-text-primary')} 4%, transparent);
                border-radius: ${t('radius-sm')};
                &.show { display: flex; }
            }
            & .edit-form__actions { display: flex; gap: ${s('sm')}; justify-content: flex-end; }
            & .edit-form__actions button {
                font: inherit;
                padding: ${s('xs')} ${s('sm')};
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius-sm')};
                background: ${t('color-surface-raised')};
                color: ${t('color-text-primary')};
                cursor: pointer;
                &:disabled { opacity: 0.45; cursor: not-allowed; }
            }

            & .hint {
                color: ${t('color-text-tertiary')};
                line-height: 1.4;
            }
            & .gen-btn, & .apply-btn {
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
    /** The groups shown open; your own edits start open, the generated ones folded. */
    private expanded = new Signal<ReadonlySet<string>>(new Set(['hand']));

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
            genPadsBtn: {
                disabled: () => this.tool.generating.get() !== null || this.tool.applying.get(),
                textContent: () => this.tool.generating.get() === 'building-pads' ? 'Surveying buildings…' : 'Generate building pads',
                title: 'OSM building footprints + lidar roof heights → one flat pad per building on the inner terrain (the outer is scenery; its buildings are surveyed but not padded). Replaces the previous pads',
                onclick: () => void this.tool.generate('building-pads'),
            },
            genRoadsBtn: {
                disabled: () => this.tool.generating.get() !== null || this.tool.applying.get(),
                textContent: () => this.tool.generating.get() === 'road-grades' ? 'Grading roads…' : 'Grade roads',
                title: 'OSM road centerlines → one corridor edit per road, smooth along, level across (replaces the previous grades)',
                onclick: () => void this.tool.generate('road-grades'),
            },
            genPondsBtn: {
                disabled: () => this.tool.generating.get() !== null || this.tool.applying.get(),
                textContent: () => this.tool.generating.get() === 'water-digs' ? 'Digging ponds…' : 'Dig ponds',
                title: 'Each water feature dug below its water level (its dig preset, default Natural Pond); the shoreline stays at the level. Creeks are left alone. Replaces the previous pond digs',
                onclick: () => void this.tool.generate('water-digs'),
            },
            genBunkersBtn: {
                disabled: () => this.tool.generating.get() !== null || this.tool.applying.get(),
                textContent: () => this.tool.generating.get() === 'bunker-digs' ? 'Digging bunkers…' : 'Dig bunkers',
                title: 'Each bunker dug below the ground around it, steep face towards its green, gentle entry opposite. Replaces the previous bunker digs',
                onclick: () => void this.tool.generate('bunker-digs'),
            },
            genCreeksBtn: {
                disabled: () => this.tool.generating.get() !== null || this.tool.applying.get(),
                textContent: () => this.tool.generating.get() === 'creek-digs' ? 'Digging creeks…' : 'Dig creeks',
                title: 'Each creek\'s bed dug below its water surface, which only falls downstream — the level the R.A.M. creeks export puts the water at. Along its centerline, or the line found down its polygon. Replaces the previous creek digs',
                onclick: () => void this.tool.generate('creek-digs'),
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

        // Edit list — a header per group, then its edits (hidden while folded).
        const items = new Computed<ListItem[]>(() => this.tool.groups.get().flatMap(group => [
            { kind: 'group' as const, group },
            ...group.edits.map(edit => ({ kind: 'edit' as const, edit, group: group.key })),
        ]));
        this.$each(this.ref(frag, 'list'), items, (item, _i, track) =>
            item.kind === 'group' ? this.groupHeader(item.group, track) : this.editRow(item.edit, item.group, track),
        item => (item.kind === 'group' ? `group:${item.group.key}` : `${item.group}:${item.edit.id}`));

        // The open row's form, built fresh each time it opens.
        const list = this.ref(frag, 'list') as HTMLElement;
        this.track(effect(() => {
            const id = this.tool.editingId.get();
            untrack(() => {
                for (const host of list.querySelectorAll<HTMLElement>('.edit-form')) host.replaceChildren();
                const edit = this.tool.edits.peek().find(e => e.id === id);
                const host = edit ? list.querySelector<HTMLElement>(`[data-edit-id="${CSS.escape(edit.id)}"] .edit-form`) : null;
                if (!edit || !host) return;
                host.append(...(this.tool.formKind(edit) === 'dig' ? this.digForm(edit) : this.paramsForm(edit)));
            });
        }));

        return frag;
    }

    /** A group's header: click to fold or unfold it. */
    private groupHeader(group: EditGroup, track: (d: () => void) => void): HTMLElement {
        const open = () => this.expanded.get().has(group.key);
        return this.wireEl(groupTpl, {
            head: {
                'aria-expanded': () => String(open()),
                onclick: () => this.expanded.update(set => {
                    const next = new Set(set);
                    if (!next.delete(group.key)) next.add(group.key);
                    return next;
                }),
            },
            chevron: { innerHTML: () => icon(open() ? 'chevron-down' : 'chevron-right', 16) },
            label: { textContent: group.label },
            count: { textContent: () => String(this.tool.groups.get().find(g => g.key === group.key)?.edits.length ?? 0) },
        }, track);
    }

    /** One edit: its name and summary (click to show it on the map), change / enable / delete. */
    private editRow(edit: TerrainEdit, group: string, track: (d: () => void) => void): HTMLElement {
        return this.wireEl(rowTpl, {
                row: {
                    className: () => {
                        const current = this.tool.edits.get().find(e => e.id === edit.id) ?? edit;
                        const highlight = this.tool.view.get().highlightId === edit.id ? ' highlight' : '';
                        return (current.enabled ? 'edit-row' : 'edit-row disabled') + highlight;
                    },
                },
                glyph: { textContent: () => OP_GLYPHS[(this.tool.edits.get().find(e => e.id === edit.id) ?? edit).op] },
                text: { onclick: () => this.tool.zoomTo(edit.id) },
                name: { textContent: () => this.tool.editName(this.tool.edits.get().find(e => e.id === edit.id) ?? edit) },
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
                editBtn: {
                    className: () => this.tool.formKind(edit) ? 'edit-row__btn' : 'edit-row__btn hidden',
                    title: edit.origin
                        ? `Change this ${FEATURE_NOUNS[edit.origin] ?? ''} dig (saved on the feature, so re-running keeps it)`
                        : 'Change this edit',
                    'aria-expanded': () => String(this.tool.editingId.get() === edit.id),
                    onclick: () => this.tool.editingId.set(this.tool.editingId.peek() === edit.id ? null : edit.id),
                },
                deleteBtn: {
                    onclick: () => void this.tool.remove(edit.id),
                    title: edit.origin && FEATURE_NOUNS[edit.origin]
                        ? `Don't dig this ${FEATURE_NOUNS[edit.origin]} (marks the feature dig: false, so re-running leaves it out)`
                        : 'Delete edit',
                },
                item: {
                    'data-edit-id': edit.id,
                    className: () => (this.expanded.get().has(group) ? 'edit-item' : 'edit-item hidden'),
                    onmouseenter: () => this.tool.hoveredId.set(edit.id),
                    onmouseleave: () => { if (this.tool.hoveredId.peek() === edit.id) this.tool.hoveredId.set(null); },
                },
                form: {
                    className: () => this.tool.editingId.get() === edit.id ? 'edit-form show' : 'edit-form',
                },
            }, track);
    }

    /** A hand-drawn edit's op and params. */
    private paramsForm(edit: TerrainEdit): HTMLElement[] {
        const op = select([['plane', 'Plane fit — even fall'], ['smooth', 'Smooth — kill spikes']], edit.op);
        const feather = numberInput(edit.params.featherM ?? 0, 0, 0.5);
        const radius = numberInput(edit.params.radiusM ?? DEFAULT_RADIUS_M, 0.5, 0.5);
        const flat = document.createElement('input');
        flat.type = 'checkbox';
        flat.checked = edit.params.flat === true;
        const radiusField = field('Radius (m)', radius);
        const flatField = checkField('Dead flat (level pad)', flat);
        const sync = () => {
            radiusField.classList.toggle('hidden', op.value !== 'smooth');
            flatField.classList.toggle('hidden', op.value !== 'plane');
        };
        op.addEventListener('change', sync);
        sync();
        const save = () => this.tool.saveParams(edit.id, {
            op: op.value as 'plane' | 'smooth',
            featherM: Math.max(Number(feather.value) || 0, 0),
            radiusM: Math.max(Number(radius.value) || DEFAULT_RADIUS_M, 0.5),
            flat: flat.checked,
        });
        return [op, field('Feather (m)', feather), radiusField, flatField, this.actions(save)];
    }

    /** A generated dig's settings, saved on its feature. */
    private digForm(edit: TerrainEdit): HTMLElement[] {
        const current = this.tool.digSettings(edit);
        const noun = FEATURE_NOUNS[edit.origin ?? ''] ?? 'feature';
        if (!current) return [hint(`The ${noun} this dig was made from is not on this course.`)];
        const table = digPresetsOf(edit);
        const out: HTMLElement[] = [];
        let preset: HTMLSelectElement | null = null;
        if (table) {
            const def = table.presets[table.fallback];
            preset = select([['', `Default — ${def.label}`], ...Object.entries(table.presets).map(([k, p]) => [k, p.label] as [string, string])],
                current.preset && current.preset in table.presets ? current.preset : '');
            preset.setAttribute('data-testid', 'terrain-edit-dig-preset');
            out.push(preset);
        }
        const depth = optionalNumber(current.depthM, 0.05, 0.05);
        const bank = optionalNumber(current.bankSlopeDeg, 1, 1);
        const face = optionalNumber(current.faceSlopeDeg, 1, 1);
        const placeholders = () => {
            const p = table ? table.presets[preset!.value || table.fallback] : BUNKER_DIG;
            depth.placeholder = String(p.depthM);
            bank.placeholder = String(p.bankSlopeDeg);
            face.placeholder = String(BUNKER_DIG.faceSlopeDeg);
        };
        preset?.addEventListener('change', placeholders);
        placeholders();
        out.push(field('Depth (m)', depth), field(edit.origin === 'bunker-digs' ? 'Entry slope (°)' : 'Bank slope (°)', bank));
        if (edit.origin === 'bunker-digs') out.push(field('Face slope (°)', face));
        out.push(hint(`Saved on this ${noun}; an empty box uses the preset. Re-digs every ${noun}.`));
        const read = (el: HTMLInputElement) => (el.value.trim() === '' || !Number.isFinite(Number(el.value)) ? undefined : Number(el.value));
        const save = () => {
            const settings: DigSettings = { preset: preset?.value || undefined, depthM: read(depth), bankSlopeDeg: read(bank) };
            if (edit.origin === 'bunker-digs') settings.faceSlopeDeg = read(face);
            return this.tool.saveDigSettings(edit.id, settings);
        };
        out.push(this.actions(save));
        return out;
    }

    /** Save / Cancel; a successful save closes the form. */
    private actions(save: () => Promise<boolean>): HTMLElement {
        const row = document.createElement('div');
        row.className = 'edit-form__actions';
        const cancel = button('Cancel', () => this.tool.editingId.set(null));
        const ok = button('Save', async () => {
            ok.disabled = true;
            try {
                if (await save()) this.tool.editingId.set(null);
            } finally {
                ok.disabled = false;
            }
        });
        ok.setAttribute('data-testid', 'terrain-edit-save');
        row.append(cancel, ok);
        return row;
    }
}

function select(options: Array<[string, string]>, value: string): HTMLSelectElement {
    const el = document.createElement('select');
    el.className = 'input';
    for (const [v, label] of options) el.add(new Option(label, v));
    el.value = value;
    return el;
}

function numberInput(value: number, min: number, step: number): HTMLInputElement {
    const el = document.createElement('input');
    el.type = 'number';
    el.className = 'input input--num';
    el.min = String(min);
    el.step = String(step);
    el.value = String(value);
    return el;
}

function optionalNumber(value: number | undefined, min: number, step: number): HTMLInputElement {
    const el = numberInput(0, min, step);
    el.value = value === undefined ? '' : String(value);
    return el;
}

function field(label: string, input: HTMLElement): HTMLElement {
    const el = document.createElement('label');
    el.className = 'field';
    const span = document.createElement('span');
    span.textContent = label;
    el.append(span, input);
    return el;
}

function checkField(label: string, input: HTMLInputElement): HTMLElement {
    const el = document.createElement('label');
    el.className = 'field field--check';
    const span = document.createElement('span');
    span.textContent = label;
    el.append(input, span);
    return el;
}

function hint(text: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'hint';
    el.textContent = text;
    return el;
}

function button(label: string, onclick: () => void): HTMLButtonElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.textContent = label;
    el.addEventListener('click', onclick);
    return el;
}
