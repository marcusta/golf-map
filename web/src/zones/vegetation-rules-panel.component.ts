// Planting rules: a read-only view of what the course's vegetation is planted by —
// the four generators (tall rough, woodland floor, rock shore, creek banks) in
// zone-stack order and the tree planting — so the builder can see how it works now
// and ask for the right change. Every rule shows the value the planting uses; one the
// course sets in its own file (docs/gspro/<course>/...) is marked, with the default
// beside it. Each section folds to one line; the explanations are tooltips until
// "Explain" shows them inline (with each generator's steps).
//
// Spawned by CourseDetailComponent like the zone-type editor, opened from the
// Vegetation mode's zone-type picker (VegetationRulesService.openFor).

import { Component, Signal, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, glassPanel, panelTitle, statusTag, OVERLAY_W, OVERLAY_INSET } from '../css';
import { icon } from '../ui/icons';
import { VegetationRulesService, formatRuleValue, ruleValueLines } from './vegetation-rules.service';
import type { PlantingRule, PlantingRuleSection, PlantingRules } from '../../../shared/api/vegetation-rules.gen';
import { modelLabel, rendererName } from '../../../shared/vegetation/model-id';

const EXPLAIN_KEY = 'golfmap.plantingRules.explain';

const tpl = template(`
    <div bind="root" class="veg-rules" data-testid="planting-rules-panel">
        <div class="veg-rules__header">
            <h3>Planting rules</h3>
            <label class="veg-rules__explain" title="Show what each rule does and how each generator works">
                <input bind="explain" type="checkbox" data-testid="planting-rules-explain" /> Explain
            </label>
            <button bind="close" type="button" aria-label="Close" title="Close">${icon('x')}</button>
        </div>
        <div bind="status" class="veg-rules__status"></div>
        <div bind="body" class="veg-rules__body"></div>
    </div>
`);

function readExplain(): boolean {
    try {
        return localStorage.getItem(EXPLAIN_KEY) === '1';
    } catch {
        return false;
    }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
}

export class VegetationRulesPanelComponent extends Component {
    static styles = `
        .veg-rules {
            position: absolute;
            top: ${OVERLAY_INSET};
            right: ${OVERLAY_INSET};
            width: ${OVERLAY_W.wide};
            max-width: calc(100% - 2 * ${OVERLAY_INSET});
            max-height: calc(100% - 2 * ${OVERLAY_INSET});
            z-index: 6;
            display: none;
            flex-direction: column;
            ${glassPanel()}
            padding: 0;
            font-size: 0.78rem;
            color: ${t('color-text-primary')};
            &.show { display: flex; }

            & .veg-rules__header {
                display: flex;
                align-items: center;
                gap: ${s('sm')};
                padding: var(--space-3) var(--space-4);
                border-bottom: 1px solid ${t('color-border-default')};
                & h3 { margin: 0; flex: 1; ${panelTitle()} }
                & button { display: inline-flex; align-items: center; padding: 2px ${s('sm')}; ${btn()} }
            }
            & .veg-rules__explain {
                display: inline-flex;
                align-items: center;
                gap: ${s('xs')};
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
                cursor: pointer;
            }
            & .veg-rules__status {
                padding: ${s('sm')} var(--space-4) 0;
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
                &:empty { display: none; }
                &.error { color: ${t('color-status-negative')}; }
            }
            & .veg-rules__body {
                overflow-y: auto;
                padding: ${s('xs')} var(--space-4) var(--space-4);
            }
            & .vr-heading {
                margin: ${s('md')} 0 ${s('xs')};
                font-size: 0.68rem;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.06em;
                color: ${t('color-text-secondary')};
            }
            & details.vr-section {
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius-sm')};
                margin-bottom: ${s('xs')};
                & > summary {
                    display: flex;
                    align-items: baseline;
                    gap: ${s('sm')};
                    padding: ${s('xs')} ${s('sm')};
                    cursor: pointer;
                    list-style: none;
                    &::-webkit-details-marker { display: none; }
                    &::before { content: '▸'; color: ${t('color-text-secondary')}; }
                }
                &[open] > summary::before { content: '▾'; }
                & > .vr-section__body { padding: 0 ${s('sm')} ${s('sm')}; }
            }
            & .vr-section__label { font-weight: 600; }
            & .vr-section__script { font-size: 0.68rem; color: ${t('color-text-secondary')}; flex: 1; }
            & .vr-tag { ${statusTag(t('color-status-info'))} padding: 1px 6px; font-size: 9px; }
            & .vr-tag--off { ${statusTag(t('color-text-secondary'))} padding: 1px 6px; font-size: 9px; }
            & .vr-summary { margin: 0 0 ${s('xs')}; color: ${t('color-text-secondary')}; }
            & .vr-file { font-size: 0.68rem; color: ${t('color-text-secondary')}; margin-bottom: ${s('xs')}; }
            & ol.vr-steps {
                margin: 0 0 ${s('sm')};
                padding-left: 1.3em;
                color: ${t('color-text-secondary')};
                & li { margin-bottom: 2px; }
            }
            & .vr-group { margin-top: ${s('sm')}; }
            & .vr-group__title { font-size: 0.7rem; font-weight: 600; color: ${t('color-text-secondary')}; margin-bottom: 2px; }
            & .vr-rule {
                display: grid;
                grid-template-columns: minmax(110px, 40%) 1fr;
                gap: ${s('sm')};
                padding: 2px 0;
                border-top: 1px solid ${t('color-border-subtle')};
                &.course { background: color-mix(in srgb, ${t('color-status-info')} 8%, transparent); }
            }
            & .vr-rule__key { font-family: var(--font-mono, monospace); font-size: 0.7rem; overflow-wrap: anywhere; }
            & .vr-rule__value { overflow-wrap: anywhere; }
            & .vr-rule__default { color: ${t('color-text-secondary')}; font-size: 0.7rem; }
            & .vr-rule__text { grid-column: 1 / -1; font-size: 0.7rem; color: ${t('color-text-secondary')}; padding-bottom: 2px; }
            & .vr-mix {
                display: grid;
                grid-template-columns: minmax(110px, 40%) 1fr;
                gap: ${s('sm')};
                padding: 2px 0;
                border-top: 1px solid ${t('color-border-subtle')};
                &.empty { color: ${t('color-text-secondary')}; }
            }
            & .vr-model {
                display: flex;
                align-items: baseline;
                gap: ${s('sm')};
                padding: 2px 0;
                border-top: 1px solid ${t('color-border-subtle')};
                &.empty { color: ${t('color-text-secondary')}; }
                & .vr-model__label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                & .vr-tag, & .vr-tag--off { flex: none; }
            }
            /* In the row's text for readers and search, not on screen: the group header shows it. */
            & .vr-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
        }
    `;

