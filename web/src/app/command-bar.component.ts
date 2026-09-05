import { Component, Computed, Router, template, effect, untrack } from '@basics/core/client/core';
import { AuthService } from '@basics/core/client/auth';
// Only the literal `href` needs the deploy prefix — router.navigate() adds it.
import { BASE_PATH } from '@basics/core/client/base';
import { t } from '../theme';
import { s, statusTag, iconBtn, input, metric, panelTitle, selectedRow } from '../css';
import { icon } from '../ui/icons';
import { PopoverComponent, type PopoverContent } from '../ui/popover.component';
import { CourseDetailService } from '../course-detail/course-detail.service';
import { ConfirmService } from './confirm-dialog.component';
import { FeaturesService } from '../draw/features.service';
import { HelpModalService } from '../editor/help-modal.component';
import { DrawToolService, DRAW_TOOL_ID } from '../draw/draw-tool.service';
import { drawTool } from '../draw/draw-tool';
import { FEATURE_TYPES, FEATURE_STYLES, digitForFeatureType, type FeatureType } from '../draw/feature-palette';
import { EditorModeService } from '../editor/editor-mode.service';
import { ServerModeService, visibleEditorTools } from './server-mode.service';
import { SvgImportService, boundsFromGeoreference } from '../import/svg-import.service';
import { GeojsonImportService } from '../import/geojson-import.service';
import { MapBuildClientService, formatBytes } from '../map-build/map-build.service';
import { PublishClientService, PUBLISH_STEP_LABELS, type PublishState } from './publish-client.service';

type CommandBarMode = 'create' | 'plan';

const tpl = template(`
    <header class="cmdbar" bind="root">
        <span class="cmdbar__identity">
            <span class="cmdbar__glyph">${icon('flag', 16)}</span>
            <a bind="courses" class="cmdbar__courses" href="${BASE_PATH}/">&#8249; Courses</a>
            <span bind="name" class="cmdbar__name" data-testid="course-name"></span>
            <span bind="status" class="cmdbar__pill"></span>
            <span bind="odbl" class="cmdbar__pill odbl" data-testid="course-odbl-pill"></span>
            <span bind="infoHost" class="cmdbar__slot"></span>
        </span>
        <span class="cmdbar__divider"></span>
        <div bind="modesHost" class="cmdbar__modes"></div>
        <span bind="zone3Divider" class="cmdbar__divider"></span>
        <div bind="zone3Host" class="cmdbar__zone3"></div>
        <div class="cmdbar__right">
            <span bind="actionsHost" class="cmdbar__slot"></span>
            <span class="cmdbar__divider cmdbar__divider--sm"></span>
            <span bind="avatarHost" class="cmdbar__slot"></span>
        </div>
    </header>
`);

type ModeMeta = {
    id: CommandBarMode | 'play' | 'review';
    label: string;
    dot: string;
    hint: string;
    enabled: boolean;
    nav?: '/course' | '/planner';
    testid?: string;
};

/** Zone-2 modes: Create/Plan navigate; Play/Review are mobile-app only. */
const MODES: ModeMeta[] = [
    { id: 'create', label: 'Create', dot: t('color-accent-primary'), hint: 'Draw & edit the course map', enabled: true, nav: '/course' },
    { id: 'plan', label: 'Plan', dot: t('color-status-info'), hint: 'Strategy, aim & gates', enabled: true, nav: '/planner', testid: 'course-plan-btn' },
    { id: 'play', label: 'Play', dot: t('color-status-positive'), hint: 'Mobile app', enabled: false },
    { id: 'review', label: 'Review', dot: t('color-accent-secondary'), hint: 'Mobile app', enabled: false },
];

const zone3Tpl = template(`
    <span bind="subHost" class="cmdbar__slot"></span>
    <span bind="featWrap" class="cmdbar__feat-wrap">
        <span bind="featHost" class="cmdbar__slot"></span>
        <span bind="drawTarget" class="cmdbar__target" data-testid="draw-target"></span>
        <button bind="newPoly" type="button" class="cmdbar__new"></button>
        <button bind="boxSelect" type="button" class="cmdbar__box"></button>
        <span class="cmdbar__divider cmdbar__divider--sm"></span>
        <button bind="undoBtn" type="button" class="cmdbar__hist" aria-label="Undo">${icon('undo', 16)}</button>
        <button bind="redoBtn" type="button" class="cmdbar__hist" aria-label="Redo">${icon('redo', 16)}</button>
    </span>
    <button bind="helpBtn" type="button" class="cmdbar__help" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">${icon('circle-help', 16)}</button>
`);

/**
 * The unified command bar (Builder redesign v2) — one 58px header shared by
 * /course (mode 'create') and /planner (mode 'plan'), replacing both the app
 * topbar and each page's old per-page header on those routes.
 *
 * Zones (see docs/ui-design "UNIFIED COMMAND BAR"):
 *   1 identity — app glyph, ‹ Courses, course name, status pill, (i) info popover
 *   2 modes    — Create · Plan · Play · Review segmented (Play/Review disabled)
 *   3 context  — Create only: sub-mode dropdown + feature-type dropdown + New/Box
 *   4 right    — ⋯ actions menu (Import SVG / Publish) + avatar menu
 *
 * Sub-mode selection lives in the shared EditorModeService (the toolbar keeps
 * hosting each tool's floating panel); the feature-type / New / Box controls
 * drive the same DrawToolService/DrawState the draw panel used to own.
 */
