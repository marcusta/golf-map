/**
 * Route → swap key.
 *
 * `$swap` matches an exact key first, then the longest key the route starts
 * with. That prefix rule cannot express a SUFFIX route: the green screen's
 * `/m/course/:id/hole/:n/green` is a strict extension of the hole screen's
 * `/m/course` prefix, so both would land on the hole screen.
 *
 * Rewriting the green route to its own `/m/green/...` prefix restores a clean
 * prefix match while keeping the URL the doc's route table specifies. The
 * screens still parse the ORIGINAL router route (identical segment indices in
 * both shapes: [3] = course id, [5] = hole number), so this is purely a
 * dispatch key, never a navigation target.
 */
export const GREEN_SUFFIX = '/green';

export function swapKey(route: string): string {
    if (route.startsWith('/m/course/') && route.endsWith(GREEN_SUFFIX)) {
        return `/m/green/${route.slice('/m/course/'.length, -GREEN_SUFFIX.length)}`;
    }
    return route;
}

/** The green route for a hole — the single place that URL is spelled. */
export function greenRoute(courseId: string, holeNumber: number): string {
    return `/m/course/${courseId}/hole/${holeNumber}${GREEN_SUFFIX}`;
}
