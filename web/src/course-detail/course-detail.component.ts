import { Component, Router, template, effect } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, primaryBtn } from '../css';
import { ConfirmService } from '../app/confirm-dialog.component';
import { CourseDetailService } from './course-detail.service';
import { EditorCanvasComponent } from '../map/editor-canvas.component';
import { SvgImportPanelComponent } from '../import/svg-import-panel.component';
import { SvgImportService, boundsFromGeoreference } from '../import/svg-import.service';
import { HoleInfoPanelComponent } from './hole-info-panel.component';

const tpl = template(`
    <div class="course-detail" bind="root" data-testid="course-detail">
        <header class="course-detail__header" data-testid="course-detail-header">
            <button bind="back" class="back-btn" type="button">&#8592; Courses</button>
            <h2 bind="name" data-testid="course-name"></h2>
            <span bind="status" class="status"></span>
            <span bind="revision" class="meta"></span>
            <span bind="parTotal" class="meta"></span>
            <span bind="georef" class="meta georef-warn"></span>
            <div class="header-actions">
                <button bind="plan" class="plan-btn" type="button" title="Open the game-plan editor for this course" data-testid="course-plan-btn">Plan</button>
                <button bind="importSvg" class="import-btn" type="button" title="Import traced course features from an SVG file" data-testid="course-import-svg-btn">Import SVG</button>
                <button bind="publish" class="publish-btn" type="button" title="Publish this course revision for device sync"></button>
            </div>
            <div class="error" bind="error">
                <span bind="errorText"></span>
                <button bind="retry" type="button">Retry</button>
            </div>
        </header>
        <div class="course-detail__body">
            <aside class="course-detail__sidebar">
                <h3 class="sidebar-title">Holes</h3>
                <nav bind="holeList" class="hole-list"></nav>
                <div bind="holeInfo"></div>
            </aside>
            <section class="course-detail__main">
                <div id="editor-canvas" bind="editorCanvas" class="editor-canvas"></div>
            </section>
        </div>
    </div>
`);

const holeTpl = template(`
    <button bind="row" type="button" class="hole-row">
        <span bind="number" class="hole-row__number"></span>
        <span bind="par" class="hole-row__par"></span>
    </button>
`);

export class CourseDetailComponent extends Component {
    static styles = `
        .course-detail {
            display: flex;
            flex-direction: column;
            height: 100%;

            &[inert] { opacity: 0.6; }

            & .course-detail__header {
                display: flex;
                align-items: center;
                gap: ${s('md')};
                flex-shrink: 0;
                padding: ${s('sm')} ${s('lg')};
                background: ${t('surface')};
                border-bottom: 1px solid ${t('border')};

                & h2 { margin: 0; font-size: 1rem; color: ${t('text')}; }

                & .back-btn {
                    padding: ${s('xs')} ${s('sm')};
                    font-size: 0.8rem;
                    ${btn()}
                }

                & .status {
                    font-size: 0.7rem;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                    padding: 2px ${s('sm')};
                    border-radius: ${t('radius-pill')};
                    background: ${t('hover-bg')};
                    color: ${t('text-muted')};

                    &.published {
                        background: rgba(47, 125, 79, 0.12);
                        color: ${t('primary')};
                    }
                }

                & .meta {
                    font-size: 0.8rem;
                    color: ${t('text-muted')};
                }

                & .georef-warn {
                    color: ${t('error')};
                    font-size: 0.75rem;
                    &:empty { display: none; }
                }

                & .header-actions {
                    display: flex;
                    gap: ${s('sm')};
                    margin-left: auto;

                    & .plan-btn {
                        padding: ${s('xs')} ${s('sm')};
                        font-size: 0.8rem;
                        ${btn()}
                    }
                    & .import-btn {
                        padding: ${s('xs')} ${s('sm')};
                        font-size: 0.8rem;
                        ${btn()}
                    }
                    & .publish-btn {
                        padding: ${s('xs')} ${s('md')};
                        font-size: 0.8rem;
                        ${primaryBtn()}
                        &:disabled { opacity: 0.5; cursor: default; }
                    }
                }

                & .error {
                    display: none;
                    color: ${t('error')};
                    font-size: 0.875rem;
                    margin-left: auto;
                }
                & .error.show {
                    display: flex;
                    align-items: center;
                    gap: ${s('sm')};
                }
                & .error button { padding: ${s('xs')} ${s('sm')}; font-size: 0.75rem; ${btn()} }
            }

            & .course-detail__body {
                display: grid;
                grid-template-columns: 280px 1fr;
                flex: 1;
                min-height: 0;
            }

            & .course-detail__sidebar {
                display: flex;
                flex-direction: column;
                min-height: 0;
                background: ${t('surface')};
                border-right: 1px solid ${t('border')};

                & .sidebar-title {
                    margin: 0;
                    padding: ${s('md')} ${s('lg')} ${s('sm')};
                    font-size: 0.7rem;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.06em;
                    color: ${t('text-muted')};
                }
            }

            & .hole-list {
                flex: 1;
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
                border-radius: ${t('radius-sm')};
                background: transparent;
                font-family: inherit;
                cursor: pointer;
                transition: background 0.15s;

                &:hover { background: ${t('hover-bg')}; }
                &.active {
                    background: ${t('active-bg')};
                    & .hole-row__number, & .hole-row__par { color: ${t('active-text')}; }
                }

                & .hole-row__number {
                    font-size: 0.875rem;
                    font-weight: 600;
                    color: ${t('text')};
                }

                & .hole-row__par {
                    font-size: 0.8rem;
                    color: ${t('text-muted')};
                }
            }

            & .course-detail__main {
                min-width: 0;
                min-height: 0;
                display: flex;
            }

            & .editor-canvas {
                flex: 1;
                position: relative;
            }
        }
    `;

