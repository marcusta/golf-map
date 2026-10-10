import { Component, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s } from '../css';
import { dockBody, sectionTitle, statusRow, smallBtn, panelInput, busyAndNotice, hintsFooter } from '../editor/panel-recipes.css';
import { CleanToolService, type CleanMode } from './clean-tool.service';

const tpl = template(`
    <div class="clean-panel" bind="root" data-testid="clean-panel">
        <div class="status-row">
            <span bind="statusDot" class="status-dot"></span>
            <span bind="statusText" class="status-text" data-testid="clean-status"></span>
            <button bind="retryBtn" type="button" class="small-btn">Retry</button>
        </div>
        <progress bind="loadBar" class="ext-progress" max="1" data-testid="load-progress"></progress>
        <div class="mode-section">
            <h4 class="section-title">Tool</h4>
            <div class="mode-row">
                <button bind="cloneModeBtn" type="button" class="mode-btn" data-testid="clone-mode-btn">Clone</button>
                <button bind="healModeBtn" type="button" class="mode-btn" data-testid="heal-mode-btn">Heal</button>
                <button bind="spotModeBtn" type="button" class="mode-btn" data-testid="spot-mode-btn">Spot</button>
                <button bind="removeModeBtn" type="button" class="mode-btn" data-testid="remove-mode-btn">Remove</button>
                <button bind="areasModeBtn" type="button" class="mode-btn" data-testid="cleanup-areas-mode">Areas</button>
            </div>
            <div bind="modeHint" class="mode-hint"></div>
        </div>
        <div bind="areasSection" class="stamp-section" data-testid="cleanup-areas-controls">
            <h4 class="section-title">Cleanup areas</h4>
            <div bind="areaDrawingHint" class="mode-hint" role="status" data-testid="cleanup-area-drawing-hint"></div>
            <div class="mode-hint">Green: eligible for cleanup where a tee, fairway, rough or green is mapped. Purple: cleaned whatever is mapped there, or nothing. Orange: keep unchanged, even inside green or purple. These boundaries guide external cleanup; they do not restrict the stamp or manual mask tools.</div>
            <div class="mode-row">
                <button bind="includeAreaBtn" type="button" class="small-btn" data-testid="cleanup-area-include">Area to clean</button>
                <button bind="forceAreaBtn" type="button" class="small-btn" data-testid="cleanup-area-force" title="Clean all ground here, regardless of course features">Clean everything</button>
                <button bind="excludeAreaBtn" type="button" class="small-btn" data-testid="cleanup-area-exclude">Keep unchanged</button>
            </div>
            <label class="check-row"><input bind="areaPreviewCheck" type="checkbox" data-testid="cleanup-area-preview"> Show cleanup preview</label>
            <label class="area-field">Saved areas<select bind="areaSelect" data-testid="cleanup-area-select" aria-label="Saved cleanup areas"></select></label>
            <label class="area-field">Name<input bind="areaName" maxlength="100" data-testid="cleanup-area-name" aria-label="Cleanup area name"></label>
            <div bind="areaDraftActions" class="mode-row">
                <button bind="finishAreaBtn" type="button" class="small-btn" data-testid="cleanup-area-finish">Finish area</button>
                <button bind="backAreaBtn" type="button" class="small-btn">Remove corner</button>
                <button bind="cancelAreaBtn" type="button" class="small-btn">Cancel</button>
            </div>
            <div bind="areaEditActions" class="mode-row">
                <button bind="renameAreaBtn" type="button" class="small-btn">Rename</button>
                <button bind="redrawAreaBtn" type="button" class="small-btn" data-testid="cleanup-area-redraw">Redraw</button>
                <button bind="deleteAreaBtn" type="button" class="small-btn" data-testid="cleanup-area-delete">Delete</button>
            </div>
            <div class="mode-row">
                <button bind="undoAreaBtn" type="button" class="small-btn" data-testid="cleanup-area-undo">Undo area change</button>
                <button bind="reloadAreasBtn" type="button" class="small-btn">Reload areas</button>
            </div>
            <button bind="exportAreasBtn" type="button" class="small-btn" data-testid="cleanup-area-export">Download cleanup boundary</button>
            <div bind="areaMessage" class="mode-hint" role="status" data-testid="cleanup-area-status"></div>
        </div>
        <div bind="brushSection" class="stamp-section" data-testid="brush-controls">
            <label class="slider-row">Size <span bind="sizeVal" class="slider-val"></span>
                <input bind="sizeSlider" type="range" min="0.5" max="30" step="0.5">
            </label>
            <label class="slider-row">Hardness <span bind="hardnessVal" class="slider-val"></span>
                <input bind="hardnessSlider" type="range" min="0" max="1" step="0.05">
            </label>
            <label bind="opacityRow" class="slider-row">Opacity <span bind="opacityVal" class="slider-val"></span>
                <input bind="opacitySlider" type="range" min="0.05" max="1" step="0.05">
            </label>
            <label bind="flowRow" class="slider-row">Flow <span bind="flowVal" class="slider-val"></span>
                <input bind="flowSlider" type="range" min="0.05" max="1" step="0.05">
            </label>
            <label bind="alignedRow" class="check-row"><input bind="alignedCheck" type="checkbox"> Aligned</label>
        </div>
        <div class="preview-actions">
            <button bind="undoStrokeBtn" type="button" class="small-btn" data-testid="undo-stroke-btn">Undo</button>
            <button bind="redoStrokeBtn" type="button" class="small-btn" data-testid="redo-stroke-btn">Redo</button>
        </div>
        <label class="check-row photo-toggle"><input bind="cleanedCheck" type="checkbox" data-testid="cleaned-photo-toggle"> Show cleaned photo</label>
        <div bind="busyLine" class="busy-line"></div>
        <div class="patches-row">
            <span bind="undoCount" class="patch-count" data-testid="undo-count"></span>
            <button bind="undoBtn" type="button" class="small-btn" data-testid="undo-btn">Undo last session</button>
        </div>
        <div class="preview-actions">
            <button bind="unityBtn" type="button" class="accept-btn" data-testid="unity-apply-btn"></button>
        </div>
        <div bind="unityMessage" class="ext-message" data-testid="unity-message"></div>
        <div class="external-section" data-testid="external-edit">
            <h4 class="section-title">Edit in an image editor</h4>
            <div class="ext-line">The cleaned photo is one 8192 × 8192 px image. Download it, edit it, and import the result: any image of that size becomes the cleaned photo.</div>
            <div class="preview-actions">
                <a bind="exportLink" class="accept-btn ext-download" data-testid="export-link">Download photo (PNG)</a>
                <button bind="refreshBtn" type="button" class="small-btn" data-testid="ext-refresh-btn">Refresh</button>
            </div>
            <h5 class="ext-sub">Import a photo</h5>
            <input bind="importFile" type="file" accept="image/png,image/jpeg,image/tiff,.png,.jpg,.jpeg,.tif,.tiff" class="ext-file" data-testid="import-file">
            <progress bind="uploadBar" class="ext-progress" max="1" data-testid="upload-progress"></progress>
            <div bind="importSummary" class="ext-summary" data-testid="import-summary"></div>
            <div bind="extMessage" class="ext-message" data-testid="ext-message"></div>
        </div>
        <div bind="notice" class="notice"></div>
        <div class="clean-panel__hints">
            <div bind="hintBlock"></div>
            <div>Every stroke changes the <b>cleaned photo</b> and is saved at once. The planning photo and iOS bundles always keep the original.</div>
        </div>
    </div>
`);

