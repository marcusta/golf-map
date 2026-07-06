import { Component, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, field } from '../css';
import { mpsToMph } from '../../../shared/strategy';
import type { PlanShot, PlanGate } from '../../../shared/api/game-plans.gen';
import { FurnitureService } from '../furniture/furniture.service';
import { ClubsService } from '../player/clubs.service';
import { PlanService } from './plan.service';
import { PlannerToolService } from './planner-tool.service';
import { gateLabel } from './plan-overlay';

const tpl = template(`
    <div class="plan-panel" bind="root">
        <div class="plan-panel__section">
            <h4 class="section-title">Plan</h4>
            <div class="mode-row">
                <button bind="addShot" type="button" class="mode-btn">+ Shot</button>
                <button bind="addGate" type="button" class="mode-btn">+ Gate</button>
            </div>
            <div bind="hint" class="plan-hint"></div>
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

        <div bind="legsSection" class="plan-panel__section">
            <h4 class="section-title">Legs</h4>
            <div bind="legsBody" class="legs-body"></div>
        </div>

        <div bind="caddySection" class="plan-panel__section">
            <h4 class="section-title">Caddy</h4>
            <div bind="caddyBody" class="caddy-body"></div>
        </div>

        <div bind="shotsSection" class="plan-panel__section">
            <h4 class="section-title">Shots</h4>
            <div bind="shotList" class="shot-list"></div>
            <div bind="noShots" class="empty-note">No shots yet — arm “+ Shot” and click the map.</div>
            <button bind="seedAims" type="button" class="mini-btn">Seed shots from aim points</button>
        </div>

        <div bind="gatesSection" class="plan-panel__section">
            <h4 class="section-title">Gates</h4>
            <div bind="gateList" class="gate-list"></div>
            <div bind="noGates" class="empty-note">No gates yet — arm “+ Gate” and click near a leg.</div>
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
        </div>
    </div>
`);

const shotRowTpl = template(`
    <div bind="row" class="shot-row">
        <span bind="idx" class="shot-idx"></span>
        <select bind="club" class="shot-club" title="Club for this shot"></select>
        <input bind="label" class="shot-label" type="text" placeholder="label" />
        <button bind="remove" class="row-remove" type="button" title="Delete shot">✕</button>
        <span bind="dist" class="shot-dist"></span>
    </div>
`);

const gateRowTpl = template(`
    <div bind="row" class="gate-row">
        <span bind="name" class="gate-name"></span>
        <span bind="widths" class="gate-widths"></span>
        <button bind="remove" class="row-remove" type="button" title="Delete gate">✕</button>
    </div>
`);

/**
 * The planner's control panel (sidebar, under the hole list): add-shot /
 * add-gate arming, tee + preferred-club selects, plan/hole wind with
 * inherit-aware override (m/s canonical, mph display-only), per-leg
 * readouts, shot rows (club/label/remove), gate rows, and hole notes.
 * Shares the PlannerToolService/PlanService DI singletons with the tool.
 */
