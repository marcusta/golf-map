import { Component, Router, Signal, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s, metric, panelTitle } from '../css';
import { icon } from '../ui/icons';
import { CourseDetailService } from './course-detail.service';

/** Shared localStorage key so the collapse state carries across Create ↔ Plan. */
const LEFT_DOCK_KEY = 'golf-map.holeDock.collapsed';

function loadCollapsed(): boolean {
    try {
        return localStorage.getItem(LEFT_DOCK_KEY) === '1';
    } catch {
        return false;
    }
}

function saveCollapsed(value: boolean): void {
    try {
        localStorage.setItem(LEFT_DOCK_KEY, value ? '1' : '0');
    } catch {
        // Non-fatal — the dock just won't remember its state across reloads.
    }
}

export type HoleSidebarProps = {
    /** Route base for hole navigation, e.g. '/course' or '/planner'. */
    routeBase: string;
    /** Component mounted in the expanded dock's footer (below the hole list). */
    footer: new () => Component<any>;
};

const tpl = template(`
    <aside class="hole-dock" bind="root" data-testid="hole-dock">
        <div class="hole-dock__expanded">
            <div class="hole-dock__head">
                <span class="hole-dock__overline">Holes</span>
                <button bind="collapseBtn" type="button" class="hole-dock__chevron" aria-label="Collapse holes" title="Collapse">${icon('chevron-left')}</button>
            </div>
            <nav bind="holeList" class="hole-list" data-testid="hole-dock-list"></nav>
            <div bind="footerHost" class="hole-dock__footer"></div>
        </div>
        <div class="hole-dock__rail" data-testid="hole-dock-rail">
            <button bind="expandBtn" type="button" class="hole-dock__chevron" aria-label="Expand holes" title="Expand">${icon('chevron-right')}</button>
            <span class="hole-dock__rail-label">Hole</span>
            <button bind="prevBtn" type="button" class="hole-dock__step" aria-label="Previous hole" data-testid="hole-dock-prev">${icon('chevron-up')}</button>
            <div class="hole-dock__rail-num">
                <span bind="railNum" class="hole-dock__rail-n" data-testid="hole-dock-num"></span>
                <span bind="railPar" class="hole-dock__rail-par"></span>
            </div>
            <button bind="nextBtn" type="button" class="hole-dock__step" aria-label="Next hole" data-testid="hole-dock-next">${icon('chevron-down')}</button>
        </div>
    </aside>
`);

const holeTpl = template(`
    <button bind="row" type="button" class="hole-row">
        <span bind="number" class="hole-row__number"></span>
        <span bind="par" class="hole-row__par"></span>
    </button>
`);

/**
 * Shared collapsible left "Holes" dock (Builder redesign v2), used by BOTH
 * course-detail (Create) and planner (Plan). Selection is the URL query
 * `?hole=N` on each page's own route (`routeBase` keeps /course and /planner
 * distinct). Expanded: a "HOLES" header, a scrollable hole list, and a
 * page-provided footer component (HoleInfoPanel / PlannerPanel). Collapsed:
 * a 58px rail with prev/next stepping and the big active hole number.
 *
 * Collapse state persists in localStorage under one shared key so it carries
 * across Create ↔ Plan; default expanded.
 */
