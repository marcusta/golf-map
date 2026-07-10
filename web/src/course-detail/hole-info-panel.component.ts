import { Component, Computed, Router, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s } from '../css';
import { CourseDetailService } from './course-detail.service';
import { FurnitureService } from '../furniture/furniture.service';
import { teeFill } from '../furniture/furniture-overlay';
import { playingLength } from './hole-length';
import type { Hole } from '../../../shared/api/holes.gen';

const tpl = template(`
    <div class="hole-info" bind="root">
        <div class="hole-info__head">
            <h3 bind="title" class="hole-info__title"></h3>
            <div class="hole-info__fields">
                <label class="hi-field">Par
                    <select bind="par"></select>
                </label>
                <label class="hi-field">Stroke index
                    <select bind="si"></select>
                </label>
            </div>
        </div>
        <div class="hole-info__tees">
            <div class="hi-tees-title">Tee boxes</div>
            <div bind="teeRows" class="hi-tee-rows"></div>
            <div bind="teeEmpty" class="hi-tee-empty">No tees placed on this hole yet.</div>
            <div class="hi-note" bind="stickyNote"></div>
        </div>
    </div>
`);

const teeRowTpl = template(`
    <label class="hi-tee-row">
        <input bind="radio" type="radio" name="active-tee" class="hi-tee-radio" />
        <span bind="swatch" class="hi-tee-swatch"></span>
        <span bind="name" class="hi-tee-name"></span>
        <span bind="length" class="hi-tee-length"></span>
    </label>
`);

/**
 * Hole info panel for the course-detail sidebar. Shown whenever a hole is
 * selected via `?hole=`. Header carries the hole number, an editable Par and
 * an editable Stroke index (both persisted through CourseDetailService.updateHole
 * with optimistic version). The tee table lists every tee of the hole with a
 * colour swatch, name, computed playing length (tee → aims → green center in
 * projected metres) and an "active tee" radio bound to FurnitureService's
 * sticky line-origin (activeTeeName / lineOriginTee / setActiveTeeName).
 *
 * Read-only against FurnitureService except (a) triggering its cached load and
 * (b) calling setActiveTeeName from the radios. Lengths are derived from the
 * furniture signals so they update live when a tee/aim/green moves.
 */
export class HoleInfoPanelComponent extends Component {
    static styles = `
        .hole-info {
            display: none;
            flex-direction: column;
            border-top: 1px solid ${t('color-border-default')};
            font-size: 0.8rem;
            color: ${t('color-text-primary')};

            &.show { display: flex; }

            & .hole-info__head {
                display: flex;
                flex-direction: column;
                gap: ${s('sm')};
                padding: ${s('md')} ${s('lg')} ${s('sm')};
            }

            & .hole-info__title {
                margin: 0;
                font-size: 0.9rem;
                color: ${t('color-text-primary')};
            }

            & .hole-info__fields {
                display: grid;
                grid-template-columns: 1fr 1.4fr;
                gap: ${s('sm')};
            }

            & .hi-field {
                display: flex;
                flex-direction: column;
                gap: ${s('xs')};
                font-size: 0.68rem;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.04em;
                color: ${t('color-text-secondary')};

                & select {
                    padding: ${s('xs')} ${s('sm')};
                    font-size: 0.8rem;
                    font-family: inherit;
                    color: ${t('color-text-primary')};
                    background: ${t('color-surface-raised')};
                    border: 1px solid ${t('color-border-default')};
                    border-radius: ${t('radius-sm')};
                }
            }

            & .hole-info__tees {
                display: flex;
                flex-direction: column;
                gap: 2px;
                padding: ${s('sm')} ${s('sm')} ${s('md')};
            }

            & .hi-tees-title {
                padding: 0 ${s('sm')} ${s('xs')};
                font-size: 0.68rem;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.06em;
                color: ${t('color-text-secondary')};
            }

            & .hi-tee-empty {
                display: none;
                padding: ${s('xs')} ${s('sm')};
                font-size: 0.75rem;
                color: ${t('color-text-secondary')};
                &.show { display: block; }
            }

            & .hi-tee-row {
                display: flex;
                align-items: center;
                gap: ${s('sm')};
                padding: ${s('xs')} ${s('sm')};
                border-radius: ${t('radius-sm')};
                cursor: pointer;
                transition: background 0.15s;
                &:hover { background: ${t('color-surface-sunken')}; }
            }

            & .hi-tee-radio { cursor: pointer; margin: 0; }

            & .hi-tee-swatch {
                width: 14px;
                height: 14px;
                border-radius: 50%;
                border: 1px solid rgba(0,0,0,0.25);
                flex-shrink: 0;
            }

            & .hi-tee-name { flex: 1; color: ${t('color-text-primary')}; }

            & .hi-tee-length {
                font-variant-numeric: tabular-nums;
                color: ${t('color-text-secondary')};
            }

            & .hi-note {
                padding: ${s('sm')} ${s('sm')} 0;
                font-size: 0.68rem;
                line-height: 1.4;
                color: ${t('color-text-secondary')};
            }
        }
    `;

    private svc = this.inject(CourseDetailService);
    private furniture = this.inject(FurnitureService);
    private router = this.inject(Router);
    private selectedHoleNumber = this.router.query('hole');

