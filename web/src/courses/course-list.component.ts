import { Component, Router, Signal, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, primaryBtn, input, statusTag } from '../css';
import { icon } from '../ui/icons';
import { PopoverComponent } from '../ui/popover.component';
import { CoursesService, type SortBy, type GroupBy } from './courses.service';
import { ServerModeService, canAuthorCourses } from '../app/server-mode.service';
import type { CourseSummary } from '../../../shared/api/courses.gen';
import { renderCourseThumb, type RoutingHole } from './course-thumb';
import { timeAgo, formatLength, formatPar, mappedPct, mappedLabel, pctLabel } from './course-format';

const SORT_LABELS: Record<SortBy, string> = { name: 'Name', updated: 'Updated', progress: 'Progress' };
const GROUP_LABELS: Record<GroupBy, string> = { site: 'Site', status: 'Status', none: 'None' };

const SELECTED_KEY = 'courses.selectedId';

// Flat render model: one $each over headers + rows keeps keyed reconciliation
// simple across filter/sort/group changes (frameless groups = whitespace only).
type RenderRow =
    | { kind: 'header'; key: string; label: string; count: number; first: boolean }
    | { kind: 'row'; key: string; course: CourseSummary };

const tpl = template(`
    <div class="courses" bind="root" data-testid="courses">
        <div class="courses__inner">
            <header class="courses__header">
                <h2>Courses</h2>
                <span bind="total" class="courses__total"></span>
                <span class="courses__spacer"></span>
                <button bind="newCourse" type="button" class="courses__new">
                    <span class="courses__new-plus">+</span>New course
                </button>
            </header>
            <div class="error" bind="error">
                <span bind="errorText"></span>
                <button bind="retry">Retry</button>
            </div>
            <div class="courses__toolbar">
                <div class="courses__search">
                    <input bind="search" type="text" placeholder="Search courses"
                        aria-label="Search courses" data-testid="courses-search">
                </div>
                <span bind="sortHost"></span>
                <span bind="groupHost"></span>
            </div>
            <div bind="empty" class="courses__empty">No courses match</div>
            <div bind="list" class="courses__list"></div>
        </div>
    </div>
`);

const headerTpl = template(`
    <div class="course-group" data-testid="course-group">
        <span bind="label" class="course-group__label"></span>
        <span bind="count" class="course-group__count"></span>
        <span class="course-group__rule"></span>
    </div>
`);

const rowTpl = template(`
    <button bind="row" type="button" class="course-row" data-testid="course-row">
        <span bind="thumb" class="course-thumb" data-testid="course-thumb"></span>
        <span class="course-row__name-block">
            <span bind="name" class="course-row__name"></span>
            <span class="course-row__meta">
                <span bind="site" class="course-row__site"></span>
                <span bind="sep" class="course-row__sep">·</span>
                <span bind="updated" class="course-row__updated"></span>
            </span>
        </span>
        <span class="course-row__metrics">
            <span class="course-row__metric">
                <span class="course-row__metric-label">HOLES</span>
                <span bind="holes" class="course-row__metric-value"></span>
            </span>
            <span class="course-row__metric">
                <span class="course-row__metric-label">PAR</span>
                <span bind="par" class="course-row__metric-value"></span>
            </span>
            <span class="course-row__metric course-row__metric--len">
                <span class="course-row__metric-label">LENGTH</span>
                <span bind="length" class="course-row__metric-value"></span>
            </span>
        </span>
        <span class="course-row__progress">
            <span class="course-row__progress-top">
                <span bind="mappedLabel" class="course-row__mapped"></span>
                <span bind="pct" class="course-row__pct"></span>
            </span>
            <span class="course-row__track"><span bind="fill" class="course-row__fill"></span></span>
        </span>
        <span bind="status" class="course-row__status"></span>
        <span class="course-row__spacer"></span>
        <span bind="chev" class="course-row__chev"></span>
    </button>
`);

