// Scorecard and Place tees: the Furniture mode's panel for TeeLengthsService, over the map like Assign to holes.
// Scorecard: paste the card, Read, a select per card set for where it goes, Accept. Tees: one line (what Accept
// writes, what is left to check), Accept, Discard; on the map each set's spot in its colour (hollow: needs a
// look, not taken), the line from a tee that is off to its spot, and the length's circle near a spot to check.
// A click on a spot takes it or leaves it. Explanations are tooltips.
//
// Spawned by CourseDetailComponent, opened from Furniture › Tee sets.

import { Component, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, primaryBtn, input, glassPanel, segmented, OVERLAY_W, OVERLAY_INSET } from '../css';
import { icon } from '../ui/icons';
import { MapService } from '../map/map.service';
import { TeeLengthsService, type CardUnit } from './tee-lengths.service';
import { FurnitureService } from './furniture.service';
import { teeFill } from './furniture-overlay';

const OVERLAY_ID = 'tee-lengths';

const CARD_TIP = 'Paste the club\'s scorecard: holes across (Hål 1 2 … / Par … / Hcp … / Gul 57 463 294 …) or down '
    + '(Hål Par Hcp Vit Gul …, then a row per hole), from a PDF, a web page or a spreadsheet. Total columns are left out. '
    + 'Ratings on lines of their own: "Gul herr 71,5/135 dam 77,5/139". JSON works too.';
const TEES_TIP = 'Each set\'s tee where its length, run back along tee -> aim points -> green centre, crosses a drawn tee shape. '
    + 'Filled: written by Accept. Hollow: needs a look (off its length, two tee shapes nearly in line, on another hole\'s shape, '
    + 'or no tee shape at its length); click to take it.';

const tpl = template(`
    <div bind="root" class="tee-len" data-testid="tee-lengths-panel">
        <div class="tee-len__header">
            <div class="tee-len__tabs">
                <button bind="tabCard" type="button" data-testid="tee-lengths-tab-card" title="${CARD_TIP}">Scorecard</button>
                <button bind="tabTees" type="button" data-testid="tee-lengths-tab-tees" title="${TEES_TIP}">Tees</button>
            </div>
            <button bind="close" type="button" class="tee-len__close" aria-label="Close" title="Close (drops what is not accepted)">${icon('x')}</button>
        </div>

        <div bind="cardStep" class="tee-len__step">
            <div bind="stored" class="tee-len__muted" data-testid="tee-lengths-stored"></div>
            <textarea bind="text" class="tee-len__text" rows="5" spellcheck="false" data-testid="tee-lengths-text"
                placeholder="Paste the scorecard" title="${CARD_TIP}"></textarea>
            <div class="tee-len__row">
                <select bind="unit" class="tee-len__unit" aria-label="Lengths in" title="Lengths in metres or yards (Auto: yards when the card says so)">
                    <option value="auto">Auto</option>
                    <option value="m">Metres</option>
                    <option value="yd">Yards</option>
                </select>
                <button bind="read" type="button" data-testid="tee-lengths-read">${icon('search', 16)}<span>Read</span></button>
            </div>
            <div bind="sets" class="tee-len__sets" data-testid="tee-lengths-sets"></div>
            <div bind="cardRow" class="tee-len__row">
                <span bind="cardCount" class="tee-len__count" data-testid="tee-lengths-card-count"></span>
                <span bind="warnings" class="tee-len__warn" data-testid="tee-lengths-warnings"></span>
            </div>
            <div bind="cardButtons" class="tee-len__row tee-len__buttons">
                <button bind="save" type="button" class="tee-len__accept" data-testid="tee-lengths-save"
                    title="Write par, stroke index, each set's lengths and ratings; new sets are made">${icon('check', 16)}<span>Accept</span></button>
            </div>
        </div>

        <div bind="teesStep" class="tee-len__step">
            <span bind="teesCount" class="tee-len__count" data-testid="tee-lengths-tees-count"></span>
            <div class="tee-len__row tee-len__buttons">
                <button bind="place" type="button" class="tee-len__accept" data-testid="tee-lengths-place"
                    title="Write the filled spots: new tees placed, taken ones moved">${icon('check', 16)}<span>Accept</span></button>
                <button bind="discard" type="button" title="Close: nothing is written">${icon('x', 16)}<span>Discard</span></button>
            </div>
        </div>

        <div bind="status" class="tee-len__status" data-testid="tee-lengths-status"></div>
    </div>
`);

