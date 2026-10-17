// What a `path` feature is made of — the `surface` attribute on roads, cart
// paths, parking lots and boardwalks. Shared by the server (validation), the
// web client (picker, map colours) and mirrored by the pipeline
// (pipeline/golfpipe/roads.py PATH_SURFACES — keep the two lists equal).
//
// The GSPro export merges the roads of every surface into one concrete shape
// per network (`roads_<n>`, as OPCD builds them best; OPCD has one hard
// surface) and writes the surfaces to a `<stem>-paths.json` sidecar (shape ->
// dominant surface, plus every piece's surface and outline for the Blender step
// that cuts a mixed mesh along the seams); only grass tracks are written apart,
// as rough (`data-surface="grass"`). The surface is what the Unity side remaps
// the mesh's look and collider material from.
//
// `gravel-track` is a gravel road with a grass strip down the middle between
// the wheel tracks (grusväg med gräsmitt, a brukningsväg; OSM highway=track,
// tracktype grade2/grade3). It is gravel to everything downstream of the
// export (material, collider, seams): only the Blender paint adds the grass
// centre, which Unity then grows grass on.

export const PATH_SURFACE_ATTRIBUTE = 'surface';

export const PATH_SURFACES = ['asphalt', 'concrete', 'paving', 'gravel', 'gravel-track', 'dirt', 'grass', 'wood'] as const;

export type PathSurface = (typeof PATH_SURFACES)[number];

export function isPathSurface(value: unknown): value is PathSurface {
    return typeof value === 'string' && (PATH_SURFACES as readonly string[]).includes(value);
}

/** The feature's surface when it has a valid one, else null (unknown). */
export function pathSurfaceOf(attributes: object | null | undefined): PathSurface | null {
    const value = (attributes as Record<string, unknown> | null | undefined)?.[PATH_SURFACE_ATTRIBUTE];
    return isPathSurface(value) ? value : null;
}

/** Loose surfaces: the ones path transitions and wear paint (a gravel track is gravel). */
export function isLoosePathSurface(value: unknown): boolean {
    return value === 'gravel' || value === 'gravel-track' || value === 'dirt';
}

export const PATH_SURFACE_LABELS: Record<PathSurface, string> = {
    asphalt: 'Asphalt',
    concrete: 'Concrete',
    paving: 'Paving stones',
    gravel: 'Gravel',
    'gravel-track': 'Gravel, grass middle',
    dirt: 'Dirt',
    grass: 'Grass track',
    wood: 'Wood / boardwalk',
};

/** Map fill per surface, so a road's material reads at a glance on the ortho. */
export const PATH_SURFACE_COLORS: Record<PathSurface, string> = {
    asphalt: '#55585e',
    concrete: '#c4c4bf',
    paving: '#b0714f',
    gravel: '#d2bb8a',
    'gravel-track': '#b3b47a',
    dirt: '#8f6a45',
    grass: '#8db562',
    wood: '#7a4b2a',
};
