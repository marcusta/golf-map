import { Component, Signal, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s } from '../css';
import { MapService } from '../map/map.service';
import { EDITOR_TOOLS } from './tools/index';
import type { EditorTool, HelpSection } from './tool';

/** Open/close state for the contextual help modal — trivial enough not to warrant a Signal-per-tool split. */
export class HelpModalService {
    readonly open = new Signal<boolean>(false);

    show(): void { this.open.set(true); }
    hide(): void { this.open.set(false); }
    toggle(): void { this.open.set(!this.open.peek()); }
}

const tpl = template(`
    <div bind="root" class="help-modal-host">
        <div bind="backdrop" class="help-modal-backdrop">
            <section class="help-modal" role="dialog" aria-modal="true" aria-labelledby="help-modal-title">
                <header class="help-modal__header">
                    <h2 bind="title" id="help-modal-title"></h2>
                    <button bind="closeBtn" type="button" class="help-modal__close" aria-label="Close">&times;</button>
                </header>
                <div bind="body" class="help-modal__body"></div>
            </section>
        </div>
    </div>
`);

/**
 * Contextual keyboard-shortcut reference (D27). Opened by `?` (guarded
 * against input targets) or the small `?` buttons in the draw/feature-stack
 * dock headers; content is per-tool — whichever `EditorTool` currently holds
 * `MapService.interactionMode` supplies its `help` sections (editor/tool.ts).
 *
 * Spawned once by `EditorToolbarComponent`, BEFORE the toolbar registers its
 * own Escape listener (see toolbar's onMount) — window keydown listeners
 * fire in registration order, so this component's Escape handler always
 * runs first. It `stopImmediatePropagation`s while open, so closing help
 * never also falls through to the toolbar's ESC (which would deactivate the
 * active tool or cancel an in-progress draw).
 */
export class HelpModalComponent extends Component {
    static styles = `
        .help-modal-host {
            position: fixed;
            inset: 0;
            z-index: 1000;
            display: none;
            color: ${t('text')};
            pointer-events: none;

            &.is-open {
                display: block;
                pointer-events: auto;
            }

            & .help-modal-backdrop {
                position: absolute;
                inset: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(20, 27, 22, 0.36);
                backdrop-filter: blur(3px);
            }

            & .help-modal {
                display: flex;
                flex-direction: column;
                width: min(480px, calc(100vw - 48px));
                max-height: min(600px, calc(100vh - 48px));
                border: 1px solid color-mix(in srgb, ${t('border')} 82%, transparent);
                border-radius: ${t('radius')};
                background: ${t('surface')};
                box-shadow: ${t('shadow-elevated')};
                overflow: hidden;
            }

            & .help-modal__header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: ${s('md')};
                padding: ${s('md')} ${s('lg')};
                border-bottom: 1px solid ${t('border')};
                flex-shrink: 0;
            }

            & .help-modal__header h2 {
                margin: 0;
                font-size: 1.02rem;
                line-height: 1.3;
            }

            & .help-modal__close {
                width: 28px;
                height: 28px;
                flex-shrink: 0;
                border: 1px solid ${t('border')};
                border-radius: 50%;
                background: ${t('surface')};
                color: ${t('text-muted')};
                font-size: 1.1rem;
                line-height: 1;
                cursor: pointer;
                &:hover { background: ${t('hover-bg')}; color: ${t('text')}; }
            }

            & .help-modal__body {
                overflow-y: auto;
                padding: ${s('md')} ${s('lg')} ${s('lg')};
            }

            & .help-section { margin-top: ${s('lg')}; }
            & .help-section:first-child { margin-top: 0; }

            & .help-section__title {
                margin: 0 0 ${s('sm')};
                font-size: 0.72rem;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.06em;
                color: ${t('text-muted')};
            }

            & .help-row {
                display: flex;
                align-items: baseline;
                gap: ${s('md')};
                padding: 3px 0;
            }

            & .help-row__keys {
                flex-shrink: 0;
                min-width: 150px;
                font-family: ui-monospace, monospace;
                font-size: 0.76rem;
                color: ${t('text')};
            }

            & .help-row__desc {
                font-size: 0.82rem;
                color: ${t('text-muted')};
            }

            & .help-empty {
                font-size: 0.85rem;
                color: ${t('text-muted')};
            }
        }
    `;

    private svc = this.inject(HelpModalService);
    private mapSvc = this.inject(MapService);

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            root: { className: () => this.svc.open.get() ? 'help-modal-host is-open' : 'help-modal-host' },
            backdrop: {
                onclick: (e: Event) => {
                    if (e.target === e.currentTarget) this.svc.hide();
                },
            },
            title: { textContent: () => `Keyboard shortcuts — ${this.activeTool()?.label ?? 'Editor'}` },
            closeBtn: { onclick: () => this.svc.hide() },
        });

        const body = this.ref(frag, 'body');
        this.track(effect(() => {
            const sections = this.activeTool()?.help ?? [];
            body.textContent = '';
            if (sections.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'help-empty';
                empty.textContent = 'No shortcuts for this tool.';
                body.appendChild(empty);
                return;
            }
            for (const section of sections) body.appendChild(this.renderSection(section));
        }));

        const onKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            if (
                target instanceof HTMLInputElement ||
                target instanceof HTMLSelectElement ||
                target instanceof HTMLTextAreaElement
            ) return;

            if (e.key === 'Escape') {
                if (!this.svc.open.peek()) return;
                e.preventDefault();
                e.stopImmediatePropagation();
                this.svc.hide();
            } else if (e.key === '?') {
                e.preventDefault();
                this.svc.toggle();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        this.track(() => window.removeEventListener('keydown', onKeyDown));

        return frag;
    }

    private activeTool(): EditorTool | null {
        const id = this.mapSvc.interactionMode.get();
        return id ? EDITOR_TOOLS.find(tool => tool.id === id) ?? null : null;
    }

    private renderSection(section: HelpSection): HTMLElement {
        const el = document.createElement('div');
        el.className = 'help-section';
        const title = document.createElement('h3');
        title.className = 'help-section__title';
        title.textContent = section.title;
        el.appendChild(title);
        for (const shortcut of section.shortcuts) {
            const row = document.createElement('div');
            row.className = 'help-row';
            const keys = document.createElement('span');
            keys.className = 'help-row__keys';
            keys.textContent = shortcut.keys;
            const desc = document.createElement('span');
            desc.className = 'help-row__desc';
            desc.textContent = shortcut.desc;
            row.append(keys, desc);
            el.appendChild(row);
        }
        return el;
    }
}
