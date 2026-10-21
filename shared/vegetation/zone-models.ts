// A course's zone palettes (docs/gspro/<course>/grass-palette.json, golfmap-grass-v1) on its model library:
// the lower vegetation - grass, ground plants, bushes - per vegetation zone. One module for the CLI
// (bun run models -- look / zone), the server (Planting rules) and the tests.
//
//   {"format": "golfmap-grass-v1", "palettes": [{"key": "<zone type key>", "package", "tintAreaScale", ...,
//     "items": [{"name", "model": "<model id>", <placement and size keys>}]}]}
//
// A zone item refers to a model and keeps only where and how densely it grows and its size (ZONE_ITEM_KEYS);
// the look - healthy / dry, the shader "material" floats, randomDarkening, rootAmbient, alphaCutoff,
// whitePoint, shadows, and an Arborist model's tint / saturation / brightness / ao ... - is the model's
// (model.look), so it is set once for every zone that uses the model. The model's renderer decides who draws
// the item: a vsp model the course's own VSP (Unity's GolfMapGrass; the asset is model.unity.path, a texture
// .psd/.png or a prefab), an arborist model Arborist's "GolfMap lower vegetation" package (pipeline/arborist.py
// lower --models). An item without "model" is the older form (Vreta's): it names its texture ("source") or
// prefab and holds its own look, and the palette's "prefabItems" / "prefabItemsInVsp" decide who draws it.
import fs from 'node:fs';
import path from 'node:path';
import { rendererName, rendererOf, type Renderer } from './model-id';
import { deepMerge, readJson, type CourseModels, type LibraryModel, type ModelLibrary } from './tree-models';

export const GRASS_PALETTE_FORMAT = 'golfmap-grass-v1';
export const GRASS_PALETTE_FILE = 'grass-palette.json';

/** What a zone item holds besides its name and model: where and how densely it grows, and its size. */
export const ZONE_ITEM_KEYS = [
    'sampleDistance', 'density', 'maxDensity', 'noiseDensityScale', 'noiseCutoff', 'noiseCutoffScale', 'noiseScaleMin', 'noiseScaleMax',
    'noiseScaleScale', 'maxSteepness', 'lodFactor', 'copies', 'renderDistance', 'width', 'height', 'minScale', 'maxScale', 'verticalOffset',
] as const;

/**
 * A model's look keys a VSP item reads: what belongs to the model, not to the zone item. The one list; its
 * twins are Unity's GolfMapVegPalette.LookRoles (+ the "mat:" roles = material) and the look reads of
 * GolfMapGrass.ResolveModel / Load (zone-models.test.ts checks both). An Arborist model's look takes
 * pipeline/arborist.py apply_look's keys too (model_look_rules passes them through).
 */
export const VSP_LOOK_KEYS = ['healthy', 'dry', 'material', 'randomDarkening', 'rootAmbient', 'alphaCutoff', 'whitePoint', 'shadows'] as const;

/** The look keys that hold a colour (#rrggbb): VSP's healthy / dry, Arborist's tint / barkTint / mainColor. */
export const COLOUR_LOOK_KEYS = ['healthy', 'dry', 'tint', 'barkTint', 'mainColor'] as const;

export interface ZoneItem { name: string; model?: string; [key: string]: unknown }
export interface ZonePalette { key: string; items: ZoneItem[]; [key: string]: unknown }
export interface ZonePaletteDoc { format: string; palettes: ZonePalette[]; [key: string]: unknown }

/** Who draws a zone item: its model's renderer, '?' for an id of no known shape. */
export type ZoneRenderer = Renderer | '?';
export interface ZoneModelItem { name: string; model: string; renderer: ZoneRenderer }
export interface ZoneModels { palette: string; items: ZoneModelItem[] }

/** The course's grass-palette.json, or null when it has none. */
export function loadZonePalettes(courseDocsDir: string): ZonePaletteDoc | null {
    const file = path.join(courseDocsDir, GRASS_PALETTE_FILE);
    if (!fs.existsSync(file)) return null;
    const doc = readJson(file);
    if (doc.format !== GRASS_PALETTE_FORMAT || !Array.isArray(doc.palettes)) throw Error(`Invalid zone palettes ${file}: format must be ${GRASS_PALETTE_FORMAT}`);
    return doc;
}

/** The palettes as the file is written (2-space JSON, a final newline). */
export function zonePalettesText(doc: ZonePaletteDoc): string {
    return JSON.stringify(doc, null, 2) + '\n';
}

/**
 * Each palette's items that refer to a model, in palette order, with the model each refers to and who draws it
 * (the model's renderer; for a model the library lacks the renderer its id names, '?' when the id has no known
 * shape). Palettes of the older form (no item with a model) are left out.
 */
export function zoneModels(doc: ZonePaletteDoc | null, library: ModelLibrary): ZoneModels[] {
    if (!doc) return [];
    const byId = new Map(library.models.map((m) => [m.id, m]));
    const out: ZoneModels[] = [];
    for (const p of doc.palettes) {
        const items = p.items.filter((i) => typeof i.model === 'string').map((i) => ({
            name: i.name, model: i.model!, renderer: (byId.get(i.model!)?.renderer ?? rendererOf(i.model) ?? '?') as ZoneRenderer,
        }));
        if (items.length) out.push({ palette: p.key, items });
    }
    return out;
}

/** Every zone item that wears `modelId`: [palette key, item name]. */
export function itemsWearing(doc: ZonePaletteDoc | null, modelId: string): { palette: string; name: string }[] {
    return (doc?.palettes ?? []).flatMap((p) => p.items.filter((i) => i.model === modelId).map((i) => ({ palette: p.key, name: i.name })));
}