export class PlannerPanelComponent extends Component {
    static styles = `
        .plan-panel {
            display: flex;
            flex-direction: column;
            font-size: 0.8rem;
            color: ${t('text')};
            border-top: 1px solid ${t('border')};
            overflow-y: auto;

            & .plan-panel__section {
                padding: ${s('sm')} ${s('md')};
                border-bottom: 1px solid ${t('border')};
                display: flex;
                flex-direction: column;
                gap: ${s('sm')};
            }

            & .section-title {
                margin: 0;
                font-size: 0.7rem;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.06em;
                color: ${t('text-muted')};
            }

            & .mode-row { display: flex; gap: ${s('xs')}; }
            & .mode-btn {
                flex: 1;
                padding: ${s('xs')} 2px;
                font-size: 0.75rem;
                ${btn(t('radius-sm'))}
                &.active {
                    border-color: ${t('primary')};
                    color: ${t('primary-text')};
                    background: ${t('primary')};
                }
            }

            & .plan-hint {
                display: none;
                font-size: 0.72rem;
                color: ${t('text-muted')};
                &.show { display: block; }
                &.warn { color: ${t('error')}; }
            }

            & .plan-field { ${field()} min-width: 0; flex: 1; }
            & .wind-row { display: flex; gap: ${s('sm')}; }
            & .wind-mph, & .wind-effective {
                font-size: 0.72rem;
                color: ${t('text-muted')};
            }
            & .override-block { display: flex; flex-direction: column; gap: ${s('xs')}; }
            & .mini-btn {
                padding: 3px ${s('xs')};
                font-size: 0.72rem;
                ${btn(t('radius-sm'))}
            }

            & .legs-body { font-size: 0.75rem; line-height: 1.6; color: ${t('text-muted')}; }
            & .legs-body b { color: ${t('text')}; }

            & .caddy-body { display: flex; flex-direction: column; gap: 6px; }
            & .caddy-card {
                border-left: 3px solid ${t('accent')};
                padding: 4px 8px;
                background: ${t('hover-bg')};
                border-radius: 3px;
            }
            & .caddy-headline { font-size: 0.78rem; font-weight: 600; color: ${t('text')}; }
            & .caddy-why { font-size: 0.72rem; line-height: 1.5; color: ${t('text-muted')}; margin-top: 2px; }

            & .shot-list, & .gate-list { display: flex; flex-direction: column; gap: 2px; }
            & .empty-note { display: none; font-size: 0.72rem; color: ${t('text-muted')}; &.show { display: block; } }

            & .shot-row {
                display: grid;
                grid-template-columns: 1.4rem 1fr 1fr 1.4rem;
                gap: ${s('xs')};
                align-items: center;
                padding: 2px ${s('xs')};
                border-radius: ${t('radius-sm')};
                cursor: pointer;
                &:hover { background: ${t('hover-bg')}; }
                &.selected { background: ${t('active-bg')}; }
            }
            & .shot-idx { font-weight: 600; }
            & .shot-club, & .shot-label {
                min-width: 0;
                font-size: 0.72rem;
                font-family: inherit;
                padding: 2px 4px;
                border: 1px solid ${t('border')};
                border-radius: ${t('radius-sm')};
                background: ${t('surface')};
                color: ${t('text')};
            }
            & .shot-dist {
                grid-column: 2 / span 3;
                font-size: 0.7rem;
                color: ${t('text-muted')};
            }

            & .gate-row {
                display: flex;
                align-items: center;
                gap: ${s('xs')};
                padding: 2px ${s('xs')};
                border-radius: ${t('radius-sm')};
                cursor: pointer;
                &:hover { background: ${t('hover-bg')}; }
                &.selected { background: ${t('active-bg')}; }
            }
            & .gate-name { font-weight: 600; }
            & .gate-widths { flex: 1; color: ${t('text-muted')}; font-size: 0.72rem; }

            & .row-remove {
                padding: 0 4px;
                font-size: 0.72rem;
                line-height: 1.4;
                ${btn(t('radius-sm'))}
                color: ${t('error')};
                border-color: transparent;
            }

            & textarea {
                padding: ${s('sm')} ${s('md')};
                font-size: 0.8rem;
                font-family: inherit;
                border: 1px solid ${t('border')};
                border-radius: ${t('radius-sm')};
                background: ${t('surface')};
                color: ${t('text')};
                resize: vertical;
            }

            & .plan-panel__status {
                padding: ${s('xs')} ${s('md')};
                font-size: 0.72rem;
                color: ${t('text-muted')};
                min-height: 1.4em;
                &.error { color: ${t('error')}; }
            }

            & .plan-panel__hints {
                padding: ${s('xs')} ${s('md')} ${s('sm')};
                font-size: 0.68rem;
                line-height: 1.5;
                color: ${t('text-muted')};
                border-top: 1px solid ${t('border')};
            }
        }
    `;

