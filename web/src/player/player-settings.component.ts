import { Component, Signal, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, primaryBtn, field } from '../css';
import { ClubsService } from './clubs.service';
import { ConfirmService } from '../app/confirm-dialog.component';
import { lengthDispersionM } from '../../../shared/strategy/club';
import type { Club } from '../../../shared/api/clubs.gen';

const CARRY_MIN = 10;
const CARRY_MAX = 400;
const DISPERSION_MIN = 1;
const DISPERSION_MAX = 100;

const tpl = template(`
    <div class="player-settings" bind="root">
        <div class="player-settings__inner">
            <header class="ps-header">
                <h2>Player settings</h2>
            </header>

            <div class="ps-panel">
                <h3 class="section-title">Clubs</h3>

                <div class="clubs-table">
                    <div class="clubs-head">
                        <span>Name</span>
                        <span>Carry (m)</span>
                        <span>Lateral dispersion (m)</span>
                        <span>Length dispersion (m)</span>
                        <span></span>
                        <span></span>
                    </div>
                    <div bind="rows" class="clubs-rows"></div>
                    <div bind="empty" class="clubs-empty">No clubs yet — add one below.</div>
                </div>

                <div class="add-row">
                    <label class="add-field">Name
                        <input bind="addName" type="text" placeholder="e.g. 7 Iron" />
                    </label>
                    <label class="add-field">Carry (m)
                        <input bind="addCarry" type="number" min="${CARRY_MIN}" max="${CARRY_MAX}" step="1" />
                    </label>
                    <label class="add-field">Dispersion (m)
                        <input bind="addDispersion" type="number" min="${DISPERSION_MIN}" max="${DISPERSION_MAX}" step="0.5" />
                    </label>
                    <button bind="addBtn" type="button" class="add-btn">Add club</button>
                </div>
                <div bind="addError" class="ps-inline-error"></div>

                <div bind="status" class="ps-panel__status"></div>
            </div>
        </div>
    </div>
`);

const rowTpl = template(`
    <div class="club-row" bind="row">
        <input bind="name" type="text" class="club-row__name" />
        <input bind="carry" type="number" min="${CARRY_MIN}" max="${CARRY_MAX}" step="1" class="club-row__num" />
        <input bind="dispersion" type="number" min="${DISPERSION_MIN}" max="${DISPERSION_MAX}" step="0.5" class="club-row__num" />
        <span bind="lengthDispersion" class="club-row__derived"></span>
        <span class="club-row__reorder">
            <button bind="upBtn" type="button" class="mini-btn" title="Move up">&#8593;</button>
            <button bind="downBtn" type="button" class="mini-btn" title="Move down">&#8595;</button>
        </span>
        <button bind="deleteBtn" type="button" class="delete-btn">Delete</button>
    </div>
`);

/**
 * Player configuration page (Phase 5). Route: /player. CRUD for the active
 * player's clubs: inline-editable name/carry/dispersion, a derived
 * (read-only) length-dispersion column from shared/strategy, up/down
 * reordering and delete, plus an "Add club" row.
 *
 * Follows the FeaturesService/CourseListComponent conventions: EntityStore +
 * request() signals, $each keyed rows, autosave-on-change with a status
 * line, bespoke panel CSS built from the shared s/btn/primaryBtn/field/t
 * recipes. Full page (not a map side panel), so content is centered with a
 * max-width rather than docked at 240px.
 */
