import { Component, Signal, template, type PropsOf } from '@basics/core/client/core';
import { s, menuPanel, menuItem, menuDivider } from '../css';

// ============================================================
// Reusable anchored popover/menu primitive for the command-bar redesign
// (dropdowns, the (i) metadata popover, the ⋯ actions menu). Renders a
// trigger button + a floating panel anchored below it; opens on trigger
// click, closes on outside click / Escape / a programmatic `close()`.
//
// Content (both trigger and panel) follows the same shape as the base
// Component's own slot props (string | Component ctor | render fn) so it
// reads like the rest of the codebase — see `slot()`/`SlotContent` in
// @basics/core/client/core. The one addition is `ctx.close()`, threaded
// through to render-fn panel content so a menu item's own click handler can
// dismiss the popover it lives in without reaching back through a parent.
//
// `menuPanel()`/`menuItem()`/`menuDivider()` (css.ts) style the panel chrome
// and are applied here under `.popover__panel` so any consumer can emit
// plain `<button class="menu-item">` rows without writing their own CSS —
// pull the recipes in directly only if you need a *non*-popover menu.
// ============================================================

export interface PopoverContext {
    spawn<T extends Component<any>>(
        Ctor: new (...args: any[]) => T,
        host: HTMLElement,
        ...args: {} extends PropsOf<T> ? [props?: PropsOf<T>] : [props: PropsOf<T>]
    ): T;
    track(dispose: () => void): void;
    /** Close this popover — call from a menu-item's own click handler after acting on the selection. */
    close(): void;
}

export type PopoverRenderFn = (host: HTMLElement, ctx: PopoverContext) => void;

export type PopoverContent =
    | string
    | (new () => Component<any>)
    | PopoverRenderFn;

export type PopoverAlign = 'left' | 'right';

export type PopoverProps = {
    /** Content rendered inside the trigger `<button>`. Style it with `triggerClassName` — the primitive only resets native button chrome. */
    trigger: PopoverContent;
    /** Content rendered inside the floating panel once mounted (visibility toggles via CSS, not mount/unmount). */
    panel: PopoverContent;
    /** Which edge of the trigger the panel's edge lines up with. Default 'left'. */
    align?: PopoverAlign;
    /** Extra class(es) for the trigger button, e.g. an `iconBtn()`-styled class or a dropdown-chip class. */
    triggerClassName?: string;
    /** Extra class(es) for the panel, e.g. to widen it past the menu default. */
    panelClassName?: string;
    ariaLabel?: string;
};

const tpl = template(`
    <div bind="root" class="popover">
        <button bind="trigger" type="button" class="popover__trigger"></button>
        <div bind="panel" class="popover__panel" role="menu"></div>
    </div>
`);

/** Registry backing the "only one popover open at a time" behavior below. */
const openPopovers = new Set<PopoverComponent>();

/**
 * Anchored dropdown/menu primitive (command-bar redesign). Spawn it wherever
 * a trigger needs a floating panel — a "Draw ▾" sub-mode switcher, the
 * feature-type grid, the (i) course-info popover, or a "⋯" actions menu.
 *
 * Usage:
 * ```ts
 * this.spawn(PopoverComponent, host, {
 *     align: 'right',
 *     ariaLabel: 'Actions',
 *     triggerClassName: 'actions-trigger', // your own class using iconBtn() from css.ts
 *     trigger: (host) => { host.innerHTML = icon('more-horizontal', 18); },
 *     panel: (host, ctx) => {
 *         host.innerHTML = `
 *             <button class="menu-item" data-action="import">${icon('upload', 16)}<span class="menu-item__label">Import SVG</span></button>
 *             <button class="menu-item" data-action="export">${icon('download', 16)}<span class="menu-item__label">Export</span></button>
 *         `;
 *         host.querySelectorAll<HTMLButtonElement>('.menu-item').forEach(btn => {
 *             btn.onclick = () => { doAction(btn.dataset.action!); ctx.close(); };
 *         });
 *     },
 * });
 * ```
 * A panel built from a full `Component` subclass (rather than a render fn)
 * gets `ctx.close()` equivalent by injecting/receiving a callback prop —
 * render-fn content is the simplest path when all you need is a few rows.
 */
