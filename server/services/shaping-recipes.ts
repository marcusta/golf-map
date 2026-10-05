// The Blender shaping recipe library (blender/SHAPING-PLAN.md, "Terrain editor
// → Blender"): `blender/recipes/library.json` indexes the Afrod JSON recipes a
// course feature can be shaped with — third-party files stay in
// GOLFMAP_AFROD_RECIPES, ours in blender/recipes/ — and marks the course
// default per surface. golf-map only reads it: the terrain editor lists it
// (`GET /api/shaping/recipes`), a `recipe` terrain edit names an entry by `id`,
// and `gspro.py shaping-global` turns the edits (and the defaults) into
// `afrod.recipe` ops naming the entry's `file`.
import * as path from 'node:path';
import { readFile } from 'node:fs/promises';

export const RECIPE_SURFACES = ['bunker', 'lake', 'creek', 'path'] as const;
export type RecipeSurface = (typeof RECIPE_SURFACES)[number];

/** The recipe surface of a course feature type; types not listed take no recipe. */
export const FEATURE_RECIPE_SURFACE: Readonly<Record<string, RecipeSurface>> = {
    bunker: 'bunker',
    water: 'lake',
    water_creek: 'creek',
    path: 'path',
};

/** The recipe id that opts a feature out: no recipe op at all, not even its surface's default. */
export const NO_RECIPE = 'none';

/** The override key every recipe takes besides its params: the random seed (an integer; default the feature number). */
export const RECIPE_SEED = 'seed';

/**
 * One knob a library entry declares (SHAPING-PLAN.md, "Composite and
 * parameterised recipes"). The library's `maps` (which step fields it sets
 * or scales) are the Blender engine's business and not served.
 */
export interface RecipeParam {
    id: string;
    label: string;
    unit?: string;
    min: number;
    max: number;
    step?: number;
    default: number;
}

/** One library entry, as the API serves it. */
export interface ShapingRecipe {
    id: string;
    name: string;
    /** The recipe file, resolved by the Blender engine in GOLFMAP_AFROD_RECIPES, then blender/recipes/. */
    file: string;
    author: string;
    surfaces: RecipeSurface[];
    /** The course default for the surface asked for (for any of its surfaces when none was asked). */
    default?: boolean;
    notes?: string;
    /** The knobs a feature's recipe edit may override (`overrides: {<id>: value, seed?}`); [] when it declares none. */
    params: RecipeParam[];
}

/** A parsed entry: `defaultFor` lists the surfaces it is the default of. */
export interface RecipeLibraryEntry extends Omit<ShapingRecipe, 'default'> {
    defaultFor: RecipeSurface[];
}

/** The repo's library; GOLFMAP_RECIPE_LIBRARY overrides it (a path to another library.json). */
export function defaultRecipeLibraryPath(): string {
    const override = process.env.GOLFMAP_RECIPE_LIBRARY;
    if (override) return path.resolve(override);
    return path.resolve(import.meta.dir, '..', '..', 'blender', 'recipes', 'library.json');
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * An entry's declared params: an id (a plain identifier, not `seed`, once
 * each), finite min < max, a default within them, an optional step > 0.
 * A malformed param is dropped, like a malformed entry; the label defaults
 * to the id.
 */
function parseParams(raw: unknown): RecipeParam[] {
    if (!Array.isArray(raw)) return [];
    const out: RecipeParam[] = [];
    for (const item of raw) {
        const p = item as Record<string, unknown> | null;
        if (!p || typeof p !== 'object') continue;
        const { id, min, max, step } = p;
        if (typeof id !== 'string' || !/^[A-Za-z_]\w*$/.test(id) || id === RECIPE_SEED || out.some(o => o.id === id)) continue;
        if (!finite(min) || !finite(max) || !(min < max)) continue;
        const def = p.default;
        if (!finite(def) || def < min || def > max) continue;
        if (step !== undefined && !(finite(step) && step > 0)) continue;
        out.push({
            id,
            label: typeof p.label === 'string' && p.label ? p.label : id,
            ...(typeof p.unit === 'string' && p.unit ? { unit: p.unit } : {}),
            min,
            max,
            ...(step !== undefined ? { step } : {}),
            default: def,
        });
    }
    return out;
}

const isSurface = (s: unknown): s is RecipeSurface => typeof s === 'string' && (RECIPE_SURFACES as readonly string[]).includes(s);

/**
 * The library's entries in file order, or null when there is no library file.
 * Takes a top-level array or `{ recipes: [...] }`. An entry without a string
 * `id` or `file` is skipped (never fatal: the editor still lists the rest);
 * unknown surfaces are dropped. `default` is `true` (default for every surface
 * the recipe lists), a surface, or a list of surfaces. `params` keeps only
 * well-formed params (parseParams) and is [] without any.
 */
export async function loadRecipeLibrary(file: string): Promise<RecipeLibraryEntry[] | null> {
    let text: string;
    try {
        text = await readFile(file, 'utf8');
    } catch {
        return null;
    }
    let doc: unknown;
    try {
        doc = JSON.parse(text);
    } catch (e) {
        throw new Error(`Recipe library ${file} is not valid JSON: ${(e as Error).message}`);
    }
    const list = Array.isArray(doc) ? doc : (doc as { recipes?: unknown } | null)?.recipes;
    if (!Array.isArray(list)) throw new Error(`Recipe library ${file} must be a list of recipes (or { "recipes": [...] })`);
    const entries: RecipeLibraryEntry[] = [];
    const seen = new Set<string>();
    for (const raw of list) {
        const r = raw as Record<string, unknown>;
        if (!r || typeof r.id !== 'string' || !r.id || typeof r.file !== 'string' || !r.file) continue;
        if (seen.has(r.id) || r.id === NO_RECIPE) continue;
        seen.add(r.id);
        const surfaces = (Array.isArray(r.surfaces) ? r.surfaces : typeof r.surfaces === 'string' ? [r.surfaces] : []).filter(isSurface);
        const d = r.default;
        const defaultFor = d === true ? surfaces
            : (Array.isArray(d) ? d : [d]).filter((s): s is RecipeSurface => isSurface(s) && surfaces.includes(s));
        entries.push({
            id: r.id,
            name: typeof r.name === 'string' && r.name ? r.name : r.id,
            file: r.file,
            author: typeof r.author === 'string' ? r.author : '',
            surfaces: [...new Set(surfaces)],
            defaultFor: [...new Set(defaultFor)],
            ...(typeof r.notes === 'string' && r.notes ? { notes: r.notes } : {}),
            params: parseParams(r.params),
        });
    }
    return entries;
}

/** The entries for one surface (all without one), with `default` for that surface. */
export function recipesFor(entries: RecipeLibraryEntry[], surface?: RecipeSurface): ShapingRecipe[] {
    return entries
        .filter(e => !surface || e.surfaces.includes(surface))
        .map(({ defaultFor, ...e }) => {
            const isDefault = surface ? defaultFor.includes(surface) : defaultFor.length > 0;
            return isDefault ? { ...e, default: true } : e;
        });
}
