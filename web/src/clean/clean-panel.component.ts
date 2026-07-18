import { Component, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s, panelTitle } from '../css';
import { CleanToolService, type CleanMode } from './clean-tool.service';

const tpl = template(`
    <div class="clean-panel" bind="root" data-testid="clean-panel">
        <div class="status-row">
            <span bind="statusDot" class="status-dot"></span>
            <span bind="statusText" class="status-text"></span>
            <button bind="retryBtn" type="button" class="small-btn">Retry</button>
        </div>
        <div class="mode-section">
            <h4 class="section-title">Mask mode</h4>
            <div class="mode-row">
                <button bind="clickModeBtn" type="button" class="mode-btn">Click object</button>
                <button bind="ellipseModeBtn" type="button" class="mode-btn">Drag ellipse</button>
            </div>
            <div bind="modeHint" class="mode-hint"></div>
        </div>
        <div bind="busyLine" class="busy-line"></div>
        <div bind="previewSection" class="preview-section">
            <div class="preview-label">Preview on the map — bake it?</div>
            <div class="preview-actions">
                <button bind="acceptBtn" type="button" class="accept-btn">Accept &amp; bake</button>
                <button bind="discardBtn" type="button" class="small-btn">Discard</button>
            </div>
        </div>
        <div class="patches-row">
            <span bind="patchCount" class="patch-count"></span>
            <button bind="revertBtn" type="button" class="small-btn">Revert last patch</button>
        </div>
        <div bind="notice" class="notice"></div>
        <div class="clean-panel__hints">
            <div><b>Click</b> a player, cart, or shadow — SAM masks it, LaMa fills it with ground.</div>
            <div><b>Drag an ellipse</b> over anything SAM misses (works without SAM weights).</div>
            <div>Accepted patches bake into the tiles; the pristine photo is never modified.</div>
        </div>
    </div>
`);

/**
 * Side panel for the Clean-photo tool (T55): sidecar/inpaint health gate,
 * mask-mode picker, preview accept/discard, and the baked-patch count with
 * revert-last. Shares the CleanToolService DI singleton with the tool
 * descriptor.
 */