export class PlayerSettingsComponent extends Component {
    static styles = `
        .player-settings {
            height: 100%;
            overflow-y: auto;
            padding: ${s('xl')} ${s('2xl')};

            & .player-settings__inner {
                max-width: 780px;
                margin: 0 auto;
            }
        }

        .ps-header {
            margin-bottom: ${s('lg')};

            & h2 { margin: 0; font-size: 1.25rem; color: ${t('color-text-primary')}; }
        }

        .ps-panel {
            display: flex;
            flex-direction: column;
            gap: ${s('md')};
            padding: ${s('lg')};
            background: ${t('color-surface-card')};
            border: 1px solid ${t('color-border-default')};
            border-radius: ${t('radius')};
            box-shadow: ${t('shadow')};
        }

        .section-title {
            margin: 0;
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.06em;
            color: ${t('color-text-secondary')};
        }

        .clubs-table {
            display: flex;
            flex-direction: column;
        }

        .clubs-head {
            display: grid;
            grid-template-columns: 1.6fr 1fr 1.3fr 1.2fr 60px 72px;
            gap: ${s('sm')};
            padding: 0 ${s('sm')} ${s('xs')};
            font-size: 0.68rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            color: ${t('color-text-secondary')};
        }

        .clubs-rows {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }

        .clubs-empty {
            display: none;
            padding: ${s('md')} ${s('sm')};
            font-size: 0.8rem;
            color: ${t('color-text-secondary')};
            &.show { display: block; }
        }

        .club-row {
            display: grid;
            grid-template-columns: 1.6fr 1fr 1.3fr 1.2fr 60px 72px;
            gap: ${s('sm')};
            align-items: center;
            padding: ${s('xs')} ${s('sm')};
            border-radius: ${t('radius-sm')};
            &:hover { background: ${t('color-surface-sunken')}; }

            & input { ${field()} padding: 0; }
            & .club-row__name, & .club-row__num {
                padding: ${s('xs')} ${s('sm')};
                font-size: 0.85rem;
                font-family: inherit;
                color: ${t('color-text-primary')};
                background: ${t('color-surface-raised')};
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius-sm')};
                width: 100%;
                box-sizing: border-box;

                &.invalid { border-color: ${t('color-status-negative')}; }
            }

            & .club-row__derived {
                font-size: 0.8rem;
                font-variant-numeric: tabular-nums;
                color: ${t('color-text-secondary')};
            }
        }

        .club-row__reorder {
            display: flex;
            gap: 2px;
        }

        .mini-btn {
            padding: 2px ${s('xs')};
            font-size: 0.7rem;
            line-height: 1.4;
            ${btn(t('radius-sm'))}

            &:disabled { opacity: 0.35; cursor: default; }
            &:disabled:hover { background: ${t('color-surface-sunken')}; }
        }

        .delete-btn {
            padding: ${s('xs')} ${s('sm')};
            font-size: 0.72rem;
            ${btn(t('radius-sm'))}
            color: ${t('color-status-negative')};
            border-color: ${t('color-status-negative')};
        }

        .add-row {
            display: grid;
            grid-template-columns: 1.6fr 1fr 1.3fr auto;
            gap: ${s('sm')};
            align-items: end;
            padding-top: ${s('sm')};
            border-top: 1px solid ${t('color-border-default')};
        }

        .add-field { ${field()} }

        .add-btn {
            padding: ${s('sm')} ${s('lg')};
            font-size: 0.85rem;
            ${primaryBtn()}
        }

        .ps-inline-error {
            display: none;
            font-size: 0.75rem;
            color: ${t('color-status-negative')};
            &.show { display: block; }
        }

        .ps-panel__status {
            font-size: 0.72rem;
            color: ${t('color-text-secondary')};
            min-height: 1.4em;
            &.error { color: ${t('color-status-negative')}; }
        }
    `;