export class CourseListComponent extends Component {
    static styles = `
        .courses {
            height: 100%;
            overflow-y: auto;
            padding: ${s('xl')} ${s('2xl')};

            &[inert] { opacity: 0.6; }

            & .courses__inner {
                max-width: 940px;
                margin: 0 auto;
            }

            /* ── header ── */
            & .courses__header {
                display: flex;
                align-items: flex-end;
                gap: ${s('md')};
                margin-bottom: ${s('lg')};

                & h2 {
                    margin: 0;
                    font-size: 1.6rem;
                    font-weight: 800;
                    letter-spacing: -0.02em;
                    color: ${t('color-text-primary')};
                }
            }

            & .courses__total {
                font-family: var(--font-mono);
                font-variant-numeric: tabular-nums;
                font-size: 0.75rem;
                color: ${t('color-text-tertiary')};
                padding-bottom: 2px;
            }

            & .courses__spacer { flex: 1; }

            & .courses__new {
                display: inline-flex;
                align-items: center;
                gap: ${s('xs')};
                padding: var(--space-3) var(--space-4);
                font-size: 0.84rem;
                box-shadow: 0 8px 18px -8px color-mix(in srgb, ${t('color-accent-primary')} 55%, transparent);
                ${primaryBtn()}

                & .courses__new-plus { font-size: 1.05em; line-height: 1; margin-top: -1px; }
            }

            & .error {
                display: none;
                color: ${t('color-status-negative')};
                font-size: 0.875rem;
                margin-bottom: ${s('md')};
            }
            & .error.show { display: flex; align-items: center; gap: ${s('sm')}; }
            & .error button { padding: ${s('xs')} ${s('sm')}; font-size: 0.75rem; ${btn()} }

            /* ── toolbar ── */
            & .courses__toolbar {
                display: flex;
                align-items: center;
                gap: ${s('sm')};
                margin-bottom: var(--space-6);
            }

            & .courses__search {
                position: relative;
                display: flex;
                flex: 1;
                max-width: 340px;

                & > svg {
                    position: absolute;
                    left: 12px;
                    top: 50%;
                    transform: translateY(-50%);
                    color: ${t('color-text-tertiary')};
                    pointer-events: none;
                }
                & input {
                    width: 100%;
                    padding: 9px 12px 9px 34px;
                    font-size: 0.84rem;
                    ${input()}
                }
            }

            & .courses__chip {
                display: inline-flex;
                align-items: center;
                gap: ${s('xs')};
                padding: 9px 13px;
                font-family: var(--font-mono);
                font-size: 0.75rem;
                ${btn()}

                & .courses__chip-chev { display: inline-flex; color: ${t('color-text-tertiary')}; }
            }

            & .courses__empty {
                display: none;
                color: ${t('color-text-tertiary')};
                font-size: 0.875rem;
                padding: ${s('sm')} 2px;
            }
            & .courses__empty.show { display: block; }

            /* ── list ── */
            & .courses__list { display: flex; flex-direction: column; }

            /* ── group header ── */
            & .course-group {
                display: flex;
                align-items: center;
                gap: ${s('md')};
                margin: 0 12px 8px;

                &:not(:first-child) { margin-top: var(--space-8); }

                & .course-group__label {
                    font: var(--text-overline);
                    letter-spacing: var(--tracking-overline);
                    text-transform: uppercase;
                    color: ${t('color-text-secondary')};
                }
                & .course-group__count {
                    font-family: var(--font-mono);
                    font-size: 11px;
                    color: ${t('color-text-tertiary')};
                }
                & .course-group__rule {
                    flex: 1;
                    height: 1px;
                    background: ${t('color-border-subtle')};
                }
            }

            /* ── row ── */
            & .course-row {
                display: flex;
                align-items: center;
                gap: 20px;
                width: 100%;
                text-align: left;
                font-family: inherit;
                padding: 14px 14px 14px 16px;
                border: none;
                border-radius: var(--radius-md);
                background: transparent;
                cursor: pointer;
                transition: background var(--dur-fast) var(--ease-standard);

                &:hover { background: color-mix(in srgb, ${t('color-text-primary')} 8%, transparent); }
                &:focus-visible {
                    outline: 2px solid ${t('color-border-focus')};
                    outline-offset: -2px;
                }
                &.is-selected {
                    background: color-mix(in srgb, ${t('color-accent-primary')} 7%, transparent);
                    box-shadow: inset 3px 0 0 ${t('color-accent-primary')};
                }

                & .course-thumb {
                    width: 104px;
                    height: 70px;
                    flex: none;
                    border-radius: 9px;
                    overflow: hidden;
                    background-color: var(--map-rough-fill);
                    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.06);
                    display: block;

                    & svg { width: 100%; height: 100%; display: block; }
                }

                & .course-row__name-block { flex: 0 1 292px; min-width: 0; }
                & .course-row__name {
                    display: block;
                    font-size: 16.5px;
                    font-weight: 700;
                    letter-spacing: -0.01em;
                    color: ${t('color-text-primary')};
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                & .course-row__meta {
                    display: flex;
                    align-items: center;
                    gap: 7px;
                    margin-top: 3px;
                    font-size: 12.5px;
                    color: ${t('color-text-tertiary')};
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;

                    & .course-row__sep { color: ${t('color-border-strong')}; }
                    & .course-row__updated { font-family: var(--font-mono); font-size: 11.5px; }
                }

                & .course-row__metrics { display: flex; gap: 20px; align-items: center; flex: none; }
                & .course-row__metric {
                    text-align: right;
                    min-width: 34px;

                    &.course-row__metric--len { min-width: 62px; }

                    & .course-row__metric-label {
                        display: block;
                        font-family: var(--font-mono);
                        font-size: 10px;
                        letter-spacing: 0.1em;
                        color: ${t('color-text-tertiary')};
                    }
                    & .course-row__metric-value {
                        display: block;
                        font-family: var(--font-mono);
                        font-variant-numeric: tabular-nums;
                        font-size: 14px;
                        font-weight: 600;
                        color: ${t('color-text-primary')};
                    }
                }

                & .course-row__progress { width: 138px; flex: none; }
                & .course-row__progress-top {
                    display: flex;
                    justify-content: space-between;
                    align-items: baseline;
                    margin-bottom: 5px;

                    & .course-row__mapped { font-size: 11px; color: ${t('color-text-tertiary')}; }
                    & .course-row__pct {
                        font-family: var(--font-mono);
                        font-size: 11px;
                        font-weight: 600;
                        color: ${t('color-text-secondary')};
                    }
                }
                & .course-row__track {
                    display: block;
                    height: 6px;
                    border-radius: var(--radius-pill);
                    overflow: hidden;
                    background: color-mix(in srgb, ${t('color-text-primary')} 10%, transparent);

                    & .course-row__fill {
                        display: block;
                        height: 100%;
                        border-radius: var(--radius-pill);
                        background: var(--data-good);
                    }
                }

                & .course-row__status {
                    flex: none;
                    font-family: var(--font-mono);
                    ${statusTag(t('color-status-positive'))}

                    &.draft { ${statusTag('var(--data-risk)')} }
                }

                & .course-row__spacer { flex: 1; }

                & .course-row__chev {
                    flex: none;
                    display: inline-flex;
                    margin-right: 4px;
                    color: ${t('color-text-disabled')};
                }
                &.is-selected .course-row__chev { color: ${t('color-accent-primary')}; }
            }
        }
    `;

