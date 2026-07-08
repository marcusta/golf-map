import { Component, Router, Signal, Computed, template, effect } from '@basics/core/client/core';
import { t } from '../theme';
import { s, primaryBtn, btn, input } from '../css';
import { api } from '../api';
import { TilesetService } from '../map/tileset.service';
import type { Site } from '../../../shared/api/sites.gen';
import type { Course } from '../../../shared/api/courses.gen';
import { AreaPicker, formatBboxSize, type Bbox } from './area-picker';
import { MapBuildClientService, isTerminal } from './map-build.service';
import { BuildProgressComponent } from './build-progress.component';

const tpl = template(`
    <div class="wizard" bind="root">
        <div class="wizard__map" bind="mapHost"></div>
        <aside class="wizard__panel">
            <h2 bind="title">Set map area</h2>
            <p class="wizard__hint">Search or pan in <b>Navigate</b> mode to find the course, then switch to <b>Draw area</b> and drag out the region to import. The area is forced to a whole-metre square (GSPro-ready). Building replaces any existing map for this course.</p>
            <div class="wizard__size" bind="size"></div>
            <button bind="build" type="button">Build map</button>
            <div class="wizard__reuse" bind="reuseBox">
                <div class="wizard__or">— or reuse an existing site's map —</div>
                <select bind="siteSelect"></select>
                <button bind="useSite" type="button" class="wizard__usesite">Use this site's map</button>
            </div>
            <div class="wizard__progress" bind="progress"></div>
            <button bind="cancel" type="button" class="wizard__cancel">Back to course</button>
        </aside>
    </div>
`);

const siteOptTpl = template(`<option bind="opt"></option>`);

/**
 * Set-map-area flow for an existing (tile-less) course: draw an area, kick off
 * the server tile build, then reload the tileset and return to the editor.
 */
export class SetMapAreaComponent extends Component {
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
                border-left: 1px solid ${t('border')};
                background: ${t('surface')};
                display: flex;
                flex-direction: column;
                gap: ${s('md')};

                & h2 { margin: 0; font-size: 1.1rem; color: ${t('text')}; }
            }

            & .wizard__hint { margin: 0; font-size: 0.8rem; color: ${t('text-muted')}; }

            & .wizard__size {
                font-size: 0.875rem;
                font-variant-numeric: tabular-nums;
                color: ${t('text')};
                min-height: 1.2em;
            }

            & button[bind=build] { ${primaryBtn()} }
            & button[bind=build]:disabled { opacity: 0.5; cursor: not-allowed; }

            & .wizard__reuse {
                display: none;
                flex-direction: column;
                gap: ${s('sm')};
                &.show { display: flex; }

                & .wizard__or { font-size: 0.75rem; color: ${t('text-muted')}; text-align: center; }
                & select { ${input()} }
                & .wizard__usesite { ${btn()} }
                & .wizard__usesite:disabled { opacity: 0.5; cursor: not-allowed; }
            }

            & .wizard__progress {
                display: none;
                margin-top: ${s('sm')};
                &.show { display: block; }
            }

            & .wizard__cancel { ${btn()} margin-top: auto; }
        }
    `;

    private router = this.inject(Router);
    private build = this.inject(MapBuildClientService);
    private tileset = this.inject(TilesetService);
    private params = this.router.params<{ courseId: string }>('/:host/:courseId');

    private course = new Signal<Course | null>(null);
    private picker: AreaPicker | null = null;
    private area = new Signal<Bbox | null>(null); // owned here so bindings track it before the picker exists
    private sites = new Signal<Site[]>([]); // other sites whose map can be reused
    private chosenSite = new Signal('');
    private attaching = new Signal(false);
    private mapHost!: HTMLElement;

    /** Placeholder + reusable sites, for the <select>. */
    private siteOptions = new Computed<{ id: string; name: string }[]>(() =>
        [{ id: '', name: 'Select a site…' }, ...this.sites.get()]);

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            title: () => this.course.get()?.name ? `Set map area — ${this.course.get()!.name}` : 'Set map area',
            size: () => {
                const box = this.area.get();
                return box ? formatBboxSize(box) : 'No area selected yet.';
            },
            build: {
                textContent: () => this.build.job.get() && !isTerminal(this.build.job.get()!) ? 'Building…' : 'Build map',
                disabled: () => !this.canBuild(),
                onclick: () => void this.onBuild(),
            },
            reuseBox: { className: () => this.sites.get().length > 0 ? 'wizard__reuse show' : 'wizard__reuse' },
            siteSelect: {
                value: () => this.chosenSite.get(),
                onchange: (e: Event) => this.chosenSite.set((e.target as HTMLSelectElement).value),
            },
            useSite: {
                disabled: () => !this.chosenSite.get() || this.attaching.get(),
                onclick: () => void this.onUseSite(),
            },
            progress: { className: () => this.build.job.get() ? 'wizard__progress show' : 'wizard__progress' },
            cancel: { onclick: () => this.router.navigate(`/course/${this.params.get().courseId}`) },
        });

        // Placeholder + one option per reusable site.
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
        const { courseId } = this.params.get();

        void this.hydrate(courseId);

        // On success, refresh the manifest cache and return to the editor.
        this.track(effect(() => {
            const job = this.build.job.get();
            if (job?.status === 'succeeded') {
                void this.tileset.reload(courseId).then(() => this.router.navigate(`/course/${courseId}`));
            }
        }));

        this.track(() => {
            this.build.stop();
            this.picker?.destroy();
            this.picker = null;
        });
    }

    /** Load the course, reusable sites, and any prior build's bbox to preseed the picker. */
    private async hydrate(courseId: string): Promise<void> {
        const [course, latest, sites] = await Promise.all([
            api.courses.get({ id: courseId }).catch(() => null),
            api.mapBuild.latest({ courseId }).catch(() => null),
            api.sites.list().catch(() => [] as Site[]),
        ]);
        if (course) {
            this.course.set(course);
            // Offer every site except this course's own (nothing to reuse from itself).
            this.sites.set(sites.filter(st => st.id !== course.siteId));
        }
        this.picker = new AreaPicker(this.mapHost, { bbox: this.area, initialBounds: latest?.bbox ?? null });
    }

    private canBuild(): boolean {
        const job = this.build.job.get();
        const building = !!job && !isTerminal(job);
        return !!this.area.get() && !building;
    }

    private async onBuild(): Promise<void> {
        const bbox = this.area.get();
        if (!bbox || !this.canBuild()) return;
        await this.build.start(this.params.get().courseId, bbox);
    }

    /** Attach this course to an existing site's map (no build) and open the editor. */
    private async onUseSite(): Promise<void> {
        const course = this.course.get();
        const siteId = this.chosenSite.get();
        if (!course || !siteId || this.attaching.get()) return;
        this.attaching.set(true);
        try {
            await api.courses.update({ id: course.id, version: course.version, siteId });
            await this.tileset.reload(course.id);
            this.router.navigate(`/course/${course.id}`);
        } finally {
            this.attaching.set(false);
        }
    }
}
