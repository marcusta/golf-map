// A model's id (CONTEXT.md "Model"): '<renderer>:<label>[#<variant>]', where the renderer is what draws
// the model in GSPro and the label names it there:
//   arborist:<Arborist catalogue label>    a tree, bush or ground plant Arborist draws
//   vsp:<Unity prefab stem>                a tree, bush or ground plant the course's own VSP draws
//   vsp:texture:<texture file stem>        a VSP texture grass (the zone palettes' grass)
// '#<variant>' tells apart several looks of one asset (vsp:texture:Rustic Grass_15#blond); the label is
// the part before it. The only place the id is parsed or built in TypeScript/JS; the twins are
// GolfMapModels.Parse/Id (unity/Editor/GolfMap) and model_id/parse_model_id (pipeline/arborist.py); the good
// and bad ids all three agree on are model-ids.fixture.json (model-id.test.ts, pipeline/tests/test_model_id.py).
// No node or browser dependency: the server, the scripts and the web panel all read it.

export const RENDERERS = ['arborist', 'vsp'] as const;
export type Renderer = (typeof RENDERERS)[number];
export const ARBORIST: Renderer = 'arborist';
export const VSP: Renderer = 'vsp';
/** A vsp texture model's id: 'vsp:texture:<texture file stem>'. */
export const TEXTURE_PREFIX = 'texture:';

export interface ModelRef {
    renderer: Renderer;
    /** What the renderer calls the model: the Arborist catalogue label, the Unity prefab stem or the texture stem. */
    label: string;
    /** The '#<variant>' part, without the '#'; absent for the plain id. */
    variant?: string;
    /** A VSP texture grass (vsp:texture:<stem>). */
    texture?: boolean;
}

const ID = /^(arborist|vsp):(.+)$/;

function parse(id: unknown): ModelRef | null {
    const m = ID.exec(String(id ?? ''));
    if (!m) return null;
    const renderer = m[1] as Renderer;
    let rest = m[2]!;
    const hash = rest.indexOf('#');
    const variant = hash >= 0 ? rest.slice(hash + 1) : undefined;
    if (hash >= 0) rest = rest.slice(0, hash);
    const texture = renderer === VSP && rest.startsWith(TEXTURE_PREFIX);
    const label = texture ? rest.slice(TEXTURE_PREFIX.length) : rest;
    if (!label.trim() || variant === '') return null;
    const ref: ModelRef = { renderer, label };
    if (variant !== undefined) ref.variant = variant;
    if (texture) ref.texture = true;
    return ref;
}

/**
 * 'arborist:CE_DA_Forest_Tree_16018' -> {renderer: 'arborist', label: 'CE_DA_Forest_Tree_16018'};
 * 'vsp:texture:Rustic Grass_15#blond' -> {renderer: 'vsp', label: 'Rustic Grass_15', variant: 'blond', texture: true};
 * throws on any other shape.
 */
export function parseModelId(id: unknown): ModelRef {
    const ref = parse(id);
    if (!ref) throw Error(`Invalid model id '${id}': expected arborist:<catalogue label>, vsp:<Unity prefab> or vsp:texture:<texture>, optionally with #<variant>`);
    return ref;
}

/** ('vsp', 'PF_Oak_tall Terrain') -> 'vsp:PF_Oak_tall Terrain'; with a variant 'arborist:X#dark'; a texture 'vsp:texture:<stem>'. */
export function modelId(renderer: Renderer, label: string, { variant, texture }: { variant?: string; texture?: boolean } = {}): string {
    return `${renderer}:${texture ? TEXTURE_PREFIX : ''}${label}${variant ? `#${variant}` : ''}`;
}

/** The id without its renderer and variant: what Arborist or Unity calls the model. An id of another shape is returned as it is. */
export function modelLabel(id: string): string {
    return parse(id)?.label ?? id;
}

/** The renderer an id names, or null for an id of another shape (a reference to fix, shown as it is). */
export function rendererOf(id: unknown): Renderer | null {
    return parse(id)?.renderer ?? null;
}

/** How a renderer reads in the UI. */
export function rendererName(renderer: string): string {
    return renderer === ARBORIST ? 'Arborist' : renderer === VSP ? 'VSP' : renderer;
}