export class CleanPanelComponent extends Component {
    static styles = `
        .clean-panel {
            /* Flat dock body (feature-dock.component.ts hosting contract). */
            display: flex;
            flex-direction: column;
            gap: var(--space-3);
            padding: var(--space-3) var(--space-4) var(--space-4);
            font-size: 0.8rem;
            color: ${t('color-text-primary')};

            & .section-title {
                margin: 0 0 ${s('xs')};
                ${panelTitle()}
            }

            & .status-row {
                display: flex;
                align-items: center;
                gap: ${s('sm')};
            }

            & .status-dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: ${t('color-text-secondary')};
                flex: none;
                &.online { background: var(--data-good); }
                &.offline { background: var(--data-bad); }
                &.degraded { background: var(--data-risk); }
            }

            & .status-text { flex: 1; }

            & .small-btn {
                display: inline-block;
                font: inherit;
                font-size: 0.72rem;
                padding: 2px ${s('sm')};
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius-sm')};
                background: transparent;
                color: ${t('color-text-primary')};
                cursor: pointer;
                &.hidden { display: none; }
                &:disabled { opacity: 0.45; cursor: default; }
            }

            & .mode-row {
                display: flex;
                gap: ${s('xs')};
            }

            & .mode-btn {
                flex: 1;
                font: inherit;
                font-size: 0.75rem;
                padding: ${s('xs')} ${s('sm')};
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius-sm')};
                background: transparent;
                color: ${t('color-text-primary')};
                cursor: pointer;
                &.active {
                    background: ${t('color-surface-card')};
                    border-color: ${t('color-accent-primary')};
                }
            }

            & .mode-hint {
                margin-top: ${s('xs')};
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
            }

            & .busy-line {
                display: none;
                color: ${t('color-text-secondary')};
                &.show { display: block; }
            }

            & .preview-section {
                display: none;
                flex-direction: column;
                gap: ${s('xs')};
                padding: ${s('sm')};
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius-sm')};
                &.show { display: flex; }
            }

            & .preview-actions {
                display: flex;
                gap: ${s('xs')};
            }

            & .accept-btn {
                flex: 1;
                font: inherit;
                font-size: 0.75rem;
                padding: ${s('xs')} ${s('sm')};
                border: 1px solid ${t('color-accent-primary')};
                border-radius: ${t('radius-sm')};
                background: ${t('color-accent-primary')};
                color: ${t('color-on-accent')};
                cursor: pointer;
            }

            & .patches-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: ${s('sm')};
            }

            & .patch-count { color: ${t('color-text-secondary')}; }

            & .notice {
                display: none;
                color: var(--data-bad);
                line-height: 1.4;
                &.show { display: block; }
            }

            & .clean-panel__hints {
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

    private tool = this.inject(CleanToolService);

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            statusDot: {
                className: () => {
                    const health = this.tool.health.get();
                    if (health === 'checking') return 'status-dot';
                    if (health === 'offline') return 'status-dot offline';
                    return this.tool.inpaintReady.get() ? 'status-dot online' : 'status-dot degraded';
                },
            },
            statusText: {
                textContent: () => {
                    const health = this.tool.health.get();
                    if (health === 'checking') return 'Checking assist sidecar…';
                    if (health === 'offline') return 'Sidecar offline — cleaning is disabled';
                    if (!this.tool.inpaintReady.get()) {
                        const detail = this.tool.healthDetail.get();
                        return `Inpainting unavailable${detail ? ` — ${detail}` : ''}`;
                    }
                    return 'Inpaint sidecar ready';
                },
            },
            retryBtn: {
                onclick: () => void this.tool.checkHealth(),
                className: () => this.tool.health.get() === 'online' && this.tool.inpaintReady.get()
                    ? 'small-btn hidden'
                    : 'small-btn',
            },
            clickModeBtn: {
                onclick: () => this.tool.mode.set('click' as CleanMode),
                className: () => `mode-btn${this.tool.mode.get() === 'click' ? ' active' : ''}`,
            },
            ellipseModeBtn: {
                onclick: () => this.tool.mode.set('ellipse' as CleanMode),
                className: () => `mode-btn${this.tool.mode.get() === 'ellipse' ? ' active' : ''}`,
            },
            modeHint: {
                textContent: () => this.tool.mode.get() === 'click'
                    ? 'Click a blemish on the photo — SAM traces its outline.'
                    : 'Press and drag a box — the inscribed ellipse becomes the mask.',
            },
            busyLine: {
                textContent: () => this.tool.phase.get() === 'applying'
                    ? 'Baking into ortho + tiles…'
                    : 'Inpainting… (a few seconds on CPU)',
                className: () => this.tool.phase.get() === 'working' || this.tool.phase.get() === 'applying'
                    ? 'busy-line show'
                    : 'busy-line',
            },
            previewSection: {
                className: () => this.tool.phase.get() === 'preview' ? 'preview-section show' : 'preview-section',
            },
            acceptBtn: { onclick: () => void this.tool.accept() },
            discardBtn: { onclick: () => this.tool.discard() },
            patchCount: {
                textContent: () => {
                    const n = this.tool.patchCount.get();
                    return n === 0 ? 'No baked patches' : `${n} baked patch${n === 1 ? '' : 'es'}`;
                },
            },
            revertBtn: {
                onclick: () => void this.tool.revertLast(),
                disabled: () => this.tool.patchCount.get() === 0 || this.tool.phase.get() !== 'idle',
            },
            notice: {
                textContent: () => this.tool.notice.get() ?? '',
                className: () => this.tool.notice.get() ? 'notice show' : 'notice',
            },
        });

        // Keep the patch count fresh when the panel (re)opens.
        this.track(effect(() => {
            // Touch phase so a bake/revert re-render keeps the row live.
            this.tool.phase.get();
        }));

        return frag;
    }
}
