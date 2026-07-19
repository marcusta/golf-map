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
            <h4 class="section-title">Mode</h4>
            <div class="mode-row">
                <button bind="clickModeBtn" type="button" class="mode-btn">Click</button>
                <button bind="ellipseModeBtn" type="button" class="mode-btn">Ellipse</button>
                <button bind="stampModeBtn" type="button" class="mode-btn" data-testid="stamp-mode-btn">Stamp</button>
            </div>
            <div bind="modeHint" class="mode-hint"></div>
        </div>
        <div bind="stampSection" class="stamp-section" data-testid="stamp-controls">
            <label class="slider-row">Size <span bind="sizeVal" class="slider-val"></span>
                <input bind="sizeSlider" type="range" min="0.5" max="30" step="0.5">
            </label>
            <label class="slider-row">Opacity <span bind="opacityVal" class="slider-val"></span>
                <input bind="opacitySlider" type="range" min="0.05" max="1" step="0.05">
            </label>
            <label class="slider-row">Flow <span bind="flowVal" class="slider-val"></span>
                <input bind="flowSlider" type="range" min="0.05" max="1" step="0.05">
            </label>
            <label class="slider-row">Hardness <span bind="hardnessVal" class="slider-val"></span>
                <input bind="hardnessSlider" type="range" min="0" max="1" step="0.05">
            </label>
            <label class="check-row"><input bind="alignedCheck" type="checkbox"> Aligned</label>
            <label class="check-row"><input bind="toneMatchCheck" type="checkbox"> Tone-match</label>
        </div>
        <label class="check-row photo-toggle"><input bind="cleanedCheck" type="checkbox" data-testid="cleaned-photo-toggle"> Show cleaned photo</label>
        <div bind="bakeNotice" class="bake-notice"></div>
        <div bind="busyLine" class="busy-line"></div>
        <div bind="previewSection" class="preview-section">
            <div class="preview-label">Preview on the map — queue it?</div>
            <div class="preview-actions">
                <button bind="acceptBtn" type="button" class="accept-btn">Accept</button>
                <button bind="discardBtn" type="button" class="small-btn">Discard</button>
            </div>
        </div>
        <div bind="pendingSection" class="pending-section" data-testid="pending-section">
            <div bind="pendingLabel" class="pending-label"></div>
            <div class="preview-actions">
                <button bind="bakeBtn" type="button" class="accept-btn" data-testid="bake-btn"></button>
                <button bind="discardLastBtn" type="button" class="small-btn">Discard last</button>
            </div>
        </div>
        <div class="patches-row">
            <span bind="patchCount" class="patch-count"></span>
            <button bind="revertBtn" type="button" class="small-btn">Revert last patch</button>
        </div>
        <div bind="notice" class="notice"></div>
        <div class="clean-panel__hints">
            <div bind="hintBlock"></div>
            <div>Edits queue up and bake in ONE batch into the <b>cleaned (sim) photo</b> — the planning photo and iOS bundles always keep the original.</div>
        </div>
    </div>