/**
 * Side panel for the Clean-photo tool: the photo's load and save status, the
 * tool picker (PhotoCraft's Clone Stamp, Healing Brush, Spot Healing and
 * Remove, plus the cleanup Areas), brush controls, stroke undo/redo, the
 * cleaned/original toggle, the server-side "undo last session", Apply in
 * Unity and the image-editor round trip. Shares the CleanToolService DI
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
                flex-wrap: wrap;
                gap: ${s('xs')};
            }

            & .area-field {
                display: flex;
                flex-direction: column;
                gap: ${s('xs')};
                font-size: 0.75rem;
                & input, & select { width: 100%; min-width: 0; ${panelInput()} }
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

            & .ext-download {
                display: inline-block;
                text-decoration: none;
                text-align: center;
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
        const areas = this.tool.areas;
        const areaLocked = () => areas.busy.get() || !!areas.kind.get() || !areas.document.get();
        const noSelection = () => areaLocked() || !areas.selected.get();
        const modeLocked = () => areas.busy.get() || !!areas.kind.get() || this.tool.phase.get() !== 'idle';
        const tool = this.tool;
        const isLive = () => tool.mode.get() === 'clone' || tool.mode.get() === 'heal';
        const modeBtn = (mode: CleanMode) => ({
            onclick: () => tool.setMode(mode), disabled: modeLocked,
            className: () => `mode-btn${tool.mode.get() === mode ? ' active' : ''}`,
        });
        const HINTS: Record<CleanMode, string> = {
            clone: 'Clone Stamp: Alt-click picks the source, drag paints a copy of it.',
            heal: 'Healing Brush: Alt-click picks the source, drag paints; on release the copy blends into its surroundings.',
            spot: 'Spot Healing: paint over a blemish. It is filled from what is around it.',
            remove: 'Remove: paint over an object, or draw a loop around it. It is filled from its surroundings (a few seconds for a large one).',
            areas: 'Define and save the boundary for image cleanup. Your photo stays unchanged.',
        };
        const frag = this.wire(tpl, {
            areasModeBtn: {
                onclick: () => this.tool.setMode('areas'), disabled: modeLocked,
                className: () => `mode-btn${this.tool.mode.get() === 'areas' ? ' active' : ''}`,
            },
            areasSection: { className: () => this.tool.mode.get() === 'areas' ? 'stamp-section show' : 'stamp-section' },
            areaDrawingHint: { textContent: () => areas.kind.get()
                ? `Drawing ${{ include: 'an area to clean', force: 'an area to clean regardless of course features', exclude: 'a protected area' }[areas.kind.get()!]}: drag to trace, or click corners. ${areas.draft.get().length} corners placed. Finish area saves the outline.`
                : 'Choose Area to clean, Clean everything or Keep unchanged to start drawing.' },
            includeAreaBtn: { onclick: () => areas.begin('include'), disabled: areaLocked },
            forceAreaBtn: { onclick: () => areas.begin('force'), disabled: areaLocked },
            excludeAreaBtn: { onclick: () => areas.begin('exclude'), disabled: areaLocked },
            areaPreviewCheck: { checked: () => areas.show.get(), onchange: (e: Event) => areas.show.set((e.target as HTMLInputElement).checked) },
            areaSelect: { disabled: areaLocked, onchange: (e: Event) => areas.select((e.target as HTMLSelectElement).value) },
            areaName: { value: () => areas.name.get(), disabled: () => areas.busy.get() || (!areas.kind.get() && !areas.selected.get()), oninput: (e: Event) => areas.name.set((e.target as HTMLInputElement).value) },
            areaDraftActions: { style: () => areas.kind.get() ? '' : 'display:none' },
            areaEditActions: { style: () => areas.kind.get() ? 'display:none' : '' },
            finishAreaBtn: { onclick: () => void areas.finish(), disabled: () => areas.busy.get() || areas.draft.get().length < 3 },
            backAreaBtn: { onclick: () => areas.back(), disabled: () => areas.busy.get() || !areas.draft.get().length },
            cancelAreaBtn: { onclick: () => areas.cancel(), disabled: () => areas.busy.get() },
            renameAreaBtn: { onclick: () => void areas.rename(), disabled: noSelection },
            redrawAreaBtn: { onclick: () => areas.begin('include', true), disabled: noSelection },
            deleteAreaBtn: { onclick: () => void areas.remove(), disabled: noSelection },
            undoAreaBtn: { onclick: () => void areas.undo(), disabled: () => areaLocked() || !areas.canUndo.get() },
            reloadAreasBtn: { onclick: () => void areas.reload(), disabled: () => areas.busy.get() || !!areas.kind.get() },
            exportAreasBtn: { onclick: () => areas.download(), disabled: () => !areas.canExport() },
            areaMessage: { textContent: () => areas.message.get() },
            statusDot: {
                className: () => {
                    if (tool.mode.get() === 'areas') return 'status-dot online';
                    const photo = tool.photo.get();
                    if (photo === 'error' || tool.saveState.get() === 'error') return 'status-dot offline';
                    if (photo !== 'ready' || tool.saveState.get() === 'saving') return 'status-dot';
                    return 'status-dot online';
                },
            },
            statusText: {
                textContent: () => {
                    if (tool.mode.get() === 'areas') return 'Cleanup boundaries';
                    const photo = tool.photo.get();
                    if (photo === 'error') return tool.loadError.get() ?? 'The photo could not be loaded';
                    if (photo !== 'ready') return `Loading the photo… ${Math.round(tool.loadProgress.get() * 100)} %`;
                    const save = tool.saveState.get();
                    if (save === 'error') return tool.saveError.get() ?? 'Saving failed';
                    return save === 'saving' ? 'Saving…' : 'All changes saved';
                },
            },
            retryBtn: {
                onclick: () => (tool.photo.get() === 'error' ? void tool.retryLoad() : tool.retrySave()),
                className: () => tool.mode.get() !== 'areas' && (tool.photo.get() === 'error' || tool.saveState.get() === 'error')
                    ? 'small-btn'
                    : 'small-btn hidden',
            },
            loadBar: {
                className: () => tool.mode.get() !== 'areas' && tool.photo.get() === 'loading' ? 'ext-progress show' : 'ext-progress',
                value: () => tool.loadProgress.get(),
            },
            cloneModeBtn: modeBtn('clone'),
            healModeBtn: modeBtn('heal'),
            spotModeBtn: modeBtn('spot'),
            removeModeBtn: modeBtn('remove'),
            modeHint: {
                textContent: () => {
                    const mode = tool.mode.get();
                    if ((mode === 'clone' || mode === 'heal') && !tool.hasSource.get()) return `${HINTS[mode]} Pick a source to start.`;
                    return HINTS[mode];
                },
            },
            brushSection: {
                className: () => tool.mode.get() === 'areas' ? 'stamp-section' : 'stamp-section show',
            },
            opacityRow: { style: () => isLive() ? '' : 'display:none' },
            flowRow: { style: () => isLive() ? '' : 'display:none' },
            alignedRow: { style: () => isLive() ? '' : 'display:none' },
            sizeSlider: {
                value: () => String(tool.brushSizeM.get()),
                oninput: (e: Event) => tool.brushSizeM.set(Number((e.target as HTMLInputElement).value)),
            },
            sizeVal: { textContent: () => `${tool.brushSizeM.get().toFixed(1)} m` },
            opacitySlider: {
                value: () => String(tool.brushOpacity.get()),
                oninput: (e: Event) => tool.brushOpacity.set(Number((e.target as HTMLInputElement).value)),
            },
            opacityVal: { textContent: () => tool.brushOpacity.get().toFixed(2) },
            flowSlider: {
                value: () => String(tool.brushFlow.get()),
                oninput: (e: Event) => tool.brushFlow.set(Number((e.target as HTMLInputElement).value)),
            },
            flowVal: { textContent: () => tool.brushFlow.get().toFixed(2) },
            hardnessSlider: {
                value: () => String(tool.brushHardness.get()),
                oninput: (e: Event) => tool.brushHardness.set(Number((e.target as HTMLInputElement).value)),
            },
            hardnessVal: { textContent: () => tool.brushHardness.get().toFixed(2) },
            alignedCheck: {
                checked: () => tool.cloneAligned.get(),
                onchange: (e: Event) => tool.cloneAligned.set((e.target as HTMLInputElement).checked),
            },
            undoStrokeBtn: {
                title: () => 'Ctrl+Z',
                onclick: () => void tool.undoStroke(),
                disabled: () => tool.undoSteps.get() === 0 || tool.working.get() || tool.phase.get() !== 'idle',
            },
            redoStrokeBtn: {
                title: () => 'Ctrl+Shift+Z',
                onclick: () => void tool.redoStroke(),
                disabled: () => tool.redoSteps.get() === 0 || tool.working.get() || tool.phase.get() !== 'idle',
            },
            cleanedCheck: {
                checked: () => this.tool.showCleaned.get(),
                onchange: (e: Event) => this.tool.setShowCleaned((e.target as HTMLInputElement).checked),
            },
            busyLine: {
                textContent: () => {
                    if (tool.working.get()) return 'Filling… (a large area takes a few seconds)';
                    const busy = tool.externalBusy.get();
                    if (busy === 'unity') return 'Rendering the mesh texture and putting it into Unity… (about a minute)';
                    if (busy === 'undo') return 'Putting the earlier photo back…';
                    if (busy === 'import') {
                        const p = tool.uploadProgress.get();
                        return p !== null && p < 1
                            ? `Uploading… ${Math.round(p * 100)} %`
                            : 'Upload done. The server is writing the photo and its map tiles…';
                    }
                    return '';
                },
                className: () => tool.working.get() || tool.phase.get() === 'applying' ? 'busy-line show' : 'busy-line',
            },
            undoCount: {
                textContent: () => {
                    const n = this.tool.undoDepth.get();
                    return n === 0 ? 'No earlier photo kept' : `${n} earlier photo${n === 1 ? '' : 's'} kept`;
                },
            },
            undoBtn: {
                title: () => 'Puts back the cleaned photo from before the last editing session or import.',
                onclick: () => void this.tool.undoLast(),
                disabled: () => this.tool.undoDepth.get() === 0 || this.tool.phase.get() !== 'idle',
            },
            unityBtn: {
                textContent: () => tool.externalBusy.get() === 'unity' ? 'Applying in Unity…' : 'Apply in Unity',
                title: () => 'Puts the cleaned photo onto the course meshes in the open Unity project: the darkened, '
                    + 'green-tinted mesh texture. The old texture is backed up in Unity.',
                onclick: () => void tool.applyInUnity(),
                disabled: () => tool.phase.get() !== 'idle' || !tool.photoExists.get(),
            },
            unityMessage: {
                textContent: () => this.tool.unityMessage.get()?.text ?? '',
                className: () => {
                    const m = this.tool.unityMessage.get();
                    return m ? `ext-message show${m.kind === 'error' ? ' error' : ''}` : 'ext-message';
                },
            },
            exportLink: {
                // A plain download: the server encodes the PNG on demand (about ten seconds).
                href: () => { this.tool.phase.get(); return this.tool.exportUrl() ?? ''; },
            },
            refreshBtn: {
                onclick: () => void this.tool.refreshInfo({ resync: true }),
                disabled: () => this.tool.phase.get() !== 'idle',
            },
            importFile: {
                disabled: () => this.tool.phase.get() !== 'idle',
                onchange: (e: Event) => {
                    const input = e.target as HTMLInputElement;
                    const file = input.files?.[0];
                    if (!file) return;
                    try {
                        input.value = ''; // so the same file can be picked again
                    } catch {
                        // Some environments refuse to reset a file input.
                    }
                    void this.tool.importPhoto(file);
                },
            },
            uploadBar: {
                className: () => this.tool.uploadProgress.get() !== null ? 'ext-progress show' : 'ext-progress',
                value: () => this.tool.uploadProgress.get() ?? 0,
            },
            importSummary: {
                textContent: () => this.tool.importSummary.get() ?? '',
                className: () => this.tool.importSummary.get() ? 'ext-summary show' : 'ext-summary',
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
                textContent: () => tool.mode.get() === 'areas'
                    ? 'Drag to trace, or click corners. Finish area / Enter saves; Ctrl/Cmd-drag pans; Escape cancels. Keep unchanged always wins.'
                    : 'Ctrl+Z undoes a stroke, Ctrl+Shift+Z redoes it. Shift-click draws a straight stroke from the last one; [ ] resize the brush; Ctrl/Cmd-drag pans.',
            },
        });

        const select = frag.querySelector<HTMLSelectElement>('[data-testid="cleanup-area-select"]')!;
        this.track(effect(() => {
            const doc = areas.document.get();
            const selected = areas.selected.get();
            const option = (label: string, value: string) => {
                const el = document.createElement('option');
                el.textContent = label; el.value = value;
                return el;
            };
            select.replaceChildren(option('Select an area', ''));
            for (const a of doc?.areas ?? []) select.append(option(`${{ include: 'Clean', force: 'Clean everything', exclude: 'Keep' }[a.kind]}: ${a.name}`, a.id));
            select.value = selected;
        }));

        // Keep the undo row fresh when the panel (re)opens.
        this.track(effect(() => {
            // Touch phase so a bake/revert re-render keeps the row live.
            this.tool.phase.get();
        }));

        return frag;
    }
}
