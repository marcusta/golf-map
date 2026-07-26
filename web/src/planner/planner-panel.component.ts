import { Component, Signal, Computed, effect, template, untrack } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, field, panelTitle, metric, selectedRow, primaryBtn } from '../css';
import { clubAdvice, mpsToMph, type BreakSide } from '../../../shared/strategy';
import type { PlanShot, PlanGate } from '../../../shared/api/game-plans.gen';
import { FurnitureService } from '../furniture/furniture.service';
import { ClubsService } from '../player/clubs.service';
import { ConfirmService } from '../app/confirm-dialog.component';
import { PlanService } from './plan.service';
import { PlannerToolService } from './planner-tool.service';
import { icon } from '../ui/icons';
import { PuttReadService, DEFAULT_STIMP_FT, type PuttReadDisplay } from './putt-read.service';
import { PuttEstimateService } from './putt-estimate.service';
import { scoreEstimate, type PuttEstimate, type PuttEstimateScore } from './putt-estimate-score';
import {
    gateLabel,
    legDriftLabel,
    legLight,
    scoreRiskTriple,
    type LegLight,
    type PlanLeg,
    type PlanNode,
} from './plan-overlay';
import { formatPercent, meanLabel, onScriptLabel } from './sim-histogram';
import { variantChipText } from './sim-overlay';
import { ElevationService } from '../map/elevation.service';
import { ElevationProfileService } from '../profile/elevation-profile.service';
import { ElevationProfileComponent, signedMeters } from '../profile/elevation-profile.component';

/** localStorage key for the training-mode toggle (default ON per doc §5.1). */
const TRAINING_MODE_KEY = 'golf-map.putt.trainingMode';

function loadTrainingMode(): boolean {
    try {
        const v = localStorage.getItem(TRAINING_MODE_KEY);
        return v === null ? false : v === '1'; // default OFF — show the read first
    } catch {
        return false;
    }
}

function saveTrainingMode(on: boolean): void {
    try {
        localStorage.setItem(TRAINING_MODE_KEY, on ? '1' : '0');
    } catch {
        // Non-fatal — the toggle just won't persist across reloads.
    }
}

/**
 * Drag frames rebuild `holePlan` per mouse-move; the profile re-samples the
 * terrain only once the route geometry settles for this long.
 */
const PROFILE_DEBOUNCE_MS = 150;

/** Profile marker labels paralleling the route nodes: Tee / S1… (or the shot's label) / Green. */
function profileLabels(nodes: readonly PlanNode[]): string[] {
    let shotIndex = 0;
    return nodes.map(n => {
        if (n.kind === 'tee') return 'Tee';
        if (n.kind === 'green') return 'Green';
        shotIndex++;
        return n.shot?.label?.trim() || `S${shotIndex}`;
    });
}

const tpl = template(`
    <div class="plan-panel" bind="root" data-testid="planner-panel">
        <div class="plan-panel__section">
            <h4 class="section-title">Plan</h4>
            <div class="mode-row">
                <button bind="browseMode" type="button" class="mode-btn" data-testid="planner-browse-mode">Browse</button>
                <button bind="addShot" type="button" class="mode-btn" data-testid="planner-add-shot">+ Shot</button>
                <button bind="addGate" type="button" class="mode-btn" data-testid="planner-add-gate">+ Gate</button>
                <button bind="puttMode" type="button" class="mode-btn" data-testid="planner-putt-mode">Putt</button>
            </div>
            <div bind="hint" class="plan-hint"></div>
        </div>

        <div bind="browseSection" class="plan-panel__section" data-testid="planner-browse-section">
            <div class="browse-head">
                <h4 class="section-title">Distance ladder</h4>
                <button bind="resetBrowse" type="button" class="mini-btn" data-testid="planner-browse-reset">From tee</button>
            </div>
            <div bind="browseFrom" class="browse-from"></div>
            <div bind="browseDetail" class="browse-detail" data-testid="planner-browse-detail">
                <div bind="browseDetailBody" class="browse-detail__body"></div>
                <button bind="promoteBrowse" type="button" class="mini-btn browse-promote" data-testid="planner-browse-promote">Browse from here</button>
            </div>
            <div bind="browseRows" class="browse-rows" data-testid="planner-browse-rows"></div>
        </div>

        <div bind="puttSection" class="plan-panel__section" data-testid="planner-putt-section">
            <h4 class="section-title">Putt read</h4>
            <div class="wind-row">
                <label class="plan-field">Stimp ft
                    <input bind="stimpInput" type="number" step="0.5" min="4" max="16" data-testid="planner-putt-stimp" />
                </label>
                <label class="putt-training-toggle" title="Estimate the read yourself before it's revealed (§5.1)">
                    <input bind="trainingToggle" type="checkbox" data-testid="planner-putt-training-toggle" />
                    Training
                </label>
            </div>
            <div class="putt-place-row">
                <span class="putt-place-label">Tap places:</span>
                <button bind="placeBallBtn" type="button" class="mini-btn" data-testid="planner-putt-place-ball">Ball</button>
                <button bind="placeHoleBtn" type="button" class="mini-btn" data-testid="planner-putt-place-hole">Hole</button>
                <button bind="holeAtPinBtn" type="button" class="mini-btn" data-testid="planner-putt-hole-at-pin">At pin</button>
            </div>
            <div class="putt-overlay-row">
                <span class="putt-place-label">Map:</span>
                <button bind="overlaySlopeBtn" type="button" class="mini-btn" data-testid="planner-putt-overlay-slope">Slope</button>
                <button bind="overlayHeightBtn" type="button" class="mini-btn" data-testid="planner-putt-overlay-height">Height</button>
                <button bind="overlayNoneBtn" type="button" class="mini-btn" data-testid="planner-putt-overlay-none">Off</button>
            </div>
            <div bind="puttQuiz" class="putt-quiz" data-testid="planner-putt-quiz"></div>
            <div bind="puttScore" class="putt-score" data-testid="planner-putt-score"></div>
            <div bind="puttVerbal" class="putt-verbal" data-testid="planner-putt-verbal"></div>
            <div bind="puttBody" class="putt-body" data-testid="planner-putt-read"></div>
            <div bind="puttConfidence" class="putt-confidence" data-testid="planner-putt-confidence"></div>
        </div>

        <div bind="holeSection" class="plan-panel__section">
            <h4 class="section-title">Hole setup</h4>
            <label class="plan-field">Tee
                <select bind="teeSelect"></select>
            </label>
            <label class="plan-field">Preferred club (tee leg)
                <select bind="preferredClub"></select>
            </label>
        </div>

        <div class="plan-panel__section">
            <h4 class="section-title">Wind</h4>
            <div class="wind-row">
                <label class="plan-field">Plan m/s
                    <input bind="planWindSpeed" type="number" step="0.1" min="0" />
                </label>
                <label class="plan-field">From °
                    <input bind="planWindDir" type="number" step="1" min="0" max="359" />
                </label>
            </div>
            <div bind="planWindMph" class="wind-mph"></div>
            <div bind="overrideBlock" class="override-block">
                <div class="wind-row">
                    <label class="plan-field">Hole m/s
                        <input bind="holeWindSpeed" type="number" step="0.1" min="0" placeholder="inherit" />
                    </label>
                    <label class="plan-field">From °
                        <input bind="holeWindDir" type="number" step="1" min="0" max="359" placeholder="inherit" />
                    </label>
                </div>
                <button bind="clearOverride" type="button" class="mini-btn">Clear override (inherit plan)</button>
            </div>
            <div bind="effectiveWind" class="wind-effective"></div>
        </div>

        <div bind="legsSection" class="plan-panel__section" data-testid="planner-legs-section">
            <h4 class="section-title">Legs</h4>
            <div bind="legsBody" class="legs-body" data-testid="planner-legs-body"></div>
        </div>

        <div class="plan-panel__section" data-testid="planner-profile-section">
            <h4 class="section-title">Elevation profile</h4>
            <div bind="profileHost"></div>
        </div>

        <div bind="caddySection" class="plan-panel__section" data-testid="planner-caddy-section">
            <h4 class="section-title">Caddy</h4>
            <div bind="caddyBody" class="caddy-body" data-testid="planner-caddy-body"></div>
        </div>

        <div bind="simSection" class="plan-panel__section" data-testid="planner-sim-section">
            <h4 class="section-title">Simulate</h4>
            <div class="sim-actions">
                <button bind="simulateBtn" type="button" class="mini-btn" data-testid="planner-simulate">Simulate</button>
                <button bind="suggestBtn" type="button" class="mini-btn" data-testid="planner-suggest-lines">Suggest lines</button>
                <label class="sim-toggle"
                    title="Show sampled landings on the map — coloured by shot number (1st shot clay, 2nd sky, 3rd wheat)">
                    <input bind="scatterToggle" type="checkbox" data-testid="planner-sim-scatter" /> Landings
                </label>
            </div>
            <div bind="simBody" class="sim-body" data-testid="planner-sim-body"></div>
            <div bind="variantList" class="variant-list" data-testid="planner-variant-list"></div>
        </div>

        <div bind="shotsSection" class="plan-panel__section" data-testid="planner-shots-section">
            <h4 class="section-title">Shots</h4>
            <button bind="addAlternative" type="button" class="mini-btn" data-testid="planner-add-alternative">+ Alternative to selected shot</button>
            <div bind="shotList" class="shot-list" data-testid="planner-shot-list"></div>
            <div bind="noShots" class="empty-note">No shots yet — arm “+ Shot” and click the map.</div>
            <button bind="applyAim" type="button" class="mini-btn" data-testid="planner-apply-aim">Apply recommended aim</button>
            <button bind="seedAims" type="button" class="mini-btn" data-testid="planner-seed-aims">Seed shots from aim points</button>
        </div>

        <div bind="gatesSection" class="plan-panel__section" data-testid="planner-gates-section">
            <h4 class="section-title">Gates</h4>
            <div bind="gateList" class="gate-list" data-testid="planner-gate-list"></div>
            <div bind="noGates" class="empty-note">No gates yet — arm “+ Gate” and click near a leg.</div>
            <button bind="autoGates" type="button" class="mini-btn" data-testid="planner-auto-gates">Auto gates from hazards</button>
        </div>

        <div bind="notesSection" class="plan-panel__section">
            <h4 class="section-title">Hole notes</h4>
            <textarea bind="notes" rows="3" placeholder="e.g. favour the left half — OB right"></textarea>
        </div>

        <div bind="status" class="plan-panel__status"></div>
        <div class="plan-panel__hints">
            <div><b>+ Shot</b>: click the map to append landing points (Esc stops).</div>
            <div><b>+ Gate</b>: click near a leg — drag the endpoints to set widths.</div>
            <div>Drag markers to move · <b>Del</b> deletes the selection.</div>
            <div><b>⌘-drag</b> pans the map from anywhere, even off a marker.</div>
        </div>
    </div>
`);

