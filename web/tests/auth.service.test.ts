import { test, expect, afterEach } from 'bun:test';
import { effect } from '@basics/core/client/core';
import { AuthService } from '@basics/core/client/auth';
import { _reset } from '@basics/core/client/error-report';

// AuthService state transitions against a stubbed global fetch — the real
// service, the real apiFetch/request layers, only the network is substituted.

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
    _reset();
});

const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });

/** Stub fetch by URL suffix; unknown URLs (e.g. error reports) get a 200. */
function stubFetch(routes: Record<string, () => Response>): void {
    globalThis.fetch = ((input: RequestInfo | URL) => {
        const url = String(input);
        for (const [suffix, respond] of Object.entries(routes)) {
            if (url.endsWith(suffix)) return Promise.resolve(respond());
        }
        return Promise.resolve(json(200, {}));
    }) as typeof fetch;
}

const marcus = { id: 'u1', username: 'marcus' };

test('load with active session sets currentUser', async () => {
    stubFetch({ '/api/auth/me': () => json(200, marcus) });
    const auth = new AuthService();

    await auth.load();

    expect(auth.currentUser.get()).toEqual(marcus);
    expect(auth.loading.get()).toBe(false);
    expect(auth.error.get()).toBeNull();
});

test('load with no session (401) leaves user null and clears the error', async () => {
    stubFetch({ '/api/auth/me': () => json(401, { error: 'Unauthorized' }) });
    const auth = new AuthService();

    await auth.load();

    expect(auth.currentUser.get()).toBeNull();
    expect(auth.loading.get()).toBe(false);
    // 401 on initial load is expected — AuthService clears the auth error
    expect(auth.error.get()).toBeNull();
});

test('login success sets currentUser and toggles loading', async () => {
    stubFetch({ '/api/auth/login': () => json(200, marcus) });
    const auth = new AuthService();

    const loadingStates: boolean[] = [];
    effect(() => loadingStates.push(auth.loading.get()));

    const ok = await auth.login('marcus', 'change-me');

    expect(ok).toBe(true);
    expect(auth.currentUser.get()).toEqual(marcus);
    expect(auth.error.get()).toBeNull();
    expect(loadingStates).toEqual([false, true, false]);
});

test('login failure sets auth error and leaves user null', async () => {
    stubFetch({ '/api/auth/login': () => json(401, { error: 'Invalid credentials' }) });
    const auth = new AuthService();

    const ok = await auth.login('marcus', 'wrong');

    expect(ok).toBe(false);
    expect(auth.currentUser.get()).toBeNull();
    expect(auth.error.get()?.code).toBe('auth');
    expect(auth.loading.get()).toBe(false);
});

test('logout clears currentUser', async () => {
    stubFetch({
        '/api/auth/login': () => json(200, marcus),
        '/api/auth/logout': () => json(200, { ok: true }),
    });
    const auth = new AuthService();

    await auth.login('marcus', 'change-me');
    expect(auth.currentUser.get()).toEqual(marcus);

    await auth.logout();
    expect(auth.currentUser.get()).toBeNull();
    expect(auth.error.get()).toBeNull();
});
