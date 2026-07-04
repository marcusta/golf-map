import { Component, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, primaryBtn, field } from '../css';
import { CourseDetailService } from '../course-detail/course-detail.service';
import { FeaturesService } from './features.service';
import { DrawToolService } from './draw-tool.service';
import { FEATURE_TYPES, FEATURE_STYLES } from './feature-palette';

const tpl = template(`
    <div class="draw-panel" bind="root">
        <div class="draw-panel__section">
            <h4 class="section-title">Feature type</h4>
            <div bind="types" class="type-grid"></div>
        </div>
        <div class="draw-panel__section">
            <button bind="newPoly" type="button" class="new-poly"></button>
            <div bind="drawHint" class="draw-hint"></div>
            <label class="hole-field">Hole
                <select bind="holeSelect"></select>
            </label>
        </div>
        <div bind="selection" class="draw-panel__section selection">
            <h4 class="section-title">Selection</h4>
            <div bind="selInfo" class="sel-info"></div>
            <button bind="deleteBtn" type="button" class="delete-btn">Delete feature</button>
        </div>
        <div bind="status" class="draw-panel__status"></div>
        <div class="draw-panel__hints">
            <div><b>N</b> new polygon &nbsp;·&nbsp; <b>Enter</b>/dbl-click close &nbsp;·&nbsp; <b>Esc</b> cancel</div>
            <div>Drag vertex to move · click edge to insert</div>
            <div><b>Alt</b>-drag vertex: curve · <b>Alt</b>-click: straighten</div>
            <div>Right-click vertex: remove · <b>Del</b> delete feature</div>
        </div>
    </div>
`);

const typeBtnTpl = template(`
    <button bind="button" type="button" class="type-btn">
        <span bind="swatch" class="type-swatch"></span>
        <span bind="name" class="type-name"></span>
    </button>
`);

/**
 * Side panel for the draw tool (spawned by the toolbar while the tool is
 * active). Shares DrawToolService/FeaturesService singletons with the
 * tool: the type grid sets the next polygon's type — or, with a selection,
 * re-types the selected feature (autosave); the hole select assigns the
 * selection (or the next polygon) to a hole; delete asks for confirmation.
 */
export class DrawPanelComponent extends Component {
    static styles = `
        .draw-panel {
            display: flex;
            flex-direction: column;
            font-size: 0.8rem;
            color: ${t('text')};

            & .draw-panel__section {
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

            & .type-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 2px;
            }

            & .type-btn {
                display: flex;
                align-items: center;
                gap: ${s('xs')};
                padding: 3px ${s('xs')};
                font-size: 0.72rem;
                border: 1px solid transparent;
                border-radius: ${t('radius-sm')};
                background: transparent;
                font-family: inherit;
                color: ${t('text')};
                cursor: pointer;
                text-align: left;
                &:hover { background: ${t('hover-bg')}; }
                &.active {
                    border-color: ${t('primary')};
                    background: ${t('hover-bg')};
                }
            }

            & .type-swatch {
                width: 12px;
                height: 12px;
                flex-shrink: 0;
                border-radius: 3px;
                border: 1px solid rgba(0, 0, 0, 0.25);
            }

            & .new-poly {
                padding: ${s('xs')} ${s('sm')};
                font-size: 0.8rem;
                ${primaryBtn()}
                &.drawing {
                    background: ${t('error')};
                    &:hover { background: ${t('error')}; }
                }
            }

            & .draw-hint {
                display: none;
                font-size: 0.72rem;
                color: ${t('text-muted')};
                &.show { display: block; }
            }

            & .hole-field { ${field()} }

            & .selection { display: none; }
            & .selection.show { display: flex; }

            & .sel-info {
                font-size: 0.75rem;
                color: ${t('text-muted')};
            }

            & .delete-btn {
                padding: ${s('xs')} ${s('sm')};
                font-size: 0.75rem;
                ${btn(t('radius-sm'))}
                color: ${t('error')};
                border-color: ${t('error')};
            }

            & .draw-panel__status {
                padding: ${s('xs')} ${s('md')};
                font-size: 0.72rem;
                color: ${t('text-muted')};
                min-height: 1.4em;
                &.error { color: ${t('error')}; }
            }

            & .draw-panel__hints {
                padding: ${s('xs')} ${s('md')} ${s('sm')};
                font-size: 0.68rem;
                line-height: 1.5;
                color: ${t('text-muted')};
                border-top: 1px solid ${t('border')};
            }
        }
    `;

