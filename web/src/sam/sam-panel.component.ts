import { Component, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s, panelTitle } from '../css';
import { FEATURE_TYPES, FEATURE_STYLES, type FeatureType } from '../draw/feature-palette';
import { SamToolService } from './sam-tool.service';

const tpl = template(`
    <div class="sam-panel" bind="root" data-testid="sam-panel">
        <div class="status-row">
            <span bind="statusDot" class="status-dot"></span>
            <span bind="statusText" class="status-text"></span>
            <button bind="retryBtn" type="button" class="retry-btn">Retry</button>
        </div>
        <div bind="armedSection" class="armed-section">
            <h4 class="section-title">Create as</h4>
            <select bind="typeSelect" class="type-select"></select>
        </div>
        <div bind="busyLine" class="busy-line">Segmenting…</div>
        <div bind="notice" class="notice"></div>
        <div class="sam-panel__hints">
            <div><b>Click inside</b> a bunker, green, or other feature on the photo.</div>
            <div>SAM traces it into an editable b-spline of the armed type.</div>
            <div>Refine it in <b>Draw</b> — <b>⌘Z</b> there undoes the create.</div>
        </div>
    </div>
`);

/**
 * Side panel for the SAM click-to-feature tool (T45): sidecar health gate
 * (status + retry), the armed-type picker, busy/notice lines, and usage
 * hints. Shares the SamToolService DI singleton with the tool descriptor.
 */
export class SamPanelComponent extends Component {
    static styles = `
        .sam-panel {
            /* Flat dock body (feature-dock.component.ts hosting contract). */
            display: flex;
            flex-direction: column;
            gap: var(--space-3);
            padding: var(--space-3) var(--space-4) var(--space-4);
            font-size: 0.8rem;
            color: ${t('color-text-primary')};

            & .section-title {
                margin: 0 0 ${s('xs')};
                ${panelTitle()}
            }

            & .status-row {
                display: flex;
                align-items: center;
                gap: ${s('sm')};
            }

            & .status-dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: ${t('color-text-secondary')};
                flex: none;
                &.online { background: var(--data-good); }
                &.offline { background: var(--data-bad); }
            }

            & .status-text { flex: 1; }

            & .retry-btn {
                display: none;
                font: inherit;
                font-size: 0.72rem;
                padding: 2px ${s('sm')};
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius-sm')};
                background: transparent;
                color: ${t('color-text-primary')};
                cursor: pointer;
                &.show { display: inline-block; }
            }

            & .type-select {
                width: 100%;
                font: inherit;
                padding: ${s('xs')} ${s('sm')};
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius-sm')};
                background: ${t('color-surface-card')};
                color: ${t('color-text-primary')};
            }

            & .busy-line {
                display: none;
                color: ${t('color-text-secondary')};
                &.show { display: block; }
            }

            & .notice {
                display: none;
                color: var(--data-bad);
                line-height: 1.4;
                &.show { display: block; }
            }

            & .sam-panel__hints {
                padding-top: var(--space-3);
                border-top: 1px solid ${t('color-border-default')};
                display: flex;
                flex-direction: column;
                gap: ${s('xs')};
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
                line-height: 1.4;
            }
        }
    `;

    private tool = this.inject(SamToolService);

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            statusDot: {
                className: () => `status-dot ${this.tool.health.get() === 'checking' ? '' : this.tool.health.get()}`,
            },
            statusText: {
                textContent: () => {
                    const health = this.tool.health.get();
                    if (health === 'checking') return 'Checking SAM sidecar…';
                    return health === 'online'
                        ? 'SAM sidecar online'
                        : 'SAM sidecar offline — clicks are disabled';
                },
            },
            retryBtn: {
                onclick: () => void this.tool.checkHealth(),
                className: () => this.tool.health.get() === 'offline' ? 'retry-btn show' : 'retry-btn',
            },
            // The type picker stays usable while offline: arming a type and
            // THEN starting the sidecar is a fine order of operations.
            busyLine: { className: () => this.tool.busy.get() ? 'busy-line show' : 'busy-line' },
            notice: {
                textContent: () => this.tool.notice.get() ?? '',
                className: () => this.tool.notice.get() ? 'notice show' : 'notice',
            },
        });

        const select = this.ref(frag, 'typeSelect') as HTMLSelectElement;
        for (const type of FEATURE_TYPES) {
            const opt = document.createElement('option');
            opt.value = type;
            opt.textContent = FEATURE_STYLES[type].label;
            select.appendChild(opt);
        }
        select.addEventListener('change', () => this.tool.armedType.set(select.value as FeatureType));
        this.track(effect(() => { select.value = this.tool.armedType.get(); }));

        return frag;
    }
}
