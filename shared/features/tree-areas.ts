// Tree species areas: a drawn polygon that tells the Unity tree planter which
// species grow inside it ("almost only oaks here"). The lidar survey knows a
// stem's height, crown and broadleaf/conifer class, not its species; the planter
// races the course palette's species by weight. An area replaces that race for the
// stems inside it with its own mix. Shared by the server (validation) and the web
// selection panel; pipeline/gspro.py mirrors the format and writes the areas into
// the trees export; the planter (unity/Editor/GolfMap) applies them.

export const TREE_AREA_TYPE = 'tree_area';

/**
 * Feature attributes are flat scalars, so the mix is one string: comma-separated
 * `<species>[=<weight>]`, e.g. `"oak=9, birch=1"`. Weights are relative (default
 * 1); species are the palette's species labels (oak, birch, elm, ...).
 */
export const TREE_AREA_SPECIES_ATTRIBUTE = 'species';
/** true: the mix decides even where the lidar classed a crown conifer/broadleaf the mix does not have. */
export const TREE_AREA_IGNORE_KIND_ATTRIBUTE = 'ignoreKind';
/** Optional label shown on the map and in Unity's report. */
export const TREE_AREA_NAME_ATTRIBUTE = 'name';

export interface TreeSpeciesShare {
    species: string;
    /** Relative weight, >= 0. */
    weight: number;
}

/** Species a new row suggests; the planter reports any the course palette does not have. */
export const SUGGESTED_TREE_SPECIES = [
    'oak', 'birch', 'elm', 'poplar', 'maple', 'pine', 'spruce', 'alder', 'ash', 'beech', 'willow', 'aspen', 'lime', 'rowan', 'broadleaf', 'conifer',
] as const;

const ENTRY = /^([a-z][a-z0-9_-]*)(?:=([0-9]*\.?[0-9]+))?$/;

/** The mix a string names, or an error for the first entry that is not `<species>[=<weight>]` (or a species named twice). */
export function parseSpeciesMix(raw: string): { mix: TreeSpeciesShare[] } | { error: string } {
    const mix: TreeSpeciesShare[] = [];
    for (const part of raw.split(',')) {
        const entry = part.trim().toLowerCase();
        if (!entry) continue;
        const m = ENTRY.exec(entry);
        const weight = m?.[2] === undefined ? 1 : Number(m[2]);
        if (!m || !(weight >= 0 && Number.isFinite(weight))) return { error: `"${part.trim()}" is not <species>[=<weight>]` };
        if (mix.some(s => s.species === m[1])) return { error: `"${m[1]}" is named twice` };
        mix.push({ species: m[1]!, weight });
    }
    return { mix };
}

/** An area's mix from its attributes ([] when absent or malformed). */
export function speciesMixOf(attributes: object | null | undefined): TreeSpeciesShare[] {
    const raw = (attributes as Record<string, unknown> | null | undefined)?.[TREE_AREA_SPECIES_ATTRIBUTE];
    if (typeof raw !== 'string') return [];
    const parsed = parseSpeciesMix(raw);
    return 'mix' in parsed ? parsed.mix : [];
}

/** The area's name, '' when it has none. */
export function treeAreaNameOf(attributes: object | null | undefined): string {
    const name = (attributes as Record<string, unknown> | null | undefined)?.[TREE_AREA_NAME_ATTRIBUTE];
    return typeof name === 'string' ? name.trim() : '';
}

/** Whether the mix decides even against the survey's broadleaf/conifer class. */
export function treeAreaIgnoresKind(attributes: object | null | undefined): boolean {
    return (attributes as Record<string, unknown> | null | undefined)?.[TREE_AREA_IGNORE_KIND_ATTRIBUTE] === true;
}

/** Whether the attributes carry a mix string at all (well-formed or not). */
export function hasSpeciesMix(attributes: object | null | undefined): boolean {
    return typeof (attributes as Record<string, unknown> | null | undefined)?.[TREE_AREA_SPECIES_ATTRIBUTE] === 'string';
}

/** The attribute string for a mix (weight 1 is left out). */
export function formatSpeciesMix(mix: readonly TreeSpeciesShare[]): string {
    return mix.map(s => (s.weight === 1 ? s.species : `${s.species}=${Math.round(s.weight * 1000) / 1000}`)).join(', ');
}

/** "oak 90% · birch 10%": each species' share of the mix's total weight. */
export function speciesMixLabel(mix: readonly TreeSpeciesShare[]): string {
    const total = mix.reduce((sum, s) => sum + s.weight, 0);
    if (!(total > 0)) return 'no species';
    return mix
        .filter(s => s.weight > 0)
        .map(s => `${s.species} ${Math.round((s.weight / total) * 100)}%`)
        .join(' · ');
}

/** Why these attributes cannot be a tree species area, or null when they can. */
export function treeAreaProblem(attributes: object | null | undefined): string | null {
    const a = (attributes ?? {}) as Record<string, unknown>;
    const raw = a[TREE_AREA_SPECIES_ATTRIBUTE];
    if (typeof raw !== 'string') return `A tree species area needs attributes.${TREE_AREA_SPECIES_ATTRIBUTE}, e.g. "oak=9, birch=1"`;
    const parsed = parseSpeciesMix(raw);
    if ('error' in parsed) return `attributes.${TREE_AREA_SPECIES_ATTRIBUTE}: ${parsed.error}`;
    if (!parsed.mix.some(s => s.weight > 0)) return `attributes.${TREE_AREA_SPECIES_ATTRIBUTE} needs at least one species with a weight above 0`;
    const ignoreKind = a[TREE_AREA_IGNORE_KIND_ATTRIBUTE];
    if (ignoreKind !== undefined && typeof ignoreKind !== 'boolean') return `attributes.${TREE_AREA_IGNORE_KIND_ATTRIBUTE} must be a boolean`;
    const name = a[TREE_AREA_NAME_ATTRIBUTE];
    if (name !== undefined && typeof name !== 'string') return `attributes.${TREE_AREA_NAME_ATTRIBUTE} must be a string`;
    return null;
}