export class TeeLengthsPanelComponent extends Component {
    static styles = `
        .tee-len {
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

            & .tee-len__header {
                display: flex;
                align-items: center;
                gap: ${s('sm')};
                & .tee-len__tabs {
                    flex: 1;
                    ${segmented()}
                    padding: 2px;
                    & > button { padding: 2px ${s('sm')}; }
                    & > button.active {
                        background: ${t('color-surface-raised')};
                        color: ${t('color-text-primary')};
                        font-weight: 600;
                        box-shadow: var(--elev-1);
                    }
                }
                & .tee-len__close { display: inline-flex; align-items: center; padding: 2px ${s('sm')}; ${btn()} }
            }
            & .tee-len__step { display: none; flex-direction: column; gap: ${s('sm')}; &.show { display: flex; } }
            & .tee-len__text {
                ${input()}
                width: 100%;
                box-sizing: border-box;
                resize: vertical;
                font-family: ui-monospace, monospace;
                font-size: 0.72rem;
                white-space: pre;
            }
            & .tee-len__row {
                display: flex;
                align-items: center;
                gap: ${s('sm')};
                & button { display: inline-flex; align-items: center; gap: ${s('xs')}; padding: 2px ${s('sm')}; ${btn()} }
                & button:disabled { opacity: 0.5; cursor: default; }
                & .tee-len__accept { ${primaryBtn()} padding: 2px ${s('sm')}; }
                &.hide { display: none; }
            }
            & .tee-len__unit { ${input()} padding: 2px ${s('xs')}; }
            & .tee-len__buttons { justify-content: flex-end; }
            & .tee-len__count { flex: 1; color: ${t('color-text-secondary')}; }
            & .tee-len__warn {
                color: ${t('color-status-caution')};
                cursor: help;
                &:empty { display: none; }
            }
            & .tee-len__muted {
                color: ${t('color-text-secondary')};
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                &:empty { display: none; }
            }
            & .tee-len__sets {
                display: flex;
                flex-direction: column;
                gap: 2px;
                &:empty { display: none; }
            }
            & .tee-len__set {
                display: grid;
                grid-template-columns: 10px minmax(0, 1fr) minmax(0, 1.4fr) auto;
                align-items: center;
                gap: ${s('xs')};
                & .dot { width: 8px; height: 8px; border-radius: 50%; }
                & .label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                & select { ${input()} padding: 1px ${s('xs')}; min-width: 0; }
                & .len { color: ${t('color-text-secondary')}; font-variant-numeric: tabular-nums; }
            }
            & .tee-len__status {
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
                &:empty { display: none; }
                &.error { color: ${t('color-status-negative')}; }
            }
        }
    `;

    private svc = this.inject(TeeLengthsService);
    private furniture = this.inject(FurnitureService);
    private mapSvc = this.inject(MapService);