    private svc = this.inject(VegetationRulesService);
    private explain = new Signal(readExplain());

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            root: { className: () => this.svc.panelCourseId.get() ? 'veg-rules show' : 'veg-rules' },
            close: { onclick: () => this.svc.close() },
            status: {
                className: () => this.svc.error.get() ? 'veg-rules__status error' : 'veg-rules__status',
                textContent: () => this.svc.error.get() || (this.svc.loading.get() && !this.svc.rules.get() ? 'Loading…' : ''),
            },
        });
        const explain = this.ref(frag, 'explain') as HTMLInputElement;
        explain.checked = this.explain.peek();
        explain.onchange = () => {
            this.explain.set(explain.checked);
            try { localStorage.setItem(EXPLAIN_KEY, explain.checked ? '1' : '0'); } catch { /* per-viewer convenience only */ }
        };
        const body = this.ref(frag, 'body');
        // Which sections are open survives a re-render (Explain, a reload on reopen).
        const open = new Set<string>();
        this.track(effect(() => {
            const rules = this.svc.rules.get();
            const explainOn = this.explain.get();
            body.textContent = '';
            if (rules) this.build(body, rules, explainOn, open);
        }));
        return frag;
    }

    private build(body: HTMLElement, rules: PlantingRules, explainOn: boolean, open: Set<string>): void {
        const heading = (text: string, title: string) => {
            const h = el('div', 'vr-heading', text);
            h.title = title;
            body.appendChild(h);
        };
        heading('Grass and ground plants', 'The vegetation generators, bottom of the zone stack first: a later one lies above and claims the ground first');
        for (const g of rules.generators) body.appendChild(this.section(g, explainOn, open));
        heading('Trees', 'Detection from the lidar, the species and model per tree in Unity, and who draws it in GSPro');
        for (const tr of rules.trees) body.appendChild(this.section(tr, explainOn, open));
        body.appendChild(this.treeAreas(rules, open));
        if (rules.treeModels?.length) body.appendChild(this.treeModels(rules, open));
        if (rules.zoneModels?.length) body.appendChild(this.zoneModels(rules, open));
    }

    private details(id: string, open: Set<string>): HTMLDetailsElement {
        const d = el('details', 'vr-section');
        d.dataset.source = id;
        d.open = open.has(id);
        d.ontoggle = () => { if (d.open) open.add(id); else open.delete(id); };
        return d;
    }

    private section(sec: PlantingRuleSection, explainOn: boolean, open: Set<string>): HTMLElement {
        const d = this.details(sec.source, open);
        d.dataset.testid = 'planting-rules-section';
        const summary = el('summary');
        summary.title = sec.summary;
        summary.append(el('span', 'vr-section__label', sec.label), el('span', 'vr-section__script', sec.script ?? ''));
        const courseSet = sec.groups.reduce((n, g) => n + g.rules.filter((r) => r.courseSets).length, 0) + sec.courseExtras.length;
        if (courseSet > 0) {
            const tag = el('span', 'vr-tag', `${courseSet} course`);
            tag.title = `${courseSet} rule${courseSet === 1 ? '' : 's'} set by this course (${sec.courseFile ?? ''})`;
            summary.appendChild(tag);
        }
        d.appendChild(summary);

        const b = el('div', 'vr-section__body');
        b.appendChild(el('p', 'vr-summary', sec.summary));
        if (sec.courseFile) b.appendChild(el('div', 'vr-file', `Course values: ${sec.courseFile}`));
        if (explainOn && sec.steps.length) {
            const ol = el('ol', 'vr-steps');
            for (const step of sec.steps) ol.appendChild(el('li', undefined, step));
            b.appendChild(ol);
        }
        for (const g of sec.groups) {
            const group = el('div', 'vr-group');
            group.appendChild(el('div', 'vr-group__title', g.title));
            for (const r of g.rules) group.appendChild(this.rule(r, explainOn));
            b.appendChild(group);
        }
        if (sec.courseExtras.length) {
            const group = el('div', 'vr-group');
            group.appendChild(el('div', 'vr-group__title', 'Other flags the course passes'));
            for (const e of sec.courseExtras) {
                const row = el('div', 'vr-rule course');
                row.append(el('span', 'vr-rule__key', e.key), el('span', 'vr-rule__value', formatRuleValue(e.value)));
                group.appendChild(row);
            }
            b.appendChild(group);
        }
        if (sec.mixes.length) {
            const group = el('div', 'vr-group');
            const title = el('div', 'vr-group__title', 'Mixes it plants');
            title.title = 'The zone type\'s mixes on this course (Edit zone types): a variant with no items plants nothing, so its rule is off';
            group.appendChild(title);
            for (const m of sec.mixes) {
                const row = el('div', m.items.length ? 'vr-mix' : 'vr-mix empty');
                row.dataset.testid = 'planting-rules-mix';
                const name = el('span', 'vr-rule__key', `${m.zoneType}/${m.variant || 'default'}`);
                name.title = `${m.zoneTypeName} · ${m.variantName}`;
                const items = el('span', undefined, m.items.length ? `${m.items.length} item${m.items.length === 1 ? '' : 's'}` : 'no items: off');
                if (m.items.length) items.title = m.items.join('\n');
                row.append(name, items);
                group.appendChild(row);
            }
            b.appendChild(group);
        }
        d.appendChild(b);
        return d;
    }

    private rule(r: PlantingRule, explainOn: boolean): HTMLElement {
        const row = el('div', r.courseSets ? 'vr-rule course' : 'vr-rule');
        row.dataset.testid = 'planting-rule';
        row.dataset.key = r.key;
        row.title = r.text + (r.flag ? '\n(also a flag of the script)' : '');
        const value = el('span', 'vr-rule__value');
        const lines = r.value === null ? ['not set'] : ruleValueLines(r.value);
        lines.forEach((line, i) => {
            if (i > 0) value.appendChild(el('br'));
            value.appendChild(document.createTextNode(line + (i === lines.length - 1 && r.unit && typeof r.value === 'number' ? ` ${r.unit}` : '')));
        });
        if (r.courseSets && r.defaultValue !== null) {
            value.appendChild(document.createTextNode(' '));
            value.appendChild(el('span', 'vr-rule__default', `(default ${formatRuleValue(r.defaultValue)})`));
        }
        row.append(el('span', 'vr-rule__key', r.key), value);
        if (explainOn) row.appendChild(el('div', 'vr-rule__text', r.text));
        return row;
    }

    private treeAreas(rules: PlantingRules, open: Set<string>): HTMLElement {
        const d = this.details('tree-areas', open);
        const summary = el('summary');
        summary.title = 'Drawn in Vegetation mode (Trees): inside one, its mix picks the species; the topmost area wins';
        summary.append(el('span', 'vr-section__label', 'Tree species areas'), el('span', 'vr-section__script', 'drawn'));
        summary.appendChild(el('span', rules.treeAreas.length ? 'vr-tag' : 'vr-tag--off', String(rules.treeAreas.length)));
        d.appendChild(summary);
        const b = el('div', 'vr-section__body');
        for (const a of rules.treeAreas) {
            const row = el('div', 'vr-mix');
            row.append(el('span', 'vr-rule__key', a.name || '(unnamed)'), el('span', undefined, a.mix + (a.ignoreKind ? ' · ignores kind' : '')));
            b.appendChild(row);
        }
        if (rules.treeAssets.length) {
            const group = el('div', 'vr-group');
            group.appendChild(el('div', 'vr-group__title', 'Models in the palette (enabled / all)'));
            for (const a of rules.treeAssets) {
                const row = el('div', 'vr-mix');
                row.append(el('span', 'vr-rule__key', a.species), el('span', undefined, `${a.enabled} / ${a.total}`));
                group.appendChild(row);
            }
            b.appendChild(group);
        }
        d.appendChild(b);
        return d;
    }

    /** Each species' models, one line each under the species header: model, who draws it; the size in the tooltip. */
    private treeModels(rules: PlantingRules, open: Set<string>): HTMLElement {
        const d = this.details('tree-models', open);
        const summary = el('summary');
        summary.title = "The palette's species and their models from the course's model library (models.json); the size fit picks among a species' models";
        const count = rules.treeModels.reduce((n, sp) => n + sp.models.length, 0);
        summary.append(el('span', 'vr-section__label', 'Tree models'), el('span', 'vr-section__script', 'models.json'), el('span', 'vr-tag', String(count)));
        d.appendChild(summary);
        const b = el('div', 'vr-section__body');
        for (const sp of rules.treeModels) {
            const group = el('div', 'vr-group');
            group.appendChild(el('div', 'vr-group__title', `${sp.species} · weight ${sp.weight}`));
            for (const m of sp.models) {
                const row = el('div', m.enabled ? 'vr-model' : 'vr-model empty');
                row.dataset.testid = 'planting-rules-model';
                row.dataset.model = m.id;
                const size = m.missing ? 'not in the model library (models.json)' : `${m.heightM.toFixed(1)} m tall, ${m.crownWidthM.toFixed(1)} m crown`;
                row.title = `${m.id}\n${size}${m.enabled ? '' : '\n(disabled in the palette)'}`;
                row.append(el('span', 'vr-hidden', `${sp.species} `), el('span', 'vr-model__label', modelLabel(m.id)),
                    el('span', m.enabled ? 'vr-tag' : 'vr-tag--off', rendererName(m.renderer)));
                group.appendChild(row);
            }
            b.appendChild(group);
        }
        d.appendChild(b);
        return d;
    }

    /** Each zone palette's items, one line each: the item and who draws it (its model's renderer); the model id in the tooltip. */
    private zoneModels(rules: PlantingRules, open: Set<string>): HTMLElement {
        const d = this.details('zone-models', open);
        const summary = el('summary');
        summary.title = "The zone palettes' items (grass-palette.json) and the models they refer to (models.json): the model's renderer draws the item, the model holds its look";
        const count = rules.zoneModels.reduce((n, p) => n + p.items.length, 0);
        summary.append(el('span', 'vr-section__label', 'Zone models'), el('span', 'vr-section__script', 'grass-palette.json'), el('span', 'vr-tag', String(count)));
        d.appendChild(summary);
        const b = el('div', 'vr-section__body');
        for (const p of rules.zoneModels) {
            const group = el('div', 'vr-group');
            group.appendChild(el('div', 'vr-group__title', p.palette));
            for (const item of p.items) {
                const row = el('div', item.renderer === '?' ? 'vr-model empty' : 'vr-model');
                row.dataset.testid = 'planting-rules-zone-item';
                row.dataset.model = item.model;
                row.title = item.model + (item.renderer === '?' ? '\nnot in the model library (models.json)' : '');
                row.append(el('span', 'vr-model__label', item.name),
                    el('span', item.renderer === '?' ? 'vr-tag--off' : 'vr-tag', item.renderer === '?' ? 'missing' : rendererName(item.renderer)));
                group.appendChild(row);
            }
            b.appendChild(group);
        }
        d.appendChild(b);
        return d;
    }
}
