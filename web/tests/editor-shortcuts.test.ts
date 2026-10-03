import { test, expect, afterEach, beforeEach } from 'bun:test';
import { Router, Signal, di } from '@basics/core/client/core';
import { _reset } from '@basics/core/client/error-report';
import { EditorToolbarComponent } from '../src/editor/toolbar.component';
import { EditorModeService, FOLLOW_HOLE_KEY, HOLE_DOCK_KEY, FEATURE_DOCK_KEY } from '../src/editor/editor-mode.service';
import { HelpModalService } from '../src/editor/help-modal.component';
import { ShortcutService, LAYER } from '../src/editor/shortcut.service';
import { attachEditorChrome } from '../src/editor/editor-chrome';
import { MapService } from '../src/map/map.service';
import { FeaturesService } from '../src/draw/features.service';
import { FurnitureService } from '../src/furniture/furniture.service';
import { CourseDetailService } from '../src/course-detail/course-detail.service';
import { ServerModeService, visibleEditorTools, type ServerMode } from '../src/app/server-mode.service';
import { PopoverComponent } from '../src/ui/popover.component';
import { HoleSidebarComponent } from '../src/course-detail/hole-sidebar.component';
import { Component, template } from '@basics/core/client/core';
import { measureTool } from '../src/measure/measure-tool';
import { MEASURE_TOOL_ID } from '../src/measure/measure-tool.service';
import { DRAW_TOOL_ID } from '../src/draw/draw-tool.service';
import { FURNITURE_TOOL_ID } from '../src/furniture/furniture.service';
import { ANALYSIS_TOOL_ID } from '../src/analysis/analysis-tool.service';
import { TERRAIN_EDIT_TOOL_ID } from '../src/terrain-edit/terrain-edit-tool.service';
import type { CourseFeaturesApi } from '../../shared/api/course-features.gen';
import type { Hole } from '../../shared/api/holes.gen';
import type { Tee } from '../../shared/api/tees.gen';

// The editor's single keydown dispatcher (review item 31), the editor-wide
// key routes (item 21) and the follow-hole camera (item 22). The builder is
// mounted the way the /course canvas mounts it: toolbar (help modal + tool
// chain) plus attachEditorChrome (key layer + hole framing).

const COURSE_ID = 'course-1';

interface Harness {
    mode: EditorModeService;
    router: Router;
    shortcuts: ShortcutService;
    help: HelpModalService;
    furniture: FurnitureService;
    fits: Array<[number, number, number, number]>;
    courseFits: () => number;
}

const disposers: Array<() => void> = [];

beforeEach(() => {
    localStorage.clear();
});

afterEach(() => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
    document.body.textContent = '';
    localStorage.clear();
    history.replaceState(null, '', '/');
    _reset();
    di.reset();
});

function hole(number: number): Hole {
    return { id: `hole-${number}`, courseId: COURSE_ID, number, par: 4 } as unknown as Hole;
}

function tee(holeNumber: number, lat: number, lon: number): Tee {
    return { id: `tee-${holeNumber}-${lat}`, holeId: `hole-${holeNumber}`, lat, lon } as unknown as Tee;
}

function mountBuilder(serverMode: ServerMode = 'builder'): Harness {
    const server = new ServerModeService();
    server.mode.set(serverMode);
    di.set(ServerModeService, server);

    const fits: Array<[number, number, number, number]> = [];
    let courseFits = 0;
    const map = {
        ready: new Signal(true),
        map: new Signal(null),
        zoom: new Signal(18),
        interactionMode: new Signal<string | null>(null),
        claimInteraction(mode: string) {
            map.interactionMode.set(mode);
            return () => { if (map.interactionMode.peek() === mode) map.interactionMode.set(null); };
        },
        onClick: () => () => {},
        onMouseMove: () => () => {},
        addOverlayLayer: () => {},
        updateOverlayData: () => {},
        removeOverlayLayer: () => {},
        fitBounds(bounds: [number, number, number, number]) { fits.push(bounds); },
        fitCourse() { courseFits++; },
    };
    di.set(MapService, map as never);
    const router = new Router();
    router.navigate(`/course/${COURSE_ID}`);
    di.set(Router, router);
    const api = { async listByCourse() { return []; } } as unknown as CourseFeaturesApi;
    di.set(FeaturesService, new FeaturesService(api));
    const courseDetail = new CourseDetailService();
    courseDetail.holeStore.set([hole(1), hole(2), hole(3)]);
    di.set(CourseDetailService, courseDetail);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const toolbar = new EditorToolbarComponent();
    toolbar.mount(host);
    disposers.push(() => toolbar.destroy());

    const mode = di.get(EditorModeService);
    const shortcuts = di.get(ShortcutService);
    const furniture = di.get(FurnitureService);
    disposers.push(attachEditorChrome({
        shortcuts,
        mode,
        map: map as never,
        furniture,
        offered: () => visibleEditorTools(server.mode.peek()),
    }));
    return { mode, router, shortcuts, help: di.get(HelpModalService), furniture, fits, courseFits: () => courseFits };
}

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
}