export class PopoverComponent extends Component<PopoverProps> {
    static styles = `
        .popover {
            position: relative;
            display: inline-flex;
        }

        .popover__trigger {
            border: none;
            background: none;
            padding: 0;
            margin: 0;
            font: inherit;
            color: inherit;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
        }

        .popover__panel {
            position: absolute;
            top: calc(100% + ${s('xs')});
            display: none;
            min-width: 180px;
            max-width: 360px;
            /* Above map overlay chrome (editor toolbar/docks sit at z-index
               5-6) but well under app-modal dialogs (confirm/help at 1000). */
            z-index: 30;
            ${menuPanel()}

            & .menu-item { ${menuItem()} }
            & .menu-divider { ${menuDivider()} }
        }
        .popover__panel.is-open { display: block; }

        .popover--align-left .popover__panel { left: 0; }
        .popover--align-right .popover__panel { right: 0; }
    `;

    readonly open = new Signal(false);
    private rootEl!: HTMLElement;

    render(): DocumentFragment {
        const align = this.props.align ?? 'left';
        const frag = this.wire(tpl, {
            root: { className: `popover popover--align-${align}` },
            trigger: {
                className: () => {
                    const extra = this.props.triggerClassName;
                    return extra ? `popover__trigger ${extra}` : 'popover__trigger';
                },
                onclick: () => this.toggle(),
                'aria-haspopup': 'menu',
                'aria-expanded': () => String(this.open.get()),
                ...(this.props.ariaLabel ? { 'aria-label': this.props.ariaLabel } : {}),
            },
            panel: {
                className: () => {
                    const extra = this.props.panelClassName;
                    const base = this.open.get() ? 'popover__panel is-open' : 'popover__panel';
                    return extra ? `${base} ${extra}` : base;
                },
            },
        });

        this.rootEl = this.ref(frag, 'root');
        this.renderContent(this.props.trigger, this.ref(frag, 'trigger'));
        this.renderContent(this.props.panel, this.ref(frag, 'panel'));

        return frag;
    }

    onMount(): void {
        // Outside click: bubbling (not capturing) listener on document, added
        // once and gated on `open` — safe against the SAME click that opens
        // the popover because the trigger is a descendant of rootEl: by the
        // time this listener runs (document is above the trigger in the
        // bubble path), `contains(target)` is already true and we no-op.
        const onDocClick = (e: MouseEvent) => {
            if (!this.open.peek()) return;
            if (this.rootEl.contains(e.target as Node)) return;
            this.close();
        };
        document.addEventListener('click', onDocClick);
        this.track(() => document.removeEventListener('click', onDocClick));

        // Escape: only consumes the event (stopping it from also closing a
        // help modal or deactivating an editor tool) when THIS popover is
        // actually open.
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || !this.open.peek()) return;
            e.stopPropagation();
            this.close();
        };
        window.addEventListener('keydown', onKeyDown);
        this.track(() => window.removeEventListener('keydown', onKeyDown));

        this.track(() => openPopovers.delete(this));
    }

    toggle(): void {
        this.open.peek() ? this.close() : this.openPopover();
    }

    openPopover(): void {
        // Only one popover open at a time: close any others before opening.
        for (const other of openPopovers) {
            if (other !== this) other.close();
        }
        openPopovers.add(this);
        this.open.set(true);
    }

    close(): void {
        if (!this.open.peek()) return;
        openPopovers.delete(this);
        this.open.set(false);
    }

    private renderContent(content: PopoverContent, host: HTMLElement): void {
        if (typeof content === 'string') {
            host.textContent = content;
        } else if (typeof content === 'function' && content.prototype instanceof Component) {
            this.spawn(content as unknown as new () => Component<any>, host);
        } else {
            (content as PopoverRenderFn)(host, {
                spawn: <T extends Component<any>>(
                    Ctor: new (...args: any[]) => T,
                    h: HTMLElement,
                    ...args: {} extends PropsOf<T> ? [props?: PropsOf<T>] : [props: PropsOf<T>]
                ) => this.spawn(Ctor, h, ...args),
                track: (d: () => void) => this.track(d),
                close: () => this.close(),
            });
        }
    }
}
