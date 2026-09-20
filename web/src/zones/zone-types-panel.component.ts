// The course's vegetation zone-type table, edited in place: one row per zone
// type with its display name, editor colour, VSPro mask slot (texture +
// channel) and the item bindings the Unity importer wires into the vegetation
// package (D-VZ9 — vegetation item name, min/max density).
//
// Deliberately plain: this is a short per-course legend a builder touches once
// per course, not a daily surface. Every field commits on `change` (blur or
// Enter) straight through ZoneTypesService, which re-reads the table after
// each write — the server owns key/channel uniqueness and sort order.
//
// Spawned once by CourseDetailComponent and hidden until the command bar's ⋯
// menu calls ZoneTypesService.openFor(), exactly like the export panel.

import { Component, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, primaryBtn, glassPanel, panelTitle, OVERLAY_W, OVERLAY_INSET } from '../css';
import { icon } from '../ui/icons';
import { ZoneTypesService, type CourseZoneType, type ZoneTypeItem } from './zone-types.service';

const tpl = template(`
    <div bind="root" class="zone-types" data-testid="zone-types-panel">
        <div class="zone-types__header">
            <h3>Vegetation zone types</h3>
            <button bind="close" type="button" aria-label="Close" title="Close">${icon('x')}</button>
        </div>
        <div class="zone-types__hint">
            The legend every vegetation zone points at. Each type owns one channel of one mask
            texture (four types per texture), and its items are the VSPro vegetation items the
            Unity importer binds to that channel.
        </div>
        <div bind="list" class="zone-types__list"></div>
        <div bind="errorRow" class="zone-types__error"></div>
        <div class="zone-types__footer">
            <input bind="newName" type="text" placeholder="New zone type" spellcheck="false" autocomplete="off" />
            <button bind="add" type="button" class="zone-types__add">Add</button>
            <button bind="defaults" type="button" class="zone-types__defaults">Add the defaults</button>
        </div>
    </div>
`);

const rowTpl = template(`
    <div bind="row" class="zt-row">
        <div class="zt-row__main">
            <input bind="color" type="color" aria-label="Colour" />
            <input bind="name" type="text" aria-label="Name" spellcheck="false" autocomplete="off" />
            <code bind="key" class="zt-row__key"></code>
            <label class="zt-row__slot">tex <input bind="texture" type="number" min="0" step="1" aria-label="Texture index" /></label>
            <label class="zt-row__slot">ch <input bind="channel" type="number" min="0" max="3" step="1" aria-label="Channel" /></label>
            <button bind="remove" type="button" class="zt-row__remove" aria-label="Delete zone type" title="Delete zone type">${icon('trash-2')}</button>
        </div>
        <div bind="items" class="zt-row__items"></div>
        <button bind="addItem" type="button" class="zt-row__add-item">Add item binding</button>
    </div>
`);

/** Placeholder name a fresh item binding gets, to be typed over. */
const NEW_ITEM_NAME = 'New item';

const itemTpl = template(`
    <div class="zt-item">
        <input bind="name" type="text" aria-label="Vegetation item" placeholder="Item name in the package" spellcheck="false" autocomplete="off" />
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
            & .zt-row__slot {
                display: inline-flex;
                align-items: center;
                gap: 2px;
                font-size: 0.7rem;
                color: ${t('color-text-secondary')};
            }
            & .zt-row__remove, & .zt-row__add-item {
                padding: 2px ${s('xs')};
                font-size: 0.7rem;
                ${btn(t('radius-sm'))}
            }
            & .zt-row__add-item { align-self: flex-start; }
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
        this.track(effect(() => {
            const types = this.svc.items.get();
            list.textContent = '';
            for (const zoneType of types) list.appendChild(this.buildRow(zoneType));
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
            texture: {
                value: String(zoneType.textureIndex),
                onchange: (e: Event) => void this.svc.update(zoneType.id, {
                    textureIndex: Number((e.target as HTMLInputElement).value),
                }),
            },
            channel: {
                value: String(zoneType.channel),
                onchange: (e: Event) => void this.svc.update(zoneType.id, {
                    channel: Number((e.target as HTMLInputElement).value),
                }),
            },
            remove: { onclick: () => void this.svc.remove(zoneType.id) },
            addItem: {
                // Named, not blank: an item binding IS its name in the VSPro
                // package, and the server (rightly) refuses an empty one.
                onclick: () => void this.svc.update(zoneType.id, {
                    items: [...items, { item: NEW_ITEM_NAME, minDensity: 0, maxDensity: 1 }],
                }),
            },
        });

        const itemsHost = row.querySelector('.zt-row__items')!;
        items.forEach((item, index) => {
            const patch = (next: Partial<ZoneTypeItem>) => void this.svc.update(zoneType.id, {
                items: items.map((it, i) => (i === index ? { ...it, ...next } : it)),
            });
            itemsHost.appendChild(this.wireEl(itemTpl, {
                name: { value: item.item, onchange: (e: Event) => patch({ item: (e.target as HTMLInputElement).value }) },
                min: { value: String(item.minDensity), onchange: (e: Event) => patch({ minDensity: Number((e.target as HTMLInputElement).value) }) },
                max: { value: String(item.maxDensity), onchange: (e: Event) => patch({ maxDensity: Number((e.target as HTMLInputElement).value) }) },
                remove: {
                    onclick: () => void this.svc.update(zoneType.id, {
                        items: items.filter((_, i) => i !== index),
                    }),
                },
            }));
        });
        return row;
    }
}

/** Display name → zone-type key: the server accepts `[a-z0-9_]+` only. */
export function slugify(name: string): string {
    return name
        .toLowerCase()
        .replace(/[åä]/g, 'a')
        .replace(/ö/g, 'o')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}
