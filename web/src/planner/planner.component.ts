import { Component, Router, template, effect, untrack } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn } from '../css';
import { CourseDetailService } from '../course-detail/course-detail.service';
import { FeaturesService } from '../draw/features.service';
import { FurnitureService } from '../furniture/furniture.service';
import { MapService } from '../map/map.service';
import { EditorCanvasComponent } from '../map/editor-canvas.component';
import { ClubsService } from '../player/clubs.service';
import { PlanService } from './plan.service';
import { PlannerToolService } from './planner-tool.service';
import { PlannerPanelComponent } from './planner-panel.component';

const tpl = template(`
    <div class="planner" bind="root" data-testid="planner">
        <header class="planner__header">
            <button bind="back" class="back-btn" type="button">&#8592; Course</button>
            <h2 bind="name"></h2>
            <span class="planner__title">Planner</span>
            <div class="error" bind="error">
                <span bind="errorText"></span>
                <button bind="retry" type="button">Retry</button>
            </div>
        </header>
        <div class="planner__body">
            <aside class="planner__sidebar">
                <h3 class="sidebar-title">Holes</h3>
                <nav bind="holeList" class="hole-list"></nav>
                <div bind="panel"></div>
            </aside>
            <section class="planner__main">
                <div bind="editorCanvas" class="editor-canvas"></div>
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

/**
 * Game-plan editor page (Phase 5). Route: /planner/:courseId?hole=N.
 * Clones the course-detail layout — header, hole-list sidebar (selection IS
 * the URL, ?hole=), map canvas — but hosts the single planner tool instead
 * of the builder toolbar (EditorCanvasComponent only spawns the toolbar on
 * /course routes). Loads course + holes, course features (rendered via the
 * shared FeaturesService overlay), furniture (tees/greens for the planning
 * nodes), clubs and the game plan; PlannerToolService drives the map.
 */
export class PlannerComponent extends Component {
    static styles = `
        .planner {
            display: flex;
            flex-direction: column;
            height: 100%;

            &[inert] { opacity: 0.6; }

            & .planner__header {
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

                & .planner__title {
                    font-size: 0.7rem;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                    padding: 2px ${s('sm')};
                    border-radius: ${t('radius-pill')};
                    background: rgba(47, 125, 79, 0.12);
                    color: ${t('primary')};
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

            & .planner__body {
                display: grid;
                grid-template-columns: 300px 1fr;
                flex: 1;
                min-height: 0;
            }

            & .planner__sidebar {
                display: flex;
                flex-direction: column;
                min-height: 0;
                overflow-y: auto;
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
                flex-shrink: 0;
                max-height: 30%;
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
                padding: ${s('xs')} ${s('md')};
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

            & .planner__main {
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
    private features = this.inject(FeaturesService);
    private furniture = this.inject(FurnitureService);
    private mapSvc = this.inject(MapService);
    private plan = this.inject(PlanService);
    private clubs = this.inject(ClubsService);
    private tool = this.inject(PlannerToolService);
    private router = this.inject(Router);
    private params = this.router.params<{ courseId: string }>('/planner/:courseId');
    private selectedHole = this.router.query('hole');

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            root: { inert: () => this.svc.loading.get() },
            back: { onclick: () => this.router.navigate(`/course/${this.params.peek().courseId}`) },
            name: () => this.svc.course.get()?.name ?? '',
            error: { className: () => this.svc.error.get() || this.plan.error.get() ? 'error show' : 'error' },
            errorText: () => this.svc.error.get()?.message ?? this.plan.error.get()?.message ?? '',
            retry: {
                onclick: () => {
                    const { courseId } = this.params.peek();
                    void this.svc.load(courseId);
                    void this.plan.load(courseId);
                },
            },
        });

        this.$each(this.ref(frag, 'holeList'), this.svc.holes, (hole, _i, track) => {
            const live = this.svc.holeStore.item(hole.id);
            const rowEl = this.wireEl(holeTpl, {
                row: {
                    onclick: () => this.router.navigate(`/planner/${hole.courseId}`, {
                        query: { hole: String(hole.number) },
                    }),
                    className: () => this.selectedHole.get() === String(hole.number)
                        ? 'hole-row active' : 'hole-row',
                },
                number: () => `Hole ${live.get().number}`,
                par: () => `Par ${live.get().par}`,
            }, track);
            // E2E hook (inert in prod): per-hole selector by hole number.
            rowEl.dataset.testid = 'planner-hole-row';
            rowEl.dataset.holeNumber = String(hole.number);
            return rowEl;
        }, hole => hole.id);

        this.spawn(EditorCanvasComponent, this.ref(frag, 'editorCanvas'));
        this.spawn(PlannerPanelComponent, this.ref(frag, 'panel'));
        return frag;
    }

    onMount(): void {
        // Course + holes, features, clubs and the plan tree — (re)loaded
        // whenever the courseId route param changes.
        this.track(effect(() => {
            const { courseId } = this.params.get();
            if (!courseId) return;
            untrack(() => {
                void this.svc.load(courseId);
                void this.features.load(courseId);
                void this.plan.load(courseId);
                void this.clubs.load();
            });
        }));

        // Furniture (tees/greens/aims) needs the hole ids — load once they
        // arrive (same pattern as the furniture tool's attach hook).
        this.track(effect(() => {
            const ids = this.svc.holes.get().map(h => h.id);
            if (ids.length === 0) return;
            untrack(() => {
                this.furniture.setHoleIds(ids);
                void this.furniture.load(this.params.peek().courseId, ids);
            });
        }));

        // Course features render through the shared persistent overlay
        // (attached BEFORE the tool starts so the plan draws on top).
        this.track(this.features.attachOverlay(this.mapSvc));

        // The planner's single tool owns the map for the page's lifetime.
        this.tool.start(d => this.track(d));
    }
}