const shotRowTpl = template(`
    <div bind="row" class="shot-row">
        <span bind="idx" class="shot-idx"></span>
        <select bind="club" class="shot-club" title="Club for this shot"></select>
        <input bind="label" class="shot-label" type="text" placeholder="option label" />
        <div class="shot-actions">
            <button bind="primary" class="option-action" type="button" data-testid="planner-set-primary">Set primary</button>
            <button bind="removeOption" class="option-action danger" type="button" data-testid="planner-delete-option">Delete option</button>
            <button bind="remove" class="row-remove" type="button" aria-label="Delete shot" title="Delete shot and splice its continuations">${icon('x')}</button>
        </div>
        <span bind="chip" class="shot-chip" data-testid="planner-option-chip"></span>
        <span bind="dist" class="shot-dist"></span>
        <span bind="advice" class="shot-advice"></span>
    </div>
`);

const gateRowTpl = template(`
    <div bind="row" class="gate-row">
        <span bind="name" class="gate-name"></span>
        <span bind="widths" class="gate-widths"></span>
        <button bind="remove" class="row-remove" type="button" aria-label="Delete gate" title="Delete gate">${icon('x')}</button>
    </div>
`);

// Training quiz (doc §5.1): estimate the read BEFORE it's revealed. Rendered
// into the putt section when training mode is on and a read is available.
const puttQuizTpl = template(`
    <div bind="root" class="putt-quiz__form">
        <div class="putt-quiz__prompt">Your read first — <span bind="dist"></span></div>
        <div class="putt-quiz__grid">
            <label class="plan-field">Slope %
                <input bind="slope" type="number" step="0.1" min="0" data-testid="planner-putt-est-slope" />
            </label>
            <label class="plan-field">Break
                <select bind="side" data-testid="planner-putt-est-side">
                    <option value="straight">Straight</option>
                    <option value="left">Left</option>
                    <option value="right">Right</option>
                </select>
            </label>
            <label class="plan-field">Aim cm
                <input bind="aim" type="number" step="1" data-testid="planner-putt-est-aim" />
            </label>
            <label class="plan-field">Plays m
                <input bind="pace" type="number" step="0.1" min="0" data-testid="planner-putt-est-pace" />
            </label>
        </div>
        <div class="putt-quiz__actions">
            <button bind="submit" type="button" class="mini-btn quiz-submit" data-testid="planner-putt-est-submit">Reveal &amp; score</button>
            <button bind="skip" type="button" class="mini-btn" data-testid="planner-putt-est-skip">Skip</button>
        </div>
    </div>
`);

/**
 * The planner's control panel, hosted statically in the right contextual
 * dock (ContextDockComponent, "Plan"): add-shot / add-gate arming, tee +
 * preferred-club selects, plan/hole wind with inherit-aware override (m/s
 * canonical, mph display-only), per-leg readouts, shot rows
 * (club/label/remove), gate rows, and hole notes. Shares the
 * PlannerToolService/PlanService DI singletons with the tool. Conforms to
 * the dock hosting contract (see feature-dock.component.ts): flat column
 * content, no glass wrapper, no fixed width, own section padding — the
 * dock owns the surface, the 268px width and the scroll bound.
 */