    /** The selected Hole (from ?hole= number), or null. */
    private readonly hole = new Computed<Hole | null>(() => {
        const num = this.selectedHoleNumber.get();
        if (num === undefined) return null;
        return this.svc.holes.get().find(h => String(h.number) === num) ?? null;
    });

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            root: { className: () => this.hole.get() ? 'hole-info show' : 'hole-info' },
            title: () => {
                const h = this.hole.get();
                return h ? `Hole ${h.number}` : '';
            },
            teeEmpty: {
                className: () => {
                    const h = this.hole.get();
                    const tees = h ? this.furniture.teesForHole(h.id) : [];
                    return tees.length === 0 ? 'hi-tee-empty show' : 'hi-tee-empty';
                },
            },
            stickyNote: () =>
                'Active tee is sticky: it stays selected as you switch holes '
                + '(matched by tee name, else the hole’s first tee).',
        });

        // Ensure furniture is loaded so the tee table has data. load() is cached
        // per courseId (no-op once loaded), so calling it on hole/holes changes
        // is cheap. We seed the hole-id set the same way the tool does.
        this.track(effect(() => {
            const course = this.svc.course.get();
            const ids = this.svc.holes.get().map(h => h.id);
            if (!course || ids.length === 0) return;
            this.furniture.setHoleIds(ids);
            void this.furniture.load(course.id, ids);
        }));

        this.buildParSelect(this.ref(frag, 'par') as HTMLSelectElement);
        this.buildSiSelect(this.ref(frag, 'si') as HTMLSelectElement);
        this.buildTeeRows(this.ref(frag, 'teeRows'));

        return frag;
    }

    // ── Par ────────────────────────────────────────────────────────────────

    private buildParSelect(sel: HTMLSelectElement): void {
        for (const p of [3, 4, 5, 6]) {
            const opt = document.createElement('option');
            opt.value = String(p);
            opt.textContent = String(p);
            sel.appendChild(opt);
        }
        sel.addEventListener('change', () => {
            const h = this.hole.peek();
            if (!h) return;
            const par = Number(sel.value);
            if (par !== h.par) void this.svc.updateHole(h.id, { par });
        });
        this.track(effect(() => {
            const h = this.hole.get();
            if (h) sel.value = String(h.par);
        }));
    }

    // ── Stroke index ─────────────────────────────────────────────────────────

    private buildSiSelect(sel: HTMLSelectElement): void {
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = '—';
        sel.appendChild(blank);
        for (let i = 1; i <= 18; i++) {
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = String(i);
            sel.appendChild(opt);
        }
        sel.addEventListener('change', () => {
            const h = this.hole.peek();
            if (!h) return;
            const strokeIndex = sel.value === '' ? null : Number(sel.value);
            if (strokeIndex !== h.strokeIndex) void this.svc.updateHole(h.id, { strokeIndex });
        });
        this.track(effect(() => {
            const h = this.hole.get();
            if (h) sel.value = h.strokeIndex === null ? '' : String(h.strokeIndex);
        }));
    }

    // ── Tee table ────────────────────────────────────────────────────────────

    /**
     * Render one row per tee of the selected hole (longest playing length
     * first, like a scorecard; unmeasurable tees last) via `$each`, keyed on
     * tee id so rows are reused across furniture updates and their per-row
     * effects are disposed on removal. Length + active state bind through
     * tracked effects, so tee/aim/green moves and active-tee changes update
     * live (moves that change lengths also re-sort).
     */
    private buildTeeRows(container: HTMLElement): void {
        this.$each(
            container,
            () => {
                const h = this.hole.get();
                if (!h) return [];
                const aims = this.furniture.aimsForHole(h.id);
                const green = this.furniture.greenForHole(h.id);
                const center = green ? { lat: green.centerLat, lon: green.centerLon } : null;
                return [...this.furniture.teesForHole(h.id)].sort((a, b) => {
                    const la = playingLength(a, aims, center).meters ?? -1;
                    const lb = playingLength(b, aims, center).meters ?? -1;
                    return lb - la;
                });
            },
            (tee, _i, track) => {
                const holeId = tee.holeId;
                const row = this.wireEl(teeRowTpl, {
                    name: () => tee.name,
                    length: () => this.lengthLabel(holeId, tee.id),
                }, track);
                const radio = row.querySelector('.hi-tee-radio') as HTMLInputElement;
                const swatch = row.querySelector('.hi-tee-swatch') as HTMLElement;
                swatch.style.background = teeFill(tee.color);
                radio.addEventListener('change', () => {
                    if (radio.checked) this.furniture.setActiveTeeName(tee.name);
                });
                track(effect(() => {
                    const origin = this.furniture.lineOriginTee(holeId);
                    radio.checked = origin?.id === tee.id;
                }));
                return row;
            },
            tee => tee.id,
        );
    }

    /** Playing-length label for a tee (metres, '~' prefix when no green). */
    private lengthLabel(holeId: string, teeId: string): string {
        const tee = this.furniture.teesForHole(holeId).find(x => x.id === teeId) ?? null;
        const aims = this.furniture.aimsForHole(holeId);
        const green = this.furniture.greenForHole(holeId);
        const center = green ? { lat: green.centerLat, lon: green.centerLon } : null;
        const { meters, approximate } = playingLength(tee, aims, center);
        if (meters === null) return '—';
        return `${approximate ? '~' : ''}${meters} m`;
    }
}
