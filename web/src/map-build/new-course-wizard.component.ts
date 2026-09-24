import { Component, Router, Signal, Computed, template, effect } from '@basics/core/client/core';
import { t } from '../theme';
import { s, field, input, primaryBtn, ghostBtn, metric, segmented } from '../css';
import { SitesService } from '../sites/sites.service';
import { AreaPicker, formatBboxSize, type Bbox } from './area-picker';
import { MapBuildClientService, isTerminal } from './map-build.service';
import { BuildProgressComponent } from './build-progress.component';

const siteOptTpl = template(`<option bind="opt"></option>`);

type Target = 'new' | 'existing';

const tpl = template(`
    <div class="wizard" bind="root">
        <div class="wizard__map" bind="mapHost"></div>
        <aside class="wizard__panel">
            <h2>New course</h2>
            <div class="wizard__target" bind="target" role="group" aria-label="Site for the new course">
                <button bind="targetNew" type="button" data-testid="wizard-new-site">New site</button>
                <button bind="targetExisting" type="button" data-testid="wizard-existing-site">Existing site</button>
            </div>
            <label class="wizard__field" bind="siteNameField">Site name
                <input bind="siteName" type="text" placeholder="e.g. Ekerum Resort" data-testid="wizard-site-name" />
            </label>
            <label class="wizard__field" bind="siteSelectField">Site
                <select bind="siteSelect" data-testid="wizard-site-select"></select>
            </label>
            <label class="wizard__field">Course name
                <input bind="name" type="text" placeholder="e.g. Långe Erik" data-testid="wizard-course-name" />
            </label>
            <p class="wizard__hint" bind="existingHint">The course uses the site's map as it is. No build runs. The dashed outline is the area the map covers. If the course extends past it, rebuild the map from the Sites page afterwards.</p>
            <p class="wizard__hint" bind="newHint">A site is the physical location and owns the map. Its courses share that map.</p>
            <p class="wizard__hint" bind="areaHint">Search or pan in <b>Navigate</b> mode to find the course, then switch to <b>Draw area</b> and drag out the region to import. The area is forced to a whole-metre square (GSPro-ready). Keep it tight — larger areas take longer to fetch and tile.</p>
            <div class="wizard__size" bind="size"></div>
            <div class="wizard__error" bind="startError"><span bind="startErrorText"></span></div>
            <button bind="build" type="button">Create &amp; build map</button>
            <div class="wizard__progress" bind="progress"></div>
            <button bind="cancel" type="button" class="wizard__cancel">Cancel</button>
        </aside>
    </div>
`);

/**
 * New-course flow, two targets.
 *
 *   New site      — name the site and the course → draw the area → create both →
 *                   kick off the server tile build → land on the editor when done.
 *   Existing site — pick a site → name the course → create it on that site. The
 *                   course shares the site's map, so no build runs.
 */
export class NewCourseWizardComponent extends Component {
    static styles = `
        .wizard {
            position: absolute;
            inset: 0;
            display: flex;

            & .wizard__map { flex: 1; min-width: 0; position: relative; }

            & .wizard__panel {
                width: 340px;
                flex-shrink: 0;
                overflow-y: auto;
                padding: ${s('xl')} ${s('lg')};
                border-left: 1px solid ${t('color-border-default')};
                background: ${t('color-surface-card')};
                display: flex;
                flex-direction: column;
                gap: ${s('md')};

                & h2 { margin: 0; font-size: 1.1rem; color: ${t('color-text-primary')}; }
            }

            & .wizard__target {
                ${segmented()}
                & > button { flex: 1; padding: ${s('sm')} ${s('md')}; font-size: 0.8rem; }
                & > button:disabled { opacity: 0.5; cursor: not-allowed; }
            }

            & .wizard__field { ${field()} }
            & .wizard__field input, & .wizard__field select { ${input()} }
            & .hide { display: none; }

            & .wizard__hint { margin: 0; font-size: 0.8rem; color: ${t('color-text-secondary')}; }

            & .wizard__size {
                ${metric()}
                font-size: 0.875rem;
                color: ${t('color-text-primary')};
                min-height: 1.2em;
            }

            & .wizard__error {
                display: none;
                color: ${t('color-status-negative')};
                font-size: 0.8rem;
                padding: ${s('sm')} ${s('md')};
                border: 1px solid color-mix(in srgb, ${t('color-status-negative')} 30%, transparent);
                background: color-mix(in srgb, ${t('color-status-negative')} 12%, transparent);
                border-radius: ${t('radius')};
                &.show { display: block; }
            }

            & button[bind=build] { ${primaryBtn()} }
            & button[bind=build]:disabled { opacity: 0.5; cursor: not-allowed; }

            & .wizard__progress {
                display: none;
                margin-top: ${s('sm')};
                &.show { display: block; }
            }

            & .wizard__cancel { ${ghostBtn()} margin-top: auto; }
        }
    `;

    private router = this.inject(Router);
    private build = this.inject(MapBuildClientService);
    private sites = this.inject(SitesService);

    private target = new Signal<Target>('new');
    private siteName = new Signal('');
    private name = new Signal('');
    /** Until the course name is typed by hand it follows the site name. */
    private nameEdited = false;
    private chosenSite = new Signal('');