export class CommandBarComponent extends Component<{ mode: CommandBarMode }> {
    static styles = `
        .cmdbar {
            display: flex;
            align-items: center;
            gap: ${s('sm')};
            height: 58px;
            flex: none;
            padding: 0 ${s('md')};
            background: ${t('color-surface-card')};
            border-bottom: 1px solid ${t('color-border-default')};
            position: relative;
            z-index: 40;
            font-size: 0.85rem;
            color: ${t('color-text-primary')};

            & .cmdbar__slot { display: inline-flex; align-items: center; }

            & .cmdbar__identity {
                display: flex;
                align-items: center;
                gap: ${s('sm')};
                min-width: 0;
            }

            & .cmdbar__glyph {
                width: 26px;
                height: 26px;
                flex: none;
                border-radius: 7px;
                background: ${t('color-surface-brand')};
                color: ${t('overlay-text')};
                display: flex;
                align-items: center;
                justify-content: center;
            }

            & .cmdbar__courses {
                font-size: 0.82rem;
                color: ${t('color-text-secondary')};
                text-decoration: none;
                white-space: nowrap;
                cursor: pointer;
                &:hover { color: ${t('color-text-primary')}; }
            }

            & .cmdbar__name {
                font-weight: 700;
                font-size: 0.95rem;
                color: ${t('color-text-primary')};
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                max-width: 220px;
            }

            /* Status pill: quiet tinted tag; variants pick the colour. */
            & .cmdbar__pill {
                &:empty { display: none; }
                &.published { ${statusTag(t('color-status-positive'))} }
                &.draft { ${statusTag('var(--data-risk)')} }
                /* T49: course contains OSM-derived (ODbL) map data. */
                &.odbl { ${statusTag(t('color-status-info'))} text-transform: none; }
            }

            & .cmdbar__divider {
                width: 1px;
                height: 26px;
                flex: none;
                background: ${t('color-border-default')};
            }
            & .cmdbar__divider--sm { height: 22px; }

            /* Zone 2: mode toggle — a compact dropdown chip (guide §06). */
            & .cmdbar__modes { display: inline-flex; align-items: center; }

            & .cmdbar__zone3 {
                display: flex;
                align-items: center;
                gap: ${s('sm')};
            }
            & .cmdbar__feat-wrap {
                display: none;
                align-items: center;
                gap: ${s('sm')};
                &.show { display: flex; }
            }

            /* Dropdown chip trigger (guide §06): swatch/icon + label + chevron. */
            & .cmdbar__chip {
                display: flex;
                align-items: center;
                gap: ${s('sm')};
                background: ${t('color-surface-raised')};
                border: 1px solid ${t('color-border-default')};
                border-radius: 9px;
                padding: 6px 10px;
                font-size: 0.82rem;
                font-weight: 600;
                color: ${t('color-text-primary')};
                cursor: pointer;
                white-space: nowrap;
                transition: border-color var(--dur-fast) var(--ease-standard);
                &:hover { border-color: ${t('color-border-strong')}; }
                &[aria-expanded="true"] { border-color: ${t('color-border-focus')}; }
                & .cmdbar__chip-icon { display: flex; align-items: center; color: ${t('color-accent-primary')}; }
                & .cmdbar__chip-chev { display: flex; align-items: center; color: ${t('color-text-tertiary')}; }
                & .cmdbar__chip-sw { width: 16px; height: 16px; flex: none; border-radius: 4px; }
                & .cmdbar__chip-dot { width: 8px; height: 8px; flex: none; border-radius: 999px; }
            }

            /* Read-only draw-target chip: quiet surface, no hover/press —
               shows where new shapes land ("→ Hole 1"). */
            & .cmdbar__target {
                display: inline-flex;
                align-items: center;
                max-width: 160px;
                padding: 6px 10px;
                border: 1px solid ${t('color-border-subtle')};
                border-radius: 9px;
                background: ${t('color-surface-sunken')};
                font-size: 0.8rem;
                color: ${t('color-text-secondary')};
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            /* Undo/redo history buttons — ghost icon buttons that dim when
               there's nothing to undo/redo (same reactive state the draw
               palette's Edit head had). */
            & .cmdbar__hist {
                ${iconBtn()}
                &:disabled {
                    opacity: 0.35;
                    cursor: default;
                    &:hover { border-color: ${t('color-border-default')}; color: ${t('color-text-secondary')}; background: ${t('color-surface-raised')}; }
                }
            }

            /* (?) round help button — opens the contextual shortcuts modal. */
            & .cmdbar__help {
                width: 24px;
                height: 24px;
                flex: none;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                padding: 0;
                border: none;
                border-radius: 999px;
                background: transparent;
                color: ${t('color-text-tertiary')};
                cursor: pointer;
                transition: color var(--dur-fast) var(--ease-standard),
                    background var(--dur-fast) var(--ease-standard);
                &:hover { background: ${t('color-surface-sunken')}; color: ${t('color-text-primary')}; }
            }

            /* New-polygon is a TOGGLE (draw ⇄ select), so it must read as
               off/on rather than being permanently accent-filled: ghost when
               idle, accent-filled + rotated-to-× icon while drawing is armed. */
            & .cmdbar__new { ${iconBtn()} }
            & .cmdbar__new .cmdbar__new-icon {
                display: inline-flex;
                transition: transform var(--dur-fast) var(--ease-standard);
            }
            & .cmdbar__new[aria-pressed="true"] {
                border-color: transparent;
                background: ${t('color-accent-primary')};
                color: ${t('color-on-accent')};
                box-shadow: 0 6px 14px -6px color-mix(in srgb, ${t('color-accent-primary')} 60%, transparent);
                &:hover { background: ${t('color-accent-hover')}; color: ${t('color-on-accent')}; }
                & .cmdbar__new-icon { transform: rotate(45deg); }
            }
            & .cmdbar__box { ${iconBtn()} }

            /* (i) round info button. */
            & .cmdbar__info-btn {
                width: 24px;
                height: 24px;
                border-radius: 999px;
                border: 1.5px solid ${t('color-border-strong')};
                background: transparent;
                color: ${t('color-text-tertiary')};
                font-style: italic;
                font-weight: 600;
                font-size: 0.72rem;
                cursor: pointer;
                transition: border-color var(--dur-fast) var(--ease-standard),
                    color var(--dur-fast) var(--ease-standard);
                &:hover, &[aria-expanded="true"] {
                    border-color: ${t('color-accent-primary')};
                    color: ${t('color-accent-primary')};
                }
            }

            & .cmdbar__right {
                margin-left: auto;
                display: flex;
                align-items: center;
                gap: ${s('sm')};
            }
            & .cmdbar__actions-btn { ${iconBtn()} }
            & .cmdbar__avatar {
                width: 30px;
                height: 30px;
                border-radius: 999px;
                flex: none;
                background: ${t('color-accent-secondary')};
                color: ${t('overlay-text')};
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 0.75rem;
                font-weight: 700;
                cursor: pointer;
            }
        }

        /* ── popover panel content (global CSS — panels are spawned components) ── */

        .cmdbar__mode-panel { width: 244px; }
        /* Mode rows: a colour dot, a name + one-line hint stacked, check on
           the active mode. Disabled rows (Play/Review) dim. */
        .cmdbar__mode-panel .menu-item { align-items: flex-start; }
        .cmdbar__mode-panel .menu-item__label { display: flex; flex-direction: column; gap: 1px; }
        .cmdbar__mode-panel .cmd-mode__dot { width: 8px; height: 8px; border-radius: 999px; margin-top: 5px; }
        .cmdbar__mode-panel .cmd-mode__hint {
            font-size: 0.72rem;
            font-weight: 400;
            color: ${t('color-text-tertiary')};
        }
        .cmdbar__mode-panel .menu-item[disabled] .cmd-mode__dot { opacity: 0.5; }

        .cmdbar__info-panel { width: 232px; }
        .cmd-info {
            display: flex;
            flex-direction: column;
            gap: 10px;
            padding: 8px 10px;
        }
        .cmd-info__row { display: flex; justify-content: space-between; align-items: baseline; }
        .cmd-info__k { font-size: 0.75rem; color: ${t('color-text-tertiary')}; }
        .cmd-info__v { ${metric()} font-size: 0.8rem; color: ${t('color-text-primary')}; }
        .cmd-info__div { height: 1px; background: ${t('color-border-subtle')}; }
        .cmd-info__geo--warn {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .cmd-info__geo-row {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 0.78rem;
            color: ${t('color-status-caution')};
        }
        .cmd-info__geo-btn {
            border: none;
            border-radius: 8px;
            padding: 8px;
            background: color-mix(in srgb, ${t('color-status-caution')} 14%, transparent);
            color: ${t('color-text-accent')};
            font-family: inherit;
            font-size: 0.78rem;
            font-weight: 600;
            text-align: left;
            cursor: pointer;
            &:hover { background: color-mix(in srgb, ${t('color-status-caution')} 22%, transparent); }
        }
        .cmd-info__geo--ok {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 0.78rem;
            color: ${t('color-status-positive')};
        }

        .cmdbar__ft-panel { width: 336px; padding: 12px; }
        .cmdbar__ft-title { ${panelTitle()} margin: 2px 4px 10px; }
        .cmdbar__ft-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 3px 8px;
            max-height: 320px;
            overflow-y: auto;
        }
        /* One grid cell = a select button + an eye visibility toggle. */
        .cmd-ft-row {
            display: flex;
            align-items: center;
            gap: 2px;
            border-radius: 8px;
        }
        .cmd-ft {
            flex: 1;
            min-width: 0;
            display: flex;
            align-items: center;
            gap: ${s('sm')};
            padding: 7px 9px;
            border: none;
            border-radius: 8px;
            background: transparent;
            font-family: inherit;
            font-size: 0.8rem;
            color: ${t('color-text-primary')};
            cursor: pointer;
            text-align: left;
            white-space: nowrap;
            &:hover { background: color-mix(in srgb, ${t('color-text-primary')} 6%, transparent); }
            &[aria-selected="true"] {
                ${selectedRow()}
                & .cmd-ft__name { font-weight: 600; }
            }
            & .cmd-ft__sw {
                width: 15px;
                height: 15px;
                flex: none;
                border-radius: 4px;
                border: 1px solid rgba(0, 0, 0, 0.25);
            }
            & .cmd-ft__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
            /* Digit hotkey badge (1–9, 0) for the keyboard-armable types. */
            & .cmd-ft__digit {
                flex: none;
                min-width: 16px;
                padding: 1px 4px;
                border-radius: 4px;
                border: 1px solid ${t('color-border-subtle')};
                background: color-mix(in srgb, ${t('color-text-primary')} 5%, transparent);
                font-size: 0.7rem;
                font-variant-numeric: tabular-nums;
                text-align: center;
                color: ${t('color-text-secondary')};
            }
        }
        /* Per-type visibility toggle: appears on row hover (always when the
           type is hidden); a hidden type dims its select row. */
        .cmd-ft-eye {
            flex: none;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 26px;
            height: 26px;
            padding: 0;
            border: none;
            border-radius: 6px;
            background: transparent;
            color: ${t('color-text-tertiary')};
            cursor: pointer;
            opacity: 0;
            transition: opacity var(--dur-fast) var(--ease-standard),
                color var(--dur-fast) var(--ease-standard),
                background var(--dur-fast) var(--ease-standard);
            &:hover { background: color-mix(in srgb, ${t('color-text-primary')} 8%, transparent); color: ${t('color-text-primary')}; }
        }
        .cmd-ft-row:hover .cmd-ft-eye,
        .cmd-ft-row.is-hidden .cmd-ft-eye { opacity: 1; }
        .cmd-ft-row.is-hidden .cmd-ft { opacity: 0.45; }

        /* New-shape type policy footer: keep-last-used checkbox + (when off)
           the default-type picker new shapes reset to on arm. */
        .cmd-ft-policy {
            margin-top: 10px;
            padding: 10px 4px 2px;
            border-top: 1px solid ${t('color-border-subtle')};
            display: flex;
            flex-direction: column;
            gap: 8px;
            font-size: 0.8rem;
            color: ${t('color-text-primary')};

            & label {
                display: flex;
                align-items: center;
                gap: 8px;
                cursor: pointer;
                & input { accent-color: ${t('color-accent-primary')}; }
            }
            & .cmd-ft-policy__default {
                display: flex;
                align-items: center;
                gap: 8px;
                &.hide { display: none; }
                & span { color: ${t('color-text-secondary')}; }
                & select { ${input()} flex: 1; min-width: 0; }
            }
        }

        /* Accent (Publish) menu item — clay text + a small clay swatch. */
        .menu-item.cmd-menu-accent {
            color: ${t('color-text-accent')};
            font-weight: 600;
            & .cmd-menu-accent__sw {
                width: 8px;
                height: 8px;
                border-radius: 2px;
                background: ${t('color-accent-primary')};
            }
        }
    `;

