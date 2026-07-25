import type { AuthUser } from '@basics/core/client/auth';
import { isBuilderRoute, type ServerMode } from '../app/server-mode.service';

/**
 * Route guard: given the current user, route and server mode, return the
 * route to redirect to, or null when the route is allowed as-is.
 *
 * - No session → everything except /login redirects to /login.
 * - Active session → /login redirects to the course list.
 * - Serve mode → builder-only routes redirect to the course list. Their APIs
 *   are not mounted on a VPS, so the page would only render a wall of 404s;
 *   a bookmark or a stale tab lands somewhere useful instead.
 */
export function guardRoute(
    user: AuthUser | null,
    route: string,
    mode: ServerMode = 'builder',
): string | null {
    if (!user) return route === '/login' ? null : '/login';
    if (route === '/login') return '/';
    if (mode === 'serve' && isBuilderRoute(route)) return '/';
    return null;
}
