// A course's tree palette resolved against its model library, as the matcher (unity/tree-matching.mjs)
// and Unity's GolfMapPalette.Load read it. One module for the server (Planting rules), the scripts
// (bun run models) and the Unity tooling's node scripts (unity/tree-models.mjs re-exports it).
//
//   docs/gspro/<course>/models.json   golfmap-models-v1: every model the course can draw. A model is
//                                     {id, species, renderer, heightM, crownWidthM, kind, form, look?,
//                                     unity?}; id = 'arborist:<catalogue label>' or 'vsp:<Unity prefab>'
//                                     (model-id.ts), renderer = what draws it, which must be the id's own
//                                     (a library saying otherwise is refused); unity = the prefab's
//                                     guid/path/assetType/catalogueGuid/originalPath for a vsp model.
//   docs/gspro/<course>/palette.json  golfmap-tree-palette-v1: rules, species weights and looks, and
//                                     assets[] = {model, enabled, selectionWeight?}: references to models.
//                                     It never names a renderer.
//
// A palette asset without `model` is the older inline form (a Unity prefab with its own guid, name and
// size; Vreta's palette): it reads as the model 'vsp:<name>'. A resolved asset's `guid` is its Unity
// prefab's (none for an Arborist model); `key` is what the matcher hashes and breaks ties on - the
// prefab guid, else the model id - so a palette moved into a library matches exactly as before.
//
// The rules for a new model (kinds, forms, catalogue labels trimmed, the first of a duplicated label)
// are the same in Unity's GolfMapModels.cs; keep the two equal.
import fs from 'node:fs';
import path from 'node:path';
import { ARBORIST, VSP, modelId, parseModelId, type Renderer } from './model-id';

export { RENDERERS, parseModelId, modelId, modelLabel } from './model-id';

export const MODELS_FORMAT = 'golfmap-models-v1';
export const PALETTE_FORMAT = 'golfmap-tree-palette-v1';
export const MODEL_KINDS = ['broadleaf', 'conifer'] as const;
export const MODEL_FORMS = ['tree', 'shrub'] as const;

const UNITY_FIELDS = ['path', 'assetType', 'catalogueGuid', 'originalPath'] as const;

export interface UnityPrefab { guid?: string; path?: string; assetType?: string; catalogueGuid?: string; originalPath?: string }

export interface LibraryModel {
    id: string;
    species?: string;
    renderer: Renderer;
    heightM: number;
    crownWidthM: number;
    kind: string;
    form: string;
    look?: Record<string, unknown>;
    unity?: UnityPrefab;
}

export interface ModelLibrary { format: string; models: LibraryModel[] }

/** A palette's assets[] entry: a reference ({model, enabled, selectionWeight}) or the inline prefab form. */
export type PaletteAsset = Record<string, unknown> & { model?: string; enabled?: boolean; selectionWeight?: number; name?: string; guid?: string };

/** One palette asset as the matcher reads it: the model's species, size and form, the palette's enabled and share. */
export interface ResolvedAsset {
    /** The Unity prefab's guid; absent for an Arborist model, which has no prefab. */
    guid?: string;
    /** What the matcher hashes and breaks ties on: the prefab guid, else the model id. */
    key: string;
    name: string;
    model: string;
    renderer: Renderer;
    heightM: number;
    crownWidthM: number;
    kind?: string;
    form?: string;
    species?: string;
    enabled?: boolean;
    selectionWeight?: number;
    look?: Record<string, unknown>;
    path?: string;
    assetType?: string;
    catalogueGuid?: string;
    originalPath?: string;
    [field: string]: unknown;
}

export interface CatalogueModel { label: string; heightM: number; crownWidthM: number; address?: unknown }

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));

/** The course's model library (empty when it has none yet). Refuses a model whose renderer is not its id's, and an id twice. */
export function loadModelLibrary(courseDocsDir: string): ModelLibrary {
    const file = path.join(courseDocsDir, 'models.json');
    if (!fs.existsSync(file)) return { format: MODELS_FORMAT, models: [] };
    const doc = readJson(file);
    if (doc.format !== MODELS_FORMAT || !Array.isArray(doc.models)) throw Error(`Invalid model library ${file}: format must be ${MODELS_FORMAT}`);
    const seen = new Set<string>();
    for (const m of doc.models as LibraryModel[]) {
        const { renderer } = parseModelId(m.id);
        if (m.renderer !== undefined && m.renderer !== renderer) throw Error(`Model ${m.id} in ${file} says renderer '${m.renderer}', but its id is ${renderer}'s`);
        if (seen.has(m.id)) throw Error(`Model ${m.id} is in ${file} twice`);
        seen.add(m.id);
    }
    return doc;
}