    private svc = this.inject(CourseDetailService);
    private features = this.inject(FeaturesService);
    private tool = this.inject(DrawToolService);
    private mode = this.inject(EditorModeService);
    private importSvc = this.inject(SvgImportService);
    private geojsonImportSvc = this.inject(GeojsonImportService);
    private mapBuild = this.inject(MapBuildClientService);
    private publishVps = this.inject(PublishClientService);
    private confirm = this.inject(ConfirmService);
    private helpModal = this.inject(HelpModalService);
    private serverMode = this.inject(ServerModeService);
    private auth = this.inject(AuthService);
    private router = this.inject(Router);
    // courseId/hole live in the route (the same param on both host routes).
    private params = this.router.params<{ courseId: string }>('/:host/:courseId');
    private selectedHole = this.router.query('hole');

    /** Route ?hole → its feature id (null = course level / no hole). */
    private readonly activeHoleId = new Computed<string | null>(() => {
        const number = this.selectedHole.get();
        if (!number) return null;
        return this.svc.holes.get().find(h => String(h.number) === number)?.id ?? null;
    });

    render(): DocumentFragment {
        const isCreate = this.props.mode === 'create';

        const frag = this.wire(tpl, {
            courses: {
                onclick: (e: Event) => {
                    e.preventDefault();
                    this.router.navigate('/');
                },
            },
            name: () => this.svc.course.get()?.name ?? '',
            status: {
                textContent: () => this.svc.course.get()?.status ?? '',
                className: () => `cmdbar__pill ${this.svc.course.get()?.status ?? ''}`,
            },
            // ODbL posture pill (T49) — derived live from the loaded
            // features; :empty hides it on courses without OSM-derived data.
            odbl: {
                textContent: () => this.features.hasOdblFeatures.get() ? 'ODbL map data' : '',
                title: () => this.features.hasOdblFeatures.get()
                    ? 'Contains OpenStreetMap-derived features — map data licensed ODbL, © OpenStreetMap contributors'
                    : '',
            },
            zone3Divider: { style: () => (isCreate ? '' : 'display:none') },
        });

        this.buildModes(this.ref(frag, 'modesHost'));

        // (i) info popover.
        this.spawn(PopoverComponent, this.ref(frag, 'infoHost'), {
            ariaLabel: 'Course info',
            triggerClassName: 'cmdbar__info-btn',
            panelClassName: 'cmdbar__info-panel',
            trigger: 'i',
            panel: (host, ctx) => this.buildInfoPanel(host, ctx.track),
        });

        // Zone 3 (Create only).
        if (isCreate) {
            this.buildZone3(this.ref(frag, 'zone3Host'));

            // New polygons follow the active route/sidebar hole (moved here
            // from the old draw panel, which no longer exists). No second
            // creation selector: pick a hole in the left sidebar, then draw.
            this.track(effect(() => {
                const number = this.selectedHole.get();
                const holes = this.svc.holes.get();
                const activeHoleId = this.activeHoleId.get();
                untrack(() => {
                    if (!number) {
                        this.tool.drawHoleId.set(null);
                    } else if (activeHoleId) {
                        this.tool.drawHoleId.set(activeHoleId);
                    } else if (holes.length > 0) {
                        this.tool.drawHoleId.set(null);
                    }
                });
            }));
        }

        // Zone 4: actions + avatar. Every entry in the actions menu authors
        // something (imports, lidar cleanup, publish revision), so serve mode
        // gets no ⋯ trigger at all rather than an empty popover.
        if (this.serverMode.isBuilder()) {
            this.spawn(PopoverComponent, this.ref(frag, 'actionsHost'), {
                align: 'right',
                ariaLabel: 'Actions',
                triggerClassName: 'cmdbar__actions-btn',
                trigger: (host) => {
                    host.dataset.testid = 'actions-menu-trigger';
                    host.innerHTML = icon('more-horizontal', 20);
                },
                panel: (host, ctx) => this.buildActionsPanel(host, ctx.track, ctx.close),
            });
        }
        this.spawn(PopoverComponent, this.ref(frag, 'avatarHost'), {
            align: 'right',
            ariaLabel: 'Account',
            triggerClassName: 'cmdbar__avatar',
            trigger: (host, ctx) => {
                ctx.track(effect(() => { host.textContent = this.userInitial(); }));
            },
            panel: (host, ctx) => this.buildAvatarPanel(host, ctx.close),
        });

        return frag;
    }

