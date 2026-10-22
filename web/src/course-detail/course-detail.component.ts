import { Component, Router, template, effect } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn } from '../css';
import { CourseDetailService } from './course-detail.service';
import { EditorCanvasComponent } from '../map/editor-canvas.component';
import { SvgImportPanelComponent } from '../import/svg-import-panel.component';
import { GeojsonImportPanelComponent } from '../import/geojson-import-panel.component';
import { GsproExportPanelComponent } from '../export/gspro-export-panel.component';
import { ZoneTypesPanelComponent } from '../zones/zone-types-panel.component';
import { VegetationRulesPanelComponent } from '../zones/vegetation-rules-panel.component';
import { PhotoStemsPanelComponent } from '../zones/photo-stems-panel.component';
import { HoleAssignmentPanelComponent } from '../draw/hole-assignment-panel.component';
import { TeeLengthsPanelComponent } from '../furniture/tee-lengths-panel.component';
import { SvgCheckPanelComponent } from '../draw/svg-check-panel.component';
import { HoleInfoPanelComponent } from './hole-info-panel.component';
import { HoleSidebarComponent } from './hole-sidebar.component';
import { ContextDockComponent } from '../draw/feature-dock.component';
import { CommandBarComponent } from '../app/command-bar.component';
import { PhotoBrowserComponent } from '../photos/photo-browser.component';

const tpl = template(`
    <div class="course-detail" bind="root" data-testid="course-detail">
        <div bind="cmdbar"></div>
        <div class="course-detail__error" bind="error">
            <span bind="errorText"></span>
            <button bind="retry" type="button">Retry</button>
        </div>
        <div class="course-detail__body">
            <div bind="holeDock"></div>
            <section class="course-detail__main">
                <div id="editor-canvas" bind="editorCanvas" class="editor-canvas"></div>
            </section>
            <div bind="featureDock"></div>
        </div>
    </div>
`);

export class CourseDetailComponent extends Component {
    static styles = `
        .course-detail {
            display: flex;
            flex-direction: column;
            height: 100%;

            &[inert] { opacity: 0.6; }

            /* Load/publish error strip — sits under the command bar (which is
               now the header), shown only on error so the retry stays reachable. */
            & .course-detail__error {
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
            & .course-detail__body {
                display: grid;
                grid-template-columns: auto 1fr auto;
                /* Cap the single row to the body height so the docks scroll
                   INSIDE their columns instead of stretching the row (and the
                   map) past the viewport. */
                grid-template-rows: minmax(0, 1fr);
                flex: 1;
                min-height: 0;
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
    private router = this.inject(Router);
    private params = this.router.params<{ courseId: string }>('/course/:courseId');

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            root: { inert: () => this.svc.loading.get() },
            error: { className: () => this.svc.error.get() || this.svc.publishError.get() ? 'course-detail__error show' : 'course-detail__error' },
            errorText: () => this.svc.error.get()?.message ?? (this.svc.publishError.get() ? `Publish failed — ${this.svc.publishError.get()?.message}` : ''),
            retry: { onclick: () => this.svc.load(this.params.get().courseId) },
        });

        // The unified command bar is the page header (Create mode).
        this.spawn(CommandBarComponent, this.ref(frag, 'cmdbar'), { mode: 'create' });

        // Load (or reload) whenever the courseId route param changes.
        this.track(effect(() => {
            const { courseId } = this.params.get();
            if (courseId) void this.svc.load(courseId);
        }));

        // Left "Holes" dock — shared collapsible sidebar; its footer hosts the
        // hole info panel (shows itself whenever a hole is selected via ?hole=).
        this.spawn(HoleSidebarComponent, this.ref(frag, 'holeDock'), {
            routeBase: '/course',
            footer: HoleInfoPanelComponent,
        });

        this.spawn(EditorCanvasComponent, this.ref(frag, 'editorCanvas'));
        // SVG import wizard — hidden until the command bar's ⋯ menu opens it;
        // shares the editor-canvas positioning context so it docks over
        // the map's right edge (the map stays visible for the preview).
        this.spawn(SvgImportPanelComponent, this.ref(frag, 'editorCanvas'));
        // GeoJSON draft-import wizard (pipeline fetch-water / fetch-osm /
        // detect-trees output) — same dock-over-the-map behavior.
        this.spawn(GeojsonImportPanelComponent, this.ref(frag, 'editorCanvas'));
        // GSPro/OPCD export — the outbound counterpart to the importers,
        // opened from the same ⋯ menu: a dialog over the page, and its SVG
        // test-variant panel docked the same way as the importers.
        this.spawn(GsproExportPanelComponent, this.ref(frag, 'editorCanvas'));
        // The course's vegetation zone-type table — same ⋯ menu, same dock.
        this.spawn(ZoneTypesPanelComponent, this.ref(frag, 'editorCanvas'));
        // The planting rules (read-only), opened from the same picker.
        this.spawn(VegetationRulesPanelComponent, this.ref(frag, 'editorCanvas'));
        // Trees in photo (young trees the lidar missed, rings on the map), opened from the same picker.
        this.spawn(PhotoStemsPanelComponent, this.ref(frag, 'editorCanvas'));
        // Assign to holes (shapes in Others onto their holes), opened from the Draw stack panel.
        this.spawn(HoleAssignmentPanelComponent, this.ref(frag, 'editorCanvas'));
        // Scorecard and Place tees (the club's lengths, the tees from them), opened from Furniture › Tee sets.
        this.spawn(TeeLengthsPanelComponent, this.ref(frag, 'editorCanvas'));
        // Check shapes (the SVG export's checks, findings on the map), from the stack panel or an export error.
        this.spawn(SvgCheckPanelComponent, this.ref(frag, 'editorCanvas'));
        // Photos sub-mode surfaces over the map (catalog, photo card, viewer);
        // each shows only while the Photos tool is active.
        this.spawn(PhotoBrowserComponent, this.ref(frag, 'editorCanvas'));

        // Right contextual dock — permanent across all Create sub-modes; its
        // body follows the active sub-mode (draw selection + stack, or the
        // active tool's own panel).
        this.spawn(ContextDockComponent, this.ref(frag, 'featureDock'));

        return frag;
    }
}
