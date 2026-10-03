import { test, expect, afterEach } from 'bun:test';
import { Router, di } from '@basics/core/client/core';
import { ApiError } from '@basics/core/client/api-error';
import { _reset } from '@basics/core/client/error-report';
import { CommandBarComponent, SAVED_MS, SUBMODE_KEY_HINTS } from '../src/app/command-bar.component';
import { ServerModeService, visibleEditorTools } from '../src/app/server-mode.service';
import { CourseDetailService } from '../src/course-detail/course-detail.service';
import { FeaturesService } from '../src/draw/features.service';
import { DrawToolService } from '../src/draw/draw-tool.service';
import { DIGIT_FEATURE_TYPES, FEATURE_STYLES } from '../src/draw/feature-palette';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';

// Review items 26 (autosave pill + failure toast) and 29 (key hints, chain
// policy in the draw-target chip).

const mounted: CommandBarComponent[] = [];
afterEach(() => {
    for (const c of mounted.splice(0)) c.destroy();
    document.body.textContent = '';
    di.reset?.();
    _reset();
});

const row: CourseFeature = {
    id: 'f1', courseId: 'c1', holeId: null, type: 'bunker',
    geometry: { crs: 'EPSG:3006', rings: [{ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }] },
    sortOrder: 0, source: null, sourceRef: null, license: null, attributes: null, version: 1,
};

/** In-memory feature API whose `update` fails with a 409 while `failUpdates` is set. */
function featureApi() {
    const counts = { list: 0, update: 0 };
    const state = { failUpdates: true };
    const api = {
        async listByCourse() {
            counts.list++;
            return [structuredClone(row)];
        },
        async update(input: { id: string; version: number; type?: string }) {
            counts.update++;
            if (state.failUpdates) throw new ApiError(409, 'Version conflict');
            return { ...structuredClone(row), ...input, version: input.version + 1 };
        },
    } as unknown as CourseFeaturesApi;
    return { api, counts, state };
}

function setup() {
    const serverMode = new ServerModeService();
    serverMode.mode.set('builder');
    di.set(ServerModeService, serverMode);

    const router = new Router();
    router.navigate('/course/c1');
    di.set(Router, router);

    const svc = new CourseDetailService({} as never, {} as never);
    svc.course.set({ id: 'c1', name: 'Test', status: 'draft', revision: 1, version: 1, georeferenceJson: null } as never);
    di.set(CourseDetailService, svc);

    const fake = featureApi();
    const features = new FeaturesService(fake.api);
    di.set(FeaturesService, features);
    const tool = di.get(DrawToolService);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const bar = new CommandBarComponent({ mode: 'create' });
    bar.mount(host);
    mounted.push(bar);

    const pill = () => host.querySelector<HTMLElement>('[data-testid="save-pill"]')!;
    const toast = () => host.querySelector<HTMLElement>('[data-testid="toast"]')!;
    const toastOpen = () => toast().classList.contains('is-open');
    return { host, features, tool, fake, pill, toast, toastOpen };
}

const wait = (ms = 0): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// ── Item 26: save-state pill ─────────────────────────────────────────────

test('pill starts idle, reads Saving while a request is out, then Saved, then idle', async () => {
    const { features, pill } = setup();
    expect(pill().dataset.state).toBe('idle');
    expect(pill().textContent).toBe('');

    features.pendingSaves.set(1);
    expect(pill().dataset.state).toBe('saving');
    expect(pill().textContent).toContain('Saving');

    features.pendingSaves.set(0);
    expect(pill().dataset.state).toBe('saved');
    expect(pill().textContent).toContain('Saved');

    await wait(SAVED_MS + 50);
    expect(pill().dataset.state).toBe('idle');
});

test('pill turns failed with the error code and stays failed', async () => {
    const { features, pill } = setup();
    features.pendingSaves.set(1);
    features.saveError.set({ code: 'conflict', message: 'Data has changed' });
    features.pendingSaves.set(0);

    expect(pill().dataset.state).toBe('failed');
    expect(pill().textContent).toContain('Not saved');
    expect(pill().textContent).toContain('conflict');
    expect(pill().getAttribute('aria-disabled')).toBe('false');

    await wait(SAVED_MS + 50);
    expect(pill().dataset.state).toBe('failed');
});

test('pill sits in the right-hand group, before the actions menu', () => {
    const { host } = setup();
    const right = host.querySelector('.cmdbar__right')!;
    const slot = right.querySelector('.cmdbar__save-slot')!;
    expect(slot.querySelector('[data-testid="save-pill"]')).not.toBeNull();
    expect(slot.nextElementSibling?.querySelector('[data-testid="actions-menu-trigger"]')).not.toBeNull();
});

test('toast appears once per transition into failed and dismisses on click', () => {
    const { features, toast, toastOpen } = setup();
    expect(toastOpen()).toBe(false);

    features.saveError.set({ code: 'server', message: 'Server error' });
    expect(toastOpen()).toBe(true);
    expect(toast().textContent).toContain('Save failed. Latest edit was reverted.');
    expect(toast().textContent).toContain('server');

    toast().click();
    expect(toastOpen()).toBe(false);

    // Still failed: a changed error without leaving failed shows no second toast.
    features.saveError.set({ code: 'network', message: 'Network error' });
    expect(toastOpen()).toBe(false);

    // A new request clears the error; its failure is a new transition.
    features.pendingSaves.set(1);
    features.saveError.set(null);
    features.saveError.set({ code: 'timeout', message: 'Request timeout' });
    features.pendingSaves.set(0);
    expect(toastOpen()).toBe(true);
    expect(toast().textContent).toContain('timeout');
});

