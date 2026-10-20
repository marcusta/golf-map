// How a `path` feature becomes ground in GSPro — the `render` attribute.
// Absent or `opcd` = an OPCD road mesh built from the SVG (the default);
// `ram` = a NatureManufacture R.A.M. spline lying on the OPCD ground meshes,
// built in Unity by `golfmap.ramroads.build` from `<slug>-inner-ramroads.json`
// (`gspro.py ramroads`). The SVG leaves render=ram roads out, so OPCD builds
// the ground under them as if there were no road. Mirrored by the pipeline
// (pipeline/gspro.py RAM_RENDER). A R.A.M. road needs its centerline (the
// spline is drawn along it) and a bridge deck is a prop, never a road.

import type { FeatureCenterline } from './centerline';

export const PATH_RENDER_ATTRIBUTE = 'render';

export const PATH_RENDERS = ['opcd', 'ram'] as const;

export type PathRender = (typeof PATH_RENDERS)[number];

export function isPathRender(value: unknown): value is PathRender {
    return typeof value === 'string' && (PATH_RENDERS as readonly string[]).includes(value);
}

/** The path's render; absent (or anything unknown) is `opcd`. */
export function pathRender(attributes: object | null | undefined): PathRender {
    const value = (attributes as Record<string, unknown> | null | undefined)?.[PATH_RENDER_ATTRIBUTE];
    return isPathRender(value) ? value : 'opcd';
}

/** Null when `value` is a valid render for a feature of this type, centerline and surface. */
export function pathRenderError(value: unknown, type: string, centerline: FeatureCenterline | undefined, surface: unknown): string | null {
    if (value === undefined) return null;
    if (!isPathRender(value)) return `attributes.${PATH_RENDER_ATTRIBUTE} must be one of ${PATH_RENDERS.join(', ')}`;
    if (value === 'opcd') return null;
    if (type !== 'path' || !centerline) return `attributes.${PATH_RENDER_ATTRIBUTE} = ram needs a path drawn as a centerline`;
    if (surface === 'bridge') return `attributes.${PATH_RENDER_ATTRIBUTE} = ram cannot be a bridge deck`;
    return null;
}
