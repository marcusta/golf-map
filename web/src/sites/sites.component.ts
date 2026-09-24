import { Component, Router, Computed, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, primaryBtn, ghostBtn, dangerBtn, input, card } from '../css';
import { ConfirmService } from '../app/confirm-dialog.component';
import { formatBboxSize } from '../map-build/bbox-math';
import { timeAgo } from '../courses/course-format';
import { SitesService } from './sites.service';
import type { SiteOverview, SiteCourse } from '../../../shared/api/sites.gen';

const tpl = template(`
    <div class="sites" bind="root" data-testid="sites">
        <div class="sites__inner">
            <header class="sites__header">
                <h2>Sites</h2>
                <span class="sites__spacer"></span>
                <button bind="back" type="button" class="sites__back">Courses</button>
            </header>
            <p class="sites__lede">A site is the physical place, for example a resort. It owns the map: orthophoto, lidar, terrain and terrain edits. A site has one or more courses, and they share that map. Holes and features belong to each course.</p>
            <p class="sites__lede">To rename a site or a course, edit its name and press Enter.</p>
            <div class="sites__error" bind="error"><span bind="errorText"></span></div>
            <div bind="empty" class="sites__none">No sites yet. A new course creates its site.</div>
            <div bind="list" class="sites__list"></div>
            <section bind="unassignedBox" class="sites__unassigned">
                <h3>Courses without a site</h3>
                <p class="sites__lede">These courses have no map. Set a map area to build one, or to use an existing site's map.</p>
                <div bind="unassigned" class="site-card__courses"></div>
            </section>
        </div>
    </div>
`);

const cardTpl = template(`
    <section class="site-card" data-testid="site-card">
        <div class="site-card__section">
            <div class="site-card__label"><span>Site (the resort or club)</span><span bind="map" class="site-card__map"></span></div>
            <input bind="name" type="text" class="site-card__name" aria-label="Site name" data-testid="site-name" />
            <input bind="notes" type="text" class="site-card__notes" placeholder="Notes about the site (optional)" aria-label="Site notes" />
        </div>
        <div class="site-card__section">
            <div class="site-card__label"><span bind="coursesLabel"></span></div>
            <div bind="courses" class="site-card__courses"></div>
            <div bind="noCourses" class="site-card__none">No courses on this site yet.</div>
        </div>
        <div class="site-card__section">
            <div class="site-card__label"><span>Add another course on this site</span></div>
            <form bind="addForm" class="site-card__add">
                <input bind="addName" type="text" placeholder="Course name, e.g. Långe Jan" aria-label="New course name" data-testid="site-add-name" />
                <button bind="add" type="submit" data-testid="site-add-course">Add course</button>
            </form>
            <p class="site-card__hint">The new course uses this site's map. No map build runs.</p>
        </div>
        <div class="site-card__actions">
            <button bind="rebuild" type="button" class="site-card__rebuild">Rebuild or extend map</button>
            <span class="sites__spacer"></span>
            <button bind="remove" type="button" class="site-card__remove">Delete site</button>
        </div>
    </section>
`);

const courseTpl = template(`
    <div class="site-course" data-testid="site-course">
        <input bind="name" type="text" aria-label="Course name" data-testid="site-course-name" />
        <button bind="open" type="button" class="site-course__open">Open</button>
        <button bind="action" type="button" class="site-course__action"></button>
    </div>
`);