test('toast dismisses itself after its timeout', async () => {
    const { features, toastOpen } = setup();
    features.saveError.set({ code: 'server', message: 'Server error' });
    expect(toastOpen()).toBe(true);
    await wait(5050);
    expect(toastOpen()).toBe(false);
}, 8000);

test('a real failed update drives failed; Retry re-syncs and clears it', async () => {
    const { host, features, fake, pill, toastOpen } = setup();
    await features.load('c1');
    expect(fake.counts.list).toBe(1);

    await features.update('f1', { type: 'green' });
    await features.flush();
    await wait();
    expect(fake.counts.update).toBe(1);
    expect(pill().dataset.state).toBe('failed');
    expect(pill().textContent).toContain('conflict');
    expect(toastOpen()).toBe(true);
    // The service reloads after a failed save; the edit is reverted.
    expect(fake.counts.list).toBe(2);
    expect(features.store.items.peek()[0]!.type).toBe('bunker');

    pill().click();
    const panel = host.querySelector<HTMLElement>('.cmdbar__save-panel')!;
    expect(panel.classList.contains('is-open')).toBe(true);
    expect(panel.textContent).toContain('code conflict');

    host.querySelector<HTMLButtonElement>('[data-testid="save-retry"]')!.click();
    await features.flush();
    await wait();
    await wait();
    expect(fake.counts.list).toBe(3);
    expect(features.saveError.peek()).toBeNull();
    expect(pill().dataset.state).toBe('idle');
    expect(panel.classList.contains('is-open')).toBe(false);
});

test('Retry keeps the failed state when the re-sync itself fails', async () => {
    const { host, features, fake, pill } = setup();
    await features.load('c1');
    await features.update('f1', { type: 'green' });
    await features.flush();
    await wait();
    expect(pill().dataset.state).toBe('failed');

    (fake.api as { listByCourse: unknown }).listByCourse = () => Promise.reject(new ApiError(500, 'down'));
    pill().click();
    host.querySelector<HTMLButtonElement>('[data-testid="save-retry"]')!.click();
    await wait();
    await wait();
    expect(features.error.peek()?.code).toBe('server');
    expect(pill().dataset.state).toBe('failed');
});

// ── Item 29: key hints and chain policy ──────────────────────────────────

test('every digit-bound feature type shows its key hint; the rest show none', () => {
    const { host } = setup();
    const rows = [...host.querySelectorAll<HTMLButtonElement>('.cmdbar__ft-panel .cmd-ft')];
    const digitFor = new Map(Object.entries(DIGIT_FEATURE_TYPES).map(([d, type]) => [type as string, d]));
    expect(rows.length).toBe(Object.keys(FEATURE_STYLES).length);
    for (const btn of rows) {
        const hint = btn.querySelector('[data-testid="ft-key"]');
        const digit = digitFor.get(btn.dataset.type!);
        if (digit) {
            expect(hint?.textContent).toBe(digit);
            expect(btn.lastElementChild).toBe(hint); // right-aligned after the name
        } else {
            expect(hint).toBeNull();
        }
    }
    expect(host.querySelectorAll('[data-testid="ft-key"]').length).toBe(Object.keys(DIGIT_FEATURE_TYPES).length);
});

test('every sub-mode entry with a key shows its hint before the check mark', () => {
    const { host } = setup();
    const tools = visibleEditorTools('builder');
    for (const tool of tools) {
        const btn = host.querySelector<HTMLElement>(`[data-testid="tool-btn-${tool.id}"]`)!;
        expect(btn).not.toBeNull();
        const hint = btn.querySelector('[data-testid="submode-key"]');
        const key = SUBMODE_KEY_HINTS[tool.id];
        if (key) {
            expect(hint?.textContent).toBe(key);
            expect(hint?.nextElementSibling?.classList.contains('menu-item__check')).toBe(true);
        } else {
            expect(hint).toBeNull();
        }
    }
    const shown = [...host.querySelectorAll('[data-testid="submode-key"]')].map(el => el.textContent).sort();
    expect(shown).toEqual(['A', 'D', 'F', 'M', 'T']);
});

test('draw-target chip shows the chain policy and follows changes to it', () => {
    const { host, tool } = setup();
    const chip = host.querySelector<HTMLElement>('[data-testid="draw-target"]')!;
    const chain = () => host.querySelector<HTMLElement>('[data-testid="draw-target-chain"]')!.textContent;

    tool.setTypeFollowsLast(true);
    expect(chip.textContent).toContain('Course level');
    expect(chain()).toBe('Next: same type');

    tool.setDefaultDrawType('fairway');
    tool.setTypeFollowsLast(false);
    expect(chain()).toBe(`Next: ${FEATURE_STYLES.fairway.label}`);
    expect(chip.title).toContain(FEATURE_STYLES.fairway.label);

    tool.setTypeFollowsLast(true);
    expect(chain()).toBe('Next: same type');
    tool.setDefaultDrawType('bunker'); // both prefs persist; restore the defaults
});

test('Dismiss clears the failure without a re-fetch', async () => {
    const { host, features, fake, pill } = setup();
    await features.load('c1');
    await features.update('f1', { type: 'green' });
    await features.flush();
    await wait();
    expect(pill().dataset.state).toBe('failed');
    const lists = fake.counts.list;

    pill().click();
    host.querySelector<HTMLButtonElement>('[data-testid="save-dismiss"]')!.click();
    expect(features.saveError.peek()).toBeNull();
    expect(pill().dataset.state).toBe('idle');
    expect(fake.counts.list).toBe(lists);
    expect(host.querySelector('.cmdbar__save-panel')!.classList.contains('is-open')).toBe(false);
});