    // ── Zone 2: mode toggle (dropdown) ────────────────────────────────────

    private buildModes(host: HTMLElement): void {
        const current = MODES.find(m => m.id === this.props.mode)!;
        this.spawn(PopoverComponent, host, {
            ariaLabel: 'Editor mode',
            triggerClassName: 'cmdbar__chip',
            panelClassName: 'cmdbar__mode-panel',
            trigger: (h) => {
                h.dataset.testid = 'mode-trigger';
                h.innerHTML = `<span class="cmdbar__chip-dot" style="background:${current.dot}"></span>`
                    + `<span>${current.label}</span>`
                    + `<span class="cmdbar__chip-chev">${icon('chevron-down', 16)}</span>`;
            },
            panel: (h, ctx) => this.buildModePanel(h, ctx.close),
        });
    }

    private buildModePanel(host: HTMLElement, close: () => void): void {
        const nav = (base: string) => {
            const { courseId } = this.params.peek();
            if (!courseId) return;
            const hole = this.selectedHole.peek();
            this.router.navigate(`${base}/${courseId}`, hole !== undefined ? { query: { hole } } : undefined);
        };
        for (const m of MODES) {
            const active = m.id === this.props.mode;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'menu-item';
            btn.setAttribute('role', 'menuitemradio');
            btn.setAttribute('aria-checked', String(active));
            if (m.testid) btn.dataset.testid = m.testid;
            btn.innerHTML = `<span class="menu-item__icon"><span class="cmd-mode__dot" style="background:${m.dot}"></span></span>`
                + `<span class="menu-item__label"><span>${m.label}</span><span class="cmd-mode__hint">${m.hint}</span></span>`
                + `<span class="menu-item__check">${icon('check', 16)}</span>`;
            if (!m.enabled || !m.nav) {
                btn.disabled = true;
            } else {
                btn.onclick = () => {
                    if (m.id !== this.props.mode) nav(m.nav!);
                    close();
                };
            }
            host.appendChild(btn);
        }
    }

