import { Component, effect, template } from '@basics/core/client/core';
import { s } from '../css';
import { dockBody, sectionTitle, statusRow, smallBtn, panelInput, busyAndNotice, hintsFooter } from '../editor/panel-recipes.css';
import { FEATURE_TYPES, FEATURE_STYLES, type FeatureType } from '../draw/feature-palette';
import { CourseDetailService } from '../course-detail/course-detail.service';
import { SamToolService, SAM_SCOPE_FOLLOW, SAM_SCOPE_COURSE } from './sam-tool.service';

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
            <h4 class="section-title scope-title">Add to</h4>
            <select bind="scopeSelect" class="type-select" data-testid="sam-scope-select"></select>
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
            ${dockBody()}

            ${sectionTitle()}

            & .scope-title { margin-top: ${s('sm')}; }

            ${statusRow()}

            & .retry-btn {
                display: none;
                ${smallBtn()}
                &.show { display: inline-block; }
            }

            & .type-select { ${panelInput()} }

            ${busyAndNotice()}

            ${hintsFooter('sam-panel__hints')}
        }
    `;

    private tool = this.inject(SamToolService);
    private courseDetail = this.inject(CourseDetailService);

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

        // Hole scope: "Selected hole" (default — follows the sidebar's active
        // hole, like draw) / "Course level" / an explicit hole. Options are
        // rebuilt when the hole list loads (feature-stack panel pattern).
        const scopeSelect = this.ref(frag, 'scopeSelect') as HTMLSelectElement;
        scopeSelect.addEventListener('change', () => this.tool.holeScope.set(scopeSelect.value));
        this.track(effect(() => {
            const holes = this.courseDetail.holes.get();
            const value = this.tool.holeScope.get();
            scopeSelect.textContent = '';
            const follow = document.createElement('option');
            follow.value = SAM_SCOPE_FOLLOW;
            follow.textContent = 'Selected hole (auto)';
            scopeSelect.appendChild(follow);
            const course = document.createElement('option');
            course.value = SAM_SCOPE_COURSE;
            course.textContent = 'Course level';
            scopeSelect.appendChild(course);
            for (const hole of holes) {
                const option = document.createElement('option');
                option.value = hole.id;
                option.textContent = `Hole ${hole.number} (par ${hole.par})`;
                scopeSelect.appendChild(option);
            }
            scopeSelect.value = value;
        }));

        return frag;
    }
}
