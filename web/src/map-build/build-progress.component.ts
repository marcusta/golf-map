import { Component, Signal, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s } from '../css';
import { MapBuildClientService, BUILD_STEPS, STEP_LABELS, type BuildStep, type MapBuildJob } from './map-build.service';

const tpl = template(`
    <div class="build-progress" bind="root">
        <ol class="build-progress__steps" bind="steps"></ol>
        <div class="build-progress__error" bind="errorBox"><span bind="errorText"></span></div>
        <details class="build-progress__log">
            <summary>Build log</summary>
            <pre bind="log"></pre>
        </details>
    </div>
`);

const stepTpl = template(`
    <li class="build-step" bind="row">
        <span class="build-step__icon" bind="icon"></span>
        <span class="build-step__label" bind="label"></span>
    </li>
`);

type StepState = 'pending' | 'active' | 'done' | 'failed';

function stepState(job: MapBuildJob | null, step: BuildStep): StepState {
    if (!job) return 'pending';
    if (job.status === 'succeeded') return 'done';
    const current = job.step ? BUILD_STEPS.indexOf(job.step) : -1;
    const idx = BUILD_STEPS.indexOf(step);
    if (job.status === 'failed') {
        if (idx < current) return 'done';
        if (idx === current) return 'failed';
        return 'pending';
    }
    // pending / running
    if (idx < current) return 'done';
    if (idx === current) return 'active';
    return 'pending';
}

const ICON: Record<StepState, string> = { pending: '○', active: '◐', done: '●', failed: '✕' };

/**
 * Renders the map-build pipeline steps with per-step status, plus the error
 * and a collapsible log. Reads the shared MapBuildClientService's `job` signal.
 */
export class BuildProgressComponent extends Component {
    static styles = `
        .build-progress {
            display: flex;
            flex-direction: column;
            gap: ${s('md')};

            & .build-progress__steps {
                list-style: none;
                margin: 0;
                padding: 0;
                display: flex;
                flex-direction: column;
                gap: ${s('xs')};
            }

            & .build-step {
                display: flex;
                align-items: center;
                gap: ${s('sm')};
                font-size: 0.875rem;
                color: ${t('color-text-secondary')};

                & .build-step__icon { width: 1.25rem; text-align: center; }

                &.done { color: ${t('color-text-primary')}; & .build-step__icon { color: ${t('color-accent-primary')}; } }
                &.active {
                    color: ${t('color-text-primary')};
                    font-weight: 600;
                    & .build-step__icon { color: ${t('color-accent-primary')}; animation: build-spin 1.2s linear infinite; }
                }
                &.failed { color: ${t('color-status-negative')}; & .build-step__icon { color: ${t('color-status-negative')}; } }
            }

            @keyframes build-spin { to { transform: rotate(360deg); } }

            & .build-progress__error {
                display: none;
                color: ${t('color-status-negative')};
                font-size: 0.875rem;
                padding: ${s('sm')} ${s('md')};
                border: 1px solid ${t('color-status-negative')};
                border-radius: ${t('radius-sm')};
                &.show { display: block; }
            }

            & .build-progress__log {
                font-size: 0.75rem;
                color: ${t('color-text-secondary')};

                & summary { cursor: pointer; }
                & pre {
                    max-height: 220px;
                    overflow: auto;
                    margin: ${s('sm')} 0 0;
                    padding: ${s('sm')};
                    background: ${t('color-surface-sunken')};
                    border-radius: ${t('radius-sm')};
                    white-space: pre-wrap;
                    word-break: break-word;
                }
            }
        }
    `;

    private build = this.inject(MapBuildClientService);
    private stepList = new Signal<BuildStep[]>([...BUILD_STEPS]);

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            errorBox: { className: () => this.build.job.get()?.status === 'failed' ? 'build-progress__error show' : 'build-progress__error' },
            errorText: () => this.build.job.get()?.error ?? 'Build failed',
            log: { textContent: () => this.build.job.get()?.log ?? '' },
        });

        this.$each(this.ref(frag, 'steps'), this.stepList, (step, _i, track) =>
            this.wireEl(stepTpl, {
                row: { className: () => `build-step ${stepState(this.build.job.get(), step)}` },
                icon: () => ICON[stepState(this.build.job.get(), step)],
                label: () => STEP_LABELS[step],
            }, track),
        step => step);

        return frag;
    }
}