export class PlannerPanelComponent extends Component {
    static styles = `
        .plan-panel {
            display: flex;
            flex-direction: column;
            font-size: 0.8rem;
            color: ${t('color-text-primary')};

            & .plan-panel__section {
                padding: var(--space-3) var(--space-4);
                border-bottom: 1px solid ${t('color-border-default')};
                display: flex;
                flex-direction: column;
                gap: ${s('sm')};
            }

            & .section-title {
                margin: 0;
                ${panelTitle()}
            }

            /* Guide §04: mode switcher reads as one segmented control, not
               loose buttons — sunken track, lifted active pill. */
            & .mode-row {
                display: flex;
                gap: 4px;
                background: ${t('color-surface-sunken')};
                border: 1px solid ${t('color-border-default')};
                border-radius: 12px;
                padding: 4px;
            }
            & .mode-btn {
                flex: 1;
                padding: ${s('xs')} 2px;
                font-size: 0.75rem;
                border: none;
                border-radius: 9px;
                background: transparent;
                color: ${t('color-text-secondary')};
                font-family: inherit;
                cursor: pointer;
                transition: background var(--dur-fast) var(--ease-standard),
                    color var(--dur-fast) var(--ease-standard);
                &:hover { color: ${t('color-text-primary')}; }
                &.active {
                    background: ${t('color-surface-raised')};
                    color: ${t('color-text-primary')};
                    font-weight: 600;
                    box-shadow: var(--elev-1);
                }
            }

            & .plan-hint {
                display: none;
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
                &.show { display: block; }
                &.warn { color: ${t('color-status-negative')}; }
            }

            & .browse-head {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: ${s('sm')};
            }
            & .browse-from {
                font-size: 0.7rem;
                color: ${t('color-text-secondary')};
            }
            & .browse-detail {
                display: none;
                padding: 7px;
                gap: ${s('xs')};
                border: 1px solid ${t('color-border-focus')};
                border-radius: ${t('radius-sm')};
                background: ${t('color-surface-raised')};
                &.show {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                }
            }
            & .browse-detail__body {
                min-width: 0;
                font-size: 0.7rem;
                line-height: 1.4;
                color: ${t('color-text-secondary')};
                & b {
                    display: block;
                    overflow: hidden;
                    color: ${t('color-text-primary')};
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
            }
            & .browse-promote { flex: 0 0 auto; }
            & .browse-rows { display: flex; flex-direction: column; gap: 3px; }
            & .browse-row {
                display: grid;
                grid-template-columns: minmax(0, 1fr) auto;
                gap: 2px ${s('xs')};
                width: 100%;
                padding: 5px 7px;
                border: 1px solid transparent;
                border-radius: ${t('radius-sm')};
                background: ${t('color-surface-sunken')};
                color: ${t('color-text-primary')};
                text-align: left;
                font-family: inherit;
                cursor: pointer;
                &:hover {
                    border-color: ${t('color-border-focus')};
                    background: ${t('color-surface-raised')};
                }
                &.selected {
                    border-color: ${t('color-border-focus')};
                    background: ${t('color-surface-raised')};
                }
            }
            & .browse-row__label {
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                font-size: 0.73rem;
                font-weight: 600;
            }
            & .browse-row__distance {
                ${metric()}
                font-size: 0.82rem;
            }
            & .browse-row__detail {
                grid-column: 1 / -1;
                font-size: 0.66rem;
                color: ${t('color-text-secondary')};
                font-family: var(--font-mono);
                font-variant-numeric: tabular-nums;
            }

            & .plan-field { ${field()} min-width: 0; flex: 1; }
            & .wind-row { display: flex; gap: ${s('sm')}; }
            & .wind-mph, & .wind-effective {
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
                font-family: var(--font-mono);
                font-variant-numeric: tabular-nums;
            }
            & .override-block { display: flex; flex-direction: column; gap: ${s('xs')}; }
            & .mini-btn {
                padding: 3px ${s('xs')};
                font-size: 0.72rem;
                ${btn(t('radius-sm'))}
                &[aria-pressed="true"] {
                    border-color: ${t('color-accent-primary')};
                    color: ${t('color-on-accent')};
                    background: ${t('color-accent-primary')};
                }
            }
            /* Guide §04: one clay primary per view — the quiz's "reveal" is
               the panel's single main action; everything else stays quiet. */
            & .mini-btn.quiz-submit {
                ${primaryBtn()}
                padding: 3px ${s('xs')};
                font-size: 0.72rem;
            }
            & .putt-place-row {
                display: flex;
                gap: ${s('xs')};
                align-items: center;
                flex-wrap: wrap;
            }
            & .putt-place-label { font-size: 0.72rem; color: ${t('color-text-secondary')}; }
            & .putt-overlay-row { display: flex; gap: ${s('xs')}; align-items: center; }

            & .legs-body { font-size: 0.75rem; line-height: 1.6; color: ${t('color-text-secondary')}; }
            & .legs-body b { color: ${t('color-text-primary')}; }
            & .leg-light {
                display: inline-block;
                width: 9px;
                height: 9px;
                border-radius: 50%;
                margin-right: 5px;
                vertical-align: baseline;
                border: 1px solid rgba(0, 0, 0, 0.35);
                &.leg-light--green { background: var(--data-good); }
                &.leg-light--yellow { background: var(--data-risk); }
                &.leg-light--red { background: var(--data-bad); }
            }

            /* Guide §02: every measurement in mono, tabular, semibold — the
               unit drops to text-tertiary at ~80% size. Reserved for a
               clean isolated number+unit pair (\`.metric\`); mixed prose
               lines (a whole "wind …" / "EV …" callout) use the lighter
               \`.metric-line\` (mono + tabular, normal weight). */
            & .metric { ${metric()} }
            & .metric-line { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }

            & .shot-advice {
                grid-column: 2 / span 2;
                font-size: 0.68rem;
                color: ${t('color-text-secondary')};
            }

            & .putt-verbal {
                font-size: 0.82rem;
                font-weight: 600;
                color: ${t('color-text-primary')};
            }
            & .putt-body { font-size: 0.75rem; line-height: 1.6; color: ${t('color-text-secondary')}; }
            & .putt-body b { color: ${t('color-text-primary')}; }
            & .putt-body .putt-warn { color: ${t('color-status-negative')}; }
            & .putt-confidence {
                font-size: 0.7rem;
                color: ${t('color-text-secondary')};
                font-family: var(--font-mono);
                font-variant-numeric: tabular-nums;
            }

            & .putt-training-toggle {
                display: flex;
                align-items: center;
                gap: 4px;
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
                white-space: nowrap;
                align-self: flex-end;
            }
            & .putt-quiz__form { display: flex; flex-direction: column; gap: ${s('xs')}; }
            & .putt-quiz__prompt { font-size: 0.75rem; font-weight: 600; color: ${t('color-text-primary')}; }
            & .putt-quiz__grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: ${s('xs')};
            }
            & .putt-quiz__grid .plan-field select {
                min-width: 0;
                font-family: inherit;
                padding: 2px 4px;
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius-sm')};
                background: ${t('color-surface-card')};
                color: ${t('color-text-primary')};
            }
            & .putt-quiz__actions { display: flex; gap: ${s('xs')}; }
            & .putt-score {
                font-size: 0.75rem;
                line-height: 1.6;
                color: ${t('color-text-secondary')};
            }
            & .putt-score b { color: ${t('color-text-primary')}; }

            & .caddy-body { display: flex; flex-direction: column; gap: 6px; }
            & .caddy-card {
                border-left: 3px solid ${t('color-accent-primary')};
                padding: 4px 8px;
                background: ${t('color-surface-sunken')};
                border-radius: 3px;
            }
            & .caddy-headline { font-size: 0.78rem; font-weight: 600; color: ${t('color-text-primary')}; }
            & .caddy-why { font-size: 0.72rem; line-height: 1.5; color: ${t('color-text-secondary')}; margin-top: 2px; }

            /* ── Hole simulation (feature-hole-sim-and-variants §5) ──────── */
            & .sim-actions { display: flex; gap: ${s('xs')}; align-items: center; flex-wrap: wrap; }
            & .sim-toggle {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
            }
            & .sim-body { display: flex; flex-direction: column; gap: 6px; margin-top: ${s('xs')}; }
            /* Stale = the plan moved under the result. Dimmed, never hidden and
               never silently recomputed (V8): an old distribution still informs. */
            & .sim-card {
                padding: 4px 8px;
                background: ${t('color-surface-sunken')};
                border-radius: 3px;
                border-left: 3px solid ${t('color-accent-primary')};
                &.stale { opacity: 0.45; }
            }
            & .sim-card__head {
                display: flex;
                justify-content: space-between;
                gap: ${s('xs')};
                font-size: 0.74rem;
                font-weight: 600;
                color: ${t('color-text-primary')};
            }
            & .sim-card__mean { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
            & .sim-card__survives { font-size: 0.7rem; color: ${t('color-text-secondary')}; }
            & .sim-bucket {
                display: grid;
                grid-template-columns: 4.6rem 1fr 2.4rem;
                gap: 4px;
                align-items: center;
                font-size: 0.7rem;
                color: ${t('color-text-secondary')};
            }
            & .sim-bucket__bar {
                height: 6px;
                border-radius: 3px;
                background: ${t('color-border-default')};
                overflow: hidden;
            }
            & .sim-bucket__fill { display: block; height: 100%; background: ${t('color-accent-primary')}; }
            & .sim-bucket__pct {
                text-align: right;
                font-family: var(--font-mono);
                font-variant-numeric: tabular-nums;
            }
            & .sim-note { font-size: 0.72rem; color: ${t('color-text-secondary')}; }
            & .sim-note.error { color: ${t('color-status-negative')}; }

            & .variant-list { display: flex; flex-direction: column; gap: ${s('xs')}; margin-top: ${s('xs')}; }
            /*
             * TWO LINES, deliberately: the label is a sentence-length signature
             * ("right of the bunkers · right of the trees · 2 shots") and the
             * dock is narrow. The old single-row 1fr/auto/auto grid gave the
             * label whatever the chip and two buttons left over — about four
             * characters — so every row wrapped one word per line and was
             * unreadable. Label owns row 1 in full; chip + actions share row 2.
             */
            & .variant-row {
                display: grid;
                grid-template-columns: 1fr auto;
                grid-template-areas: 'label label' 'chip actions';
                gap: 2px 4px;
                align-items: center;
                padding: ${s('xs')};
                border-radius: ${t('radius-sm')};
                border-left: 2px dashed ${t('color-border-default')};
                font-size: 0.78rem;
                color: ${t('color-text-secondary')};
                cursor: pointer;
                &:hover { background: ${t('color-surface-sunken')}; }
                /* Pinned ghost — matches the map's emphasised corridor. */
                &.selected {
                    background: ${t('color-surface-sunken')};
                    border-left-style: solid;
                    border-left-color: ${t('color-accent-primary')};
                }
            }
            & .variant-row__label {
                grid-area: label;
                color: ${t('color-text-primary')};
                font-weight: 500;
                line-height: 1.25;
            }
            & .variant-row__chip {
                grid-area: chip;
                font-family: var(--font-mono);
                font-variant-numeric: tabular-nums;
            }
            & .variant-row .shot-actions { grid-area: actions; }

            & .shot-list, & .gate-list { display: flex; flex-direction: column; gap: 2px; }
            & .empty-note { display: none; font-size: 0.72rem; color: ${t('color-text-secondary')}; &.show { display: block; } }

            & .shot-row {
                display: grid;
                grid-template-columns: 2rem 1fr 1fr;
                gap: ${s('xs')};
                align-items: center;
                padding: 2px ${s('xs')};
                border-left: 2px solid transparent;
                border-radius: ${t('radius-sm')};
                cursor: pointer;
                &:hover { background: ${t('color-surface-sunken')}; }
                &.selected { ${selectedRow()} }
                &.option-row { border-left-color: ${t('color-border-default')}; }
            }
            & .shot-idx {
                font-size: 0.68rem;
                font-weight: 600;
                color: ${t('color-text-secondary')};
            }
            & .shot-club, & .shot-label {
                min-width: 0;
                font-size: 0.72rem;
                font-family: inherit;
                padding: 2px 4px;
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius-sm')};
                background: ${t('color-surface-card')};
                color: ${t('color-text-primary')};
            }
            /* Option score chip (T30): the decision's headline number —
               semibold mono, hidden entirely off decision points. */
            & .shot-chip {
                grid-column: 2 / span 2;
                font-size: 0.7rem;
                font-weight: 600;
                color: ${t('color-text-primary')};
                font-family: var(--font-mono);
                font-variant-numeric: tabular-nums;
                &:empty { display: none; }
            }
            & .shot-dist {
                grid-column: 2 / span 2;
                font-size: 0.7rem;
                color: ${t('color-text-secondary')};
                font-family: var(--font-mono);
                font-variant-numeric: tabular-nums;
            }
            & .shot-actions {
                grid-column: 2 / span 2;
                display: flex;
                align-items: center;
                justify-content: flex-end;
                gap: 4px;
            }
            & .option-action {
                padding: 2px 5px;
                font-size: 0.66rem;
                ${btn(t('radius-sm'))}
                &.danger { color: ${t('color-status-negative')}; }
            }

            & .gate-row {
                display: flex;
                align-items: center;
                gap: ${s('xs')};
                padding: 2px ${s('xs')};
                border-radius: ${t('radius-sm')};
                cursor: pointer;
                &:hover { background: ${t('color-surface-sunken')}; }
                &.selected { ${selectedRow()} }
            }
            & .gate-name { font-weight: 600; }
            & .gate-widths {
                flex: 1;
                color: ${t('color-text-secondary')};
                font-size: 0.72rem;
                font-family: var(--font-mono);
                font-variant-numeric: tabular-nums;
            }

            & .row-remove {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                padding: 0 4px;
                font-size: 0.72rem;
                line-height: 1.4;
                ${btn(t('radius-sm'))}
                color: ${t('color-status-negative')};
                border-color: transparent;
            }

            & textarea {
                padding: ${s('sm')} ${s('md')};
                font-size: 0.8rem;
                font-family: inherit;
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius-sm')};
                background: ${t('color-surface-card')};
                color: ${t('color-text-primary')};
                resize: vertical;
            }

            & .plan-panel__status {
                padding: ${s('xs')} var(--space-4);
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
                min-height: 1.4em;
                &.error { color: ${t('color-status-negative')}; }
            }

            & .plan-panel__hints {
                padding: ${s('xs')} var(--space-4) var(--space-3);
                font-size: 0.68rem;
                line-height: 1.5;
                color: ${t('color-text-secondary')};
                border-top: 1px solid ${t('color-border-default')};
            }
        }
    `;

    private plan = this.inject(PlanService);
    private clubs = this.inject(ClubsService);
    private furniture = this.inject(FurnitureService);
    private tool = this.inject(PlannerToolService);
    private confirm = this.inject(ConfirmService);
    private putt = this.inject(PuttReadService);
    private puttEstimate = this.inject(PuttEstimateService);
    private profile = this.inject(ElevationProfileService);
    private elevation = this.inject(ElevationService);

    // ── Training-quiz state (doc §5.1) ─────────────────────────────────────
    /** Training mode on/off (persisted). Default ON — "first-class, not incidental". */
    private trainingMode = new Signal(loadTrainingMode());
    /** True once the player has submitted or skipped for the CURRENT putt. */
    private revealed = new Signal(false);
    /** The score for the last submitted estimate (cleared when skipped/reset). */
    private lastScore = new Signal<PuttEstimateScore | null>(null);

    /**
     * Signature of the settled putt the quiz is gating — ball, hole and stimp.
     * When it changes (new/adjusted putt) the quiz resets to "estimate first".
     */
    private puttSig = new Computed<string>(() => {
        const b = this.putt.ball.get();
        const h = this.putt.hole.get();
        return `${b ? `${b.x},${b.y}` : ''}|${h ? `${h.x},${h.y}` : ''}|${this.putt.stimpFt.get()}`;
    });

