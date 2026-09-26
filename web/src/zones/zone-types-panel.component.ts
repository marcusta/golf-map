// The course's vegetation zone-type table, edited in place: one row per zone
// type with its display name, editor colour and the item bindings the Unity
// importer wires into the vegetation package (D-VZ9 — vegetation item name,
// min/max density). The type's own items are its "Default" mix; below them
// each named variant (e.g. Tall rough -> "Dry straw") carries its own mix,
// and a drawn zone picks one in the selection panel. Mask channels are not
// edited here: the pipeline gives every bound item a channel of its own.
//
// Variant keys are chosen once, on "Add variant" (the slug of the
// placeholder name, unique in the type), and never re-derived: renaming a
// variant must not unbind the zones that already name it.
//
// Deliberately plain: this is a short per-course legend a builder touches once
// per course, not a daily surface. Every field commits on `change` (blur or
// Enter) straight through ZoneTypesService, which re-reads the table after
// each write — the server owns key uniqueness and sort order.
//
// Spawned once by CourseDetailComponent and hidden until the command bar's ⋯
// menu calls ZoneTypesService.openFor(), exactly like the export panel.

import { Component, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, primaryBtn, glassPanel, panelTitle, OVERLAY_W, OVERLAY_INSET } from '../css';
import { icon } from '../ui/icons';
import {
    ZoneTypesService, itemNamesOf, slugify,
    type CourseZoneType, type ZoneTypeItem, type ZoneTypeVariant,
} from './zone-types.service';

/** One `<datalist>` for every item input: the names bound anywhere in the table. */
const ITEM_NAMES_LIST_ID = 'zone-type-item-names';

const tpl = template(`
    <div bind="root" class="zone-types" data-testid="zone-types-panel">
        <div class="zone-types__header">
            <h3>Vegetation zone types</h3>
            <button bind="close" type="button" aria-label="Close" title="Close">${icon('x')}</button>
        </div>
        <div class="zone-types__hint">
            The legend every vegetation zone points at. A type's Default items are the VSPro
            vegetation items its zones grow; a variant is a named alternative mix a zone can pick
            instead. The export gives every bound item its own mask channel.
        </div>
        <div bind="list" class="zone-types__list"></div>
        <datalist bind="itemNames" id="${ITEM_NAMES_LIST_ID}"></datalist>
        <div bind="errorRow" class="zone-types__error"></div>
        <div class="zone-types__footer">
            <input bind="newName" type="text" placeholder="New zone type" spellcheck="false" autocomplete="off" />
            <button bind="add" type="button" class="zone-types__add">Add</button>
            <button bind="defaults" type="button" class="zone-types__defaults">Add the defaults</button>
        </div>
    </div>
`);

const rowTpl = template(`
    <div bind="row" class="zt-row" data-testid="zone-type-row">
        <div class="zt-row__main">
            <input bind="color" type="color" aria-label="Colour" />
            <input bind="name" type="text" aria-label="Name" spellcheck="false" autocomplete="off" />
            <code bind="key" class="zt-row__key"></code>
            <button bind="remove" type="button" class="zt-row__remove" aria-label="Delete zone type" title="Delete zone type">${icon('trash-2')}</button>
        </div>
        <div class="zt-mix" data-testid="zone-type-default">
            <div class="zt-mix__head"><span class="zt-mix__label">Default</span></div>
            <div bind="items" class="zt-row__items"></div>
            <button bind="addItem" type="button" class="zt-row__add-item">Add item binding</button>
        </div>
        <div bind="variants" class="zt-row__variants"></div>
        <button bind="addVariant" type="button" class="zt-row__add-variant" data-testid="zone-type-add-variant">Add variant</button>
    </div>
`);

const variantTpl = template(`
    <div class="zt-mix zt-variant" data-testid="zone-type-variant">
        <div class="zt-mix__head">
            <input bind="name" type="text" aria-label="Variant name" spellcheck="false" autocomplete="off" />
            <code bind="key" class="zt-row__key"></code>
            <button bind="remove" type="button" class="zt-row__remove" aria-label="Delete variant" title="Delete variant">${icon('trash-2')}</button>
        </div>
        <div bind="items" class="zt-row__items"></div>
        <button bind="addItem" type="button" class="zt-row__add-item">Add item binding</button>
    </div>
`);

/** Placeholder name a fresh item binding gets, to be typed over. */
const NEW_ITEM_NAME = 'New item';

