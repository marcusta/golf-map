import { Component, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s } from '../css';
import { dockBody, sectionTitle, statusRow, smallBtn, panelInput, busyAndNotice, hintsFooter } from '../editor/panel-recipes.css';
import { API_BASE } from '../api';
import { CleanToolService, type CleanMode } from './clean-tool.service';

/** `ortho-sim-3.png` from whatever path the server reports. */
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

const formatBytes = (bytes: number) =>
    bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(0)} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`;

/** Local `YYYY-MM-DD HH:mm` of an ISO time. */
function formatTime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

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
        <div class="preview-actions">
            <button bind="unityBtn" type="button" class="accept-btn" data-testid="unity-apply-btn"></button>
        </div>
        <div bind="unityMessage" class="ext-message" data-testid="unity-message"></div>
        <div class="external-section" data-testid="external-edit">
            <h4 class="section-title">External edit</h4>
            <div bind="frameLine" class="ext-line" data-testid="ext-frame-line"></div>
            <div bind="pendingNote" class="ext-line"></div>
            <div class="preview-actions">
                <button bind="exportBtn" type="button" class="accept-btn" data-testid="export-btn"></button>
                <button bind="refreshBtn" type="button" class="small-btn" data-testid="ext-refresh-btn">Refresh</button>
            </div>
            <div bind="exportResult" class="ext-result" data-testid="export-result">
                <span bind="exportResultText"></span>
                <a bind="exportResultLink" class="ext-link" data-testid="export-result-link">Download</a>
            </div>
            <ul bind="exportList" class="export-list" data-testid="export-list"></ul>
            <h5 class="ext-sub">Import edited photo</h5>
            <label class="ext-field">Edited from
                <select bind="exportPicker" data-testid="import-export-picker"></select>
            </label>
            <input bind="importFile" type="file" accept="image/png,.png" class="ext-file" data-testid="import-file">
            <details class="ext-advanced">
                <summary>Advanced</summary>
                <label class="ext-field">Tolerance (0 to 254)
                    <input bind="toleranceInput" type="number" min="0" max="254" step="1" placeholder="server default" data-testid="import-tolerance">
                </label>
                <div class="ext-line">Raise it only for a JPEG or a photo saved with a colour-profile change. Empty uses the server default.</div>
            </details>
            <progress bind="uploadBar" class="ext-progress" max="1" data-testid="upload-progress"></progress>
            <div bind="importSummary" class="ext-summary" data-testid="import-summary">
                <div bind="summaryHead" class="ext-summary__head"></div>
                <div bind="summaryDetail" class="ext-summary__detail"></div>
                <div bind="summaryBoxNote" class="ext-line"></div>
                <div bind="summaryWarning" class="ext-warning" data-testid="import-warning"></div>
            </div>
            <div bind="extMessage" class="ext-message" data-testid="ext-message"></div>
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
            ${dockBody()}

            ${sectionTitle()}

            ${statusRow()}

            & .small-btn {
                display: inline-block;
                ${smallBtn()}
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

            & .external-section {
                display: flex;
                flex-direction: column;
                gap: ${s('xs')};
                padding: ${s('sm')};
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius-sm')};
            }

            & .ext-line, & .ext-field {
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
                line-height: 1.4;
                &:empty { display: none; }
            }

            & .ext-sub {
                margin: ${s('xs')} 0 0;
                font-size: 0.75rem;
                font-weight: 600;
            }

            & .ext-field {
                display: flex;
                flex-direction: column;
                gap: 2px;
                & select, & input { ${panelInput()} }
            }

            & .ext-file { font: inherit; font-size: 0.72rem; width: 100%; }
            & .ext-file:disabled { opacity: 0.45; }

            & .ext-advanced {
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
                & summary { cursor: pointer; }
                & .ext-field { margin-top: ${s('xs')}; }
            }

            & .ext-result {
                display: none;
                font-size: 0.72rem;
                line-height: 1.4;
                &.show { display: block; }
            }

            & .ext-link {
                color: ${t('color-accent-primary')};
                text-decoration: underline;
                cursor: pointer;
            }

            & .export-list {
                list-style: none;
                margin: 0;
                padding: 0;
                max-height: 7rem;
                overflow-y: auto;
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
                font-variant-numeric: tabular-nums;
                & li {
                    display: flex;
                    justify-content: space-between;
                    gap: ${s('sm')};
                    padding: 1px 0;
                }
            }

            & .ext-progress {
                display: none;
                width: 100%;
                &.show { display: block; }
            }

            & .ext-summary {
                display: none;
                flex-direction: column;
                gap: 2px;
                padding: ${s('sm')};
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius-sm')};
                &.show { display: flex; }
            }

            & .ext-summary__head { font-weight: 600; }
            & .ext-summary__detail { font-size: 0.72rem; white-space: pre-line; color: ${t('color-text-secondary')}; }

            & .ext-warning {
                display: none;
                font-size: 0.72rem;
                line-height: 1.4;
                color: var(--data-risk);
                &.show { display: block; }
            }

            & .ext-message {
                display: none;
                line-height: 1.4;
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
                &.error { color: var(--data-bad); }
                &.show { display: block; }
            }

            ${busyAndNotice()}

            ${hintsFooter('clean-panel__hints')}
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
                textContent: () => {
                    if (this.tool.phase.get() !== 'applying') return 'Inpainting… (a few seconds on CPU)';
                    const busy = this.tool.externalBusy.get();
                    if (busy === 'export') return 'Exporting the cleaned photo… (up to a minute, longer if patches must be replayed first)';
                    if (busy === 'unity') return 'Rendering the mesh texture and putting it into Unity… (about a minute)';
                    if (busy === 'import') {
                        const p = this.tool.uploadProgress.get();
                        return p !== null && p < 1
                            ? `Uploading… ${Math.round(p * 100)} %`
                            : 'Upload done — the server is comparing, baking and retiling…';
                    }
                    return 'Baking into the cleaned photo…';
                },
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
            unityBtn: {
                textContent: () => {
                    if (this.tool.externalBusy.get() === 'unity') return 'Applying in Unity…';
                    return this.tool.pendingCount.get() > 0 ? 'Bake and apply in Unity' : 'Apply in Unity';
                },
                title: () => 'Puts the cleaned photo onto the course meshes in the open Unity project: the darkened, '
                    + 'green-tinted mesh texture. Pending edits are baked first. The old texture is backed up in Unity.',
                onclick: () => void this.tool.applyInUnity(),
                disabled: () => this.tool.phase.get() !== 'idle'
                    || (this.tool.patchCount.get() === 0 && this.tool.pendingCount.get() === 0),
            },
            unityMessage: {
                textContent: () => this.tool.unityMessage.get()?.text ?? '',
                className: () => {
                    const m = this.tool.unityMessage.get();
                    return m ? `ext-message show${m.kind === 'error' ? ' error' : ''}` : 'ext-message';
                },
            },
            frameLine: {
                textContent: () => {
                    const frame = this.tool.exportFrame.get();
                    const n = this.tool.exports.get().length;
                    const count = n === 0 ? 'no exports yet' : `${n} export${n === 1 ? '' : 's'}`;
                    return frame
                        ? `Frame ${frame.size} × ${frame.size} px, fixed for this course · ${count}`
                        : `The first export fixes the frame (a square image) · ${count}`;
                },
            },
            pendingNote: {
                textContent: () => {
                    const n = this.tool.pendingCount.get();
                    return n > 0 ? `${n} pending edit${n === 1 ? ' is' : 's are'} not baked yet and not in the export.` : '';
                },
            },
            exportBtn: {
                textContent: () => this.tool.externalBusy.get() === 'export' ? 'Exporting…' : 'Export cleaned photo (PNG)',
                onclick: () => void this.tool.exportPhoto(),
                disabled: () => this.tool.phase.get() !== 'idle',
            },
            refreshBtn: {
                onclick: () => void this.tool.refreshInfo({ resync: true }),
                disabled: () => this.tool.phase.get() !== 'idle',
            },
            exportResult: {
                className: () => this.tool.lastExport.get() ? 'ext-result show' : 'ext-result',
            },
            exportResultText: {
                textContent: () => {
                    const r = this.tool.lastExport.get();
                    if (!r) return '';
                    return `Exported ${fileName(r.file)} (${formatBytes(r.bytes)}, ${r.size} px, patches through ${r.logSeq}). `;
                },
            },
            exportResultLink: {
                href: () => {
                    const r = this.tool.lastExport.get();
                    return r ? API_BASE + r.downloadPath : '';
                },
                download: () => {
                    const r = this.tool.lastExport.get();
                    return r ? fileName(r.file) : '';
                },
            },
            exportPicker: {
                disabled: () => this.tool.exports.get().length === 0 || this.tool.phase.get() !== 'idle',
                onchange: (e: Event) => this.tool.pickedExportSeq.set(Number((e.target as HTMLSelectElement).value)),
            },
            importFile: {
                disabled: () => this.tool.exports.get().length === 0 || this.tool.phase.get() !== 'idle',
                onchange: (e: Event) => {
                    const input = e.target as HTMLInputElement;
                    const file = input.files?.[0];
                    if (!file) return;
                    const seq = this.tool.effectiveExportSeq();
                    const tolerance = input.closest('.external-section')
                        ?.querySelector<HTMLInputElement>('[data-testid="import-tolerance"]');
                    const raw = tolerance?.value.trim() ?? '';
                    try {
                        input.value = ''; // so the same file can be picked again
                    } catch {
                        // Some environments refuse to reset a file input.
                    }
                    if (seq === null) return;
                    void this.tool.importPhoto(file, seq, raw === '' ? null : Number(raw));
                },
            },
            uploadBar: {
                className: () => this.tool.uploadProgress.get() !== null ? 'ext-progress show' : 'ext-progress',
                value: () => this.tool.uploadProgress.get() ?? 0,
            },
            importSummary: {
                className: () => this.tool.importSummary.get() ? 'ext-summary show' : 'ext-summary',
            },
            summaryHead: { textContent: () => this.tool.importSummary.get()?.headline ?? '' },
            summaryDetail: { textContent: () => this.tool.importSummary.get()?.details.join('\n') ?? '' },
            summaryBoxNote: { textContent: () => this.tool.importSummary.get()?.boxNote ?? '' },
            summaryWarning: {
                textContent: () => this.tool.importSummary.get()?.warning ?? '',
                className: () => this.tool.importSummary.get()?.warning ? 'ext-warning show' : 'ext-warning',
            },
            extMessage: {
                textContent: () => this.tool.externalMessage.get()?.text ?? '',
                className: () => {
                    const m = this.tool.externalMessage.get();
                    return m ? `ext-message show${m.kind === 'error' ? ' error' : ''}` : 'ext-message';
                },
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

        // Existing exports, newest first, each with its download link.
        this.$each(
            this.ref(frag, 'exportList'),
            () => [...this.tool.exports.get()].reverse(),
            exp => {
                const li = document.createElement('li');
                const label = document.createElement('span');
                label.textContent = `#${exp.seq} · ${formatTime(exp.createdAt)} · ${formatBytes(exp.bytes)} · patches through ${exp.logSeq}`;
                const link = document.createElement('a');
                link.className = 'ext-link';
                link.textContent = 'Download';
                link.href = API_BASE + exp.downloadPath;
                link.download = `ortho-sim-${exp.seq}.${exp.format}`;
                li.append(label, link);
                return li;
            },
            exp => exp.seq,
        );

        // Import picker: one option per export, the latest unless picked.
        const picker = this.ref(frag, 'exportPicker') as HTMLSelectElement;
        this.$each(
            picker,
            () => [...this.tool.exports.get()].reverse(),
            exp => {
                const option = document.createElement('option');
                option.value = String(exp.seq);
                option.textContent = `Export ${exp.seq} (${formatTime(exp.createdAt)})`;
                return option;
            },
            exp => exp.seq,
        );
        // Registered after the $each so it runs once the options exist.
        this.track(effect(() => {
            const seq = this.tool.effectiveExportSeq();
            this.tool.exports.get();
            if (seq !== null) picker.value = String(seq);
        }));

        // Keep the patch count fresh when the panel (re)opens.
        this.track(effect(() => {
            // Touch phase so a bake/revert re-render keeps the row live.
            this.tool.phase.get();
        }));

        return frag;
    }
}