    /**
     * True when the estimate FORM should replace the read: training on, a read
     * is available (ok/soft — never for withheld/loading/place), and the player
     * hasn't revealed this putt yet.
     */
    private quizActive = new Computed<boolean>(() => {
        if (!this.trainingMode.get()) return false;
        if (this.revealed.get()) return false;
        const status = this.putt.display.get().status;
        return status === 'ok' || status === 'soft';
    });

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            browseMode: {
                onclick: () => this.tool.enterBrowseMode(),
                className: () => this.tool.mode.get() === 'select' ? 'mode-btn active' : 'mode-btn',
            },
            addShot: {
                onclick: () => this.tool.setMode('add-shot'),
                className: () => this.tool.mode.get() === 'add-shot' ? 'mode-btn active' : 'mode-btn',
            },
            addAlternative: {
                onclick: () => this.tool.setMode('add-alternative'),
                disabled: () => !this.tool.selectedShot.get(),
                textContent: () => this.tool.mode.get() === 'add-alternative'
                    ? 'Click map to place the alternative'
                    : '+ Alternative to selected shot',
            },
            addGate: {
                onclick: () => this.tool.setMode('add-gate'),
                className: () => this.tool.mode.get() === 'add-gate' ? 'mode-btn active' : 'mode-btn',
            },
            puttMode: {
                onclick: () => this.tool.setMode('putt'),
                className: () => this.tool.mode.get() === 'putt' ? 'mode-btn active' : 'mode-btn',
            },
            puttSection: { style: () => this.tool.mode.get() === 'putt' ? '' : 'display:none' },
            browseSection: { style: () => this.tool.mode.get() === 'putt' ? 'display:none' : '' },
            resetBrowse: {
                onclick: () => this.tool.resetBrowseFrom(),
                disabled: () => !this.tool.browseOrigin.get()?.isOverride,
            },
            browseFrom: () => this.tool.browseOrigin.get()?.isOverride
                ? 'From selected map point · select a target to inspect it'
                : 'From selected tee · select a target to inspect it',
            browseDetail: {
                className: () => this.tool.inspectedBrowseRow.get() ? 'browse-detail show' : 'browse-detail',
            },
            browseDetailBody: { textContent: () => '' },
            promoteBrowse: {
                onclick: () => this.tool.promoteInspectedBrowseTarget(),
                disabled: () => !this.tool.inspectedBrowseRow.get(),
            },
            hint: {
                textContent: () => this.hintText() ?? '',
                className: () => {
                    const notice = this.tool.notice.get();
                    if (notice) return 'plan-hint show warn';
                    return this.hintText() ? 'plan-hint show' : 'plan-hint';
                },
            },
            holeSection: { style: () => this.tool.selectedHole.get() ? '' : 'display:none' },
            planWindMph: () => {
                const speed = this.plan.plan.get()?.windSpeedMps ?? null;
                return speed !== null ? `= ${mpsToMph(speed).toFixed(1)} mph` : '';
            },
            overrideBlock: { style: () => this.tool.selectedHole.get() ? '' : 'display:none' },
            clearOverride: {
                onclick: () => void this.setHoleWind(null, null),
                style: () => {
                    const hole = this.tool.planHole.get();
                    return hole && (hole.windSpeedMps !== null || hole.windDirectionDeg !== null)
                        ? '' : 'display:none';
                },
            },
            effectiveWind: () => {
                const wind = this.tool.effectiveWind.get();
                if (!wind) return 'Effective: calm (no wind set)';
                return `Effective: ${wind.speedMps.toFixed(1)} m/s `
                    + `(${mpsToMph(wind.speedMps).toFixed(1)} mph) from ${Math.round(wind.directionDeg)}°`;
            },
            legsSection: { style: () => (this.tool.overlayPlan.get()?.legs.length ?? 0) > 0 ? '' : 'display:none' },
            legsBody: { textContent: () => '' }, // filled via effect (multiline)
            caddySection: { style: () => this.tool.caddyAdvice.get().length > 0 ? '' : 'display:none' },
            caddyBody: { textContent: () => '' }, // filled via effect (multiline)
            simSection: { style: () => this.tool.selectedHole.get() ? '' : 'display:none' },
            simulateBtn: {
                onclick: () => void this.tool.simulateNow(),
                disabled: () => this.tool.sim.running.get(),
                textContent: () => this.tool.sim.running.get() ? 'Simulating…' : 'Simulate',
            },
            suggestBtn: {
                onclick: () => void this.tool.suggestLines(),
                disabled: () => this.tool.sim.discovering.get(),
                textContent: () => this.tool.sim.discovering.get() ? 'Finding lines…' : 'Suggest lines',
            },
            simBody: { textContent: () => '' }, // filled via effect (multiline)
            variantList: { textContent: () => '' }, // filled via effect (multiline)
            shotsSection: { style: () => this.tool.selectedHole.get() ? '' : 'display:none' },
            noShots: { className: () => this.tool.holeShots.get().length === 0 ? 'empty-note show' : 'empty-note' },
            applyAim: {
                onclick: () => void this.tool.applyRecommendedAim(),
                // Shown only when the selected shot has a recommended ghost aim.
                style: () => this.tool.selectedShotGhostAim.get() ? '' : 'display:none',
            },
            seedAims: {
                onclick: () => void this.seedFromAims(),
                textContent: () => {
                    const n = this.tool.aimCount.get();
                    return `Seed shots from ${n} aim point${n === 1 ? '' : 's'}`;
                },
                // Only offer it when the hole actually has aim points to seed from.
                style: () => this.tool.aimCount.get() > 0 ? '' : 'display:none',
            },
            gatesSection: { style: () => this.tool.selectedHole.get() ? '' : 'display:none' },
            noGates: { className: () => this.tool.holeGates.get().length === 0 ? 'empty-note show' : 'empty-note' },
            autoGates: {
                onclick: () => void this.tool.generateAutoGates(),
                // Only offer it when there are legs to cast a corridor from.
                style: () => (this.tool.overlayPlan.get()?.legs.length ?? 0) > 0 ? '' : 'display:none',
            },
            notesSection: { style: () => this.tool.selectedHole.get() ? '' : 'display:none' },
            status: {
                textContent: () => this.statusText(),
                className: () => this.plan.saveError.get() || this.plan.error.get() || this.clubs.error.get()
                    ? 'plan-panel__status error' : 'plan-panel__status',
            },
        });

        this.bindTeeSelect(this.ref(frag, 'teeSelect') as HTMLSelectElement);
        this.bindPreferredClub(this.ref(frag, 'preferredClub') as HTMLSelectElement);
        this.bindWindInputs(frag);
        this.bindPuttSection(frag);
        this.bindNotes(this.ref(frag, 'notes') as HTMLTextAreaElement);

        // E2E cadence hook (inert in prod): mirror the tool's completed-
        // enrichment-pass counter onto the panel root as data-enrich-count.
        // The smoke suite reads it to prove enrichment stays flat across drag
        // frames and bumps exactly once on release (DECADE §4.5).
        const rootEl = this.ref(frag, 'root');
        this.track(effect(() => {
            rootEl.dataset.enrichCount = String(this.tool.enrichCount.get());
        }));

        // Multiline legs readout (distances / plays-like / carries / remaining).
        const legsBody = this.ref(frag, 'legsBody');
        this.track(effect(() => { legsBody.innerHTML = this.legsHtml(); }));

        const browseRows = this.ref(frag, 'browseRows');
        this.track(effect(() => { browseRows.innerHTML = this.browseRowsHtml(); }));
        const browseDetailBody = this.ref(frag, 'browseDetailBody');
        this.track(effect(() => { browseDetailBody.innerHTML = this.browseDetailHtml(); }));
        const onBrowseRow = (event: Event): void => {
            const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-browse-row]');
            if (!button) return;
            const row = this.tool.browseRows.peek().find(candidate => candidate.id === button.dataset.browseRow);
            if (row) this.tool.activateBrowseRow(row);
        };
        browseRows.addEventListener('click', onBrowseRow);
        this.track(() => browseRows.removeEventListener('click', onBrowseRow));

        // Caddy advice (green-slope-half + future rules), ranked highest first.
        const caddyBody = this.ref(frag, 'caddyBody');
        this.track(effect(() => { caddyBody.innerHTML = this.caddyHtml(); }));

        // ── Hole simulation (§5) ─────────────────────────────────────────
        const scatterToggle = this.ref(frag, 'scatterToggle') as HTMLInputElement;
        this.track(effect(() => { scatterToggle.checked = this.tool.sim.scatterVisible.get(); }));
        const onScatter = (): void => this.tool.sim.scatterVisible.set(scatterToggle.checked);
        scatterToggle.addEventListener('change', onScatter);
        this.track(() => scatterToggle.removeEventListener('change', onScatter));

        const simBody = this.ref(frag, 'simBody');
        this.track(effect(() => { simBody.innerHTML = this.simHtml(); }));

        // Ghost branches: hovering a row previews its corridor on the map,
        // accept materialises it as ordinary shots, dismiss just forgets it.
        const variantList = this.ref(frag, 'variantList');
        this.track(effect(() => {
            const html = this.variantsHtml();
            variantList.innerHTML = html;
            // The rows the pointer was over no longer exist — mouseleave will
            // never fire for them, so the corridor preview would stick on the
            // map after an accept/dismiss/hole switch. Drop it with them.
            if (html === '') untrack(() => this.tool.hoverVariant(null));
        }));
        const variantId = (event: Event): string | null =>
            (event.target as HTMLElement).closest<HTMLElement>('[data-variant]')?.dataset.variant ?? null;
        const onVariantClick = (event: Event): void => {
            const id = variantId(event);
            if (!id) return;
            const action = (event.target as HTMLElement).closest<HTMLElement>('[data-variant-action]');
            if (!action) {
                // Anywhere else on the row pins the ghost (and clicking the
                // pinned row again unpins it) — the affordance that makes a
                // suggestion inspectable once the pointer moves away.
                this.tool.selectVariant(id);
                return;
            }
            if (action.dataset.variantAction === 'accept') void this.tool.acceptVariant(id);
            else this.tool.dismissVariant(id);
        };
        const onVariantKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                this.tool.selectVariant(null);
                return;
            }
            if (event.key !== 'Enter' && event.key !== ' ') return;
            // Keyboard parity for the row itself; the accept/dismiss buttons
            // are real <button>s and handle their own keys.
            const target = event.target as HTMLElement;
            if (target.closest('[data-variant-action]')) return;
            const id = variantId(event);
            if (!id) return;
            event.preventDefault();
            this.tool.selectVariant(id);
        };
        const onVariantOver = (event: Event): void => this.tool.hoverVariant(variantId(event));
        const onVariantOut = (event: Event): void => {
            // mouseout fires per row (including row → row); only clear when the
            // pointer actually left the list. mouseleave alone misses the case
            // where the hovered row is removed from under the cursor.
            const to = (event as MouseEvent).relatedTarget;
            if (to instanceof Node && variantList.contains(to)) return;
            this.tool.hoverVariant(null);
        };
        const onVariantBlur = (event: Event): void => {
            // Keyboard parity: tabbing off the accept/dismiss buttons clears the
            // preview the same way moving the pointer away does.
            const to = (event as FocusEvent).relatedTarget;
            if (to instanceof Node && variantList.contains(to)) return;
            this.tool.hoverVariant(null);
        };
        const onVariantFocus = (event: Event): void => this.tool.hoverVariant(variantId(event));
        variantList.addEventListener('click', onVariantClick);
        variantList.addEventListener('keydown', onVariantKey);
        variantList.addEventListener('mouseover', onVariantOver);
        variantList.addEventListener('mouseout', onVariantOut);
        variantList.addEventListener('mouseleave', onVariantOut);
        variantList.addEventListener('focusin', onVariantFocus);
        variantList.addEventListener('focusout', onVariantBlur);
        this.track(() => {
            variantList.removeEventListener('click', onVariantClick);
            variantList.removeEventListener('keydown', onVariantKey);
            variantList.removeEventListener('mouseover', onVariantOver);
            variantList.removeEventListener('mouseout', onVariantOut);
            variantList.removeEventListener('mouseleave', onVariantOut);
            variantList.removeEventListener('focusin', onVariantFocus);
            variantList.removeEventListener('focusout', onVariantBlur);
        });

        // Elevation profile along the hole route (tee → shots → green) — the
        // iOS profile sheet's web home. Sampled through the shared
        // ElevationService; debounced so drag frames don't re-sample the
        // terrain per mouse-move (stale batches are seq-dropped regardless).
        this.spawn(ElevationProfileComponent, this.ref(frag, 'profileHost'));
        this.profile.useSampler(p => this.elevation.elevationAt({ lng: p.lon, lat: p.lat }));
        let profileTimer: ReturnType<typeof setTimeout> | undefined;
        this.track(effect(() => {
            const nodes = this.tool.holePlan.get()?.nodes ?? [];
            clearTimeout(profileTimer);
            profileTimer = setTimeout(() => {
                void this.profile.update(
                    nodes.map(n => ({ lat: n.lat, lon: n.lon })),
                    profileLabels(nodes),
                );
            }, PROFILE_DEBOUNCE_MS);
        }));
        this.track(() => clearTimeout(profileTimer));

        this.buildShotRows(this.ref(frag, 'shotList'));
        this.buildGateRows(this.ref(frag, 'gateList'));

        return frag;
    }

    /**
     * Seed the hole's plan shots from its furniture aim points. When the hole
     * already has shots, confirm a replace (so re-seeding doesn't stack dupes);
     * an empty hole seeds straight away.
     */
    private async seedFromAims(): Promise<void> {
        const existing = this.tool.holeShots.peek().length;
        if (existing > 0) {
            const ok = await this.confirm.confirm({
                title: 'Replace existing shots?',
                body: `This will replace the ${existing} existing shot${existing === 1 ? '' : 's'} on this hole with aim point shots.`,
                detail: 'Existing shot labels, clubs, and landing positions for this hole will be replaced.',
                confirmLabel: 'Replace shots',
                cancelLabel: 'Keep current shots',
                tone: 'warning',
                layout: 'review',
            });
            if (!ok) return;
        }
        await this.tool.seedShotsFromAims(existing > 0);
    }

    // ── Hole setup (tee / preferred club) ───────────────────────────────────

    private bindTeeSelect(sel: HTMLSelectElement): void {
        sel.addEventListener('change', () => {
            const hole = this.tool.selectedHole.peek();
            if (!hole) return;
            const teeId = sel.value || null;
            void this.plan.setHoleFields(hole.number, { teeId });
            // Remember the chosen tee BY NAME so it sticks to the other holes
            // (holes without their own teeId anchor on this name).
            const tee = teeId ? this.furniture.teesForHole(hole.id).find(t => t.id === teeId) : null;
            this.tool.setActiveTeeName(tee ? tee.name : null);
            this.tool.resetBrowseFrom();
        });
        this.track(effect(() => {
            const hole = this.tool.selectedHole.get();
            const tees = hole ? this.furniture.teesForHole(hole.id) : [];
            const current = this.tool.originTee.get();
            sel.textContent = '';
            for (const tee of tees) {
                const opt = document.createElement('option');
                opt.value = tee.id;
                opt.textContent = tee.name;
                sel.appendChild(opt);
            }
            if (tees.length === 0) {
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = 'No tees on this hole';
                sel.appendChild(opt);
            }
            sel.value = current?.id ?? '';
        }));
    }

    private bindPreferredClub(sel: HTMLSelectElement): void {
        sel.addEventListener('change', () => {
            const hole = this.tool.selectedHole.peek();
            if (!hole) return;
            void this.plan.setHoleFields(hole.number, { preferredClubId: sel.value || null });
        });
        this.track(effect(() => {
            const clubs = this.tool.orderedClubs.get();
            const current = this.tool.planHole.get()?.preferredClubId ?? '';
            sel.textContent = '';
            const none = document.createElement('option');
            none.value = '';
            none.textContent = '— none —';
            sel.appendChild(none);
            for (const club of clubs) {
                const opt = document.createElement('option');
                opt.value = club.id;
                opt.textContent = `${club.name} (${Math.round(club.carryM)} m)`;
                sel.appendChild(opt);
            }
            sel.value = current;
        }));
    }

    // ── Wind ────────────────────────────────────────────────────────────────

    private bindWindInputs(frag: DocumentFragment): void {
        const planSpeed = this.ref(frag, 'planWindSpeed') as HTMLInputElement;
        const planDir = this.ref(frag, 'planWindDir') as HTMLInputElement;
        const holeSpeed = this.ref(frag, 'holeWindSpeed') as HTMLInputElement;
        const holeDir = this.ref(frag, 'holeWindDir') as HTMLInputElement;

        planSpeed.addEventListener('change', () =>
            void this.plan.setPlanWind({ windSpeedMps: parseNum(planSpeed.value, 1) }));
        planDir.addEventListener('change', () =>
            void this.plan.setPlanWind({ windDirectionDeg: parseNum(planDir.value, 0) }));
        holeSpeed.addEventListener('change', () => {
            const hole = this.tool.selectedHole.peek();
            if (hole) void this.plan.setHoleFields(hole.number, { windSpeedMps: parseNum(holeSpeed.value, 1) });
        });
        holeDir.addEventListener('change', () => {
            const hole = this.tool.selectedHole.peek();
            if (hole) void this.plan.setHoleFields(hole.number, { windDirectionDeg: parseNum(holeDir.value, 0) });
        });

        // Reflect store state into the inputs — but never clobber the field
        // the user is currently typing in.
        this.track(effect(() => {
            const plan = this.plan.plan.get();
            syncInput(planSpeed, plan?.windSpeedMps ?? null, 1);
            syncInput(planDir, plan?.windDirectionDeg ?? null, 0);
        }));
        this.track(effect(() => {
            const hole = this.tool.planHole.get();
            syncInput(holeSpeed, hole?.windSpeedMps ?? null, 1);
            syncInput(holeDir, hole?.windDirectionDeg ?? null, 0);
        }));
    }

    /** Clear (or set) both hole-override wind fields (null = inherit). */
    private async setHoleWind(speed: number | null, dir: number | null): Promise<void> {
        const hole = this.tool.selectedHole.peek();
        if (!hole) return;
        await this.plan.setHoleFields(hole.number, { windSpeedMps: speed, windDirectionDeg: dir });
    }

    // ── Putt read (feature-putting-green-reading §5.1) ──────────────────────

    /**
     * Stimp input follows the wind-input pattern (change → service, effect →
     * input unless focused); the read blocks render from the single
     * `PuttReadService.display` view-model. B2: the training quiz (doc §5.1)
     * gates that display behind an "estimate first" step — when training mode
     * is on and a read is available, an estimate FORM replaces the read until
     * the player submits (scored) or skips (revealed, unrecorded). The service
     * and tool stay untouched; all quiz state lives here.
     */
    private bindPuttSection(frag: DocumentFragment): void {
        const stimp = this.ref(frag, 'stimpInput') as HTMLInputElement;
        stimp.addEventListener('change', () =>
            this.putt.setStimp(parseNum(stimp.value, 1) ?? DEFAULT_STIMP_FT));
        this.track(effect(() => {
            syncInput(stimp, this.putt.stimpFt.get(), 1);
        }));

        // "Tap places" selector — lets the user choose BOTH points by tapping
        // (ball, then hole), and re-place either afterwards. Active button is
        // reflected via aria-pressed so the styling can highlight it.
        const placeBallBtn = this.ref(frag, 'placeBallBtn') as HTMLButtonElement;
        const placeHoleBtn = this.ref(frag, 'placeHoleBtn') as HTMLButtonElement;
        const holeAtPinBtn = this.ref(frag, 'holeAtPinBtn') as HTMLButtonElement;
        placeBallBtn.addEventListener('click', () => this.putt.setPlacing('ball'));
        placeHoleBtn.addEventListener('click', () => this.putt.setPlacing('hole'));
        holeAtPinBtn.addEventListener('click', () => this.putt.placeHoleAtPin());
        this.track(effect(() => {
            const which = this.putt.placing.get();
            placeBallBtn.setAttribute('aria-pressed', String(which === 'ball'));
            placeHoleBtn.setAttribute('aria-pressed', String(which === 'hole'));
        }));

        // Map-overlay toggle — reuses the Green-analysis Slope/Height maps.
        const overlaySlopeBtn = this.ref(frag, 'overlaySlopeBtn') as HTMLButtonElement;
        const overlayHeightBtn = this.ref(frag, 'overlayHeightBtn') as HTMLButtonElement;
        const overlayNoneBtn = this.ref(frag, 'overlayNoneBtn') as HTMLButtonElement;
        overlaySlopeBtn.addEventListener('click', () => this.putt.setOverlayMode('slope'));
        overlayHeightBtn.addEventListener('click', () => this.putt.setOverlayMode('height'));
        overlayNoneBtn.addEventListener('click', () => this.putt.setOverlayMode('none'));
        this.track(effect(() => {
            const m = this.putt.overlayMode.get();
            overlaySlopeBtn.setAttribute('aria-pressed', String(m === 'slope'));
            overlayHeightBtn.setAttribute('aria-pressed', String(m === 'height'));
            overlayNoneBtn.setAttribute('aria-pressed', String(m === 'none'));
        }));

        // Training-mode toggle (persisted; default ON).
        const toggle = this.ref(frag, 'trainingToggle') as HTMLInputElement;
        toggle.addEventListener('change', () => {
            this.trainingMode.set(toggle.checked);
            saveTrainingMode(toggle.checked);
        });
        this.track(effect(() => { toggle.checked = this.trainingMode.get(); }));

        // Reset the quiz whenever the putt changes (new estimate needed). The
        // signature read here subscribes this effect to ball/hole/stimp.
        let lastSig: string | null = null;
        this.track(effect(() => {
            const sig = this.puttSig.get();
            if (sig !== lastSig) {
                lastSig = sig;
                if (this.revealed.peek()) this.revealed.set(false);
                if (this.lastScore.peek() !== null) this.lastScore.set(null);
            }
        }));

        const quizHost = this.ref(frag, 'puttQuiz');
        this.buildQuiz(quizHost);

        const scoreHost = this.ref(frag, 'puttScore');
        this.track(effect(() => { scoreHost.innerHTML = this.scoreHtml(); }));

        const section = this.ref(frag, 'puttSection');
        const verbal = this.ref(frag, 'puttVerbal');
        const body = this.ref(frag, 'puttBody');
        const confidence = this.ref(frag, 'puttConfidence');
        this.track(effect(() => {
            const d = this.putt.display.get();
            // E2E hook (inert in prod): expose the presentation tier so a spec
            // can assert softened/withheld states without parsing prose.
            section.dataset.puttStatus = d.status;
            // E2E hook: whether the quiz gate is currently withholding the read.
            section.dataset.puttQuiz = this.quizActive.get() ? 'active' : 'off';
            // Putt length straight from the LIVE marker geometry (doc §5.1) —
            // it tracks the cursor mid-drag even while the read is pending.
            const b = this.putt.ball.get();
            const h = this.putt.hole.get();
            const distanceM = b && h ? Math.hypot(h.x - b.x, h.y - b.y) : null;
            // While the quiz gates a readable putt, WITHHOLD the read (verbal +
            // numbers) so the estimate is honest. Confidence provenance stays.
            const gate = this.quizActive.get();
            verbal.textContent = gate ? '' : puttVerbalText(d);
            body.innerHTML = gate ? '' : puttBodyHtml(d, distanceM);
            confidence.textContent = puttConfidenceText(d);
        }));
    }

    /** Wire the estimate form: shown only while the quiz is active; submit
     *  scores + records, skip reveals without recording. */
    private buildQuiz(host: HTMLElement): void {
        const q = this.wireEl(puttQuizTpl, {
            root: { style: () => this.quizActive.get() ? '' : 'display:none' },
            dist: () => {
                const b = this.putt.ball.get();
                const h = this.putt.hole.get();
                const d = b && h ? Math.hypot(h.x - b.x, h.y - b.y) : null;
                return d === null ? 'place the ball' : `${d.toFixed(1)} m putt`;
            },
        });
        host.appendChild(q);

        const slope = q.querySelector('[data-testid="planner-putt-est-slope"]') as HTMLInputElement;
        const side = q.querySelector('[data-testid="planner-putt-est-side"]') as HTMLSelectElement;
        const aim = q.querySelector('[data-testid="planner-putt-est-aim"]') as HTMLInputElement;
        const pace = q.querySelector('[data-testid="planner-putt-est-pace"]') as HTMLInputElement;
        const submit = q.querySelector('[data-testid="planner-putt-est-submit"]') as HTMLButtonElement;
        const skip = q.querySelector('[data-testid="planner-putt-est-skip"]') as HTMLButtonElement;

        submit.addEventListener('click', () => {
            const estimate: PuttEstimate = {
                slopePct: parseNum(slope.value, 1) ?? 0,
                breakSide: (side.value as BreakSide) || 'straight',
                aimOffsetM: (parseNum(aim.value, 0) ?? 0) / 100, // cm → m
                playsLikeM: parseNum(pace.value, 1) ?? 0,
            };
            this.submitEstimate(estimate);
        });
        skip.addEventListener('click', () => {
            this.lastScore.set(null);
            this.revealed.set(true); // reveal without recording
        });
    }

    /** Score the estimate against the settled read's ground truth, record it
     *  (server = source of truth), and reveal. */
    private submitEstimate(estimate: PuttEstimate): void {
        const d = this.putt.display.peek();
        if (!d.groundTruth) { this.revealed.set(true); return; } // nothing to score
        const score = scoreEstimate(estimate, d.groundTruth);
        this.lastScore.set(score);
        this.revealed.set(true);

        const b = this.putt.ball.peek();
        const h = this.putt.hole.peek();
        const distanceM = b && h ? Math.hypot(h.x - b.x, h.y - b.y) : 0;
        const greenId = this.putt.context.peek()?.greenId ?? null;
        void this.puttEstimate.record({
            greenId,
            distanceM,
            stimpFt: this.putt.stimpFt.peek(),
            estimate,
            truth: d.groundTruth,
        });
    }

    /** The scored-result block (per-field errors + overall), or '' when none. */
    private scoreHtml(): string {
        const score = this.lastScore.get();
        if (score === null) return '';
        const rows = [
            `<div><b>Score</b> ${metricValue(score.score, '/100')}</div>`,
            `<div>Slope off <b>${metricValue(score.slopeErrorPct.toFixed(1), '%')}</b> · `
                + `break ${score.breakSideCorrect ? '✓' : '✗'} · `
                + `aim off <b>${metricValue(Math.round(score.aimErrorM * 100), 'cm')}</b> · `
                + `pace off <b>${metricValue(score.paceErrorM.toFixed(1), 'm')}</b></div>`,
        ];
        return rows.join('');
    }

    // ── Notes ───────────────────────────────────────────────────────────────

    private bindNotes(area: HTMLTextAreaElement): void {
        area.addEventListener('blur', () => {
            const hole = this.tool.selectedHole.peek();
            if (!hole) return;
            const value = area.value.trim() || null;
            if ((this.tool.planHole.peek()?.notes ?? null) === value) return; // unchanged
            void this.plan.setHoleFields(hole.number, { notes: value });
        });
        this.track(effect(() => {
            const notes = this.tool.planHole.get()?.notes ?? '';
            if (document.activeElement !== area) area.value = notes;
        }));
    }

    // ── Shot / gate rows ────────────────────────────────────────────────────

    private buildShotRows(container: HTMLElement): void {
        this.$each(
            container,
            () => this.tool.holeShots.get(),
            (shot, _i, track) => {
                const live = this.plan.shots.item(shot.id);
                const row = this.wireEl(shotRowTpl, {
                    row: {
                        onclick: () => this.tool.selection.set({ kind: 'shot', id: shot.id }),
                        className: () => {
                            const selected = this.tool.selection.get()?.kind === 'shot'
                                && this.tool.selection.get()?.id === shot.id;
                            const option = this.plan.childShots(shot.gamePlanHoleId, shot.parentShotId).length > 1;
                            return `shot-row${selected ? ' selected' : ''}${option ? ' option-row' : ''}`;
                        },
                        style: () => `margin-left:${Math.min(3, this.shotDepth(live.get())) * 8}px`,
                    },
                    // Reactive index — keyed rows are reused, so a captured
                    // index would go stale after a mid-list delete.
                    idx: () => this.optionIndexLabel(live.get()),
                    // Option score chip (T30): probable score + penalty%; the
                    // blow-up tail rides the hover tooltip. Empty (and hidden
                    // via :empty) off decision points and mid-drag.
                    chip: {
                        textContent: () => this.optionChipText(shot.id),
                        title: () => this.optionChipTailText(shot.id),
                    },
                    dist: () => this.shotDistText(shot.id),
                    advice: () => this.shotAdviceText(shot.id),
                    remove: {
                        onclick: async (e: Event) => {
                            e.stopPropagation();
                            const ok = await this.confirm.confirm({
                                title: 'Delete shot?',
                                body: 'This shot will be removed from the hole plan.',
                                confirmLabel: 'Delete shot',
                                tone: 'danger',
                                layout: 'default',
                            });
                            if (ok) void this.plan.removeShot(shot.id, 'splice');
                        },
                    },
                    primary: {
                        onclick: (e: Event) => {
                            e.stopPropagation();
                            void this.tool.setPrimary(shot.id);
                        },
                        style: () => live.get().sortOrder === 0 ? 'display:none' : '',
                    },
                    removeOption: {
                        onclick: (e: Event) => {
                            e.stopPropagation();
                            void this.tool.deleteOption(shot.id);
                        },
                    },
                }, track);

                // E2E hooks (inert in prod): identify the row + reflect the live
                // landing point so a flow can assert "apply recommended aim"
                // actually moved the shot (data-lat/lon change).
                row.dataset.testid = 'planner-shot-row';
                row.dataset.shotId = shot.id;
                track(effect(() => {
                    const s = live.get();
                    row.dataset.lat = s.lat.toFixed(7);
                    row.dataset.lon = s.lon.toFixed(7);
                    row.dataset.parentShotId = s.parentShotId ?? '';
                    row.dataset.sortOrder = String(s.sortOrder);
                    row.dataset.depth = String(this.shotDepth(s));
                }));

                const club = row.querySelector('.shot-club') as HTMLSelectElement;
                club.addEventListener('click', e => e.stopPropagation());
                club.addEventListener('change', () =>
                    void this.plan.updateShot(shot.id, { clubId: club.value || null }));
                track(effect(() => {
                    const clubs = this.tool.orderedClubs.get();
                    const current = live.get().clubId ?? '';
                    club.textContent = '';
                    const none = document.createElement('option');
                    none.value = '';
                    none.textContent = '— club —';
                    club.appendChild(none);
                    for (const c of clubs) {
                        const opt = document.createElement('option');
                        opt.value = c.id;
                        opt.textContent = c.name;
                        club.appendChild(opt);
                    }
                    club.value = current;
                }));

                const label = row.querySelector('.shot-label') as HTMLInputElement;
                label.addEventListener('click', e => e.stopPropagation());
                label.addEventListener('blur', () => {
                    const value = label.value.trim() || null;
                    if ((live.peek().label ?? null) === value) return; // unchanged
                    void this.plan.updateShot(shot.id, { label: value });
                });
                track(effect(() => {
                    const value = live.get().label ?? '';
                    if (document.activeElement !== label) label.value = value;
                }));

                return row;
            },
            shot => shot.id,
        );
    }

    /** Tree depth for panel indentation (roots = 0). */
    private shotDepth(shot: PlanShot): number {
        const byId = new Map(this.tool.holeShots.get().map(candidate => [candidate.id, candidate]));
        let depth = 0;
        let parentShotId = shot.parentShotId;
        while (parentShotId !== null) {
            const parent = byId.get(parentShotId);
            if (!parent) break;
            depth++;
            parentShotId = parent.parentShotId;
        }
        return depth;
    }

    /**
     * The option's score/risk chip text — "prob. 4.2 · 12% pen" (O4: probable
     * hole score leading, penalty% beside) — or '' when the shot is not part
     * of a multi-sibling decision point / not yet priced (mid-drag). Same
     * vocabulary as the map chip and iOS ScoreRiskFormat.
     */
    private optionChipText(shotId: string): string {
        const chip = this.tool.optionChips.get().find(c => c.shotId === shotId);
        return chip ? scoreRiskTriple(chip.probableScore, chip.penaltyProb) : '';
    }

    /** Hover tooltip for the chip: the blow-up (CVaR₈₀) score. */
    private optionChipTailText(shotId: string): string {
        const chip = this.tool.optionChips.get().find(c => c.shotId === shotId);
        return chip ? `blow-up ${chip.tailScore.toFixed(1)}` : '';
    }

    /** Compact leg/option label: 1A, 1B, 2A… within each decision point. */
    private optionIndexLabel(shot: PlanShot): string {
        const siblings = this.plan.childShots(shot.gamePlanHoleId, shot.parentShotId);
        const rank = siblings.findIndex(candidate => candidate.id === shot.id);
        const suffix = siblings.length > 1 ? String.fromCharCode(65 + Math.max(0, rank)) : '';
        return `${this.shotDepth(shot) + 1}${suffix}`;
    }

    private buildGateRows(container: HTMLElement): void {
        this.$each(
            container,
            () => this.tool.holeGates.get(),
            (gate, _i, track) => {
                const live = this.plan.gates.item(gate.id);
                return this.wireEl(gateRowTpl, {
                    row: {
                        onclick: () => this.tool.selection.set({ kind: 'gate', id: gate.id }),
                        className: () => this.tool.selection.get()?.kind === 'gate'
                            && this.tool.selection.get()?.id === gate.id
                            ? 'gate-row selected' : 'gate-row',
                    },
                    name: () => `Gate ${this.tool.holeGates.get().findIndex(g => g.id === gate.id) + 1}`,
                    widths: () => gateLabel(live.get()),
                    remove: {
                        onclick: async (e: Event) => {
                            e.stopPropagation();
                            const ok = await this.confirm.confirm({
                                title: 'Delete gate?',
                                body: 'This gate will be removed from the hole plan.',
                                confirmLabel: 'Delete gate',
                                tone: 'danger',
                                layout: 'default',
                            });
                            if (ok) void this.plan.removeGate(gate.id);
                        },
                    },
                }, track);
            },
            gate => gate.id,
        );
    }

    // ── Readouts ────────────────────────────────────────────────────────────

    private hintText(): string | null {
        const notice = this.tool.notice.get();
        if (notice) return notice;
        if (!this.tool.selectedHole.get()) return 'Select a hole from the list to plan it.';
        const mode = this.tool.mode.get();
        if (mode === 'add-shot') return 'Click the map to append shots — Esc to stop.';
        if (mode === 'add-alternative') return 'Click the map once to place a sibling option.';
        if (mode === 'add-gate') return 'Click near a leg to drop a corridor gate (Shift-click for several).';
        if (mode === 'putt') return 'Click the green to place the ball — drag ball/hole; the read updates on release.';
        return 'Click open map space or a ladder rung to inspect it. Use “Browse from here” to move the origin.';
    }

    private browseRowsHtml(): string {
        const rows = this.tool.browseRows.get();
        const inspectedId = this.tool.inspectedBrowseRow.get()?.id ?? null;
        if (rows.length === 0) return '<div class="empty-note show">No distance targets on this hole.</div>';
        return rows.map(row => {
            const detail: string[] = [];
            if (row.playsAsM !== null && Math.round(row.playsAsM) !== Math.round(row.lineM)) {
                detail.push(`plays ${Math.round(row.playsAsM)} m`);
            }
            if (row.clubName) detail.push(row.clubName);
            const detailHtml = detail.length > 0
                ? `<span class="browse-row__detail">${escapeHtml(detail.join(' · '))}</span>`
                : '';
            const selected = row.id === inspectedId ? ' selected' : '';
            return `<button type="button" class="browse-row${selected}" data-browse-row="${escapeHtml(row.id)}" aria-pressed="${row.id === inspectedId}">`
                + `<span class="browse-row__label">${escapeHtml(row.label)}</span>`
                + `<span class="browse-row__distance">${Math.round(row.lineM)} <span class="metric__unit">m</span></span>`
                + detailHtml + '</button>';
        }).join('');
    }

    private browseDetailHtml(): string {
        const row = this.tool.inspectedBrowseRow.get();
        if (!row) return '';
        const details = [`Actual ${Math.round(row.lineM)} m`];
        if (row.playsAsM !== null) details.push(`plays ${Math.round(row.playsAsM)} m`);
        if (row.elevationDeltaM !== null) details.push(`elevation ${signedMeters(row.elevationDeltaM)}`);
        if (row.windDeltaM !== null) details.push(`wind ${signedMeters(row.windDeltaM)}`);
        if (row.clubName) details.push(row.clubName);
        return `<b>${escapeHtml(row.label)}</b>${escapeHtml(details.join(' · '))}`;
    }

    /** "1: Tee → ①" per-shot distance text from the leg landing on it. */
    private shotDistText(shotId: string): string {
        const plan = this.tool.overlayPlan.get();
        const leg = plan?.allLegs.find(l => l.to.kind === 'shot' && l.to.shot?.id === shotId);
        if (!leg) return '';
        const parts = [`${Math.round(leg.horizontalM)} m`];
        if (leg.playsLikeM !== undefined) parts.push(`plays ${Math.round(leg.playsLikeM)} m`);
        if (leg.club && leg.adjustedCarryM !== undefined) {
            parts.push(`${leg.club.name} carries ${Math.round(leg.adjustedCarryM)} m`);
        }
        if (leg.remainingToGreenM !== undefined) {
            parts.push(`${Math.round(leg.remainingToGreenM)} m to green`);
        }
        return parts.join(' · ');
    }

    /**
     * Front/centre/back club advice (`clubAdvice`) for the shot landing on
     * `shotId`, priced against how far the leg plays (plays-like, else
     * horizontal). "F 7i · C 8i · B 9i" — the shot-edit popover's club-choice
     * helper (DECADE Phase D). Empty when there's no leg/clubs, or when a
     * single club covers all three slots (no choice to surface).
     */
    private shotAdviceText(shotId: string): string {
        const plan = this.tool.overlayPlan.get();
        const leg = plan?.allLegs.find(l => l.to.kind === 'shot' && l.to.shot?.id === shotId);
        if (!leg) return '';
        const clubs = this.tool.orderedClubs.get();
        if (clubs.length === 0) return '';
        const distanceM = leg.playsLikeM ?? leg.horizontalM;
        const { front, center, back } = clubAdvice(clubs, distanceM);
        const parts: string[] = [];
        if (front) parts.push(`F ${front.name}`);
        if (center) parts.push(`C ${center.name}`);
        if (back) parts.push(`B ${back.name}`);
        // Collapse when every slot is the same club (nothing to choose between).
        const distinct = new Set([front?.id, center?.id, back?.id].filter(Boolean));
        if (distinct.size <= 1) return '';
        return parts.join(' · ');
    }

    private legsHtml(): string {
        const plan = this.tool.overlayPlan.get();
        if (!plan || plan.legs.length === 0) return '';
        const nodeName = (node: { kind: string; shot?: { id: string } }, plan2 = plan): string => {
            if (node.kind === 'tee') return 'Tee';
            if (node.kind === 'green') return 'Green';
            const n = plan2.nodes.filter(x => x.kind === 'shot')
                .findIndex(x => x.shot?.id === node.shot?.id);
            return `S${n + 1}`;
        };
        const lines = plan.legs.map(leg => {
            const light = lightChip(leg);
            const parts = [`<b>${light}${nodeName(leg.from)} → ${nodeName(leg.to)}</b>`,
                metricValue(Math.round(leg.horizontalM), 'm')];
            if (leg.playsLikeM !== undefined) parts.push(metricLine(`plays ${Math.round(leg.playsLikeM)} m`));
            if (leg.club && leg.adjustedCarryM !== undefined) {
                parts.push(metricLine(`${escapeHtml(leg.club.name)} carries ${Math.round(leg.adjustedCarryM)} m`));
            }
            if (leg.remainingToGreenM !== undefined && leg.to.kind !== 'green') {
                parts.push(metricLine(`${Math.round(leg.remainingToGreenM)} m left`));
            }
            const drift = legDriftLabel(leg);
            if (drift) {
                // E2E hook (inert): the wind-hold readout for this leg.
                parts.push(`<span class="metric-line" data-testid="planner-leg-drift">wind ${escapeHtml(drift)}</span>`);
            }
            if (leg.expectedStrokes !== undefined) {
                // E2E hook (inert): the EV readout carries a testid so the smoke
                // suite can assert it renders for an enriched leg.
                parts.push(`<span class="metric-line" data-testid="planner-leg-ev">EV ${leg.expectedStrokes.toFixed(2)}</span>`);
            }
            // E2E hook (inert): one wrapper per leg line for stable counting.
            return `<div data-testid="planner-leg">${parts.join(' · ')}</div>`;
        });
        const totals = [`<b>Total</b> ${metricValue(Math.round(plan.totalHorizontalM), 'm')}`];
        if (plan.totalPlaysLikeM !== undefined) {
            totals.push(metricLine(`plays ${Math.round(plan.totalPlaysLikeM)} m`));
        }
        lines.push(`<div data-testid="planner-leg-total">${totals.join(' · ')}</div>`);
        return lines.join('');
    }

    /**
     * Ranked caddy advice as stacked cards: bold headline + the one-sentence
     * "why". Empty string when there is no advice (the section hides itself via
     * its style binding). Advice is already ranked by the evaluator.
     */
    private caddyHtml(): string {
        const advice = this.tool.caddyAdvice.get();
        if (advice.length === 0) return '';
        return advice.map(a => {
            const why = a.detail ? `<div class="caddy-why">${escapeHtml(a.detail)}</div>` : '';
            // E2E hook (inert): one testid per ranked caddy card.
            return `<div class="caddy-card" data-testid="planner-caddy-card">`
                + `<div class="caddy-headline">${escapeHtml(a.headline)}</div>${why}</div>`;
        }).join('');
    }

    /**
     * The simulate readout: one card per simulated branch (two or more when
     * comparing siblings — they stack, sharing the same bucket rows so the
     * shapes line up), each with its mean beside the label, "plan survives",
     * and the five par-relative buckets as bars.
     *
     * When the result is stale the whole block is DIMMED and says so — V8 is
     * explicit that a plan edit greys the distribution and waits for the user
     * to ask again rather than recomputing itself.
     */
    private simHtml(): string {
        const sim = this.tool.sim;
        // A failed run is reported ABOVE the results, never INSTEAD of them: the
        // last good distribution is still the best information on screen, and
        // blanking it would punish the user for a transient worker failure.
        const error = sim.simError.get();
        const errorNote = error
            ? `<div class="sim-note error" data-testid="planner-sim-error">${escapeHtml(error)}</div>`
            : '';
        const branches = sim.branches.get();
        if (branches.length === 0) {
            return errorNote || '<div class="sim-note">No distribution yet — hit Simulate, or select an '
                + 'option at a decision point.</div>';
        }
        const stale = sim.stale.get();
        const staleNote = stale
            ? '<div class="sim-note" data-testid="planner-sim-stale">Plan changed — simulate again.</div>'
            : '';
        const cards = branches.map(branch => {
            const rows = branch.buckets.map(bucket =>
                `<div class="sim-bucket" data-testid="planner-sim-bucket" data-bucket="${escapeHtml(bucket.label)}">`
                + `<span>${escapeHtml(bucket.label)}</span>`
                + `<span class="sim-bucket__bar">`
                + `<span class="sim-bucket__fill" style="width:${(bucket.prob * 100).toFixed(1)}%"></span></span>`
                + `<span class="sim-bucket__pct">${formatPercent(bucket.prob)}</span></div>`).join('');
            return `<div class="sim-card${stale ? ' stale' : ''}" data-testid="planner-sim-card"`
                + ` data-branch="${escapeHtml(branch.branchId)}" data-stale="${stale ? '1' : '0'}">`
                + `<div class="sim-card__head"><span>${escapeHtml(branch.label)}</span>`
                + `<span class="sim-card__mean" data-testid="planner-sim-mean">${escapeHtml(meanLabel(branch.mean))}</span></div>`
                + `<div class="sim-card__survives" data-testid="planner-sim-survives">`
                + `${escapeHtml(onScriptLabel(branch.onScriptRate))}</div>${rows}</div>`;
        }).join('');
        return errorNote + staleNote + cards;
    }

    /**
     * Suggest-lines ghosts (V7): signature label + the same ChainScore
     * vocabulary the option chips use, with accept / dismiss. Purely transient —
     * accepting is what turns one into real plan shots.
     */
    private variantsHtml(): string {
        const ghosts = this.tool.sim.variants.get();
        if (ghosts.length === 0) return '';
        const selectedId = this.tool.sim.selectedVariantId.get();
        const hint = '<div class="sim-note">Click a line to pin it on the map (ellipses, leg '
            + 'distances and its own histogram). Accept writes it into the plan as an option; '
            + 'Dismiss just forgets it.</div>';
        return hint + ghosts.map(ghost => {
            const selected = ghost.id === selectedId;
            return `<div class="variant-row${selected ? ' selected' : ''}" `
            + `data-testid="planner-variant-row" data-variant="${escapeHtml(ghost.id)}" `
            + `data-selected="${selected ? '1' : '0'}" role="button" tabindex="0" `
            + `aria-pressed="${selected ? 'true' : 'false'}">`
            + `<span class="variant-row__label">${escapeHtml(ghost.label)}</span>`
            + `<span class="variant-row__chip" data-testid="planner-variant-chip">`
            + `${escapeHtml(variantChipText(ghost))}</span>`
            + `<span class="shot-actions">`
            + `<button type="button" class="mini-btn" data-variant-action="accept" `
            + `data-testid="planner-variant-accept">Accept</button>`
            + `<button type="button" class="mini-btn" data-variant-action="dismiss" `
            + `data-testid="planner-variant-dismiss">Dismiss</button></span></div>`;
        }).join('');
    }

    private statusText(): string {
        if (this.plan.saving.get()) return 'Saving…';
        const saveError = this.plan.saveError.get();
        if (saveError) return `Save failed: ${saveError.message}`;
        if (this.plan.loading.get() || this.clubs.loading.get()) return 'Loading plan…';
        const error = this.plan.error.get() ?? this.clubs.error.get();
        if (error) return `Load failed: ${error.message}`;
        return this.plan.plan.get() ? 'Autosaves' : 'No plan yet — first edit creates one';
    }
}

