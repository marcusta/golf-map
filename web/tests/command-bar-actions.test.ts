import { test, expect, afterEach } from 'bun:test';
import { Router, di } from '@basics/core/client/core';
import { _reset } from '@basics/core/client/error-report';
import { CommandBarComponent } from '../src/app/command-bar.component';
import { ServerModeService } from '../src/app/server-mode.service';
import { PublishClientService } from '../src/app/publish-client.service';
import { MapBuildClientService } from '../src/map-build/map-build.service';
import { CourseDetailService } from '../src/course-detail/course-detail.service';
import type { PublishApi } from '../../shared/api/publish.gen';
import type { MapBuildApi } from '../../shared/api/map-build.gen';

// The ⋯ actions menu builds its panel, and fires its publish-status and
// lidar-info fetches, on first open. Mounting the command bar costs neither.

const mounted: CommandBarComponent[] = [];
afterEach(() => {
    for (const c of mounted.splice(0)) c.destroy();
    document.body.textContent = '';
    di.reset?.();
    _reset();
});

function setup() {
    const counts = { publishStatus: 0, lidarInfo: 0 };
    const publishApi = {
        async status() {
            counts.publishStatus++;
            return { status: 'idle', configured: true, warnings: [], step: null, targetUrl: null, bundleBytes: null, error: null };
        },
    } as unknown as PublishApi;
    const mapBuildApi = {
        async lidarInfo() {
            counts.lidarInfo++;
            return { files: [{ name: 'a.laz', bytes: 10 }], totalBytes: 10 };
        },
    } as unknown as MapBuildApi;

    const serverMode = new ServerModeService();
    serverMode.mode.set('builder');
    di.set(ServerModeService, serverMode);
    di.set(PublishClientService, new PublishClientService(publishApi));
    di.set(MapBuildClientService, new MapBuildClientService(mapBuildApi));

    const router = new Router();
    router.navigate('/course/c1');
    di.set(Router, router);

    const svc = new CourseDetailService({} as never, {} as never);
    svc.course.set({ id: 'c1', name: 'Test', status: 'draft', revision: 1, version: 1, georeferenceJson: null } as never);
    di.set(CourseDetailService, svc);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const bar = new CommandBarComponent({ mode: 'create' });
    bar.mount(host);
    mounted.push(bar);
    return { host, counts };
}

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

test('mounting the command bar makes no publish-status or lidar-info calls', async () => {
    const { host, counts } = setup();
    await tick();
    expect(host.querySelector('[data-testid="actions-menu-trigger"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="course-publish-vps-btn"]')).toBeNull();
    expect(counts).toEqual({ publishStatus: 0, lidarInfo: 0 });
});

test('opening the menu fetches each once; reopening does not refetch', async () => {
    const { host, counts } = setup();
    const trigger = host.querySelector('[data-testid="actions-menu-trigger"]') as HTMLButtonElement;

    trigger.click();
    await tick();
    expect(counts).toEqual({ publishStatus: 1, lidarInfo: 1 });
    expect(host.querySelector('[data-testid="course-publish-vps-btn"]')).not.toBeNull();
    expect((host.querySelector('[data-testid="course-delete-lidar-btn"]') as HTMLElement).style.display).toBe('');

    trigger.click(); // close
    trigger.click(); // reopen
    await tick();
    expect(counts).toEqual({ publishStatus: 1, lidarInfo: 1 });
});