    private svc = this.inject(ClubsService);
    private confirm = this.inject(ConfirmService);
    private readonly addErrorMsg = new Signal('');
    private addName!: HTMLInputElement;
    private addCarry!: HTMLInputElement;
    private addDispersion!: HTMLInputElement;

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            empty: {
                className: () => this.svc.store.items.get().length === 0 ? 'clubs-empty show' : 'clubs-empty',
            },
            addBtn: { onclick: () => this.handleAdd() },
            addError: {
                textContent: () => this.addErrorMsg.get(),
                className: () => this.addErrorMsg.get() ? 'ps-inline-error show' : 'ps-inline-error',
            },
            status: {
                textContent: () => this.statusText(),
                className: () => this.svc.saveError.get() || this.svc.error.get() ? 'ps-panel__status error' : 'ps-panel__status',
            },
        });

        this.addName = this.ref(frag, 'addName') as HTMLInputElement;
        this.addCarry = this.ref(frag, 'addCarry') as HTMLInputElement;
        this.addDispersion = this.ref(frag, 'addDispersion') as HTMLInputElement;

        this.buildRows(this.ref(frag, 'rows'));

        return frag;
    }

    onMount(): void {
        void this.svc.load();
    }

    // ── Rows ─────────────────────────────────────────────────────────────

    private buildRows(container: HTMLElement): void {
        this.$each(
            container,
            this.svc.store.items,
            (club, _i, track) => {
                const live = this.svc.store.item(club.id);
                const row = this.wireEl(rowTpl, {
                    lengthDispersion: () => lengthDispersionM(live.get().carryM).toFixed(1),
                    upBtn: {
                        onclick: () => void this.move(club.id, -1),
                        disabled: () => this.orderedIds().indexOf(club.id) <= 0,
                    },
                    downBtn: {
                        onclick: () => void this.move(club.id, 1),
                        disabled: () => {
                            const ids = this.orderedIds();
                            return ids.indexOf(club.id) === ids.length - 1;
                        },
                    },
                    deleteBtn: {
                        onclick: () => void this.handleDelete(live.get()),
                    },
                }, track);

                const nameInput = this.ref(row, 'name') as HTMLInputElement;
                const carryInput = this.ref(row, 'carry') as HTMLInputElement;
                const dispersionInput = this.ref(row, 'dispersion') as HTMLInputElement;

                track(effect(() => { if (document.activeElement !== nameInput) nameInput.value = live.get().name; }));
                track(effect(() => { if (document.activeElement !== carryInput) carryInput.value = String(live.get().carryM); }));
                track(effect(() => { if (document.activeElement !== dispersionInput) dispersionInput.value = String(live.get().dispersionM); }));

                const saveName = () => {
                    const value = nameInput.value.trim();
                    if (!value || value === live.get().name) { nameInput.value = live.get().name; return; }
                    void this.svc.update(club.id, { name: value });
                };
                nameInput.addEventListener('change', saveName);
                nameInput.addEventListener('blur', saveName);

                const saveCarry = () => {
                    const value = Number(carryInput.value);
                    if (!isValidCarry(value)) {
                        carryInput.classList.add('invalid');
                        this.setAddError(`Carry must be between ${CARRY_MIN} and ${CARRY_MAX} m.`);
                        carryInput.value = String(live.get().carryM);
                        return;
                    }
                    carryInput.classList.remove('invalid');
                    if (value === live.get().carryM) return;
                    void this.svc.update(club.id, { carryM: value });
                };
                carryInput.addEventListener('change', saveCarry);
                carryInput.addEventListener('blur', saveCarry);

                const saveDispersion = () => {
                    const value = Number(dispersionInput.value);
                    if (!isValidDispersion(value)) {
                        dispersionInput.classList.add('invalid');
                        this.setAddError(`Dispersion must be between ${DISPERSION_MIN} and ${DISPERSION_MAX} m.`);
                        dispersionInput.value = String(live.get().dispersionM);
                        return;
                    }
                    dispersionInput.classList.remove('invalid');
                    if (value === live.get().dispersionM) return;
                    void this.svc.update(club.id, { dispersionM: value });
                };
                dispersionInput.addEventListener('change', saveDispersion);
                dispersionInput.addEventListener('blur', saveDispersion);

                return row;
            },
            club => club.id,
        );
    }

    private orderedIds(): string[] {
        return this.svc.store.items.get().map(c => c.id);
    }

    private async move(id: string, delta: number): Promise<void> {
        const ids = this.orderedIds();
        const i = ids.indexOf(id);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= ids.length) return;
        const next = [...ids];
        [next[i], next[j]] = [next[j], next[i]];
        await this.svc.reorder(next);
    }

    private async handleDelete(club: Club): Promise<void> {
        const ok = await this.confirm.confirm({
            title: 'Delete club?',
            body: `"${club.name}" will be removed from your bag.`,
            confirmLabel: 'Delete club',
            tone: 'danger',
            layout: 'default',
        });
        if (!ok) return;
        await this.svc.remove(club.id);
    }

    // ── Add row ──────────────────────────────────────────────────────────

    private setAddError(message: string): void {
        this.addErrorMsg.set(message);
    }

    private handleAdd(): void {
        const name = this.addName.value.trim();
        const carryM = Number(this.addCarry.value);
        const dispersionM = Number(this.addDispersion.value);

        if (!name) { this.setAddError('Name is required.'); return; }
        if (!isValidCarry(carryM)) { this.setAddError(`Carry must be between ${CARRY_MIN} and ${CARRY_MAX} m.`); return; }
        if (!isValidDispersion(dispersionM)) { this.setAddError(`Dispersion must be between ${DISPERSION_MIN} and ${DISPERSION_MAX} m.`); return; }

        this.setAddError('');
        void this.svc.create(name, carryM, dispersionM).then(created => {
            if (!created) return;
            this.addName.value = '';
            this.addCarry.value = '';
            this.addDispersion.value = '';
        });
    }

    private statusText(): string {
        if (this.svc.saving.get()) return 'Saving…';
        const saveError = this.svc.saveError.get();
        if (saveError) {
            return saveError.code === 'conflict'
                ? 'Someone else changed this club — reloaded latest.'
                : `Save failed: ${saveError.message}`;
        }
        if (this.svc.loading.get()) return 'Loading clubs…';
        const error = this.svc.error.get();
        if (error) return `Load failed: ${error.message}`;
        const n = this.svc.store.items.get().length;
        return `${n} club${n === 1 ? '' : 's'}`;
    }
}

function isValidCarry(value: number): boolean {
    return Number.isFinite(value) && value >= CARRY_MIN && value <= CARRY_MAX;
}

function isValidDispersion(value: number): boolean {
    return Number.isFinite(value) && value >= DISPERSION_MIN && value <= DISPERSION_MAX;
}
