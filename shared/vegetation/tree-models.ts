// A course's tree palette resolved against its model library, as the matcher (unity/tree-matching.mjs)
// and Unity's GolfMapPalette.Load read it. One module for the server (Planting rules), the scripts
// (bun run models) and the Unity tooling's node scripts (unity/tree-models.mjs re-exports it).
//
//   docs/gspro/model-library.json     golfmap-model-library-v1: the shared model library, every model any
//                                     course can draw. A model is {id, species, renderer, heightM,
//                                     crownWidthM, kind, form, look?, unity?}; id = 'arborist:<catalogue
//                                     label>' or 'vsp:<Unity prefab>' (model-id.ts), renderer = what draws
//                                     it, which must be the id's own (a library saying otherwise is
//                                     refused); unity = the prefab's guid/path/assetType/catalogueGuid/
//                                     originalPath for a vsp model; look = its base look.
//   docs/gspro/<course>/models.json   golfmap-models-v1: the course's overrides. An entry whose id is in the
//                                     shared library is deep-merged onto it (a look tuned to the course's
//                                     light; `disabled: true` leaves the model out of the course); any
//                                     other entry is a course-only model, complete. A course without the
//                                     file inherits the whole shared library. loadModelLibrary resolves
//                                     the two (shared order, then the course-only models); that resolved
//                                     library is what Unity's copy holds (model-sync.ts).
//   docs/gspro/<course>/palette.json  golfmap-tree-palette-v1: rules, species weights and looks, and
//                                     assets[] = {model, enabled, selectionWeight?}: references to models.
//                                     It never names a renderer.
//
// A palette asset without `model` is the older inline form (a Unity prefab with its own guid, name and
// size; Vreta's palette): it reads as the model 'vsp:<name>'. A resolved asset's `guid` is its Unity
// prefab's (none for an Arborist model); `key` is what the matcher hashes and breaks ties on - the
// prefab guid, else the model id - so a palette moved into a library matches exactly as before.
//
// A new model's rules (kinds, forms, catalogue labels trimmed, the first of a duplicated label) live only
// here: Unity's Palette panel runs `bun run models -- add` (scripts/models.ts).
import fs from 'node:fs';
import path from 'node:path';
import { ARBORIST, VSP, modelId, parseModelId, type Renderer } from './model-id';

export { RENDERERS, parseModelId, modelId, modelLabel } from './model-id';

export const MODELS_FORMAT = 'golfmap-models-v1';
export const SHARED_LIBRARY_FORMAT = 'golfmap-model-library-v1';
/** The shared library's file name, in the course docs root (docs/gspro/) beside the course folders. */
export const SHARED_LIBRARY_FILE = 'model-library.json';
export const PALETTE_FORMAT = 'golfmap-tree-palette-v1';
export const MODEL_KINDS = ['broadleaf', 'conifer'] as const;
/** tree: a tree; shrub: a bush (a tree palette's or a zone palette's); plant: a ground plant; grass: a VSP texture grass. */
export const MODEL_FORMS = ['tree', 'shrub', 'plant', 'grass'] as const;
/** The forms a zone palette item (grass-palette.json) may refer to: lower vegetation. They need no kind. */
export const LOWER_FORMS = ['grass', 'plant', 'shrub'] as const;
export const isLowerForm = (form: unknown): boolean => (LOWER_FORMS as readonly string[]).includes(String(form));
/** Whether zone items wear `model` rather than tree palettes: a lower form, a bush only without a tree's kind. */
export const isZoneModel = (model: { form?: string; kind?: string }): boolean => isLowerForm(model.form) && !(model.form === 'shrub' && model.kind);

const UNITY_FIELDS = ['path', 'assetType', 'catalogueGuid', 'originalPath'] as const;

export interface UnityPrefab { guid?: string; path?: string; assetType?: string; catalogueGuid?: string; originalPath?: string }

export interface LibraryModel {
    id: string;
    species?: string;
    renderer: Renderer;
    /** Required for a tree; optional for a lower-vegetation model (a vsp texture or prefab is sized by its zone item). */
    heightM: number;
    crownWidthM: number;
    /** broadleaf | conifer: a tree's; a lower-vegetation model needs none. */
    kind?: string;
    form: string;
    look?: Record<string, unknown>;
    unity?: UnityPrefab;
}

export interface ModelLibrary { format: string; models: LibraryModel[]; [key: string]: unknown }

/** A course file's entry: an override of a shared model (any subset of its fields, `disabled`), or a course-only model. */
export type ModelOverride = Partial<LibraryModel> & { id: string; disabled?: boolean; [key: string]: unknown };

