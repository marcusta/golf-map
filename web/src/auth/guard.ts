import type { AuthUser } from '@basics/core/client/auth';

/**
 * Route guard: given the current user and route, return the route to
 * redirect to, or null when the route is allowed as-is.
 *
 * - No session → everything except /login redirects to /login.
 * - Active session → /login redirects to the course list.
 */
export function guardRoute(user: AuthUser | null, route: string): string | null {
    if (!user) return route === '/login' ? null : '/login';
    if (route === '/login') return '/';
    return null;
}
