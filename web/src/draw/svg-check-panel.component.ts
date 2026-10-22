// Check shapes: the Draw mode's floating panel for SvgCheckService. Header with Run again and close, one summary
// line, then one line per finding grouped Errors / Warnings, with Notes and Accepted folded. A row = severity dot,
// the shapes it names, a short code label; the message is the row's tooltip. A click focuses the finding (selects
// its shapes, moves the map there); the check button accepts an error or warning, Undo takes it back. On the map the
// findings' geometries: red errors, amber warnings, the focused one thicker.
//
// Spawned by CourseDetailComponent like Assign to holes; opened from the stack panel's "Check shapes…" and from an
// export error that starts with `SVG check:` ("Open errors").

import { Component, effect, template, untrack } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, glassPanel, panelTitle, OVERLAY_W, OVERLAY_INSET } from '../css';
import { icon } from '../ui/icons';
import { MapService } from '../map/map.service';
import { EditorModeService } from '../editor/editor-mode.service';
import { ServerModeService, visibleEditorTools } from '../app/server-mode.service';
import { HIDDEN_SHAPE, SvgCheckService, codeLabel, shapesLabel } from './svg-check.service';
import type { SvgCheckFinding } from '../../../shared/api/gspro-export.gen';
import type { ExpressionSpecification } from 'maplibre-gl';

const OVERLAY_ID = 'svg-check';
const ERROR = '#ef4444';
const WARNING = '#f59e0b';
const NOTE = '#9ca3af';

const tpl = template(`
    <div bind="root" class="svg-check" data-testid="svg-check-panel">
        <div class="svg-check__header">
            <h3 title="The GSPro SVG export's checks on the shapes as they are now. Errors stop the export until fixed or accepted; nothing is written.">Check shapes</h3>
            <button bind="run" type="button" data-testid="svg-check-run" title="Run the checks again">${icon('redo', 16)}<span>Run again</span></button>
            <button bind="close" type="button" aria-label="Close" title="Close">${icon('x')}</button>
        </div>
        <div bind="summary" class="svg-check__summary" data-testid="svg-check-summary"></div>
        <div bind="status" class="svg-check__status" data-testid="svg-check-status"></div>
        <div bind="list" class="svg-check__list" data-testid="svg-check-list"></div>
    </div>
`);

type Group = 'error' | 'warning' | 'note' | 'accepted';

export class SvgCheckPanelComponent extends Component {
    static styles = `
        .svg-check {
            position: absolute;
            top: ${OVERLAY_INSET};
            left: ${OVERLAY_INSET};
            width: ${OVERLAY_W.standard};
            max-width: calc(100% - 2 * ${OVERLAY_INSET});
            max-height: 50%;
            z-index: 6;
            display: none;
            flex-direction: column;
            gap: ${s('xs')};
            ${glassPanel()}
            padding: var(--space-3) var(--space-4);
            font-size: 0.78rem;
            color: ${t('color-text-primary')};
            &.show { display: flex; }

            & .svg-check__header {
                display: flex;
                align-items: center;
                gap: ${s('sm')};
                & h3 { margin: 0; flex: 1; ${panelTitle()} }
                & button { display: inline-flex; align-items: center; gap: ${s('xs')}; padding: 2px ${s('sm')}; ${btn()} }
                & button:disabled { opacity: 0.5; cursor: default; }
            }
            & .svg-check__summary { color: ${t('color-text-secondary')}; &.bad { color: ${t('color-status-negative')}; } }
            & .svg-check__status {
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                &:empty { display: none; }
                &.error { color: ${t('color-status-negative')}; }
            }
            & .svg-check__list {
                display: flex;
                flex-direction: column;
                overflow-y: auto;
                min-height: 0;
                &:empty { display: none; }
            }
            & .svg-check__group {
                margin-top: ${s('xs')};
                font-size: 0.7rem;
                text-transform: uppercase;
                letter-spacing: 0.04em;
                color: ${t('color-text-secondary')};
            }
            & details > summary { cursor: pointer; list-style-position: inside; }
            & .svg-check__row {
                display: flex;
                align-items: center;
                gap: ${s('sm')};
                padding: 2px ${s('xs')};
                border-radius: var(--radius-sm);
                cursor: pointer;
                &:hover { background: color-mix(in srgb, ${t('color-text-primary')} 6%, transparent); }
                &.focused { background: color-mix(in srgb, ${t('color-accent-primary')} 18%, transparent); }
            }
            & .svg-check__dot { flex: none; width: 8px; height: 8px; border-radius: 50%; }
            & .svg-check__names { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            & .svg-check__code { flex: none; color: ${t('color-text-secondary')}; }
            & .svg-check__accept {
                flex: none;
                display: inline-flex;
                align-items: center;
                gap: ${s('xs')};
                padding: 0 ${s('xs')};
                ${btn()}
                &:disabled { opacity: 0.5; cursor: default; }
            }
        }
    `;