    /** Placeholder + existing sites, for the <select>. */
    private siteOptions = new Computed<{ id: string; name: string }[]>(() =>
        [{ id: '', name: 'Select a site…' }, ...this.sites.sites.get()]);
    private picker: AreaPicker | null = null;
    private area = new Signal<Bbox | null>(null); // owned here so bindings track it before the picker exists
    private mapHost!: HTMLElement;

    render(): DocumentFragment {
        const isNew = () => this.target.get() === 'new';
        const onlyNew = (cls: string) => ({ className: () => isNew() ? cls : `${cls} hide` });
        const onlyExisting = (cls: string) => ({ className: () => isNew() ? `${cls} hide` : cls });

        const frag = this.wire(tpl, {
            targetNew: {
                'aria-pressed': () => String(isNew()),
                disabled: () => this.busy(),
                onclick: () => this.setTarget('new'),
            },
            targetExisting: {
                'aria-pressed': () => String(!isNew()),
                disabled: () => this.busy() || this.sites.sites.get().length === 0,
                onclick: () => this.setTarget('existing'),
            },
            siteNameField: onlyNew('wizard__field'),
            siteSelectField: onlyExisting('wizard__field'),
            newHint: onlyNew('wizard__hint'),
            areaHint: onlyNew('wizard__hint'),
            existingHint: onlyExisting('wizard__hint'),
            siteName: {
                value: () => this.siteName.get(),
                oninput: (e: Event) => {
                    const value = (e.target as HTMLInputElement).value;
                    this.siteName.set(value);
                    if (!this.nameEdited) this.name.set(value);
                },
                disabled: () => this.busy(),
            },
            siteSelect: {
                value: () => this.chosenSite.get(),
                onchange: (e: Event) => this.chooseSite((e.target as HTMLSelectElement).value),
                disabled: () => this.busy(),
            },
            name: {
                value: () => this.name.get(),
                oninput: (e: Event) => {
                    this.nameEdited = true;
                    this.name.set((e.target as HTMLInputElement).value);
                },
                disabled: () => this.busy(),
            },
            size: {
                className: () => isNew() ? 'wizard__size' : 'wizard__size hide',
                textContent: () => {
                    const box = this.area.get();
                    return box ? formatBboxSize(box) : 'No area selected yet.';
                },
            },
            startError: { className: () => this.sites.error.get() ? 'wizard__error show' : 'wizard__error' },
            startErrorText: () => this.sites.error.get()?.message ?? '',
            build: {
                textContent: () => {
                    if (!isNew()) return 'Create course';
                    return this.build.job.get() && !isTerminal(this.build.job.get()!) ? 'Building…' : 'Create & build map';
                },
                disabled: () => !this.canCreate(),
                onclick: () => void this.onCreate(),
            },
            progress: { className: () => this.build.job.get() ? 'wizard__progress show' : 'wizard__progress' },
            cancel: { onclick: () => this.router.navigate('/') },
        });

        this.$each(this.ref(frag, 'siteSelect'), this.siteOptions, (site, _i, track) =>
            this.wireEl(siteOptTpl, {
                opt: { textContent: () => site.name, value: () => site.id },
            }, track), site => site.id);

        this.mapHost = this.ref(frag, 'mapHost');
        this.spawn(BuildProgressComponent, this.ref(frag, 'progress'));
        return frag;
    }

    onMount(): void {
        this.build.job.set(null);
        this.sites.error.set(null);
        this.picker = new AreaPicker(this.mapHost, { bbox: this.area });
        void this.sites.load();

        // Navigate to the editor once the build succeeds.
        this.track(effect(() => {
            const job = this.build.job.get();
            if (job?.status === 'succeeded') this.router.navigate(`/course/${job.courseId}`);
        }));

        this.track(() => {
            this.build.stop();
            this.picker?.destroy();
            this.picker = null;
        });
    }

    private setTarget(target: Target): void {
        this.target.set(target);
        this.showChosenSiteArea();
    }

    private chooseSite(siteId: string): void {
        this.chosenSite.set(siteId);
        this.showChosenSiteArea();
    }

    /** On an existing site, outline the area its map covers; on a new site, clear the outline. */
    private showChosenSiteArea(): void {
        const site = this.target.get() === 'existing'
            ? this.sites.sites.get().find(st => st.id === this.chosenSite.get())
            : undefined;
        this.picker?.showReference(site?.mapBounds ?? null);
    }

    private busy(): boolean {
        const job = this.build.job.get();
        return this.sites.loading.get() || (!!job && !isTerminal(job));
    }

    private canCreate(): boolean {
        if (this.busy() || this.name.get().trim().length === 0) return false;
        return this.target.get() === 'new'
            ? this.siteName.get().trim().length > 0 && !!this.area.get()
            : !!this.chosenSite.get();
    }

    private async onCreate(): Promise<void> {
        if (!this.canCreate()) return;

        if (this.target.get() === 'existing') {
            const course = await this.sites.addCourse(this.chosenSite.get(), this.name.get());
            if (course) this.router.navigate(`/course/${course.id}`);
            return;
        }

        const bbox = this.area.get()!;
        const course = await this.sites.createSiteWithCourse({
            siteName: this.siteName.get(),
            courseName: this.name.get(),
            home: { lat: (bbox.south + bbox.north) / 2, lon: (bbox.west + bbox.east) / 2 },
        });
        if (!course) return; // error signal set

        await this.build.start(course.id, bbox);
    }
}