function mountPopover(): PopoverComponent {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const popover = new PopoverComponent({
        trigger: 'Menu',
        panel: (panel) => {
            panel.innerHTML = '<button class="menu-item">One</button><button class="menu-item">Two</button>';
        },
    });
    popover.mount(host);
    disposers.push(() => popover.destroy());
    return popover;
}

// ── Dispatcher (item 31) ────────────────────────────────────────────────

test('layer stack order: popover above help modal above tool chain', () => {
    const h = mountBuilder();
    const popover = mountPopover();
    h.mode.activate(measureTool);
    h.help.show();
    popover.openPopover();

    const order = h.shortcuts.layerIds();
    expect(order.indexOf('popover')).toBeLessThan(order.indexOf('help-modal'));
    expect(order.indexOf('help-modal')).toBeLessThan(order.indexOf('tool-chain'));
    expect(order.indexOf('tool-chain')).toBeLessThan(order.indexOf('editor-keys'));

    // First Esc: the popover closes; help and Measure stay.
    press('Escape');
    expect(popover.open.peek()).toBe(false);
    expect(h.help.open.peek()).toBe(true);
    expect(h.mode.activeToolId.peek()).toBe(MEASURE_TOOL_ID);

    // Second Esc: help closes; Measure stays.
    press('Escape');
    expect(h.help.open.peek()).toBe(false);
    expect(h.mode.activeToolId.peek()).toBe(MEASURE_TOOL_ID);

    // Third Esc: the tool chain returns to Draw.
    press('Escape');
    expect(h.mode.activeToolId.peek()).toBe(DRAW_TOOL_ID);
});

test('the popover layer exists only while the popover is open', () => {
    const h = mountBuilder();
    const popover = mountPopover();
    expect(h.shortcuts.layerIds()).not.toContain('popover');
    popover.openPopover();
    expect(h.shortcuts.layerIds()).toContain('popover');
    popover.close();
    expect(h.shortcuts.layerIds()).not.toContain('popover');
});

test('a higher level wins regardless of push order', () => {
    const shortcuts = new ShortcutService();
    const seen: string[] = [];
    const popLow = shortcuts.push({ id: 'low', level: LAYER.toolChain, onKey: () => { seen.push('low'); return true; } });
    const popHigh = shortcuts.push({ id: 'high', level: LAYER.popover, onKey: () => { seen.push('high'); return false; } });
    const popMid = shortcuts.push({ id: 'mid', level: LAYER.modal, onKey: () => { seen.push('mid'); return false; } });
    press('x');
    expect(seen).toEqual(['high', 'mid', 'low']);
    popLow(); popHigh(); popMid();
});

test('a consumed key stops later window listeners', () => {
    const h = mountBuilder();
    let later = 0;
    const listener = (): void => { later++; };
    window.addEventListener('keydown', listener);
    disposers.push(() => window.removeEventListener('keydown', listener));

    h.help.show();
    press('Escape');
    expect(h.help.open.peek()).toBe(false);
    expect(later).toBe(0);

    press('q');
    expect(later).toBe(1);
});

test('keys typed in inputs never reach the stack, except Escape', () => {
    const h = mountBuilder();
    const input = document.createElement('input');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const textarea = document.createElement('textarea');
    document.body.append(input, editable, textarea);

    for (const target of [input, editable, textarea]) {
        press('m', {}, target);
        expect(h.mode.activeToolId.peek()).toBe(DRAW_TOOL_ID);
        press('?', {}, target);
        expect(h.help.open.peek()).toBe(false);
    }

    h.help.show();
    press('Escape', {}, input);
    expect(h.help.open.peek()).toBe(false);
});

test('an Escape another listener already handled is skipped', () => {
    const h = mountBuilder();
    h.mode.activate(measureTool);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    event.preventDefault();
    document.body.dispatchEvent(event);
    expect(h.mode.activeToolId.peek()).toBe(MEASURE_TOOL_ID);
});