// ── Putt readout formatting (pure — renders PuttReadService.display) ────────

/**
 * The Tour Read verbal line — ALWAYS shown alongside the exact read when one
 * exists (doc §5.1: it's the on-course takeaway and a sanity cross-check
 * against the integrator; big disagreement on a single-plane putt ⇒ grid
 * problem). Empty while there's nothing readable.
 */
function puttVerbalText(d: PuttReadDisplay): string {
    if (!d.verbal) return '';
    return `Tour read: ${d.verbal.combined}`;
}

/** Exact-read rows (plays-like / aim / holed%), or the withhold message. */
function puttBodyHtml(d: PuttReadDisplay, distanceM: number | null): string {
    if (d.read === null) {
        if (d.status === 'loading') return 'Loading green surface…';
        if (d.status === 'pending') return 'Reading…';
        return d.message ? `<span class="putt-warn">${escapeHtml(d.message)}</span>` : '';
    }
    const lines: string[] = [];
    if (d.message) lines.push(`<div class="putt-warn">${escapeHtml(d.message)}</div>`);
    const parts: string[] = [];
    if (distanceM !== null) parts.push(`<b>Putt</b> ${metricValue(distanceM.toFixed(1), 'm')}`);
    parts.push(`<b>plays</b> ${metricValue(d.read.playsLikeM.toFixed(1), 'm')}`);
    parts.push(`<b>aim</b> ${metricLine(formatAimOffset(d.read.aimOffsetM))}`);
    lines.push(`<div>${parts.join(' · ')}</div>`);
    lines.push(`<div><b>Holed</b> ${metricValue(`~${Math.round(d.read.holedProb * 100)}`, '%')}`
        + ` <span title="Heuristic — uncalibrated single-trajectory estimate">(est.)</span></div>`);
    return lines.join('');
}