export class HoleSidebarComponent extends Component<HoleSidebarProps> {
    static styles = `
        .hole-dock {
            flex: none;
            width: 264px;
            /* height:100% resolves against the (definite) grid row so the dock
               caps to the viewport and its list scrolls INSIDE — min-height:0
               alone lets the flex column grow past the row. */
            height: 100%;
            min-height: 0;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            background: ${t('color-surface-card')};
            border-right: 1px solid ${t('color-border-default')};

            &.is-collapsed { width: 58px; }

            /* ── expanded ── */
            & .hole-dock__expanded {
                flex: 1;
                min-height: 0;
                display: flex;
                flex-direction: column;
            }
            &.is-collapsed .hole-dock__expanded { display: none; }

            & .hole-dock__head {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: ${s('md')} ${s('md')} ${s('sm')};
            }
            & .hole-dock__overline { ${panelTitle()} }

            & .hole-dock__chevron {
                width: 26px;
                height: 26px;
                flex: none;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                border: 1px solid ${t('color-border-default')};
                border-radius: 7px;
                background: ${t('color-surface-raised')};
                color: ${t('color-text-secondary')};
                cursor: pointer;
                transition: border-color var(--dur-fast) var(--ease-standard),
                    color var(--dur-fast) var(--ease-standard);
                &:hover { border-color: ${t('color-border-strong')}; color: ${t('color-text-primary')}; }
            }

            & .hole-list {
                flex: 1;
                min-height: 0;
                overflow-y: auto;
                display: flex;
                flex-direction: column;
                gap: 2px;
                padding: 0 ${s('sm')} ${s('md')};
            }

            & .hole-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: ${s('sm')} ${s('md')};
                border: none;
                border-radius: ${t('radius')};
                background: transparent;
                font-family: inherit;
                cursor: pointer;
                transition: background var(--dur-fast) var(--ease-standard);

                &:hover { background: ${t('color-surface-sunken')}; }
                &.active {
                    background: ${t('color-accent-primary')};
                    & .hole-row__number, & .hole-row__par { color: ${t('color-on-accent')}; }
                }

                & .hole-row__number {
                    font-size: 0.875rem;
                    font-weight: 600;
                    color: ${t('color-text-primary')};
                }
                & .hole-row__par {
                    ${metric()}
                    font-size: 0.75rem;
                    font-weight: 400;
                    text-transform: uppercase;
                    color: ${t('color-text-tertiary')};
                }
            }

            & .hole-dock__footer {
                flex: none;
                min-height: 0;
            }

            /* ── collapsed rail ── */
            & .hole-dock__rail {
                display: none;
                flex-direction: column;
                align-items: center;
                gap: ${s('sm')};
                padding: ${s('md')} 0;
            }
            &.is-collapsed .hole-dock__rail { display: flex; }

            & .hole-dock__rail-label {
                writing-mode: vertical-rl;
                ${panelTitle()}
                margin: ${s('xs')} 0;
            }

            & .hole-dock__step {
                width: 30px;
                height: 24px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                border: none;
                background: transparent;
                color: ${t('color-text-tertiary')};
                cursor: pointer;
                border-radius: ${t('radius-sm')};
                transition: color var(--dur-fast) var(--ease-standard),
                    background var(--dur-fast) var(--ease-standard);
                &:hover { color: ${t('color-text-primary')}; background: ${t('color-surface-sunken')}; }
                &:disabled { opacity: 0.4; cursor: default; }
                &:disabled:hover { color: ${t('color-text-tertiary')}; background: transparent; }
            }

            & .hole-dock__rail-num {
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 2px;
            }
            & .hole-dock__rail-n {
                font-family: var(--font-mono);
                font-variant-numeric: tabular-nums;
                font-size: 1.5rem;
                font-weight: 700;
                line-height: 1;
                color: ${t('color-accent-primary')};
            }
            & .hole-dock__rail-par {
                font-family: var(--font-mono);
                font-variant-numeric: tabular-nums;
                font-size: 0.65rem;
                color: ${t('color-text-tertiary')};
            }
        }
    `;

    private svc = this.inject(CourseDetailService);
    private router = this.inject(Router);
    private params = this.router.params<{ courseId: string }>('/:host/:courseId');
    private selectedHole = this.router.query('hole');
    private collapsed = new Signal(loadCollapsed());

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            root: {
                className: () => this.collapsed.get() ? 'hole-dock is-collapsed' : 'hole-dock',
            },
            collapseBtn: { onclick: () => this.setCollapsed(true) },
            expandBtn: { onclick: () => this.setCollapsed(false) },
            prevBtn: {
                onclick: () => this.nav(this.currentHole() - 1),
                disabled: () => this.currentHole() <= 1,
            },
            nextBtn: {
                onclick: () => this.nav(this.currentHole() + 1),
                disabled: () => this.currentHole() >= this.holeCount(),
            },
            railNum: () => String(this.currentHole()),
            railPar: () => {
                const par = this.parFor(this.currentHole());
                return par === null ? 'PAR —' : `PAR ${par}`;
            },
        });

        this.$each(this.ref(frag, 'holeList'), this.svc.holes, (hole, _i, track) => {
            const live = this.svc.holeStore.item(hole.id);
            const rowEl = this.wireEl(holeTpl, {
                row: {
                    onclick: () => this.router.navigate(`${this.props.routeBase}/${hole.courseId}`, {
                        query: { hole: String(hole.number) },
                    }),
                    className: () => this.selectedHole.get() === String(hole.number)
                        ? 'hole-row active' : 'hole-row',
                },
                number: () => `Hole ${live.get().number}`,
                par: () => `Par ${live.get().par}`,
            }, track);
            // E2E hook (inert in prod): per-hole selector by hole number.
            rowEl.dataset.testid = 'hole-dock-row';
            rowEl.dataset.holeNumber = String(hole.number);
            return rowEl;
        }, hole => hole.id);

        // Footer region: the page-provided panel (HoleInfoPanel / PlannerPanel).
        // Spawned once and kept mounted across collapse toggles (the collapsed
        // rail just hides the whole expanded block), so its state survives.
        this.spawn(this.props.footer, this.ref(frag, 'footerHost'));

        return frag;
    }

    private setCollapsed(value: boolean): void {
        this.collapsed.set(value);
        saveCollapsed(value);
    }

    private holeCount(): number {
        return this.svc.holes.get().length || 1;
    }

    /** Selected hole number (from ?hole=), clamped to 1..holeCount; default 1. */
    private currentHole(): number {
        const q = this.selectedHole.get();
        const n = q !== undefined ? Number(q) : 1;
        if (!Number.isFinite(n)) return 1;
        return Math.max(1, Math.min(this.holeCount(), n));
    }

    private parFor(n: number): number | null {
        return this.svc.holes.get().find(h => h.number === n)?.par ?? null;
    }

    private nav(n: number): void {
        const { courseId } = this.params.peek();
        if (!courseId) return;
        const clamped = Math.max(1, Math.min(this.holeCount(), n));
        this.router.navigate(`${this.props.routeBase}/${courseId}`, { query: { hole: String(clamped) } });
    }
}