    private svc = this.inject(CourseDetailService);
    private importSvc = this.inject(SvgImportService);
    private confirm = this.inject(ConfirmService);
    private router = this.inject(Router);
    private params = this.router.params<{ courseId: string }>('/course/:courseId');
    private selectedHole = this.router.query('hole');

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            root: { inert: () => this.svc.loading.get() },
            back: { onclick: () => this.router.navigate('/') },
            name: () => this.svc.course.get()?.name ?? '',
            status: {
                textContent: () => this.svc.course.get()?.status ?? '',
                className: () => `status ${this.svc.course.get()?.status ?? ''}`,
            },
            revision: () => {
                const course = this.svc.course.get();
                return course ? `rev ${course.revision}` : '';
            },
            parTotal: () => {
                const holes = this.svc.holes.get();
                return holes.length ? `${holes.length} holes · par ${this.svc.totalPar.get()}` : '';
            },
            georef: () => {
                const course = this.svc.course.get();
                return course && !course.georeferenceJson ? '⚠ no georeference' : '';
            },
            plan: {
                onclick: () => {
                    const { courseId } = this.params.peek();
                    const hole = this.selectedHole.peek();
                    if (!courseId) return;
                    this.router.navigate(`/planner/${courseId}`,
                        hole !== undefined ? { query: { hole } } : undefined);
                },
            },
            importSvg: {
                onclick: () => {
                    const course = this.svc.course.peek();
                    if (!course) return;
                    this.importSvc.openFor(course.id, boundsFromGeoreference(course.georeferenceJson));
                },
            },
            publish: {
                textContent: () => this.svc.publishing.get() ? 'Publishing…' : 'Publish',
                disabled: () => this.svc.publishing.get() || !this.svc.course.get(),
                onclick: async () => {
                    const course = this.svc.course.peek();
                    if (!course) return;
                    const ok = await this.confirm.confirm({
                        title: `Publish ${course.name}?`,
                        body: `Publishing bumps revision ${course.revision} to ${course.revision + 1} for device sync.`,
                        detail: 'Players already on the course keep their current local copy until they refresh.',
                        confirmLabel: 'Publish course',
                        cancelLabel: 'Keep editing',
                        tone: 'primary',
                        layout: 'review',
                    });
                    if (ok) void this.svc.publish();
                },
            },
            error: { className: () => this.svc.error.get() || this.svc.publishError.get() ? 'error show' : 'error' },
            errorText: () => this.svc.error.get()?.message ?? (this.svc.publishError.get() ? `Publish failed — ${this.svc.publishError.get()?.message}` : ''),
            retry: { onclick: () => this.svc.load(this.params.get().courseId) },
        });

        // Load (or reload) whenever the courseId route param changes.
        this.track(effect(() => {
            const { courseId } = this.params.get();
            if (courseId) void this.svc.load(courseId);
        }));

        // Hole info panel — lives in the sidebar below the hole list; shows
        // itself whenever a hole is selected (?hole=).
        this.spawn(HoleInfoPanelComponent, this.ref(frag, 'holeInfo'));

        this.spawn(EditorCanvasComponent, this.ref(frag, 'editorCanvas'));
        // SVG import wizard — hidden until the header button opens it;
        // shares the editor-canvas positioning context so it docks over
        // the map's right edge (the map stays visible for the preview).
        this.spawn(SvgImportPanelComponent, this.ref(frag, 'editorCanvas'));

        this.$each(this.ref(frag, 'holeList'), this.svc.holes, (hole, _i, track) => {
            const live = this.svc.holeStore.item(hole.id);
            const rowEl = this.wireEl(holeTpl, {
                row: {
                    onclick: () => this.router.navigate(`/course/${hole.courseId}`, {
                        query: { hole: String(hole.number) },
                    }),
                    className: () => this.selectedHole.get() === String(hole.number)
                        ? 'hole-row active' : 'hole-row',
                },
                number: () => `Hole ${live.get().number}`,
                par: () => `Par ${live.get().par}`,
            }, track);
            // E2E hook (inert in prod): per-hole selector by hole number.
            rowEl.dataset.testid = 'course-hole-row';
            rowEl.dataset.holeNumber = String(hole.number);
            return rowEl;
        }, hole => hole.id);

        return frag;
    }
}