    // ── Zone 3: contextual toolbar (Create) ───────────────────────────────

    private buildZone3(host: HTMLElement): void {
        const frag = this.wire(zone3Tpl, {
            featWrap: { className: () => (this.isDrawSubmode() ? 'cmdbar__feat-wrap show' : 'cmdbar__feat-wrap') },
            drawTarget: {
                textContent: () => `→ ${this.holeLabel(this.tool.drawHoleId.get())}`,
                title: 'New shapes are added to this hole / scope',
            },
            undoBtn: {
                onclick: () => this.tool.undo(),
                disabled: () => !this.tool.history.canUndo.get(),
                title: 'Undo (⌘Z / Ctrl+Z)',
            },
            redoBtn: {
                onclick: () => this.tool.redo(),
                disabled: () => !this.tool.history.canRedo.get(),
                title: 'Redo (⌘⇧Z / ⌘Y)',
            },
            helpBtn: { onclick: () => this.helpModal.show() },
            newPoly: {
                innerHTML: `<span class="cmdbar__new-icon">${icon('plus', 16)}</span>`,
                title: () => (this.tool.state.isDrawing.get()
                    ? 'Drawing — click to stop and return to Select (Esc)'
                    : 'New polygon (N)'),
                'aria-label': () => (this.tool.state.isDrawing.get() ? 'Stop drawing' : 'New polygon'),
                'aria-pressed': () => this.tool.state.isDrawing.get(),
                'data-testid': 'new-polygon-btn',
                onclick: () => {
                    if (this.tool.state.isDrawing.peek()) this.tool.state.disarm();
                    else this.tool.armDraw();
                },
            },
            boxSelect: {
                innerHTML: icon('box-select', 16),
                title: () => (this.tool.state.boxSelect.get() ? 'Box-select: on (B)' : 'Box-select (B)'),
                'aria-label': 'Box-select',
                'aria-pressed': () => this.tool.state.boxSelect.get(),
                'data-testid': 'box-select-btn',
                onclick: () => this.tool.state.toggleBoxSelect(),
            },
        });

        // Sub-mode dropdown.
        this.spawn(PopoverComponent, this.ref(frag, 'subHost'), {
            ariaLabel: 'Editor sub-mode',
            triggerClassName: 'cmdbar__chip',
            trigger: (h, ctx) => {
                h.dataset.testid = 'submode-trigger';
                h.innerHTML = `<span class="cmdbar__chip-icon" data-k="icon"></span><span data-k="label"></span><span class="cmdbar__chip-chev">${icon('chevron-down', 16)}</span>`;
                const iconEl = h.querySelector<HTMLElement>('[data-k="icon"]')!;
                const labelEl = h.querySelector<HTMLElement>('[data-k="label"]')!;
                ctx.track(effect(() => {
                    const active = this.mode.activeTool() ?? drawTool;
                    iconEl.innerHTML = icon(active.icon, 16);
                    labelEl.textContent = active.label;
                }));
            },
            panel: (h, ctx) => this.buildSubmodePanel(h, ctx.track, ctx.close),
        });

        // Feature-type dropdown.
        this.spawn(PopoverComponent, this.ref(frag, 'featHost'), {
            ariaLabel: 'Feature type',
            triggerClassName: 'cmdbar__chip',
            panelClassName: 'cmdbar__ft-panel',
            trigger: (h, ctx) => {
                h.dataset.testid = 'feature-type-trigger';
                h.innerHTML = `<span class="cmdbar__chip-sw" data-k="sw"></span><span data-k="name"></span><span class="cmdbar__chip-chev">${icon('chevron-down', 16)}</span>`;
                const swEl = h.querySelector<HTMLElement>('[data-k="sw"]')!;
                const nameEl = h.querySelector<HTMLElement>('[data-k="name"]')!;
                ctx.track(effect(() => {
                    const style = FEATURE_STYLES[this.triggerFeatureType()];
                    swEl.style.background = style.fill;
                    swEl.style.border = `1px solid ${style.outline}`;
                    nameEl.textContent = style.label;
                }));
            },
            panel: (h, ctx) => this.buildFeaturePanel(h, ctx.track, ctx.close),
        });

        host.appendChild(frag);
    }

    /** Human label for the draw target hole (null = course level). */
    private holeLabel(holeId: string | null): string {
        if (holeId === null) return 'Course level';
        const hole = this.svc.holes.get().find(h => h.id === holeId);
        return hole ? `Hole ${hole.number} (par ${hole.par})` : 'Selected hole';
    }

    /**
     * The draw tool is the active sub-mode (or none is armed yet → treat as
     * draw). Never in serve mode: the draw tool isn't registered there, so the
     * "nothing armed yet" fallback must not reveal the drawing controls.
     */
    private isDrawSubmode(): boolean {
        if (!this.serverMode.isBuilder()) return false;
        const active = this.mode.activeTool();
        return active ? active.id === DRAW_TOOL_ID : true;
    }

    /** Feature type shown on the dropdown trigger swatch (selected single → drawType). */
    private triggerFeatureType(): FeatureType {
        const multi = this.features.selectedIds.get().size > 1;
        const selected = this.features.selected.get();
        return !multi && selected ? (selected.type as FeatureType) : this.tool.drawType.get();
    }