const itemTpl = template(`
    <div class="zt-item">
        <input bind="name" type="text" list="${ITEM_NAMES_LIST_ID}" aria-label="Vegetation item" placeholder="Item name in the package" spellcheck="false" autocomplete="off" />
        <label>min <input bind="min" type="number" min="0" max="1" step="0.05" aria-label="Minimum density" /></label>
        <label>max <input bind="max" type="number" min="0" max="1" step="0.05" aria-label="Maximum density" /></label>
        <button bind="remove" type="button" aria-label="Remove item binding" title="Remove item binding">${icon('x')}</button>
    </div>
`);

export class ZoneTypesPanelComponent extends Component {
    static styles = `
        .zone-types {
            position: absolute;
            top: ${OVERLAY_INSET};
            right: ${OVERLAY_INSET};
            width: ${OVERLAY_W.standard};
            max-height: calc(100% - 2 * ${OVERLAY_INSET});
            z-index: 6;
            display: none;
            flex-direction: column;
            overflow-y: auto;
            ${glassPanel()}
            padding: 0;
            font-size: 0.8rem;
            color: ${t('color-text-primary')};
            &.show { display: flex; }

            & .zone-types__header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: var(--space-3) var(--space-4);
                border-bottom: 1px solid ${t('color-border-default')};
                & h3 { margin: 0; ${panelTitle()} }
                & button {
                    display: inline-flex;
                    align-items: center;
                    padding: 2px ${s('sm')};
                    ${btn()}
                }
            }

            & .zone-types__hint {
                padding: ${s('sm')} var(--space-4) 0;
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
            }

            & .zone-types__list {
                display: flex;
                flex-direction: column;
                gap: ${s('sm')};
                padding: ${s('sm')} var(--space-4);
            }

            & .zone-types__error {
                display: none;
                padding: 0 var(--space-4) ${s('sm')};
                color: ${t('color-status-negative')};
                &.show { display: block; }
            }

            & .zone-types__footer {
                display: flex;
                flex-wrap: wrap;
                gap: ${s('xs')};
                padding: ${s('sm')} var(--space-4) var(--space-4);
                border-top: 1px solid ${t('color-border-default')};
                & input { flex: 1; min-width: 100px; }
                & .zone-types__add { ${primaryBtn()} padding: ${s('xs')} ${s('sm')}; }
                & .zone-types__defaults { ${btn(t('radius-sm'))} padding: ${s('xs')} ${s('sm')}; }
            }

            & .zt-row {
                display: flex;
                flex-direction: column;
                gap: ${s('xs')};
                padding: ${s('sm')};
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius-sm')};
            }
            & .zt-row__main {
                display: flex;
                align-items: center;
                gap: ${s('xs')};
                & input[type="text"] { flex: 1; min-width: 60px; }
                & input[type="color"] { width: 28px; padding: 0; }
                & input[type="number"] { width: 44px; }
            }
            & .zt-row__key {
                font-size: 0.7rem;
                color: ${t('color-text-secondary')};
            }
            & .zt-row__remove, & .zt-row__add-item, & .zt-row__add-variant {
                padding: 2px ${s('xs')};
                font-size: 0.7rem;
                ${btn(t('radius-sm'))}
            }
            & .zt-row__add-item, & .zt-row__add-variant { align-self: flex-start; }
            & .zt-row__variants {
                display: flex;
                flex-direction: column;
                gap: ${s('xs')};
                &:empty { display: none; }
            }
            & .zt-mix {
                display: flex;
                flex-direction: column;
                gap: ${s('xs')};
                padding-left: ${s('sm')};
                border-left: 2px solid ${t('color-border-default')};
            }
            & .zt-mix__head {
                display: flex;
                align-items: center;
                gap: ${s('xs')};
                & input[type="text"] { flex: 1; min-width: 60px; }
            }
            & .zt-mix__label {
                font-size: 0.7rem;
                font-weight: 600;
                color: ${t('color-text-secondary')};
            }
            & .zt-row__items {
                display: flex;
                flex-direction: column;
                gap: 2px;
            }
            & .zt-item {
                display: flex;
                align-items: center;
                gap: ${s('xs')};
                font-size: 0.7rem;
                color: ${t('color-text-secondary')};
                & input[type="text"] { flex: 1; min-width: 60px; }
                & input[type="number"] { width: 52px; }
                & button { padding: 0 ${s('xs')}; ${btn(t('radius-sm'))} }
            }
        }
    `;

