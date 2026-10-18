// A tree model's id (CONTEXT.md "Model"): '<renderer>:<label>', where the renderer is what draws the
// model in GSPro and the label names it there - 'arborist:<Arborist catalogue label>' or
// 'vsp:<Unity prefab name>'. The only place the id is parsed or built in TypeScript/JS; the twins are
// GolfMapModels.Parse/Id (unity/Editor/GolfMap) and model_id/parse_model_id (pipeline/arborist.py).
// No node or browser dependency: the server, the scripts and the web panel all read it.

export const RENDERERS = ['arborist', 'vsp'] as const;
export type Renderer = (typeof RENDERERS)[number];
export const ARBORIST: Renderer = 'arborist';
export const VSP: Renderer = 'vsp';

export interface ModelRef { renderer: Renderer; label: string }

const ID = /^(arborist|vsp):(.+)$/;

/** 'arborist:CE_DA_Forest_Tree_16018' -> {renderer: 'arborist', label: 'CE_DA_Forest_Tree_16018'}; throws on any other shape. */
export function parseModelId(id: unknown): ModelRef {
    const m = ID.exec(String(id ?? ''));
    if (!m) throw Error(`Invalid model id '${id}': expected arborist:<catalogue label> or vsp:<Unity prefab>`);
    return { renderer: m[1] as Renderer, label: m[2]! };
}

/** ('vsp', 'PF_Oak_tall Terrain') -> 'vsp:PF_Oak_tall Terrain'. */
export function modelId(renderer: Renderer, label: string): string {
    return `${renderer}:${label}`;
}

/** The id without its renderer: what Arborist or Unity calls the model. An id of another shape is returned as it is. */
export function modelLabel(id: string): string {
    return ID.exec(id)?.[2] ?? id;
}

/** The renderer an id names, or null for an id of another shape (a reference to fix, shown as it is). */
export function rendererOf(id: unknown): Renderer | null {
    return (ID.exec(String(id ?? ''))?.[1] as Renderer | undefined) ?? null;
}

/** How a renderer reads in the UI. */
export function rendererName(renderer: string): string {
    return renderer === ARBORIST ? 'Arborist' : renderer === VSP ? 'VSP' : renderer;
}