    private plan = this.inject(PlanService);
    private clubs = this.inject(ClubsService);
    private furniture = this.inject(FurnitureService);
    private tool = this.inject(PlannerToolService);

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            addShot: {
                onclick: () => this.tool.setMode('add-shot'),
                className: () => this.tool.mode.get() === 'add-shot' ? 'mode-btn active' : 'mode-btn',
            },
            addGate: {
                onclick: () => this.tool.setMode('add-gate'),
                className: () => this.tool.mode.get() === 'add-gate' ? 'mode-btn active' : 'mode-btn',
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
            legsSection: { style: () => (this.tool.holePlan.get()?.legs.length ?? 0) > 0 ? '' : 'display:none' },
            legsBody: { textContent: () => '' }, // filled via effect (multiline)
            caddySection: { style: () => this.tool.caddyAdvice.get().length > 0 ? '' : 'display:none' },
            caddyBody: { textContent: () => '' }, // filled via effect (multiline)
            shotsSection: { style: () => this.tool.selectedHole.get() ? '' : 'display:none' },
            noShots: { className: () => this.tool.holeShots.get().length === 0 ? 'empty-note show' : 'empty-note' },
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
        this.bindNotes(this.ref(frag, 'notes') as HTMLTextAreaElement);

        // Multiline legs readout (distances / plays-like / carries / remaining).
        const legsBody = this.ref(frag, 'legsBody');
        this.track(effect(() => { legsBody.innerHTML = this.legsHtml(); }));

        // Caddy advice (green-slope-half + future rules), ranked highest first.
        const caddyBody = this.ref(frag, 'caddyBody');
        this.track(effect(() => { caddyBody.innerHTML = this.caddyHtml(); }));

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
        if (existing > 0 && !window.confirm(
            `Replace the ${existing} existing shot${existing === 1 ? '' : 's'} on this hole `
            + `with its aim points?`)) return;
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
                        className: () => this.tool.selection.get()?.kind === 'shot'
                            && this.tool.selection.get()?.id === shot.id
                            ? 'shot-row selected' : 'shot-row',
                    },
                    // Reactive index — keyed rows are reused, so a captured
                    // index would go stale after a mid-list delete.
                    idx: () => String(this.tool.holeShots.get().findIndex(s => s.id === shot.id) + 1),
                    dist: () => this.shotDistText(shot.id),
                    remove: {
                        onclick: (e: Event) => {
                            e.stopPropagation();
                            if (window.confirm('Delete this shot?')) void this.plan.removeShot(shot.id);
                        },
                    },
                }, track);

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
                        onclick: (e: Event) => {
                            e.stopPropagation();
                            if (window.confirm('Delete this gate?')) void this.plan.removeGate(gate.id);
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
        if (mode === 'add-gate') return 'Click near a leg to drop a corridor gate (Shift-click for several).';
        return null;
    }

    /** "1: Tee → ①" per-shot distance text from the leg landing on it. */
    private shotDistText(shotId: string): string {
        const plan = this.tool.holePlan.get();
        const leg = plan?.legs.find(l => l.to.kind === 'shot' && l.to.shot?.id === shotId);
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

    private legsHtml(): string {
        const plan = this.tool.holePlan.get();
        if (!plan || plan.legs.length === 0) return '';
        const nodeName = (node: { kind: string; shot?: { id: string } }, plan2 = plan): string => {
            if (node.kind === 'tee') return 'Tee';
            if (node.kind === 'green') return 'Green';
            const n = plan2.nodes.filter(x => x.kind === 'shot')
                .findIndex(x => x.shot?.id === node.shot?.id);
            return `S${n + 1}`;
        };
        const lines = plan.legs.map(leg => {
            const parts = [`<b>${nodeName(leg.from)} → ${nodeName(leg.to)}</b>`,
                `${Math.round(leg.horizontalM)} m`];
            if (leg.playsLikeM !== undefined) parts.push(`plays ${Math.round(leg.playsLikeM)} m`);
            if (leg.club && leg.adjustedCarryM !== undefined) {
                parts.push(`${escapeHtml(leg.club.name)} carries ${Math.round(leg.adjustedCarryM)} m`);
            }
            if (leg.remainingToGreenM !== undefined && leg.to.kind !== 'green') {
                parts.push(`${Math.round(leg.remainingToGreenM)} m left`);
            }
            return parts.join(' · ');
        });
        const totals = [`<b>Total</b> ${Math.round(plan.totalHorizontalM)} m`];
        if (plan.totalPlaysLikeM !== undefined) {
            totals.push(`plays ${Math.round(plan.totalPlaysLikeM)} m`);
        }
        lines.push(totals.join(' · '));
        return lines.join('<br>');
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
            return `<div class="caddy-card">`
                + `<div class="caddy-headline">${escapeHtml(a.headline)}</div>${why}</div>`;
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
