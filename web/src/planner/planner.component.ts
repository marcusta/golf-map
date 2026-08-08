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
import { HoleSidebarComponent } from '../course-detail/hole-sidebar.component';
import { HoleInfoPanelComponent } from '../course-detail/hole-info-panel.component';
import { ContextDockComponent } from '../draw/feature-dock.component';
import { CommandBarComponent } from '../app/command-bar.component';

const tpl = template(`
    <div class="planner" bind="root" data-testid="planner">
        <div bind="cmdbar"></div>
        <div class="planner__error" bind="error">
            <span bind="errorText"></span>
            <button bind="retry" type="button">Retry</button>
        </div>
        <div class="planner__body">
            <div bind="holeDock"></div>
            <section class="planner__main">
                <div bind="editorCanvas" class="editor-canvas"></div>
            </section>
            <div bind="planDock"></div>
        </div>
    </div>
`);

/**
 * Game-plan editor page (Phase 5). Route: /planner/:courseId?hole=N.
 * Shares the course-detail layout — command bar header, the collapsible
 * "Holes" dock (selection IS the URL, ?hole=; footer hosts the same hole
 * info panel as Create), map canvas, and the right contextual dock, which
 * here statically hosts the planner panel ("Plan"). The page hosts the
 * single planner tool instead of the builder toolbar (EditorCanvasComponent
 * only spawns the toolbar on /course routes). Loads course + holes, course
 * features (rendered via the shared FeaturesService overlay), furniture
 * (tees/greens for the planning nodes), clubs and the game plan;
 * PlannerToolService drives the map.
 */
export class PlannerComponent extends Component {
    static styles = `
        .planner {
            display: flex;
            flex-direction: column;
            height: 100%;

            &[inert] { opacity: 0.6; }

            /* Load/plan error strip — under the command bar (the page header). */
            & .planner__error {
                display: none;
                align-items: center;
                gap: ${s('sm')};
                flex-shrink: 0;
                padding: ${s('sm')} ${s('lg')};
                background: ${t('color-surface-card')};
                border-bottom: 1px solid ${t('color-border-default')};
                color: ${t('color-status-negative')};
                font-size: 0.875rem;
                &.show { display: flex; }
                & button { padding: ${s('xs')} ${s('sm')}; font-size: 0.75rem; ${btn()} }
            }

            /* Docks size to content (264/58px left, 268/40px right); the map
               column flexes to fill whatever is left. */
            & .planner__body {
                display: grid;
                grid-template-columns: auto 1fr auto;
                /* Cap the single row to the body height so the dock scrolls
                   INSIDE its column instead of stretching the row (and the
                   map) past the viewport. */
                grid-template-rows: minmax(0, 1fr);
                flex: 1;
                min-height: 0;
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

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            root: { inert: () => this.svc.loading.get() },
            error: { className: () => this.svc.error.get() || this.plan.error.get() ? 'planner__error show' : 'planner__error' },
            errorText: () => this.svc.error.get()?.message ?? this.plan.error.get()?.message ?? '',
            retry: {
                onclick: () => {
                    const { courseId } = this.params.peek();
                    void this.svc.load(courseId);
                    void this.plan.load(courseId);
                },
            },
        });

        // The unified command bar is the page header (Plan mode).
        this.spawn(CommandBarComponent, this.ref(frag, 'cmdbar'), { mode: 'plan' });

        // Left "Holes" dock — shared collapsible sidebar; its footer hosts the
        // same hole info panel as Create (the hole sidebar is identical in
        // all modes).
        this.spawn(HoleSidebarComponent, this.ref(frag, 'holeDock'), {
            routeBase: '/planner',
            footer: HoleInfoPanelComponent,
        });

        this.spawn(EditorCanvasComponent, this.ref(frag, 'editorCanvas'));

        // Right contextual dock — statically hosts the planner panel (Plan
        // has no sub-mode concept; collapse state shared with Create's dock).
        this.spawn(ContextDockComponent, this.ref(frag, 'planDock'), {
            content: { label: 'Plan', panel: PlannerPanelComponent },
        });

        return frag;
    }

    onMount(): void {
        // Course + holes, features, clubs and the plan tree — (re)loaded
        // whenever the courseId route param changes.
        //
        // The plan tree is force-loaded: it is the one store the iOS app also
        // writes to, and `PlanService`'s per-course cache would otherwise serve
        // whatever this tab last saw — so re-entering the planner showed a
        // stale tree until a hard page reload.
        this.track(effect(() => {
            const { courseId } = this.params.get();
            if (!courseId) return;
            untrack(() => {
                void this.svc.load(courseId);
                void this.features.load(courseId);
                void this.plan.load(courseId, true);
                void this.clubs.load();
            });
        }));

        // Same reason, for a tab left open while the plan was edited on the
        // phone: refetch when the window regains focus.
        // A refetch replaces the stores wholesale, so skip it while a local
        // save is in flight — that response reconciles the tree by itself.
        const onFocus = () => {
            if (this.plan.saving.peek()) return;
            void this.plan.reload();
        };
        window.addEventListener('focus', onFocus);
        this.track(() => window.removeEventListener('focus', onFocus));

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