    private buildSubmodePanel(host: HTMLElement, track: (d: () => void) => void, close: () => void): void {
        // Serve mode drops the map-editing tools (draw, furniture, SAM,
        // terrain edit, clean) — their APIs are not mounted on the VPS.
        const tools = visibleEditorTools(this.serverMode.mode.peek());
        for (const editorTool of [...tools].sort((a, b) => a.order - b.order)) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'menu-item';
            btn.setAttribute('role', 'menuitemradio');
            btn.dataset.testid = `tool-btn-${editorTool.id}`;
            btn.dataset.toolId = editorTool.id;
            btn.innerHTML = `<span class="menu-item__icon">${icon(editorTool.icon, 16)}</span>`
                + `<span class="menu-item__label">${editorTool.label}</span>`
                + `<span class="menu-item__check">${icon('check', 16)}</span>`;
            btn.onclick = () => {
                if (this.mode.activeToolId.peek() !== editorTool.id) this.mode.activate(editorTool);
                close();
            };
            track(effect(() => btn.setAttribute('aria-checked', String(this.mode.activeToolId.get() === editorTool.id))));
            host.appendChild(btn);
        }
    }

    private buildFeaturePanel(host: HTMLElement, track: (d: () => void) => void, close: () => void): void {
        host.innerHTML = `<div class="cmdbar__ft-title">Feature type</div><div class="cmdbar__ft-grid" data-k="grid"></div>`
            + `<div class="cmd-ft-policy">`
            + `<label><input type="checkbox" data-k="follow" data-testid="ft-follow-last"> New shapes keep the last-used type</label>`
            + `<div class="cmd-ft-policy__default" data-k="defaultRow"><span>Start new shapes as</span>`
            + `<select data-k="defaultSel" data-testid="ft-default-type" aria-label="Default type for new shapes"></select></div>`
            + `</div>`;
        const grid = host.querySelector<HTMLElement>('[data-k="grid"]')!;

        // New-shape type policy footer (persisted on DrawToolService).
        const follow = host.querySelector<HTMLInputElement>('[data-k="follow"]')!;
        const defaultRow = host.querySelector<HTMLElement>('[data-k="defaultRow"]')!;
        const defaultSel = host.querySelector<HTMLSelectElement>('[data-k="defaultSel"]')!;
        for (const type of FEATURE_TYPES) {
            const opt = document.createElement('option');
            opt.value = type;
            opt.textContent = FEATURE_STYLES[type].label;
            defaultSel.appendChild(opt);
        }
        follow.onchange = () => this.tool.setTypeFollowsLast(follow.checked);
        defaultSel.onchange = () => this.tool.setDefaultDrawType(defaultSel.value as FeatureType);
        track(effect(() => {
            follow.checked = this.tool.typeFollowsLast.get();
            defaultRow.classList.toggle('hide', this.tool.typeFollowsLast.get());
            defaultSel.value = this.tool.defaultDrawType.get();
        }));
        for (const type of FEATURE_TYPES) {
            const style = FEATURE_STYLES[type];
            const row = document.createElement('div');
            row.className = 'cmd-ft-row';

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'cmd-ft';
            btn.title = style.label;
            const digit = digitForFeatureType(type);
            const badge = digit ? `<span class="cmd-ft__digit" aria-hidden="true">${digit}</span>` : '';
            btn.innerHTML = `<span class="cmd-ft__sw"></span><span class="cmd-ft__name">${style.label}</span>${badge}`;
            const sw = btn.querySelector<HTMLElement>('.cmd-ft__sw')!;
            sw.style.background = style.fill;
            sw.style.borderColor = style.outline;
            // Armed → type for the next shape; else retype the selection or
            // set the draw type (DrawToolService.chooseType).
            btn.onclick = () => {
                this.tool.chooseType(type);
                close();
            };
            track(effect(() => {
                const drawing = this.tool.state.isDrawing.get();
                const multi = this.features.selectedIds.get().size > 1;
                const selected = this.features.selected.get();
                const current = drawing ? this.tool.drawType.get()
                    : multi ? null : selected ? selected.type : this.tool.drawType.get();
                btn.setAttribute('aria-selected', String(current === type));
            }));

            // Per-type visibility toggle (re-homed from the old draw panel's
            // type grid). stopPropagation so it never also selects the type;
            // hidden types render dimmed + eye-off.
            const eye = document.createElement('button');
            eye.type = 'button';
            eye.className = 'cmd-ft-eye';
            eye.onclick = (e) => {
                e.stopPropagation();
                this.features.toggleTypeVisibility(type);
            };
            track(effect(() => {
                const hidden = this.features.hiddenTypes.get().has(type);
                eye.innerHTML = icon(hidden ? 'eye-off' : 'eye', 16);
                eye.title = hidden ? `Show ${style.label}` : `Hide ${style.label}`;
                eye.setAttribute('aria-label', eye.title);
                eye.setAttribute('aria-pressed', String(hidden));
                row.classList.toggle('is-hidden', hidden);
            }));

            row.appendChild(btn);
            row.appendChild(eye);
            grid.appendChild(row);
        }
    }

    // ── Zone 1: (i) info popover ──────────────────────────────────────────

    private buildInfoPanel(host: HTMLElement, track: (d: () => void) => void): void {
        host.innerHTML = `
            <div class="cmd-info">
                <div class="cmd-info__row"><span class="cmd-info__k">Revision</span><span class="cmd-info__v" data-k="rev"></span></div>
                <div class="cmd-info__row"><span class="cmd-info__k">Holes</span><span class="cmd-info__v" data-k="holes"></span></div>
                <div class="cmd-info__row"><span class="cmd-info__k">Total par</span><span class="cmd-info__v" data-k="par"></span></div>
                <div class="cmd-info__div"></div>
                <div data-k="geo"></div>
            </div>`;
        const rev = host.querySelector<HTMLElement>('[data-k="rev"]')!;
        const holes = host.querySelector<HTMLElement>('[data-k="holes"]')!;
        const par = host.querySelector<HTMLElement>('[data-k="par"]')!;
        const geo = host.querySelector<HTMLElement>('[data-k="geo"]')!;

        track(effect(() => {
            const course = this.svc.course.get();
            rev.textContent = course ? `rev ${course.revision}` : '—';
        }));
        track(effect(() => { holes.textContent = String(this.svc.holes.get().length); }));
        track(effect(() => { par.textContent = String(this.svc.totalPar.get()); }));
        track(effect(() => {
            const course = this.svc.course.get();
            const georeferenced = !!course?.georeferenceJson;
            geo.textContent = '';
            if (georeferenced) {
                geo.className = 'cmd-info__geo--ok';
                geo.innerHTML = `${icon('check', 16)}<span>Georeferenced</span>`;
                return;
            }
            geo.className = 'cmd-info__geo--warn';
            geo.innerHTML = `<div class="cmd-info__geo-row">${icon('triangle-alert', 16)}<span>No georeference</span></div>`;
            // Setting the georeference means running the map-build wizard —
            // builder only. Serve mode states the fact without the dead end.
            if (!this.serverMode.isBuilder()) return;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'cmd-info__geo-btn';
            btn.textContent = 'Set georeference';
            btn.onclick = () => {
                const { courseId } = this.params.peek();
                if (courseId) this.router.navigate(`/set-area/${courseId}`);
            };
            geo.appendChild(btn);
        }));
    }

    // ── Zone 4: actions + avatar ──────────────────────────────────────────

    private buildActionsPanel(host: HTMLElement, track: (d: () => void) => void, close: () => void): void {
        // Import SVG — Create only (matches today's availability), and builder
        // only: both importers author geometry, and the lidar entry below calls
        // a builder-only API that 404s on the VPS.
        if (this.props.mode === 'create' && this.serverMode.isBuilder()) {
            const importBtn = document.createElement('button');
            importBtn.type = 'button';
            importBtn.className = 'menu-item';
            importBtn.dataset.testid = 'course-import-svg-btn';
            importBtn.innerHTML = `<span class="menu-item__icon">${icon('upload', 16)}</span><span class="menu-item__label">Import SVG</span>`;
            importBtn.onclick = () => {
                const course = this.svc.course.peek();
                if (course) this.importSvc.openFor(course.id, boundsFromGeoreference(course.georeferenceJson));
                close();
            };
            host.appendChild(importBtn);

            // Import GeoJSON — the draft-import wizard for pipeline output
            // (fetch-water / fetch-osm / detect-trees), EPSG:3006 only.
            const geojsonBtn = document.createElement('button');
            geojsonBtn.type = 'button';
            geojsonBtn.className = 'menu-item';
            geojsonBtn.dataset.testid = 'course-import-geojson-btn';
            geojsonBtn.innerHTML = `<span class="menu-item__icon">${icon('upload', 16)}</span><span class="menu-item__label">Import GeoJSON</span>`;
            geojsonBtn.onclick = () => {
                const course = this.svc.course.peek();
                if (course) this.geojsonImportSvc.openFor(course.id);
                close();
            };
            host.appendChild(geojsonBtn);

            // Delete lidar files — the .laz sources kept after a map build are
            // multi-use (detect-trees/water) but large; this frees them per
            // course on explicit action. Shown only when files exist; the label
            // names the reclaimable size, and the delete is confirmed first.
            this.mountDeleteLidar(host, close);

            const divider = document.createElement('div');
            divider.className = 'menu-divider';
            host.appendChild(divider);
        }

        // Publish revision — same ConfirmService + publish flow as the old
        // header. Builder only: the courses API is mounted in serve mode, so
        // this button really would bump the revision on the VPS — but a
        // revision is an AUTHORING act (it tells devices to re-sync), and on a
        // serve box the authored truth arrives by publish/ingest from the
        // builder. Bumping it here would desync the two.
        if (!this.serverMode.isBuilder()) return;
        const publishBtn = document.createElement('button');
        publishBtn.type = 'button';
        publishBtn.className = 'menu-item cmd-menu-accent';
        publishBtn.innerHTML = `<span class="menu-item__icon cmd-menu-accent__sw"></span><span class="menu-item__label">Publish revision</span>`;
        publishBtn.onclick = async () => {
            const course = this.svc.course.peek();
            close();
            if (!course) return;
            // T49: ODbL is surfaced, never a publish blocker — a course with
            // any OSM-derived feature publishes its map data under ODbL.
            const odbl = this.features.hasOdblFeatures.peek();
            const ok = await this.confirm.confirm({
                title: `Publish ${course.name}?`,
                body: `Publishing bumps revision ${course.revision} to ${course.revision + 1} for device sync.`,
                detail: 'Players already on the course keep their current local copy until they refresh.'
                    + (odbl ? ' This course contains OpenStreetMap-derived features, so its map data is published under the ODbL license with "© OpenStreetMap contributors" attribution.' : ''),
                confirmLabel: 'Publish course',
                cancelLabel: 'Keep editing',
                tone: 'primary',
                layout: 'review',
            });
            if (ok) void this.svc.publish();
        };
        track(effect(() => {
            const disabled = this.svc.publishing.get() || !this.svc.course.get();
            publishBtn.disabled = disabled;
        }));
        host.appendChild(publishBtn);

        // Publish to VPS — ships the site's built bundle to the serve box
        // (tiles, content, analysis DEM), so the phone can download the
        // course. The UI face of `bun run publish` (T59); builder only, same
        // guard as Publish revision above.
        this.mountPublishToVps(host, track, close);
    }

    /**
     * "Publish to VPS" actions-menu row. Label reflects the live run state
     * (step while running); clicking when unconfigured explains the env setup
     * instead of failing. Result (success/failure + warnings) is reported via
     * ConfirmService once the run reaches a terminal state — the menu itself
     * is long closed by then.
     */
    private mountPublishToVps(host: HTMLElement, track: (d: () => void) => void, close: () => void): void {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'menu-item';
        btn.dataset.testid = 'course-publish-vps-btn';
        host.appendChild(btn);

        // Preseed configured/running state on menu open (cheap GET).
        void this.publishVps.refresh();

        track(effect(() => {
            const state = this.publishVps.state.get();
            const running = state?.status === 'running';
            const label = running
                ? `Publishing to VPS — ${state?.step ? PUBLISH_STEP_LABELS[state.step] : 'finishing'}…`
                : 'Publish to VPS';
            btn.innerHTML = `<span class="menu-item__icon">${icon(running ? 'loader-circle' : 'arrow-up-to-line', 16)}</span>`
                + `<span class="menu-item__label">${label}</span>`;
            btn.disabled = running;
        }));

        btn.onclick = async () => {
            const course = this.svc.course.peek();
            close();
            if (!course) return;

            const state = this.publishVps.state.peek() ?? await this.publishVps.refresh();
            if (state && !state.configured) {
                await this.confirm.confirm({
                    title: 'Publishing is not configured',
                    body: 'This builder has no publish target.',
                    detail: 'Set PUBLISH_URL and PUBLISH_TOKEN in the server environment and restart it. See docs/reference/vps-serve-runbook.md.',
                    confirmLabel: 'OK',
                    tone: 'primary',
                });
                return;
            }

            const target = state?.targetUrl ? ` to ${state.targetUrl}` : ' to the VPS';
            const ok = await this.confirm.confirm({
                title: `Publish ${course.name}${target}?`,
                body: 'This uploads the built course bundle (map tiles, holes and features, analysis DEM) and swaps it in atomically on the serve box.',
                detail: 'User data on the VPS (rounds, plans, calibration, pins) is never touched. Devices download the update from the course list.',
                confirmLabel: 'Publish to VPS',
                cancelLabel: 'Not now',
                tone: 'primary',
                layout: 'review',
            });
            if (!ok) return;

            let result: PublishState;
            try {
                result = await this.publishVps.run(course.id);
            } catch (err) {
                await this.confirm.confirm({
                    title: 'Publish failed to start',
                    body: err instanceof Error ? err.message : String(err),
                    confirmLabel: 'OK',
                    tone: 'danger',
                });
                return;
            }
            const warnings = result.warnings.length
                ? ` Warnings: ${result.warnings.join(' — ')}`
                : '';
            if (result.status === 'succeeded') {
                const size = result.bundleBytes !== null ? formatBytes(result.bundleBytes) : 'unknown size';
                await this.confirm.confirm({
                    title: 'Published to VPS',
                    body: `${course.name} is live (bundle ${size}).`,
                    detail: `Open the course list on your phone and download (or re-download) the course.${warnings}`,
                    confirmLabel: 'Done',
                    tone: 'primary',
                });
            } else {
                await this.confirm.confirm({
                    title: 'Publish failed',
                    body: result.error ?? 'Unknown error — check the server log.',
                    detail: warnings || undefined,
                    confirmLabel: 'OK',
                    tone: 'danger',
                });
            }
        };
    }

    /**
     * "Delete lidar files (X.X GB)" — appended into the actions menu only when
     * the course has persisted .laz sources. Fetches lidar info on menu open;
     * the button lands hidden and reveals itself (or removes itself) once the
     * size is known, so it never flashes an empty/loading state.
     */
    private mountDeleteLidar(host: HTMLElement, close: () => void): void {
        const course = this.svc.course.peek();
        if (!course) return;
        const courseId = course.id;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'menu-item';
        btn.dataset.testid = 'course-delete-lidar-btn';
        btn.style.display = 'none';
        host.appendChild(btn);

        void this.mapBuild.lidarInfo(courseId).then((info) => {
            if (info.files.length === 0) {
                btn.remove();
                return;
            }
            const size = formatBytes(info.totalBytes);
            btn.innerHTML = `<span class="menu-item__icon">${icon('trash-2', 16)}</span>`
                + `<span class="menu-item__label">Delete lidar files (${size})</span>`;
            btn.style.display = '';
            btn.onclick = () => {
                close();
                void this.confirmDeleteLidar(courseId, info.files.length, size);
            };
        }).catch(() => {
            btn.remove(); // info fetch failed — leave the menu unchanged
        });
    }

    /** Confirm, delete, then report the result as a notice (house ConfirmService). */
    private async confirmDeleteLidar(courseId: string, fileCount: number, size: string): Promise<void> {
        const ok = await this.confirm.confirm({
            title: 'Delete lidar files?',
            body: `This permanently removes the ${fileCount} downloaded lidar (.laz) file${fileCount === 1 ? '' : 's'} for this course, freeing ${size}.`,
            detail: 'The built map (terrain, hillshade, DEM) is unaffected. Re-fetching the lidar means rebuilding the map from Lantmäteriet.',
            confirmLabel: 'Delete lidar files',
            cancelLabel: 'Keep files',
            tone: 'danger',
        });
        if (!ok) return;
        try {
            const { freedBytes } = await this.mapBuild.deleteLidar(courseId);
            await this.confirm.confirm({
                title: 'Lidar files deleted',
                body: `Freed ${formatBytes(freedBytes)}.`,
                confirmLabel: 'Done',
                cancelLabel: 'Close',
                tone: 'primary',
            });
        } catch (e) {
            await this.confirm.confirm({
                title: 'Could not delete lidar files',
                body: e instanceof Error ? e.message : String(e),
                confirmLabel: 'OK',
                cancelLabel: 'Close',
                tone: 'warning',
            });
        }
    }

    private buildAvatarPanel(host: HTMLElement, close: () => void): void {
        const player = document.createElement('button');
        player.type = 'button';
        player.className = 'menu-item';
        player.innerHTML = `<span class="menu-item__icon">${icon('map-pin', 16)}</span><span class="menu-item__label">Player settings</span>`;
        player.onclick = () => { this.router.navigate('/player'); close(); };
        host.appendChild(player);

        const logout = document.createElement('button');
        logout.type = 'button';
        logout.className = 'menu-item';
        logout.innerHTML = `<span class="menu-item__label">Log out</span>`;
        logout.onclick = async () => {
            close();
            await this.auth.logout();
            this.router.navigate('/login', true);
        };
        host.appendChild(logout);
    }

    private userInitial(): string {
        return (this.auth.currentUser.get()?.username ?? '?').charAt(0).toUpperCase();
    }
}
