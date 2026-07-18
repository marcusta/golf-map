import { Component, Computed, Router, template, effect, untrack } from '@basics/core/client/core';
import { AuthService } from '@basics/core/client/auth';
import { t } from '../theme';
import { s, statusTag, iconBtn, metric, panelTitle, selectedRow } from '../css';
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
import { EDITOR_TOOLS } from '../editor/tools/index';
import { SvgImportService, boundsFromGeoreference } from '../import/svg-import.service';
import { GeojsonImportService } from '../import/geojson-import.service';

type CommandBarMode = 'create' | 'plan';

const tpl = template(`
    <header class="cmdbar" bind="root">
        <span class="cmdbar__identity">
            <span class="cmdbar__glyph">${icon('flag', 16)}</span>
            <a bind="courses" class="cmdbar__courses" href="/">&#8249; Courses</a>
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

            & .cmdbar__new { ${iconBtn({ primary: true })} }
            /* Armed (drawing) → the button is now Cancel; mirror the draw
               panel's red affordance instead of a second variant. */
            & .cmdbar__new[aria-pressed="true"] {
                background: ${t('color-status-negative')};
                &:hover { background: ${t('color-status-negative')}; }
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
    private confirm = this.inject(ConfirmService);
    private helpModal = this.inject(HelpModalService);
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

        // Zone 4: actions + avatar.
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
                innerHTML: icon('plus', 16),
                title: () => (this.tool.state.isDrawing.get() ? 'Cancel drawing (Esc)' : 'New polygon (N)'),
                'aria-label': () => (this.tool.state.isDrawing.get() ? 'Cancel drawing' : 'New polygon'),
                'aria-pressed': () => this.tool.state.isDrawing.get(),
                onclick: () => {
                    if (this.tool.state.isDrawing.peek()) this.tool.state.disarm();
                    else this.tool.state.arm();
                },
            },
            boxSelect: {
                innerHTML: icon('box-select', 16),
                title: () => (this.tool.state.boxSelect.get() ? 'Box-select: on (B)' : 'Box-select (B)'),
                'aria-label': 'Box-select',
                'aria-pressed': () => this.tool.state.boxSelect.get(),
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

    /** The draw tool is the active sub-mode (or none is armed yet → treat as draw). */
    private isDrawSubmode(): boolean {
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
        for (const editorTool of [...EDITOR_TOOLS].sort((a, b) => a.order - b.order)) {
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
        host.innerHTML = `<div class="cmdbar__ft-title">Feature type</div><div class="cmdbar__ft-grid" data-k="grid"></div>`;
        const grid = host.querySelector<HTMLElement>('[data-k="grid"]')!;
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
            // Same select/retype behavior the draw panel's type grid used.
            btn.onclick = () => {
                if (this.features.selectedIds.peek().size > 0) this.tool.retypeSelection(type);
                else this.tool.drawType.set(type);
                close();
            };
            track(effect(() => {
                const multi = this.features.selectedIds.get().size > 1;
                const selected = this.features.selected.get();
                const current = multi ? null : selected ? selected.type : this.tool.drawType.get();
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
        // Import SVG — Create only (matches today's availability).
        if (this.props.mode === 'create') {
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

            const divider = document.createElement('div');
            divider.className = 'menu-divider';
            host.appendChild(divider);
        }

        // Publish revision — same ConfirmService + publish flow as the old header.
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