    private svc = this.inject(CoursesService);
    private router = this.inject(Router);
    private serverMode = this.inject(ServerModeService);
    private selectedId = new Signal<string | null>(this.readSelected());

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            root: { inert: () => this.svc.loading.get() },
            total: () => {
                const total = this.svc.store.total.get();
                return total ? `${total} course${total === 1 ? '' : 's'}` : '';
            },
            error: { className: () => this.svc.error.get() ? 'error show' : 'error' },
            errorText: () => this.svc.error.get()?.message ?? '',
            retry: { onclick: () => this.svc.load() },
            // Creating a course means running the map-build wizard, which only
            // exists on a builder box — the button is absent in serve mode.
            newCourse: {
                onclick: () => this.router.navigate('/new'),
                style: () => (canAuthorCourses(this.serverMode.mode.get()) ? '' : 'display:none'),
            },
            search: {
                oninput: (e: Event) => this.svc.query.set((e.target as HTMLInputElement).value),
            },
            empty: {
                className: () => {
                    const hasItems = this.svc.store.items.get().length > 0;
                    const noMatch = this.rows().every(r => r.kind !== 'row');
                    return hasItems && noMatch ? 'courses__empty show' : 'courses__empty';
                },
            },
        });

        // Prefix the search box with the magnifier icon.
        this.ref(frag, 'search').insertAdjacentHTML('beforebegin', icon('search', 16));

        this.buildSort(this.ref(frag, 'sortHost'));
        this.buildGroup(this.ref(frag, 'groupHost'));

        this.$each(this.ref(frag, 'list'), () => this.rows(), (item, _i, track) => {
            return item.kind === 'header'
                ? this.renderHeader(item, track)
                : this.renderRow(item.course, track);
        }, item => item.key);

        return frag;
    }

    onMount(): void {
        void this.svc.load();
    }

    // ── flat render model ────────────────────────────────────────────────
    private rows(): RenderRow[] {
        const out: RenderRow[] = [];
        this.svc.groups.get().forEach((g, gi) => {
            if (g.label !== null) {
                out.push({ kind: 'header', key: `h:${g.label}`, label: g.label, count: g.courses.length, first: gi === 0 });
            }
            for (const c of g.courses) out.push({ kind: 'row', key: c.id, course: c });
        });
        return out;
    }

    private renderHeader(item: Extract<RenderRow, { kind: 'header' }>, track: (d: () => void) => void) {
        return this.wireEl(headerTpl, {
            label: () => item.label,
            count: () => String(item.count),
        }, track);
    }

    private renderRow(course: CourseSummary, track: (d: () => void) => void): HTMLElement {
        const holes = course.holeCount;
        // Row content other than the selection state is fixed for the row's
        // lifetime; only `row.className` reads a signal (selectedId).
        const el = this.wireEl(rowTpl, {
            row: {
                className: () => `course-row${this.selectedId.get() === course.id ? ' is-selected' : ''}`,
                onclick: () => this.openCourse(course.id),
            },
            name: () => course.name,
            updated: () => timeAgo(course.updatedAt),
            holes: () => (holes > 0 ? String(holes) : '—'),
            par: () => formatPar(course.parTotal),
            length: () => formatLength(course.lengthM),
            mappedLabel: () => mappedLabel(course.mappedHoleCount, holes),
            pct: () => pctLabel(course.mappedHoleCount, holes),
            status: {
                textContent: () => (course.status === 'published' ? 'Published' : 'Draft'),
                className: () => `course-row__status${course.status === 'published' ? '' : ' draft'}`,
            },
        }, track);

        el.dataset.courseId = course.id;

        // Meta line: drop the site segment (and its separator) when unassigned
        // or when it just repeats the course name (1:1 backfilled sites).
        if (course.siteName && course.siteName !== course.name) this.ref(el, 'site').textContent = course.siteName;
        else { this.ref(el, 'site').remove(); this.ref(el, 'sep').remove(); }

        // Progress fill width.
        (this.ref(el, 'fill') as HTMLElement).style.width = `${holes > 0 ? mappedPct(course.mappedHoleCount, holes) : 0}%`;

        // Thumbnail — static per course (routing doesn't change here).
        const routing = (course.routing ?? []) as RoutingHole[];
        this.ref(el, 'thumb').appendChild(renderCourseThumb(routing));

        // Persistent chevron affordance.
        this.ref(el, 'chev').innerHTML = icon('chevron-right', 16);

        return el;
    }

    // ── toolbar popovers ─────────────────────────────────────────────────
    private buildSort(host: HTMLElement): void {
        this.spawn(PopoverComponent, host, {
            ariaLabel: 'Sort courses',
            triggerClassName: 'courses__chip',
            trigger: (h, ctx) => {
                h.dataset.testid = 'courses-sort-trigger';
                const lbl = document.createElement('span');
                h.appendChild(lbl);
                h.insertAdjacentHTML('beforeend', `<span class="courses__chip-chev">${icon('chevron-down', 16)}</span>`);
                ctx.track(effect(() => { lbl.textContent = `Sort · ${SORT_LABELS[this.svc.sortBy.get()]}`; }));
            },
            panel: (h, ctx) => this.buildChoicePanel(
                h, ctx,
                (['name', 'updated', 'progress'] as SortBy[]).map(v => ({ v, label: SORT_LABELS[v] })),
                () => this.svc.sortBy.get(),
                v => this.svc.setSortBy(v),
            ),
        });
    }

    private buildGroup(host: HTMLElement): void {
        this.spawn(PopoverComponent, host, {
            ariaLabel: 'Group courses',
            triggerClassName: 'courses__chip',
            trigger: (h, ctx) => {
                h.dataset.testid = 'courses-group-trigger';
                const lbl = document.createElement('span');
                h.appendChild(lbl);
                h.insertAdjacentHTML('beforeend', `<span class="courses__chip-chev">${icon('chevron-down', 16)}</span>`);
                ctx.track(effect(() => { lbl.textContent = `Group · ${GROUP_LABELS[this.svc.groupBy.get()]}`; }));
            },
            panel: (h, ctx) => this.buildChoicePanel(
                h, ctx,
                (['site', 'status', 'none'] as GroupBy[]).map(v => ({ v, label: GROUP_LABELS[v] })),
                () => this.svc.groupBy.get(),
                v => this.svc.setGroupBy(v),
            ),
        });
    }

    private buildChoicePanel<T extends string>(
        host: HTMLElement,
        ctx: { track: (d: () => void) => void; close: () => void },
        options: { v: T; label: string }[],
        current: () => T,
        set: (v: T) => void,
    ): void {
        for (const opt of options) {
            const optBtn = document.createElement('button');
            optBtn.type = 'button';
            optBtn.className = 'menu-item';
            optBtn.setAttribute('role', 'menuitemradio');
            optBtn.innerHTML = `<span class="menu-item__label">${opt.label}</span>`
                + `<span class="menu-item__check">${icon('check', 16)}</span>`;
            optBtn.onclick = () => { set(opt.v); ctx.close(); };
            ctx.track(effect(() => { optBtn.setAttribute('aria-checked', String(current() === opt.v)); }));
            host.appendChild(optBtn);
        }
    }

    // ── selection persistence ────────────────────────────────────────────
    private openCourse(id: string): void {
        this.selectedId.set(id);
        try { localStorage.setItem(SELECTED_KEY, id); } catch { /* ignore */ }
        this.router.navigate(`/course/${id}`);
    }

    private readSelected(): string | null {
        try { return localStorage.getItem(SELECTED_KEY); } catch { return null; }
    }
}