    private svc = this.inject(SvgCheckService);
    private mapSvc = this.inject(MapService);
    private mode = this.inject(EditorModeService);
    private serverMode = this.inject(ServerModeService);
    /** Which folded groups are open, kept across re-renders. */
    private openGroups = new Set<Group>();

    render(): DocumentFragment {
        const svc = this.svc;
        const frag = this.wire(tpl, {
            root: { className: () => svc.courseId.get() ? 'svg-check show' : 'svg-check' },
            close: { onclick: () => svc.close() },
            run: { onclick: () => void svc.run(), disabled: () => !!svc.busy.get() },
            summary: {
                textContent: () => svc.busy.get() === 'run' ? 'Checking…' : svc.summary(),
                className: () => (svc.report.get()?.findings.some((f) => f.severity === 'error' && !f.accepted)
                    ? 'svg-check__summary bad' : 'svg-check__summary'),
                title: () => {
                    const r = svc.report.get();
                    return r ? `Checked ${new Date(r.checkedAt).toLocaleTimeString()}` : '';
                },
            },
            status: {
                className: () => svc.error.get() ? 'svg-check__status error' : 'svg-check__status',
                textContent: () => svc.error.get(),
                title: () => svc.error.get(),
            },
        });
        this.bindList(this.ref(frag, 'list'));
        this.bindMap();
        this.bindDrawMode();
        return frag;
    }

    /** The findings as one-line rows, rebuilt on every change of the report, the focus or the busy key. */
    private bindList(list: HTMLElement): void {
        this.track(effect(() => {
            const findings = this.svc.report.get()?.findings ?? [];
            const focused = this.svc.focused.get();
            const busy = this.svc.busy.get();
            list.replaceChildren();
            const by = (g: Group) => findings.filter((f) => g === 'accepted' ? f.accepted : !f.accepted && f.severity === g);
            for (const [g, label] of [['error', 'Errors'], ['warning', 'Warnings']] as const) {
                const rows = by(g);
                if (!rows.length) continue;
                const head = document.createElement('div');
                head.className = 'svg-check__group';
                head.textContent = label;
                list.append(head, ...rows.map((f) => this.row(f, focused, busy)));
            }
            for (const [g, label] of [['note', 'Notes'], ['accepted', 'Accepted']] as const) {
                const rows = by(g);
                if (!rows.length) continue;
                const box = document.createElement('details');
                box.open = this.openGroups.has(g);
                box.ontoggle = () => { if (box.open) this.openGroups.add(g); else this.openGroups.delete(g); };
                const head = document.createElement('summary');
                head.className = 'svg-check__group';
                head.textContent = `${label} (${rows.length})`;
                box.append(head, ...rows.map((f) => this.row(f, focused, busy)));
                list.append(box);
            }
        }));
    }