test('popover arrow keys move focus between menu rows', () => {
    mountBuilder();
    const popover = mountPopover();
    popover.openPopover();
    const rows = [...document.querySelectorAll<HTMLButtonElement>('.popover__panel .menu-item')];
    press('ArrowDown');
    expect(document.activeElement).toBe(rows[0]!);
    press('ArrowDown');
    expect(document.activeElement).toBe(rows[1]!);
    press('ArrowDown');
    expect(document.activeElement).toBe(rows[0]!);
    press('End');
    expect(document.activeElement).toBe(rows[1]!);
});

// ── Key routes (item 21) ────────────────────────────────────────────────

test('sub-mode letters select the offered tools', () => {
    const h = mountBuilder();
    const routes: Array<[string, string]> = [
        ['m', MEASURE_TOOL_ID],
        ['f', FURNITURE_TOOL_ID],
        ['a', ANALYSIS_TOOL_ID],
        ['t', TERRAIN_EDIT_TOOL_ID],
        ['d', DRAW_TOOL_ID],
        ['M', MEASURE_TOOL_ID], // caps lock
    ];
    for (const [key, toolId] of routes) {
        press(key);
        expect(h.mode.activeToolId.peek()).toBe(toolId);
    }
});

test('sub-mode letters skip tools the server mode hides', () => {
    const h = mountBuilder('serve');
    const offered = visibleEditorTools('serve').map(tool => tool.id);
    expect(offered).not.toContain(DRAW_TOOL_ID);
    const before = h.mode.activeToolId.peek();
    press('d');
    expect(h.mode.activeToolId.peek()).toBe(before);
    if (offered.includes(MEASURE_TOOL_ID)) {
        press('m');
        expect(h.mode.activeToolId.peek()).toBe(MEASURE_TOOL_ID);
    }
});

test('sub-mode letters are ignored while the active tool reports busy', () => {
    const h = mountBuilder();
    h.mode.activate(measureTool);
    measureTool.isBusy = () => true;
    try {
        const event = press('d');
        expect(h.mode.activeToolId.peek()).toBe(MEASURE_TOOL_ID);
        expect(event.defaultPrevented).toBe(false);
    } finally {
        delete measureTool.isBusy;
    }
    press('d');
    expect(h.mode.activeToolId.peek()).toBe(DRAW_TOOL_ID);
});

test('modified letters stay with the browser and the draw tool', () => {
    const h = mountBuilder();
    press('m', { metaKey: true });
    press('m', { ctrlKey: true });
    press('m', { altKey: true });
    press('M', { shiftKey: true });
    expect(h.mode.activeToolId.peek()).toBe(DRAW_TOOL_ID);
});

test(', and . step the hole and clamp at the ends', () => {
    const h = mountBuilder();
    const holeParam = () => new URLSearchParams(h.router.search.peek()).get('hole');

    press('.');
    expect(holeParam()).toBe('1');
    press('.');
    expect(holeParam()).toBe('2');
    press(',');
    expect(holeParam()).toBe('1');
    press(',');
    expect(holeParam()).toBe('1');

    h.router.navigate(`/course/${COURSE_ID}`, { query: { hole: '3', view: 'x' } });
    press('.');
    expect(holeParam()).toBe('3');
    press(',');
    expect(holeParam()).toBe('2');
    expect(new URLSearchParams(h.router.search.peek()).get('view')).toBe('x');
    expect(h.router.route.peek()).toBe(`/course/${COURSE_ID}`);
});

test('Shift+F fits the hole, Cmd/Ctrl+Shift+F fits the course', () => {
    const h = mountBuilder();
    h.mode.setFollowHole(false);
    h.furniture.tees.set([tee(2, 58.0, 15.0), tee(2, 58.002, 15.004)]);
    h.router.navigate(`/course/${COURSE_ID}`, { query: { hole: '2' } });
    expect(h.fits).toHaveLength(0);

    press('F', { shiftKey: true });
    expect(h.fits).toEqual([[15.0, 58.0, 15.004, 58.002]]);

    press('F', { shiftKey: true, metaKey: true });
    press('f', { shiftKey: true, ctrlKey: true });
    expect(h.courseFits()).toBe(2);
    expect(h.fits).toHaveLength(1);
});

test('Cmd/Ctrl+\\ collapses both docks, then expands both', () => {
    const h = mountBuilder();
    press('\\', { metaKey: true });
    expect(localStorage.getItem(HOLE_DOCK_KEY)).toBe('1');
    expect(localStorage.getItem(FEATURE_DOCK_KEY)).toBe('1');
    expect(h.mode.dockRequest.peek()).toEqual({ collapsed: true });

    press('\\', { ctrlKey: true });
    expect(localStorage.getItem(HOLE_DOCK_KEY)).toBe('0');
    expect(localStorage.getItem(FEATURE_DOCK_KEY)).toBe('0');
    expect(h.mode.dockRequest.peek()).toEqual({ collapsed: false });

    // One dock collapsed by hand: the next toggle collapses both.
    localStorage.setItem(HOLE_DOCK_KEY, '1');
    press('\\', { metaKey: true });
    expect(h.mode.dockRequest.peek()).toEqual({ collapsed: true });
});

