import { Component, Signal, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s, panelTitle } from '../css';
import { MapService } from '../map/map.service';
import { EDITOR_TOOLS } from './tools/index';
import type { EditorTool, HelpSection } from './tool';
import { editorHelp } from './editor-keys';
import { ServerModeService, visibleEditorTools } from '../app/server-mode.service';
import { icon } from '../ui/icons';
import { ShortcutService, LAYER } from './shortcut.service';

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
                    <button bind="closeBtn" type="button" class="help-modal__close" aria-label="Close">${icon('x')}</button>
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
 * Spawned once by `EditorToolbarComponent`. Keys arrive through the
 * ShortcutService stack (editor/shortcut.service.ts) at the modal level:
 * below open popovers, above the tool chain. Escape while open closes the
 * modal and is consumed there, so it never also cancels a draft or switches
 * tool. `?` toggles the modal; the dispatcher already keeps it away from
 * text inputs.
 *
 * Below the tool's own sections the modal lists the editor-wide keys
 * (editorHelp, editor-keys.ts) that work in every sub-mode.
 */
export class HelpModalComponent extends Component {
    static styles = `
        .help-modal-host {
            position: fixed;
            inset: 0;
            z-index: 1000;
            display: none;
            color: ${t('color-text-primary')};
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
                background: ${t('overlay-scrim')};
                backdrop-filter: blur(6px);
                -webkit-backdrop-filter: blur(6px);
            }

            & .help-modal {
                display: flex;
                flex-direction: column;
                width: min(480px, calc(100vw - 48px));
                max-height: min(600px, calc(100vh - 48px));
                border: 1px solid ${t('color-border-subtle')};
                border-radius: var(--radius-lg);
                background: ${t('color-surface-card')};
                box-shadow: var(--elev-3);
                overflow: hidden;
            }

            & .help-modal__header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: ${s('md')};
                padding: ${s('md')} ${s('lg')};
                border-bottom: 1px solid ${t('color-border-default')};
                flex-shrink: 0;
            }

            & .help-modal__header h2 {
                margin: 0;
                font-size: 1.02rem;
                line-height: 1.3;
            }

            & .help-modal__close {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 28px;
                height: 28px;
                flex-shrink: 0;
                border: 1px solid ${t('color-border-default')};
                border-radius: 50%;
                background: ${t('color-surface-card')};
                color: ${t('color-text-secondary')};
                cursor: pointer;
                &:hover { background: ${t('color-surface-sunken')}; color: ${t('color-text-primary')}; }
            }

            & .help-modal__body {
                overflow-y: auto;
                padding: ${s('md')} ${s('lg')} ${s('lg')};
            }

            & .help-section { margin-top: ${s('lg')}; }
            & .help-section:first-child { margin-top: 0; }

            & .help-section__title {
                margin: 0 0 ${s('sm')};
                ${panelTitle()}
            }

            & .help-row {
                display: flex;
                align-items: baseline;
                gap: ${s('md')};
                padding: ${s('xs')} 0;
            }

            & .help-row__keys {
                flex-shrink: 0;
                min-width: 150px;
                font-family: var(--font-mono);
                font-variant-numeric: tabular-nums;
                font-size: 0.76rem;
                color: ${t('color-text-primary')};
            }

            & .help-row__desc {
                font-size: 0.82rem;
                color: ${t('color-text-secondary')};
            }
        }
    `;

    private svc = this.inject(HelpModalService);
    private mapSvc = this.inject(MapService);
    private shortcuts = this.inject(ShortcutService);
    private serverMode = this.inject(ServerModeService);

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
            const sections = [
                ...(this.activeTool()?.help ?? []),
                ...editorHelp(visibleEditorTools(this.serverMode.mode.get())),
            ];
            body.textContent = '';
            for (const section of sections) body.appendChild(this.renderSection(section));
        }));

        this.track(this.shortcuts.push({
            id: 'help-modal',
            level: LAYER.modal,
            onKey: (e: KeyboardEvent) => {
                if (e.key === 'Escape') {
                    if (!this.svc.open.peek()) return false;
                    e.preventDefault();
                    this.svc.hide();
                    return true;
                }
                if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
                    e.preventDefault();
                    this.svc.toggle();
                    return true;
                }
                return false;
            },
        }));

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