/** Signed aim offset (m, + = right of the hole) → "37 cm left" / "straight". */
function formatAimOffset(aimOffsetM: number): string {
    const cm = Math.round(Math.abs(aimOffsetM) * 100);
    if (cm === 0) return 'straight';
    return `${cm} cm ${aimOffsetM > 0 ? 'right' : 'left'}`;
}

/** Calibration provenance line — 'scans' vs 'prior' (ordinal, not a probability). */
function puttConfidenceText(d: PuttReadDisplay): string {
    if (d.status === 'inactive') return '';
    const c = d.confidence;
    if (!c) return 'Green data: uncalibrated DEM (default confidence)';
    const src = c.source === 'scans'
        ? `calibrated from ${c.sampleCount} scan${c.sampleCount === 1 ? '' : 's'}`
        : 'DEM prior (no scans yet)';
    return `Green data: ${src} · confidence ${c.confidence.toFixed(2)}`;
}

/** Parse a numeric input value; empty/invalid → null (clears the field). */
function parseNum(value: string, decimals: number): number | null {
    const v = value.trim();
    if (v === '') return null;
    const parsed = Number(v);
    if (!Number.isFinite(parsed)) return null;
    const factor = 10 ** decimals;
    return Math.round(parsed * factor) / factor;
}

/** Reflect a nullable number into an input unless it has focus. */
function syncInput(input: HTMLInputElement, value: number | null, decimals: number): void {
    if (document.activeElement === input) return;
    input.value = value === null ? '' : value.toFixed(decimals);
}