    private svc = this.inject(ZoneTypesService);
    private newName!: HTMLInputElement;

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            root: { className: () => this.svc.panelCourseId.get() ? 'zone-types show' : 'zone-types' },
            close: { onclick: () => this.svc.close() },
            errorRow: {
                className: () => this.svc.error.get() ? 'zone-types__error show' : 'zone-types__error',
                textContent: () => this.svc.error.get(),
            },
            add: { onclick: () => void this.addZoneType() },
            defaults: {
                onclick: () => {
                    const courseId = this.svc.panelCourseId.peek();
                    if (courseId) void this.svc.addDefaults(courseId);
                },
            },
        });

        this.newName = this.ref(frag, 'newName') as HTMLInputElement;
        const list = this.ref(frag, 'list');
        const itemNames = this.ref(frag, 'itemNames');
        this.track(effect(() => {
            const types = this.svc.items.get();
            list.textContent = '';
            for (const zoneType of types) list.appendChild(this.buildRow(zoneType));
            itemNames.textContent = '';
            for (const name of itemNamesOf(types)) {
                const option = document.createElement('option');
                option.value = name;
                itemNames.appendChild(option);
            }
        }));

        return frag;
    }

    /** Add a type from the footer input: the name doubles as the key, slugged. */
    private async addZoneType(): Promise<void> {
        const courseId = this.svc.panelCourseId.peek();
        const input = this.newName;
        const name = input.value.trim();
        if (!courseId || name.length === 0) return;
        const key = slugify(name);
        if (!key) return;
        if (await this.svc.create(courseId, { key, name, color: '#7c8f3a' })) input.value = '';
    }

    private buildRow(zoneType: CourseZoneType): HTMLElement {
        const items = zoneType.items;
        const variants = zoneType.variants ?? [];
        const row = this.wireEl(rowTpl, {
            color: {
                value: zoneType.color,
                onchange: (e: Event) => void this.svc.update(zoneType.id, { color: (e.target as HTMLInputElement).value }),
            },
            name: {
                value: zoneType.name,
                onchange: (e: Event) => void this.svc.update(zoneType.id, { name: (e.target as HTMLInputElement).value }),
            },
            key: { textContent: zoneType.key },
            remove: { onclick: () => void this.svc.remove(zoneType.id) },
            addItem: {
                // Named, not blank: an item binding IS its name in the VSPro
                // package, and the server (rightly) refuses an empty one.
                onclick: () => void this.svc.update(zoneType.id, {
                    items: [...items, { item: NEW_ITEM_NAME, minDensity: 0, maxDensity: 1 }],
                }),
            },
            addVariant: { onclick: () => void this.svc.addVariant(zoneType) },
        });

        this.buildItems(this.ref(row, 'items'), items, (next) => void this.svc.update(zoneType.id, { items: next }));

        // Each variant writes the whole list back with only its own entry changed.
        const variantsHost = this.ref(row, 'variants');
        const saveVariant = (index: number, next: Partial<ZoneTypeVariant> | null) => void this.svc.update(zoneType.id, {
            variants: next === null
                ? variants.filter((_, i) => i !== index)
                : variants.map((v, i) => (i === index ? { ...v, ...next } : v)),
        });
        variants.forEach((variant, index) => {
            const el = this.wireEl(variantTpl, {
                name: {
                    value: variant.name,
                    // The key stays: zones bind by key, the name is a label.
                    onchange: (e: Event) => {
                        const name = (e.target as HTMLInputElement).value.trim();
                        if (name) saveVariant(index, { name });
                        else (e.target as HTMLInputElement).value = variant.name;
                    },
                },
                key: { textContent: variant.key },
                remove: { onclick: () => saveVariant(index, null) },
                addItem: {
                    onclick: () => saveVariant(index, {
                        items: [...variant.items, { item: NEW_ITEM_NAME, minDensity: 0, maxDensity: 1 }],
                    }),
                },
            });
            this.buildItems(this.ref(el, 'items'), variant.items, (next) => saveVariant(index, { items: next }));
            variantsHost.appendChild(el);
        });
        return row;
    }

    /** The binding rows of one mix (Default or a variant); `commit` gets the whole new list. */
    private buildItems(host: HTMLElement, items: ZoneTypeItem[], commit: (next: ZoneTypeItem[]) => void): void {
        items.forEach((item, index) => {
            const patch = (next: Partial<ZoneTypeItem>) =>
                commit(items.map((it, i) => (i === index ? { ...it, ...next } : it)));
            host.appendChild(this.wireEl(itemTpl, {
                name: { value: item.item, onchange: (e: Event) => patch({ item: (e.target as HTMLInputElement).value }) },
                min: { value: String(item.minDensity), onchange: (e: Event) => patch({ minDensity: Number((e.target as HTMLInputElement).value) }) },
                max: { value: String(item.maxDensity), onchange: (e: Event) => patch({ maxDensity: Number((e.target as HTMLInputElement).value) }) },
                remove: { onclick: () => commit(items.filter((_, i) => i !== index)) },
            }));
        });
    }
}