/** A course's models.json as written: its overrides and course-only models. */
export interface CourseModels { format: string; models: ModelOverride[]; [key: string]: unknown }

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

/** A JSON file, a UTF-8 byte order mark allowed (the files Unity and Windows editors write). */
export const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));

/** Every entry has an id, no id twice, and a renderer (when given) that is its id's. */
function checkModels(models: ModelOverride[], file: string): void {
    const seen = new Set<string>();
    for (const m of models) {
        const { renderer, texture } = parseModelId(m.id);
        if (m.renderer !== undefined && m.renderer !== renderer) throw Error(`Model ${m.id} in ${file} says renderer '${m.renderer}', but its id is ${renderer}'s`);
        if (m.form !== undefined && !(MODEL_FORMS as readonly string[]).includes(m.form)) throw Error(`Model ${m.id} in ${file}: form must be ${MODEL_FORMS.join(', ')}, not '${m.form}'`);
        if (texture && m.form !== undefined && m.form !== 'grass') throw Error(`Model ${m.id} in ${file} is a texture grass: its form must be grass, not '${m.form}'`);
        if (seen.has(m.id)) throw Error(`Model ${m.id} is in ${file} twice`);
        seen.add(m.id);
    }
}

/** The shared library's file for a course docs folder (or the docs root itself): <docs root>/model-library.json. */
export function sharedLibraryFile(courseDocsDir: string): string {
    return path.join(path.dirname(path.resolve(courseDocsDir)), SHARED_LIBRARY_FILE);
}

/** The shared library in `docsRoot` (empty when there is none). */
export function loadSharedLibrary(docsRoot: string): ModelLibrary {
    const file = path.join(docsRoot, SHARED_LIBRARY_FILE);
    if (!fs.existsSync(file)) return { format: SHARED_LIBRARY_FORMAT, models: [] };
    const doc = readJson(file);
    if (doc.format !== SHARED_LIBRARY_FORMAT || !Array.isArray(doc.models)) throw Error(`Invalid shared model library ${file}: format must be ${SHARED_LIBRARY_FORMAT}`);
    checkModels(doc.models, file);
    return doc;
}

/** The course's own models.json as written (overrides and course-only models); empty when it has none. */
export function loadCourseModels(courseDocsDir: string): CourseModels {
    const file = path.join(courseDocsDir, 'models.json');
    if (!fs.existsSync(file)) return { format: MODELS_FORMAT, models: [] };
    const doc = readJson(file);
    if (doc.format !== MODELS_FORMAT || !Array.isArray(doc.models)) throw Error(`Invalid model library ${file}: format must be ${MODELS_FORMAT}`);
    checkModels(doc.models, file);
    return doc;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * `over` onto `base`: objects merge key by key (onto an empty one when `base` has none), anything else
 * replaces; null removes the key, at any depth. The one merge of the model library: a course's override onto
 * its shared model, a look change (`models -- look`), a zone item's --set.
 */
export function deepMerge<T extends Record<string, unknown>>(base: T, over: Record<string, unknown>): T {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(over)) {
        if (v === null) delete out[k];
        else if (isObject(v)) out[k] = deepMerge(isObject(out[k]) ? out[k] as Record<string, unknown> : {}, v);
        else out[k] = v;
    }
    return out as T;
}

/**
 * A course's library: each shared model with the course's override deep-merged onto it (`disabled` ones
 * left out), in the shared library's order, then the course-only models in the course file's order. The
 * course file's other top-level keys (its comment) come along.
 */
export function resolveModelLibrary(shared: ModelLibrary, course: CourseModels): ModelLibrary {
    const overrides = new Map(course.models.map((m) => [m.id, m]));
    const models: LibraryModel[] = [];
    for (const base of shared.models) {
        const over = overrides.get(base.id);
        if (over?.disabled) continue;
        const { disabled: _off, ...change } = over ?? { id: base.id };
        models.push(over ? deepMerge(base as unknown as Record<string, unknown>, change) as unknown as LibraryModel : base);
    }
    const sharedIds = new Set(shared.models.map((m) => m.id));
    for (const m of course.models) {
        if (sharedIds.has(m.id)) continue;
        const { disabled, ...model } = m;
        if (disabled) throw Error(`Model ${m.id} is disabled in the course's models.json but is not in the shared library (${SHARED_LIBRARY_FILE})`);
        models.push(model as LibraryModel);
    }
    const { models: _ignored, format: _format, ...rest } = course;
    return { format: MODELS_FORMAT, ...rest, models };
}