/** SQLite `datetime('now')` is UTC without a zone suffix; Date.parse would read it as local time. */
function sqliteUtc(ts: string): string {
    return ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`;
}

/** Enter commits a rename the same way clicking away does. */
function blurOnEnter(e: KeyboardEvent): void {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
}

function mapLabel(site: SiteOverview): string {
    if (!site.mapBounds) return 'not built';
    const built = site.mapBuiltAt ? ` · built ${timeAgo(sqliteUtc(site.mapBuiltAt)).toLowerCase()}` : '';
    return `${formatBboxSize(site.mapBounds)}${built}`;
}

/**
 * Site setup page: rename sites and courses, add a course on an existing site,
 * detach a course, rebuild a site's map, delete an empty site.
 */
export class SitesComponent extends Component {
    static styles = `
        .sites {
            height: 100%;
            overflow-y: auto;
            padding: ${s('xl')} ${s('2xl')};

            & .sites__inner { max-width: 760px; margin: 0 auto; }

            & .sites__header {
                display: flex;
                align-items: flex-end;
                gap: ${s('md')};
                margin-bottom: ${s('sm')};

                & h2 {
                    margin: 0;
                    font-size: 1.6rem;
                    font-weight: 800;
                    letter-spacing: -0.02em;
                    color: ${t('color-text-primary')};
                }
            }
            & .sites__spacer { flex: 1; }
            & .sites__back { padding: ${s('sm')} ${s('md')}; font-size: 0.84rem; ${btn()} }

            & .sites__lede {
                margin: 0 0 ${s('lg')};
                font-size: 0.84rem;
                color: ${t('color-text-secondary')};
            }

            & .sites__error {
                display: none;
                margin-bottom: ${s('md')};
                padding: ${s('sm')} ${s('md')};
                font-size: 0.84rem;
                color: ${t('color-status-negative')};
                border: 1px solid color-mix(in srgb, ${t('color-status-negative')} 30%, transparent);
                background: color-mix(in srgb, ${t('color-status-negative')} 12%, transparent);
                border-radius: ${t('radius')};
                &.show { display: block; }
            }

            & .sites__none {
                display: none;
                font-size: 0.875rem;
                color: ${t('color-text-tertiary')};
                &.show { display: block; }
            }

            & .sites__list { display: flex; flex-direction: column; gap: ${s('lg')}; }

            & .sites__unassigned {
                display: none;
                margin-top: var(--space-8);
                &.show { display: block; }

                & h3 {
                    margin: 0 0 ${s('xs')};
                    font: var(--text-overline);
                    letter-spacing: var(--tracking-overline);
                    text-transform: uppercase;
                    color: ${t('color-text-secondary')};
                }
            }

            & .site-card {
                ${card()}
                padding: ${s('lg')};
                display: flex;
                flex-direction: column;
                gap: ${s('md')};

                &.is-focused { border-color: ${t('color-accent-primary')}; }
            }

            & .site-card__section { display: flex; flex-direction: column; gap: ${s('xs')}; }
            & .site-card__label {
                display: flex;
                align-items: baseline;
                justify-content: space-between;
                gap: ${s('md')};
                font: var(--text-overline);
                letter-spacing: var(--tracking-overline);
                text-transform: uppercase;
                color: ${t('color-text-secondary')};
            }
            & .site-card__hint, & .site-card__none {
                margin: 0;
                font-size: 0.78rem;
                color: ${t('color-text-tertiary')};
            }
            & .site-card__none { display: none; &.show { display: block; } }

            & input {
                padding: ${s('sm')} ${s('md')};
                font-size: 0.875rem;
                min-width: 0;
                ${input()}
            }
            & .site-card__name { font-size: 1.05rem; font-weight: 700; }
            & .site-card__map {
                font-family: var(--font-mono);
                font-size: 0.72rem;
                letter-spacing: 0;
                text-transform: none;
                color: ${t('color-text-tertiary')};
            }

            & .site-card__courses { display: flex; flex-direction: column; gap: ${s('xs')}; }

            & .site-course {
                display: flex;
                align-items: center;
                gap: ${s('sm')};

                & input { flex: 1; }
                & button { padding: ${s('sm')} ${s('md')}; font-size: 0.8rem; }
                & .site-course__open { ${btn()} }
                & .site-course__action { ${ghostBtn()} }
            }

            & .site-card__add {
                display: flex;
                gap: ${s('sm')};
                margin: 0;

                & input { flex: 1; }
                & button { padding: ${s('sm')} ${s('md')}; font-size: 0.8rem; ${primaryBtn()} }
                & button:disabled { opacity: 0.5; cursor: not-allowed; }
            }

            & .site-card__actions {
                display: flex;
                align-items: center;
                gap: ${s('sm')};

                & button { padding: ${s('sm')} ${s('md')}; font-size: 0.8rem; }
                & button:disabled { opacity: 0.5; cursor: not-allowed; }
                & .site-card__rebuild { ${btn()} }
                & .site-card__remove { ${dangerBtn()} }
            }
        }
    `;

    private svc = this.inject(SitesService);
    private router = this.inject(Router);
    private confirm = this.inject(ConfirmService);
    private params = this.router.params<{ siteId: string }>('/:host/:siteId');

    /**
     * $each keeps a keyed node for the life of its key, so the key carries
     * everything a card shows: a write re-renders that card and no other.
     */
    private cards = new Computed(() => this.svc.sites.get().map(site => ({ key: JSON.stringify(site), site })));

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            root: { inert: () => this.svc.loading.get() },
            back: { onclick: () => this.router.navigate('/') },
            error: { className: () => this.svc.error.get() ? 'sites__error show' : 'sites__error' },
            errorText: () => this.errorText(),
            empty: {
                className: () => !this.svc.loading.get() && this.svc.sites.get().length === 0 ? 'sites__none show' : 'sites__none',
            },
            unassignedBox: {
                className: () => this.svc.unassigned.get().length > 0 ? 'sites__unassigned show' : 'sites__unassigned',
            },
        });

        this.$each(this.ref(frag, 'list'), this.cards, (item, _i, track) => this.renderCard(item.site, track), item => item.key);

        this.$each(this.ref(frag, 'unassigned'), this.svc.unassigned, (course, _i, track) =>
            this.renderCourse(course, track, {
                label: 'Set map area',
                run: () => this.router.navigate(`/set-area/${course.id}`),
            }), course => `${course.id}:${course.name}`);

        return frag;
    }

    onMount(): void {
        void this.svc.load();
    }

    private errorText(): string {
        const err = this.svc.error.get();
        if (!err) return '';
        return err.code === 'conflict'
            ? 'The server refused the change: the data changed elsewhere, or the site still has courses. The list is reloaded.'
            : err.message;
    }

    private renderCard(site: SiteOverview, track: (d: () => void) => void): HTMLElement {
        const el = this.wireEl(cardTpl, {
            name: {
                value: () => site.name,
                'data-site': () => site.name,
                onchange: (e: Event) => void this.svc.renameSite(site.id, (e.target as HTMLInputElement).value),
                onkeydown: blurOnEnter,
            },
            notes: {
                value: () => site.notes ?? '',
                onchange: (e: Event) => void this.svc.setSiteNotes(site.id, (e.target as HTMLInputElement).value),
            },
            map: () => `Map: ${mapLabel(site)}`,
            coursesLabel: () => site.courses.length === 1 ? '1 course on this site' : `${site.courses.length} courses on this site`,
            noCourses: { className: () => site.courses.length === 0 ? 'site-card__none show' : 'site-card__none' },
            addForm: {
                onsubmit: (e: Event) => {
                    e.preventDefault();
                    const field = this.ref(el, 'addName') as HTMLInputElement;
                    if (field.value.trim()) void this.svc.addCourse(site.id, field.value);
                },
            },
            rebuild: {
                // The build API is addressed by course; any course on the site targets the site's map.
                disabled: () => site.courses.length === 0,
                title: () => site.courses.length === 0 ? 'Add a course first' : 'Redraw the map area and rebuild. Every course on the site gets the new map.',
                onclick: () => this.router.navigate(`/set-area/${site.courses[0].id}`),
            },
            remove: {
                disabled: () => site.courses.length > 0,
                title: () => site.courses.length > 0 ? 'Detach its courses first' : '',
                onclick: () => void this.onRemove(site),
            },
        }, track);

        if (this.params.get().siteId === site.id) el.classList.add('is-focused');

        const host = this.ref(el, 'courses');
        for (const course of site.courses) {
            host.appendChild(this.renderCourse(course, track, {
                label: 'Detach',
                run: () => void this.onDetach(site, course),
            }));
        }
        return el;
    }

    private renderCourse(
        course: SiteCourse,
        track: (d: () => void) => void,
        action: { label: string; run: () => void },
    ): HTMLElement {
        return this.wireEl(courseTpl, {
            name: {
                value: () => course.name,
                onchange: (e: Event) => void this.svc.renameCourse(course.id, (e.target as HTMLInputElement).value),
                onkeydown: blurOnEnter,
            },
            open: { onclick: () => this.router.navigate(`/course/${course.id}`) },
            action: { textContent: () => action.label, onclick: action.run },
        }, track);
    }

    private async onDetach(site: SiteOverview, course: SiteCourse): Promise<void> {
        const ok = await this.confirm.confirm({
            title: `Detach ${course.name}?`,
            body: `${course.name} stops using the ${site.name} map. Its holes and features stay. The map stays on the site.`,
            confirmLabel: 'Detach',
            tone: 'warning',
        });
        if (ok) await this.svc.detachCourse(course.id);
    }

    private async onRemove(site: SiteOverview): Promise<void> {
        const ok = await this.confirm.confirm({
            title: `Delete ${site.name}?`,
            body: 'The site record is deleted. Tiles and source files stay on disk.',
            confirmLabel: 'Delete site',
        });
        if (ok) await this.svc.removeSite(site.id);
    }
}