`);

/**
 * Side panel for the Clean-photo tool: sidecar/inpaint health gate (mask
 * modes; stamping never needs the sidecar), mode picker with clone-stamp
 * brush controls, the dual-photo-state toggle, candidate-preview
 * accept/discard, the pending-edit queue with batch "Bake N edits", and the
 * baked-patch count with revert-last. Shares the CleanToolService DI
 * singleton with the tool descriptor.
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

            & .stamp-section {
                display: none;
                flex-direction: column;
                gap: ${s('xs')};
                padding: ${s('sm')};
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius-sm')};
                &.show { display: flex; }
            }

            & .slider-row {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: ${s('xs')};
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
                & input[type="range"] { width: 100%; }
            }

            & .slider-val {
                margin-left: auto;
                color: ${t('color-text-primary')};
                font-variant-numeric: tabular-nums;
            }

            & .check-row {
                display: flex;
                align-items: center;
                gap: ${s('xs')};
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
                cursor: pointer;
            }

            & .bake-notice {
                display: none;
                padding: ${s('sm')};
                border: 1px solid var(--data-risk);
                border-radius: ${t('radius-sm')};
                background: ${t('color-surface-card')};
                color: ${t('color-text-secondary')};
                line-height: 1.4;
                font-size: 0.72rem;
                &.show { display: block; }
            }

            & .busy-line {
                display: none;
                color: ${t('color-text-secondary')};
                &.show { display: block; }
            }

            & .preview-section, & .pending-section {
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

            & .pending-label { color: ${t('color-text-secondary')}; }

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
                &:disabled { opacity: 0.45; cursor: default; }
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
        const stampHint = 'Alt-click picks the clone source; drag paints. Shift-click draws a line from the last dab; [ ] resize the brush.';
        const frag = this.wire(tpl, {
            statusDot: {
                className: () => {
                    if (this.tool.mode.get() === 'stamp') return 'status-dot online';
                    const health = this.tool.health.get();
                    if (health === 'checking') return 'status-dot';
                    if (health === 'offline') return 'status-dot offline';
                    return this.tool.inpaintReady.get() ? 'status-dot online' : 'status-dot degraded';
                },
            },
            statusText: {
                textContent: () => {
                    if (this.tool.mode.get() === 'stamp') return 'Clone stamp — no sidecar needed';
                    const health = this.tool.health.get();
                    if (health === 'checking') return 'Checking assist sidecar…';
                    if (health === 'offline') return 'Sidecar offline — mask modes are disabled';
                    if (!this.tool.inpaintReady.get()) {
                        const detail = this.tool.healthDetail.get();
                        return `Inpainting unavailable${detail ? ` — ${detail}` : ''}`;
                    }
                    return 'Inpaint sidecar ready';
                },
            },
            retryBtn: {
                onclick: () => void this.tool.checkHealth(),
                className: () => this.tool.mode.get() === 'stamp'
                    || (this.tool.health.get() === 'online' && this.tool.inpaintReady.get())
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
            stampModeBtn: {
                onclick: () => this.tool.mode.set('stamp' as CleanMode),
                className: () => `mode-btn${this.tool.mode.get() === 'stamp' ? ' active' : ''}`,
            },
            modeHint: {
                textContent: () => {
                    const mode = this.tool.mode.get();
                    if (mode === 'click') return 'Click a blemish on the photo — SAM traces its outline.';
                    if (mode === 'ellipse') return 'Press and drag a box — the inscribed ellipse becomes the mask.';
                    return this.tool.hasStampSource.get()
                        ? stampHint
                        : 'Alt-click the photo to pick the clone source, then drag to paint.';
                },
            },
            stampSection: {
                className: () => this.tool.mode.get() === 'stamp' ? 'stamp-section show' : 'stamp-section',
            },
            sizeSlider: {
                value: () => String(this.tool.stampSizeM.get()),
                oninput: (e: Event) => this.tool.stampSizeM.set(Number((e.target as HTMLInputElement).value)),
            },
            sizeVal: { textContent: () => `${this.tool.stampSizeM.get().toFixed(1)} m` },
            opacitySlider: {
                value: () => String(this.tool.stampOpacity.get()),
                oninput: (e: Event) => this.tool.stampOpacity.set(Number((e.target as HTMLInputElement).value)),
            },
            opacityVal: { textContent: () => this.tool.stampOpacity.get().toFixed(2) },
            flowSlider: {
                value: () => String(this.tool.stampFlow.get()),
                oninput: (e: Event) => this.tool.stampFlow.set(Number((e.target as HTMLInputElement).value)),
            },
            flowVal: { textContent: () => this.tool.stampFlow.get().toFixed(2) },
            hardnessSlider: {
                value: () => String(this.tool.stampHardness.get()),
                oninput: (e: Event) => this.tool.stampHardness.set(Number((e.target as HTMLInputElement).value)),
            },
            hardnessVal: { textContent: () => this.tool.stampHardness.get().toFixed(2) },
            alignedCheck: {
                checked: () => this.tool.stampAligned.get(),
                onchange: (e: Event) => this.tool.stampAligned.set((e.target as HTMLInputElement).checked),
            },
            toneMatchCheck: {
                checked: () => this.tool.stampToneMatch.get(),
                onchange: (e: Event) => this.tool.stampToneMatch.set((e.target as HTMLInputElement).checked),
            },
            cleanedCheck: {
                checked: () => this.tool.showCleaned.get(),
                onchange: (e: Event) => this.tool.setShowCleaned((e.target as HTMLInputElement).checked),
            },
            bakeNotice: {
                textContent: () => this.tool.bakeReason.get()
                    ?? "Preview only — this course's map must be rebuilt before edits can bake.",
                className: () => {
                    // Surface the pre-flight block that matters for the mode:
                    // stamps only need the source; masks also need LaMa deps.
                    const blocked = this.tool.mode.get() === 'stamp'
                        ? !this.tool.stampBakeable.get()
                        : !this.tool.bakeable.get();
                    return blocked ? 'bake-notice show' : 'bake-notice';
                },
            },
            busyLine: {
                textContent: () => this.tool.phase.get() === 'applying'
                    ? 'Baking into the cleaned photo…'
                    : 'Inpainting… (a few seconds on CPU)',
                className: () => this.tool.phase.get() === 'working' || this.tool.phase.get() === 'applying'
                    ? 'busy-line show'
                    : 'busy-line',
            },
            previewSection: {
                className: () => this.tool.phase.get() === 'preview' ? 'preview-section show' : 'preview-section',
            },
            acceptBtn: { onclick: () => this.tool.accept() },
            discardBtn: { onclick: () => this.tool.discard() },
            pendingSection: {
                className: () => this.tool.pendingCount.get() > 0 ? 'pending-section show' : 'pending-section',
            },
            pendingLabel: {
                textContent: () => {
                    const n = this.tool.pendingCount.get();
                    return `${n} pending edit${n === 1 ? '' : 's'} (not baked yet)`;
                },
            },
            bakeBtn: {
                textContent: () => `Bake ${this.tool.pendingCount.get()} edit${this.tool.pendingCount.get() === 1 ? '' : 's'}`,
                onclick: () => void this.tool.bakeAll(),
                disabled: () => this.tool.phase.get() !== 'idle' || !this.tool.stampBakeable.get(),
            },
            discardLastBtn: { onclick: () => this.tool.discardLastPending() },
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
            hintBlock: {
                textContent: () => this.tool.mode.get() === 'stamp'
                    ? stampHint
                    : 'Click (SAM) or drag an ellipse to mask a blemish; LaMa fills it with ground. Accept queues the edit.',
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