/**
 * The course's model library, resolved: the shared library (<docs root>/model-library.json) with the
 * course's models.json over it. Empty when neither exists. Refuses a model whose renderer is not its id's,
 * and an id twice in either file.
 */
export function loadModelLibrary(courseDocsDir: string): ModelLibrary {
    return resolveModelLibrary(loadSharedLibrary(path.dirname(path.resolve(courseDocsDir))), loadCourseModels(courseDocsDir));
}

/** The resolved library as the file Unity's copy (and arborist.py --models) gets. */
export function modelLibraryText(library: ModelLibrary): string {
    return JSON.stringify(library, null, 2) + '\n';
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
export function addArboristModel(library: ModelLibrary, { id, species, kind, form = 'tree', look }: NewArboristModel,
    catalogue: Map<string, CatalogueModel>): { library: ModelLibrary; model: LibraryModel } {
    const { renderer, label } = parseModelId(id);
    if (renderer !== ARBORIST) throw Error(`${id}: only Arborist models are added here; a vsp model joins from Unity's Palette panel (it needs the prefab)`);
    if (!species) throw Error('A model needs its species (--species)');
    const forms = MODEL_FORMS.filter((f) => f !== 'grass') as readonly string[];
    if (!forms.includes(form)) throw Error(`form must be ${forms.join(', ')} for an Arborist model, not '${form}'`);
    // A tree needs its kind (broadleaf when not given); a bush or ground plant of the zone palettes needs none.
    if (form === 'tree' && kind === undefined) kind = 'broadleaf';
    if (kind !== undefined && !(MODEL_KINDS as readonly string[]).includes(kind)) throw Error(`kind must be broadleaf or conifer, not '${kind}'`);
    const size = catalogue.get(label);
    if (!size) throw Error(`Arborist has no model '${label}' (not in its catalogue sizes)`);
    if ((library.models ?? []).some((m) => m.id === id)) throw Error(`${id} is already in the model library`);
    const model = { id, species, renderer, heightM: size.heightM, crownWidthM: size.crownWidthM, ...(kind !== undefined ? { kind } : {}), form } as LibraryModel;
    if (look) model.look = look;
    return { library: { ...library, format: library.format ?? MODELS_FORMAT, models: [...(library.models ?? []), model] }, model };
}

/** The course's own models.json (overrides and course-only models). */
export function writeModelLibrary(courseDocsDir: string, library: ModelLibrary | CourseModels): void {
    fs.writeFileSync(path.join(courseDocsDir, 'models.json'), JSON.stringify(library, null, 2) + '\n');
}

/** The shared library (<docs root>/model-library.json). */
export function writeSharedLibrary(docsRoot: string, library: ModelLibrary): void {
    fs.writeFileSync(path.join(docsRoot, SHARED_LIBRARY_FILE), JSON.stringify({ ...library, format: SHARED_LIBRARY_FORMAT }, null, 2) + '\n');
}

/**
 * A course entry moved into the shared library: an override is deep-merged onto its shared model (every
 * course without its own override then gets it), a course-only model joins the shared library; either way
 * it leaves the course file. Refuses a model the course file does not have and a `disabled` entry. The
 * course's own resolved library is unchanged. Writes nothing.
 */
export function promoteModel(shared: ModelLibrary, course: CourseModels, id: string): { shared: ModelLibrary; course: CourseModels; model: LibraryModel; joined: boolean } {
    const entry = course.models.find((m) => m.id === id);
    if (!entry) throw Error(`${id} is not in the course's models.json (nothing to promote)`);
    if (entry.disabled) throw Error(`${id} is disabled in the course: that stays the course's own`);
    const at = shared.models.findIndex((m) => m.id === id);
    const model = at >= 0 ? deepMerge(shared.models[at] as unknown as Record<string, unknown>, entry) as unknown as LibraryModel : entry as LibraryModel;
    const models = at >= 0 ? shared.models.map((m, i) => (i === at ? model : m)) : [...shared.models, model];
    return {
        shared: { ...shared, format: SHARED_LIBRARY_FORMAT, models },
        course: { ...course, models: course.models.filter((m) => m.id !== id) },
        model, joined: at < 0,
    };
}

/** A palette file read with the model library beside it (models.json in the same folder). */
export function loadPaletteFile(paletteFile: string) {
    return resolvePalette(readJson(paletteFile), loadModelLibrary(path.dirname(paletteFile)));
}

/** docs/gspro/<course>/: palette.json + models.json -> the matcher's config. */
export function loadCoursePalette(courseDocsDir: string) {
    return loadPaletteFile(path.join(courseDocsDir, 'palette.json'));
}
