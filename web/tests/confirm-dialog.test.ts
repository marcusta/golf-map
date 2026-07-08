import { test, expect, afterEach } from 'bun:test';
import { ConfirmDialogComponent, ConfirmService } from '../src/app/confirm-dialog.component';

const mounted: ConfirmDialogComponent[] = [];

function mount(): { host: HTMLElement; svc: ConfirmService; component: ConfirmDialogComponent } {
    document.body.textContent = '';
    const host = document.createElement('div');
    document.body.appendChild(host);
    const svc = new ConfirmService();
    const component = new ConfirmDialogComponent({ service: svc });
    component.mount(host);
    mounted.push(component);
    return { host, svc, component };
}

afterEach(() => {
    for (const component of mounted.splice(0)) component.destroy();
    document.body.textContent = '';
});

test('default danger confirm resolves true from the primary action', async () => {
    const { host, svc } = mount();

    const result = svc.confirm({
        title: 'Delete selected shot?',
        body: 'This removes the selected 7-iron layup from Hole 4.',
        detail: 'Undo is not available yet.',
        confirmLabel: 'Delete shot',
        tone: 'danger',
        layout: 'default',
    });

    expect(host.querySelector('.confirm-dialog-host')?.className).toContain('is-open');
    expect(host.querySelector('.confirm-dialog-host')?.className).toContain('layout-default');
    expect(host.querySelector('.confirm-dialog-host')?.className).toContain('tone-danger');
    expect(host.textContent).toContain('Delete selected shot?');

    (host.querySelector('.confirm-dialog__confirm') as HTMLButtonElement).click();

    await expect(result).resolves.toBe(true);
    expect(host.querySelector('.confirm-dialog-host')?.className).not.toContain('is-open');
});

test('review confirm renders the review layout and resolves false from cancel', async () => {
    const { host, svc } = mount();

    const result = svc.confirm({
        title: 'Publish Bro Hof Stadium?',
        body: 'Publishing bumps revision 12 to 13 for device sync.',
        detail: 'Players already on the course keep their current local copy until they refresh.',
        confirmLabel: 'Publish course',
        cancelLabel: 'Keep editing',
        tone: 'primary',
        layout: 'review',
    });

    expect(host.querySelector('.confirm-dialog-host')?.className).toContain('layout-review');
    expect(host.querySelector('.confirm-dialog-host')?.className).toContain('tone-primary');
    expect(host.textContent).toContain('Publish Bro Hof Stadium?');
    expect(host.textContent).toContain('Players already on the course');

    (host.querySelector('.confirm-dialog__cancel') as HTMLButtonElement).click();

    await expect(result).resolves.toBe(false);
    expect(host.querySelector('.confirm-dialog-host')?.className).not.toContain('is-open');
});
