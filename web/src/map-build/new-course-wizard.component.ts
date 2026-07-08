import { Component, Router, Signal, template, effect } from '@basics/core/client/core';
import { request, type RequestError } from '@basics/core/client/request';
import { t } from '../theme';
import { s, field, input, primaryBtn, btn } from '../css';
import { api } from '../api';
import { AreaPicker, formatBboxSize, type Bbox } from './area-picker';
import { MapBuildClientService, isTerminal } from './map-build.service';
import { BuildProgressComponent } from './build-progress.component';

const tpl = template(`
    <div class="wizard" bind="root">
        <div class="wizard__map" bind="mapHost"></div>
        <aside class="wizard__panel">
            <h2>New course</h2>
            <label class="wizard__field">Course name
                <input bind="name" type="text" placeholder="e.g. Landeryd" />
            </label>
            <p class="wizard__hint">Search or pan in <b>Navigate</b> mode to find the course, then switch to <b>Draw area</b> and drag out the region to import. The area is forced to a whole-metre square (GSPro-ready). Keep it tight — larger areas take longer to fetch and tile.</p>
            <div class="wizard__size" bind="size"></div>
            <div class="wizard__error" bind="startError"><span bind="startErrorText"></span></div>
            <button bind="build" type="button">Create &amp; build map</button>
            <div class="wizard__progress" bind="progress"></div>
            <button bind="cancel" type="button" class="wizard__cancel">Cancel</button>
        </aside>
    </div>
`);

/**
 * New-course flow: name → draw area on an OSM map → create the course →
 * kick off the server tile build → land on the course editor when done.
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
                border-left: 1px solid ${t('border')};
                background: ${t('surface')};
                display: flex;
                flex-direction: column;
                gap: ${s('md')};

                & h2 { margin: 0; font-size: 1.1rem; color: ${t('text')}; }
            }

            & .wizard__field { ${field()} }
            & .wizard__field input { ${input()} }

            & .wizard__hint { margin: 0; font-size: 0.8rem; color: ${t('text-muted')}; }

            & .wizard__size {
                font-size: 0.875rem;
                font-variant-numeric: tabular-nums;
                color: ${t('text')};
                min-height: 1.2em;
            }

            & .wizard__error {
                display: none;
                color: ${t('error')};
                font-size: 0.8rem;
                &.show { display: block; }
            }

            & button[bind=build] { ${primaryBtn()} }
            & button[bind=build]:disabled { opacity: 0.5; cursor: not-allowed; }

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

    private name = new Signal('');
    private startError = new Signal<RequestError | null>(null);
    private creating = new Signal(false);
    private picker: AreaPicker | null = null;
    private area = new Signal<Bbox | null>(null); // owned here so bindings track it before the picker exists
    private mapHost!: HTMLElement;

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            name: {
                value: () => this.name.get(),
                oninput: (e: Event) => this.name.set((e.target as HTMLInputElement).value),
                disabled: () => this.busy(),
            },
            size: () => {
                const box = this.area.get();
                return box ? formatBboxSize(box) : 'No area selected yet.';
            },
            startError: { className: () => this.startError.get() ? 'wizard__error show' : 'wizard__error' },
            startErrorText: () => this.startError.get()?.message ?? '',
            build: {
                textContent: () => this.build.job.get() && !isTerminal(this.build.job.get()!) ? 'Building…' : 'Create & build map',
                disabled: () => !this.canBuild(),
                onclick: () => void this.onBuild(),
            },
            progress: { className: () => this.build.job.get() ? 'wizard__progress show' : 'wizard__progress' },
            cancel: { onclick: () => this.router.navigate('/') },
        });

        this.mapHost = this.ref(frag, 'mapHost');
        this.spawn(BuildProgressComponent, this.ref(frag, 'progress'));
        return frag;
    }

    onMount(): void {
        this.build.job.set(null);
        this.picker = new AreaPicker(this.mapHost, { bbox: this.area });

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

    private busy(): boolean {
        const job = this.build.job.get();
        return this.creating.get() || (!!job && !isTerminal(job));
    }

    private canBuild(): boolean {
        return this.name.get().trim().length > 0 && !!this.area.get() && !this.busy();
    }

    private async onBuild(): Promise<void> {
        const bbox = this.area.get();
        if (!bbox || !this.canBuild()) return;
        this.startError.set(null);

        const center = { lat: (bbox.south + bbox.north) / 2, lon: (bbox.west + bbox.east) / 2 };
        const course = await request(this.creating, this.startError, () =>
            api.courses.create({ name: this.name.get().trim(), homeLat: center.lat, homeLon: center.lon }));
        if (!course) return; // error signal set

        await this.build.start(course.id, bbox);
    }
}