    render(): DocumentFragment {
        const svc = this.svc;
        const busy = () => !!svc.busy.get();
        const frag = this.wire(tpl, {
            root: { className: () => svc.courseId.get() ? 'tee-len show' : 'tee-len' },
            tabCard: {
                className: () => svc.step.get() === 'scorecard' ? 'active' : '',
                onclick: () => svc.goTo('scorecard'),
                disabled: busy,
            },
            tabTees: {
                className: () => svc.step.get() === 'tees' ? 'active' : '',
                onclick: () => svc.goTo('tees'),
                disabled: busy,
            },
            close: { onclick: () => svc.close() },
            cardStep: { className: () => svc.step.get() === 'scorecard' ? 'tee-len__step show' : 'tee-len__step' },
            teesStep: { className: () => svc.step.get() === 'tees' ? 'tee-len__step show' : 'tee-len__step' },
            stored: {
                textContent: () => {
                    const stored = svc.stored.get();
                    if (svc.card.get() || !stored?.sets.length) return '';
                    return `Now: ${stored.sets.map((x) => `${x.name} ${x.totalM} m`).join(' · ')}`;
                },
                title: () => (svc.stored.get()?.sets ?? []).map((x) => `${x.name}: ${x.lengths.map((l) => `${l.holeNumber}:${Math.round(l.lengthM)}`).join(' ')}`).join('\n'),
            },
            read: {
                onclick: () => void svc.read(),
                disabled: () => busy() || !svc.text.get().trim(),
            },
            cardRow: { className: () => svc.card.get() ? 'tee-len__row' : 'tee-len__row hide' },
            cardButtons: { className: () => svc.card.get() ? 'tee-len__row tee-len__buttons' : 'tee-len__row tee-len__buttons hide' },
            cardCount: { textContent: () => svc.busy.get() === 'read' ? 'Reading…' : svc.cardSummary() },
            warnings: {
                textContent: () => {
                    const n = svc.card.get()?.warnings.length ?? 0;
                    return n ? `${n} ⚠` : '';
                },
                title: () => (svc.card.get()?.warnings ?? []).join('\n'),
            },
            save: { onclick: () => void svc.save(), disabled: () => busy() || !svc.card.get() },
            teesCount: {
                textContent: () => svc.busy.get() === 'find' ? 'Finding…' : svc.teesSummary(),
                title: () => svc.teesDetail(),
            },
            place: { onclick: () => void svc.place(), disabled: () => busy() || svc.taken.get().size === 0 },
            discard: { onclick: () => svc.close(), disabled: busy },
            status: {
                className: () => svc.error.get() ? 'tee-len__status error' : 'tee-len__status',
                textContent: () => svc.error.get() || svc.done.get(),
            },
        });

        const text = this.ref(frag, 'text') as HTMLTextAreaElement;
        text.addEventListener('input', () => svc.text.set(text.value));
        this.track(effect(() => {
            const value = svc.text.get();
            if (text.value !== value) text.value = value;
        }));
        const unit = this.ref(frag, 'unit') as HTMLSelectElement;
        unit.addEventListener('change', () => {
            svc.unit.set(unit.value as CardUnit);
            if (svc.card.peek()) void svc.read();
        });
        this.track(effect(() => { unit.value = svc.unit.get(); }));

        // One row per card set: its label, where it goes (a select over the course's sets), its length.
        const sets = this.ref(frag, 'sets');
        this.track(effect(() => {
            const card = svc.card.get();
            const courseSets = this.furniture.teeSets.get();
            sets.replaceChildren(...(card?.sets ?? []).map((set) => {
                const row = document.createElement('div');
                row.className = 'tee-len__set';
                const dot = document.createElement('span');
                dot.className = 'dot';
                dot.style.background = teeFill(set.color);
                const label = document.createElement('span');
                label.className = 'label';
                label.textContent = set.label;
                label.title = `${set.label}: ${set.holes} holes${set.ratingMen !== null ? ` · men ${set.ratingMen}/${set.slopeMen ?? '?'}` : ''}`
                    + `${set.ratingWomen !== null ? ` · women ${set.ratingWomen}/${set.slopeWomen ?? '?'}` : ''}`;
                const pick = document.createElement('select');
                pick.setAttribute('aria-label', `${set.label} goes to`);
                pick.title = set.teeSetId ? `Matched by ${set.matchedBy}` : 'A new set';
                const options: [string, string][] = [
                    ...courseSets.map((c) => [c.id, c.name] as [string, string]),
                    ['new', set.teeSetId ? 'New set' : `New: ${set.name}`],
                ];
                for (const [value, name] of options) pick.append(new Option(name, value));
                pick.value = set.teeSetId ?? 'new';
                pick.addEventListener('change', () => void svc.mapSet(set.label, pick.value));
                pick.disabled = !!svc.busy.peek();
                const len = document.createElement('span');
                len.className = 'len';
                len.textContent = `${set.totalM} m`;
                row.append(dot, label, pick, len);
                return row;
            }));
        }));

        this.bindMap();
        return frag;
    }

    /** The tee spots on the map while the Tees step has a proposal; a click takes or leaves one. */
    private bindMap(): void {
        const map = this.mapSvc;
        let added = false;
        this.track(effect(() => {
            const ready = map.ready.get();
            if (!ready) { added = false; return; }
            const data = this.svc.courseId.get() && this.svc.step.get() === 'tees' && this.svc.tees.get() ? this.svc.layer() : null;
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
                    id: `${OVERLAY_ID}-arcs`, type: 'line', filter: ['==', ['get', 'kind'], 'arc'],
                    paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-dasharray': [2, 2] },
                },
                {
                    id: `${OVERLAY_ID}-moves`, type: 'line', filter: ['==', ['get', 'kind'], 'move'],
                    paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': ['case', ['get', 'taken'], 1, 0.6] },
                },
                {
                    id: `${OVERLAY_ID}-spots`, type: 'circle', filter: ['==', ['get', 'kind'], 'spot'],
                    paint: {
                        'circle-radius': 6,
                        'circle-color': ['get', 'color'],
                        'circle-opacity': ['case', ['get', 'taken'], 1, 0],
                        'circle-stroke-color': ['case', ['get', 'look'], '#f59e0b', '#111827'],
                        'circle-stroke-width': ['case', ['get', 'look'], 2.5, 1.5],
                    },
                },
            ], { keepOnTop: true });
            added = true;
        }));
        this.track(map.onClick((e) => {
            if (!this.svc.courseId.peek() || this.svc.step.peek() !== 'tees' || !this.svc.tees.peek()) return;
            const m = map.map.peek();
            if (!m) return;
            const key = this.svc.spotAt((at) => {
                const p = m.project(at);
                return Math.hypot(p.x - e.point.x, p.y - e.point.y);
            });
            if (key) this.svc.toggle(key);
        }));
        this.track(() => { if (added && map.ready.peek()) map.removeOverlayLayer(OVERLAY_ID); });
    }
}