    private tool = this.inject(DrawToolService);
    private features = this.inject(FeaturesService);
    private courseDetail = this.inject(CourseDetailService);
    private holeSelect!: HTMLSelectElement;

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            newPoly: {
                onclick: () => {
                    if (this.tool.state.isDrawing.peek()) this.tool.state.disarm();
                    else this.tool.state.arm();
                },
                textContent: () => this.tool.state.isDrawing.get() ? 'Cancel drawing (Esc)' : 'New polygon (N)',
                className: () => this.tool.state.isDrawing.get() ? 'new-poly drawing' : 'new-poly',
            },
            drawHint: {
                className: () => this.tool.state.isDrawing.get() ? 'draw-hint show' : 'draw-hint',
                textContent: () => {
                    const n = this.tool.state.draft.get().length;
                    return n === 0
                        ? 'Click the map to place the first point.'
                        : `${n} point${n === 1 ? '' : 's'} placed — Enter or double-click to close.`;
                },
            },
            selection: { className: () => this.features.selected.get() ? 'draw-panel__section selection show' : 'draw-panel__section selection' },
            selInfo: () => {
                const f = this.features.selected.get();
                if (!f) return '';
                const points = f.geometry.rings.reduce((sum, r) => sum + r.points.length, 0);
                const label = FEATURE_STYLES[f.type as keyof typeof FEATURE_STYLES]?.label ?? f.type;
                return `${label} · ${f.geometry.rings.length} ring${f.geometry.rings.length === 1 ? '' : 's'} · ${points} pts · v${f.version}`;
            },
            deleteBtn: { onclick: () => this.tool.deleteSelected() },
            status: {
                textContent: () => this.statusText(),
                className: () => this.statusIsError() ? 'draw-panel__status error' : 'draw-panel__status',
            },
        });

        // Feature type grid: with a selection → re-type it; otherwise set
        // the type for the next drawn polygon.
        const grid = this.ref(frag, 'types');
        for (const type of FEATURE_TYPES) {
            const style = FEATURE_STYLES[type];
            grid.appendChild(this.wireEl(typeBtnTpl, {
                button: {
                    onclick: () => {
                        const selected = this.features.selected.peek();
                        if (selected) void this.features.update(selected.id, { type });
                        else this.tool.drawType.set(type);
                    },
                    className: () => {
                        const selected = this.features.selected.get();
                        const current = selected ? selected.type : this.tool.drawType.get();
                        return current === type ? 'type-btn active' : 'type-btn';
                    },
                    title: style.label,
                },
                swatch: { 'style': `background:${style.fill}; border-color:${style.outline}` },
                name: { textContent: style.label },
            }));
        }

        this.holeSelect = this.ref(frag, 'holeSelect') as HTMLSelectElement;
        this.holeSelect.addEventListener('change', () => {
            const holeId = this.holeSelect.value || null;
            const selected = this.features.selected.peek();
            if (selected) void this.features.update(selected.id, { holeId });
            else this.tool.drawHoleId.set(holeId);
        });

        // Hole options + current value: rebuilt on holes load / selection /
        // draw-target changes (cheap — a course has ≤ 18 holes).
        this.track(effect(() => {
            const holes = this.courseDetail.holes.get();
            const selected = this.features.selected.get();
            const value = selected ? selected.holeId ?? '' : this.tool.drawHoleId.get() ?? '';
            this.holeSelect.textContent = '';
            const courseLevel = document.createElement('option');
            courseLevel.value = '';
            courseLevel.textContent = 'Course level';
            this.holeSelect.appendChild(courseLevel);
            for (const hole of holes) {
                const option = document.createElement('option');
                option.value = hole.id;
                option.textContent = `Hole ${hole.number} (par ${hole.par})`;
                this.holeSelect.appendChild(option);
            }
            this.holeSelect.value = value;
        }));

        return frag;
    }

    private statusText(): string {
        if (this.features.saving.get()) return 'Saving…';
        const saveError = this.features.saveError.get();
        if (saveError) return `Save failed: ${saveError.message}`;
        if (this.features.loading.get()) return 'Loading features…';
        const error = this.features.error.get();
        if (error) return `Load failed: ${error.message}`;
        const count = this.features.store.items.get().length;
        return `${count} feature${count === 1 ? '' : 's'} · autosaves on close & edit`;
    }

    private statusIsError(): boolean {
        return !!(this.features.saveError.get() || this.features.error.get());
    }
}