class EmptyFooter extends Component {
    render(): DocumentFragment { return this.wire(template('<div></div>'), {}); }
}

test('the hole dock collapses and expands live on Cmd+\\', () => {
    const h = mountBuilder();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const dock = new HoleSidebarComponent({ footer: EmptyFooter });
    dock.mount(host);
    disposers.push(() => dock.destroy());
    const root = host.querySelector('.hole-dock')!;
    expect(root.classList.contains('is-collapsed')).toBe(false);

    press('\\', { metaKey: true });
    expect(root.classList.contains('is-collapsed')).toBe(true);
    press('\\', { metaKey: true });
    expect(root.classList.contains('is-collapsed')).toBe(false);
    expect(h.mode.dockRequest.peek()).toEqual({ collapsed: false });
});

test('draw keys still reach the draw tool', () => {
    const h = mountBuilder();
    for (const key of ['n', 'b', 'c', 'i', '1', 'Delete', 'Enter']) {
        expect(h.shortcuts.dispatch(new KeyboardEvent('keydown', { key }))).toBe(false);
        expect(h.mode.activeToolId.peek()).toBe(DRAW_TOOL_ID);
    }
    expect(h.shortcuts.dispatch(new KeyboardEvent('keydown', { key: 'z', metaKey: true }))).toBe(false);
    expect(h.shortcuts.dispatch(new KeyboardEvent('keydown', { key: 'd', metaKey: true }))).toBe(false);
});

test('? toggles help and the modal lists the editor keys', () => {
    const h = mountBuilder();
    press('?');
    expect(h.help.open.peek()).toBe(true);
    const text = document.querySelector('.help-modal__body')?.textContent ?? '';
    expect(text).toContain('Previous / next hole');
    expect(text).toContain('Shift+F');
    expect(text).toContain('Measure');
    press('?');
    expect(h.help.open.peek()).toBe(false);
});

// ── Follow hole (item 22) ───────────────────────────────────────────────

test('hole change frames the camera while follow-hole is on', () => {
    const h = mountBuilder();
    expect(h.mode.followHole.peek()).toBe(true);
    h.furniture.tees.set([tee(1, 58.0, 15.0), tee(2, 58.01, 15.01), tee(2, 58.012, 15.013)]);

    h.router.navigate(`/course/${COURSE_ID}`, { query: { hole: '1' } });
    expect(h.fits.at(-1)).toEqual([15.0, 58.0, 15.0, 58.0]);

    press('.');
    expect(h.fits.at(-1)).toEqual([15.01, 58.01, 15.013, 58.012]);
    const count = h.fits.length;

    // Editing furniture on the same hole does not re-frame.
    h.furniture.tees.set([tee(1, 58.0, 15.0), tee(2, 58.01, 15.01), tee(2, 58.02, 15.02)]);
    expect(h.fits.length).toBe(count);
});

test('follow-hole off: hole change leaves the camera alone; the toggle persists', () => {
    const h = mountBuilder();
    h.mode.setFollowHole(false);
    expect(localStorage.getItem(FOLLOW_HOLE_KEY)).toBe('0');
    h.furniture.tees.set([tee(1, 58.0, 15.0), tee(2, 58.01, 15.01)]);

    h.router.navigate(`/course/${COURSE_ID}`, { query: { hole: '1' } });
    press('.');
    expect(h.fits).toHaveLength(0);

    // Turning it back on frames the current hole.
    h.mode.setFollowHole(true);
    expect(localStorage.getItem(FOLLOW_HOLE_KEY)).toBe('1');
    expect(h.fits).toEqual([[15.01, 58.01, 15.01, 58.01]]);

    // A new service instance reads the persisted value.
    localStorage.setItem(FOLLOW_HOLE_KEY, '0');
    di.reset();
    di.set(MapService, { ready: new Signal(true) } as never);
    di.set(Router, new Router());
    expect(di.get(EditorModeService).followHole.peek()).toBe(false);
});

test('follow-hole defaults on with nothing stored', () => {
    mountBuilder();
    expect(localStorage.getItem(FOLLOW_HOLE_KEY)).toBeNull();
    expect(di.get(EditorModeService).followHole.peek()).toBe(true);
});