/** The one item `name` of palette `key`; throws when either is missing. */
export function zoneItem(doc: ZonePaletteDoc, key: string, name: string): ZoneItem {
    const palette = doc.palettes.find((p) => p.key === key);
    if (!palette) throw Error(`No zone palette '${key}' (${doc.palettes.map((p) => p.key).join(', ')})`);
    const item = palette.items.find((i) => i.name === name);
    if (!item) throw Error(`Zone palette '${key}' has no item '${name}'`);
    return item;
}

/**
 * `k=v[,k=v...]` as values: '#rrggbb' and other text stay strings, true/false booleans, numbers numbers,
 * 'material.<float>=v' a key of the nested "material". null removes the key.
 */
export function parseSetValues(text: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const part of text.split(',').map((s) => s.trim()).filter(Boolean)) {
        const eq = part.indexOf('=');
        if (eq <= 0) throw Error(`--set ${part}: expected <key>=<value>`);
        const key = part.slice(0, eq).trim(), raw = part.slice(eq + 1).trim();
        const value: unknown = raw === 'true' ? true : raw === 'false' ? false : raw === 'null' ? null
            : raw !== '' && Number.isFinite(Number(raw)) && !raw.startsWith('#') ? Number(raw) : raw;
        const dot = key.indexOf('.');
        if (dot > 0) {
            const [outer, inner] = [key.slice(0, dot), key.slice(dot + 1)];
            if (outer !== 'material') throw Error(`--set ${key}: only material.<shader float> is nested`);
            const material = (out.material ??= {}) as Record<string, unknown>;
            material[inner] = value;
        } else out[key] = value;
    }
    if (!Object.keys(out).length) throw Error('--set needs at least one <key>=<value>');
    return out;
}

const COLOUR = /^#[0-9a-fA-F]{6}$/;

/** The model `id` of the course's library; throws (naming the id) when the library lacks it. */
function requireModel(library: ModelLibrary, id: string): LibraryModel {
    const model = library.models.find((m) => m.id === id);
    if (!model) throw Error(`${id} is not in the course's model library (models.json); add it first`);
    return model;
}

/**
 * The course's models.json with `change` set on the look of `modelId`: the course-only model's look, or (for a
 * model of the shared library) the course's override of it - the override's look holds the whole new look, so
 * the course's model reads as `look` whatever the shared one later says. Objects (material) merge key by key,
 * null removes. Returns the new course document and the model's resolved look. Throws for a model the course's
 * library lacks and a colour that is not #rrggbb.
 */
export function setModelLook(course: CourseModels, library: ModelLibrary, modelId: string,
    change: Record<string, unknown>): { course: CourseModels; look: Record<string, unknown>; model: LibraryModel } {
    const model = requireModel(library, modelId);
    for (const key of COLOUR_LOOK_KEYS) {
        if (change[key] !== undefined && change[key] !== null && !COLOUR.test(String(change[key]))) throw Error(`${key} must be #rrggbb, not '${change[key]}'`);
    }
    const look = deepMerge(model.look ?? {}, change);
    const at = course.models.findIndex((m) => m.id === modelId);
    const models = [...course.models];
    if (at >= 0) models[at] = { ...models[at]!, look };
    else models.push({ id: modelId, look });
    return { course: { ...course, models }, look, model: { ...model, look } };
}

/** Who draws a zone item that refers to `model` (none: the older form), as the CLI says it. */
function drawnBy(library: ModelLibrary, model: unknown): string {
    const m = library.models.find((x) => x.id === model);
    return m ? rendererName(m.renderer) : model ? 'nobody (not in the library)' : 'its own prefab or texture (the older form)';
}

/**
 * The palettes with one zone item changed: its model (`model`, which must be in the library) and/or its
 * placement and size keys (`set`; only ZONE_ITEM_KEYS, null removes one). The item's other keys and order stay.
 * `report` says it: who draws the item before and after (VSP / Arborist) and each changed key.
 */
export function setZoneItem(doc: ZonePaletteDoc, key: string, name: string, library: ModelLibrary,
    { model, set }: { model?: string; set?: Record<string, unknown> }): { doc: ZonePaletteDoc; before: ZoneItem; after: ZoneItem; report: string[] } {
    const before = zoneItem(doc, key, name);
    if (model !== undefined) requireModel(library, model);
    for (const k of Object.keys(set ?? {})) {
        if (!(ZONE_ITEM_KEYS as readonly string[]).includes(k)) {
            throw Error(`--set ${k}: a zone item holds only its placement and size (${ZONE_ITEM_KEYS.join(', ')}); a look key belongs to the model (bun run models -- look)`);
        }
    }
    const after = deepMerge(model !== undefined ? { ...before, model } : before, set ?? {});
    const palettes = doc.palettes.map((p) => (p.key !== key ? p : { ...p, items: p.items.map((i) => (i === before ? after : i)) }));
    const changed = Object.keys({ ...before, ...after }).filter((k) => k !== 'model' && JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    const report = [`${key} / ${name}:`,
        `  before: ${before.model ?? '(no model)'} - ${drawnBy(library, before.model)}`,
        `  after:  ${after.model ?? '(no model)'} - ${drawnBy(library, after.model)}`,
        ...changed.map((k) => `  ${k}: ${JSON.stringify(before[k])} -> ${JSON.stringify(after[k])}`)];
    return { doc: { ...doc, palettes }, before, after, report };
}
