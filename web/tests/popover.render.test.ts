import { test, expect, afterEach } from 'bun:test';
import { PopoverComponent } from '../src/ui/popover.component';

// Render smoke for the popover primitive (there are no per-component specs
// by design — TESTING.md — but this reusable primitive's open/close wiring
// is worth throw-checking through real DOM events, since it's the base for
// every command-bar dropdown/menu going forward).

const mounted: PopoverComponent[] = [];

function mount(): { host: HTMLElement; component: PopoverComponent } {
    document.body.textContent = '';
    const host = document.createElement('div');
    document.body.appendChild(host);
    const component = new PopoverComponent({
        trigger: (triggerHost) => { triggerHost.textContent = 'Draw'; },
        panel: (panelHost, ctx) => {
            panelHost.innerHTML = `<button class="menu-item" data-action="furniture">Furniture</button>`;
            panelHost.querySelector('button')!.addEventListener('click', () => ctx.close());
        },
    });
    component.mount(host);
    mounted.push(component);
    return { host, component };
}

afterEach(() => {
    for (const component of mounted.splice(0)) component.destroy();
    document.body.textContent = '';
});

test('opens on trigger click and reflects state via aria-expanded + is-open', () => {
    const { host, component } = mount();

    const trigger = host.querySelector('.popover__trigger') as HTMLButtonElement;
    const panel = host.querySelector('.popover__panel') as HTMLElement;

    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(panel.className).not.toContain('is-open');
    expect(component.open.peek()).toBe(false);

    trigger.click();

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(panel.className).toContain('is-open');
    expect(component.open.peek()).toBe(true);
    expect(panel.textContent).toContain('Furniture');
});

test('closes on outside click but not on a click inside the panel', () => {
    const { host, component } = mount();
    const trigger = host.querySelector('.popover__trigger') as HTMLButtonElement;
    trigger.click();
    expect(component.open.peek()).toBe(true);

    // Click inside the panel itself must not close it.
    (host.querySelector('.popover__panel') as HTMLElement).click();
    expect(component.open.peek()).toBe(true);

    // A click on an unrelated element outside the popover's root closes it.
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    outside.click();

    expect(component.open.peek()).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
});

test('closes on Escape', () => {
    const { host, component } = mount();
    const trigger = host.querySelector('.popover__trigger') as HTMLButtonElement;
    trigger.click();
    expect(component.open.peek()).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(component.open.peek()).toBe(false);
});

test('a menu item calling ctx.close() dismisses the popover', () => {
    const { host, component } = mount();
    const trigger = host.querySelector('.popover__trigger') as HTMLButtonElement;
    trigger.click();
    expect(component.open.peek()).toBe(true);

    (host.querySelector('.menu-item') as HTMLButtonElement).click();

    expect(component.open.peek()).toBe(false);
});

test('opening a second popover closes the first (single-open policy)', () => {
    const { host: hostA, component: a } = mount();
    document.body.appendChild(hostA); // no-op, kept for clarity

    const hostB = document.createElement('div');
    document.body.appendChild(hostB);
    const b = new PopoverComponent({
        trigger: (h) => { h.textContent = 'Feature'; },
        panel: (h) => { h.innerHTML = `<button class="menu-item">Bunker</button>`; },
    });
    b.mount(hostB);
    mounted.push(b);

    (hostA.querySelector('.popover__trigger') as HTMLButtonElement).click();
    expect(a.open.peek()).toBe(true);

    (hostB.querySelector('.popover__trigger') as HTMLButtonElement).click();
    expect(b.open.peek()).toBe(true);
    expect(a.open.peek()).toBe(false);
});