    private row(f: SvgCheckFinding, focused: string | null, busy: string): HTMLElement {
        const el = document.createElement('div');
        el.className = f.key === focused ? 'svg-check__row focused' : 'svg-check__row';
        el.dataset.testid = 'svg-check-row';
        el.dataset.code = f.code;
        el.title = f.message;
        el.onclick = () => this.svc.focus(f);
        const dot = document.createElement('span');
        dot.className = 'svg-check__dot';
        dot.style.background = f.severity === 'error' ? ERROR : f.severity === 'warning' ? WARNING : NOTE;
        const names = document.createElement('span');
        names.className = 'svg-check__names';
        names.textContent = shapesLabel(f);
        const code = document.createElement('span');
        code.className = 'svg-check__code';
        code.textContent = codeLabel(f.code);
        el.append(dot, names, code);
        if (f.code === HIDDEN_SHAPE && !f.accepted) {
            const lift = document.createElement('button');
            lift.type = 'button';
            lift.className = 'svg-check__accept';
            lift.dataset.testid = 'svg-check-lift';
            lift.disabled = !!busy;
            lift.innerHTML = `${icon('arrow-up', 16)}`;
            lift.title = `Lift ${f.shapes[0]?.name ?? 'it'} just above ${f.shapes.slice(1).map((s) => s.name).join(', ')} (into their hole or group when they are higher)`;
            lift.onclick = (e) => { e.stopPropagation(); void this.svc.lift(f); };
            el.append(lift);
        }
        if (f.accepted || f.severity !== 'note') {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'svg-check__accept';
            b.dataset.testid = f.accepted ? 'svg-check-undo' : 'svg-check-accept';
            b.disabled = !!busy;
            if (f.accepted) {
                b.innerHTML = `${icon('undo', 16)}`;
                b.title = 'Undo: this stops the export again';
            } else {
                b.innerHTML = `${icon('check', 16)}`;
                b.title = 'Accept: this no longer stops the export';
            }
            b.onclick = (e) => { e.stopPropagation(); void this.svc.accept(f, !f.accepted); };
            el.append(b);
        }
        return el;
    }

    /** The findings on the map while the panel is open. */
    private bindMap(): void {
        const map = this.mapSvc;
        let added = false;
        this.track(effect(() => {
            const ready = map.ready.get();
            if (!ready) { added = false; return; }
            const data = this.svc.courseId.get() && this.svc.report.get() ? this.svc.layer() : null;
            if (!data) {
                if (added) map.removeOverlayLayer(OVERLAY_ID);
                added = false;
                return;
            }
            if (added) {
                map.updateOverlayData(OVERLAY_ID, data);
                return;
            }
            const color: ExpressionSpecification = ['match', ['get', 'severity'], 'error', ERROR, 'warning', WARNING, NOTE];
            const focused: ExpressionSpecification = ['==', ['get', 'focused'], true];
            map.addOverlayLayer(OVERLAY_ID, data, [
                {
                    id: `${OVERLAY_ID}-fill`, type: 'fill', filter: ['==', ['get', 'shape'], 'area'],
                    paint: { 'fill-color': color, 'fill-opacity': ['case', focused, 0.5, 0.3] },
                },
                {
                    id: `${OVERLAY_ID}-line`, type: 'line', filter: ['!=', ['get', 'shape'], 'pin'],
                    paint: { 'line-color': color, 'line-width': ['case', focused, 4, 2] },
                },
                {
                    id: `${OVERLAY_ID}-pin`, type: 'circle', filter: ['==', ['get', 'shape'], 'pin'],
                    paint: {
                        'circle-radius': ['case', focused, 8, 5],
                        'circle-color': 'rgba(0,0,0,0)',
                        'circle-stroke-color': color,
                        'circle-stroke-width': ['case', focused, 3, 2],
                    },
                },
            ], { keepOnTop: true });
            added = true;
        }));
        this.track(() => { if (added && map.ready.peek()) map.removeOverlayLayer(OVERLAY_ID); });
    }

    /** Opening the panel (also from the GSPro dialog) puts the editor in the Draw mode. */
    private bindDrawMode(): void {
        this.track(effect(() => {
            if (this.svc.opened.get() === 0) return;
            untrack(() => this.mode.selectSubMode('draw', visibleEditorTools(this.serverMode.mode.peek())));
        }));
    }
}
