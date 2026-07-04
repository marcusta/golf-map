import { test, expect } from 'bun:test';
import { guardRoute } from '../src/auth/guard';

const marcus = { id: 'u1', username: 'marcus' };

test('no session: any app route redirects to /login', () => {
    expect(guardRoute(null, '/')).toBe('/login');
    expect(guardRoute(null, '/course/abc-123')).toBe('/login');
});

test('no session: /login is allowed', () => {
    expect(guardRoute(null, '/login')).toBeNull();
});

test('active session: app routes are allowed', () => {
    expect(guardRoute(marcus, '/')).toBeNull();
    expect(guardRoute(marcus, '/course/abc-123')).toBeNull();
});

test('active session: /login redirects to the course list', () => {
    expect(guardRoute(marcus, '/login')).toBe('/');
});