/** One palette asset resolved through the library (by id). Throws when it refers to a model the library lacks. */
export function resolveAsset(asset: PaletteAsset, byId: Map<string, LibraryModel>): ResolvedAsset {
    if (!asset.model) {
        // The inline form: a Unity prefab named by the palette itself.
        return { ...asset, key: asset.guid as string, model: modelId(VSP, asset.name as string), renderer: VSP } as ResolvedAsset;
    }
    const model = byId.get(asset.model);
    if (!model) throw Error(`Palette asset ${asset.model} is not in the course's model library (models.json)`);
    const { renderer, label } = parseModelId(model.id);
    const unity = model.unity ?? {};
    const out: ResolvedAsset = {
        key: unity.guid || model.id, name: label, model: model.id, renderer,
        heightM: model.heightM, crownWidthM: model.crownWidthM, kind: model.kind, form: model.form,
        enabled: asset.enabled !== false,
    };
    if (unity.guid) out.guid = unity.guid;
    if (model.species) out.species = model.species;
    for (const k of UNITY_FIELDS) if (unity[k] !== undefined) out[k] = unity[k];
    if (asset.selectionWeight !== undefined) out.selectionWeight = asset.selectionWeight;
    if (model.look) out.look = model.look;
    return out;
}

/** A palette document and a library -> the matcher's config (the palette with resolved assets). */
export function resolvePalette<P extends { format?: string; assets?: PaletteAsset[] }>(palette: P, library: ModelLibrary | null | undefined): P & { assets: ResolvedAsset[] } {
    if (palette.format !== PALETTE_FORMAT) throw Error(`Palette format must be ${PALETTE_FORMAT}`);
    const byId = new Map((library?.models ?? []).map((m) => [m.id, m]));
    return { ...palette, assets: (palette.assets ?? []).map((a) => resolveAsset(a, byId)) };
}

/** Arborist's model sizes (data/arborist/catalog-sizes.json, the mod's arb.catalog with sizes) by label. */
export function loadArboristCatalogue(file: string): Map<string, CatalogueModel> {
    const doc = readJson(file);
    const assets = doc.result?.assets ?? doc.assets;
    if (!Array.isArray(assets)) throw Error(`No assets in Arborist's catalogue sizes ${file}`);
    const models = new Map<string, CatalogueModel>();
    for (const a of assets) {
        // Several catalogue labels end in a space; labels are compared without it. The first of a label counts.
        const label = String(a.label).trim();
        if (a.heightM > 0 && a.widthM > 0 && !models.has(label)) models.set(label, { label, heightM: a.heightM, crownWidthM: a.widthM, address: a.address });
    }
    return models;
}

export interface NewArboristModel { id: string; species: string; kind?: string; form?: string; look?: Record<string, unknown> }

/**
 * A new model for the library: an Arborist model sized from Arborist's catalogue (its first LOD).
 * Refuses a label the catalogue does not have, and an id the library already holds. Returns the new
 * library document and the model; writes nothing.
 */
export function addArboristModel(library: ModelLibrary, { id, species, kind = 'broadleaf', form = 'tree', look }: NewArboristModel,
    catalogue: Map<string, CatalogueModel>): { library: ModelLibrary; model: LibraryModel } {
    const { renderer, label } = parseModelId(id);
    if (renderer !== ARBORIST) throw Error(`${id}: only Arborist models are added here; a vsp model joins from Unity's Palette panel (it needs the prefab)`);
    if (!species) throw Error('A model needs its species (--species)');
    if (!(MODEL_KINDS as readonly string[]).includes(kind)) throw Error(`kind must be broadleaf or conifer, not '${kind}'`);
    if (!(MODEL_FORMS as readonly string[]).includes(form)) throw Error(`form must be tree or shrub, not '${form}'`);
    const size = catalogue.get(label);
    if (!size) throw Error(`Arborist has no model '${label}' (not in its catalogue sizes)`);
    if ((library.models ?? []).some((m) => m.id === id)) throw Error(`${id} is already in the model library`);
    const model: LibraryModel = { id, species, renderer, heightM: size.heightM, crownWidthM: size.crownWidthM, kind, form };
    if (look) model.look = look;
    return { library: { ...library, format: MODELS_FORMAT, models: [...(library.models ?? []), model] }, model };
}

export function writeModelLibrary(courseDocsDir: string, library: ModelLibrary): void {
    fs.writeFileSync(path.join(courseDocsDir, 'models.json'), JSON.stringify(library, null, 2) + '\n');
}

/** A palette file read with the model library beside it (models.json in the same folder). */
export function loadPaletteFile(paletteFile: string) {
    return resolvePalette(readJson(paletteFile), loadModelLibrary(path.dirname(paletteFile)));
}

/** docs/gspro/<course>/: palette.json + models.json -> the matcher's config. */
export function loadCoursePalette(courseDocsDir: string) {
    return loadPaletteFile(path.join(courseDocsDir, 'palette.json'));
}
