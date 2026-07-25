import type { AuthUser } from '@basics/core/client/auth';

/** The mobile companion's route root — every app screen lives under this. */
export const MOBILE_ROOT = '/m';
export const MOBILE_LOGIN = '/m/login';

/**
 * Route guard for the mobile companion (mirrors auth/guard.ts, scoped to the
 * `/m/*` tree). Returns the route to redirect to, or null when the current
 * route is allowed as-is.
 *
 * - Any path OUTSIDE `/m` (a bare `/mobile.html` dev load, or `/`) normalises
 *   to the course list `/m` — the mobile app never renders desktop routes.
 * - No session → everything except `/m/login` redirects to `/m/login`.
 * - Active session → `/m/login` redirects to the course list.
 */
export function guardMobileRoute(user: AuthUser | null, route: string): string | null {
    const inTree = route === MOBILE_ROOT || route.startsWith(MOBILE_ROOT + '/');
    if (!inTree) return user ? MOBILE_ROOT : MOBILE_LOGIN;
    if (!user) return route === MOBILE_LOGIN ? null : MOBILE_LOGIN;
    if (route === MOBILE_LOGIN) return MOBILE_ROOT;
    return null;
}