function escapeHtml(str: string): string {
    return str.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Guide §02: an isolated number+unit pair — mono, tabular, semibold, with
 *  the unit dropped to text-tertiary at 80% size (the `.metric` recipe). */
function metricValue(value: number | string, unit: string): string {
    return `<span class="metric">${value}<span class="metric__unit">${unit}</span></span>`;
}

/** Guide §02: a whole mixed prose+number phrase kept in mono/tabular at
 *  normal weight (the `.metric-line` treatment) — for compound readouts
 *  like "plays 231 m" or "wind drift 9 m R" where isolating the number
 *  alone would fragment the sentence. */
function metricLine(text: string): string {
    return `<span class="metric-line">${text}</span>`;
}

/** Human labels for the generic approach-confidence chip (no DECADE branding). */
const LIGHT_TITLE: Record<LegLight, string> = {
    green: 'Attack — pattern holds the green',
    yellow: 'Cautious — a slice misses',
    red: 'Bail — take the fat side / medicine',
};

/**
 * A leading confidence-chip span for an approach leg (green/yellow/red dot),
 * or '' when the leg is not an enriched approach. Generic terminology only.
 */
function lightChip(leg: PlanLeg): string {
    const light = legLight(leg);
    if (!light) return '';
    // E2E hook (inert): data-light exposes the confidence tier (green/yellow/red).
    return `<span class="leg-light leg-light--${light}" data-testid="planner-leg-light" data-light="${light}" title="${LIGHT_TITLE[light]}"></span>`;
}
