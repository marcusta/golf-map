// "Find falls" Accept: a water-steps proposal (WaterStepsService -> golfpipe.water_steps) turned into feature edits.
// Pure, and shared by the terrain editor (one undo step) and `bun run water:steps`, so both store the same thing:
//
// - per body, the largest piece keeps the original feature (same id: its shape name and feature number stay, so the
//   meshes Unity keys edits to keep their names); the other pieces become new features in the same hole and layer;
// - a pond piece is a `water` feature with the original's attributes and dig settings that hold its water at the
//   level found: the bank above the water at 45° (the outline is the water's edge, so the dig's level is the water
//   plane Unity puts there) and `digLevelOffsetM` (what the dig needs on top of its rim percentile); a creek piece is a
//   `water_creek` with the original's attributes, without the pond dig keys;
// - each fall is a new `waterfall` feature: a centerline along its lip (a cascade's: along its path down, upstream
//   first), with its style, levels, flow bearing and sill (a cascade: its stream width); a fall the course already
//   has a waterfall for (`exists`, WaterStepsService) gets none;
// - every outline is stored as a smooth closed B-spline (drawn features are B-splines), the lip's straight edge kept
//   within a few decimetres.
//
// A body cut into one piece keeps its drawn outline: only its type and dig settings follow the piece.
//
// `split: false` (the default) keeps every body as it is drawn and only adds the waterfalls: a creek stays one OPCD
// shape (no new SVG, no OPCD build), and its dig and its R.A.M. water are cut at the falls instead (golfpipe.creeks
// surface_profile's breaks), so each stretch keeps its own level. Split when the shapes go to OPCD anyway.
import { fitClosedBspline } from '../geo/spline-fit';
import { centerlineGeometry, type FeatureCenterline } from '../../../shared/features/centerline';
import {
    CASCADE_WIDTH_RANGE_M, DEFAULT_CASCADE_WIDTH_M, DEFAULT_WATERFALL_WIDTH_M, WATERFALL_BOTTOM_ATTRIBUTE, WATERFALL_FLOW_ATTRIBUTE,
    WATERFALL_SILL_ATTRIBUTE, WATERFALL_STYLE_ATTRIBUTE, WATERFALL_TOP_ATTRIBUTE, WATERFALL_TYPE, WATERFALL_WIDTH_ATTRIBUTE,
} from '../../../shared/features/waterfall';
import { CREEK_DIG_PRESETS, DEFAULT_WATER_DIG_PRESET, WATER_DIG_PRESETS } from '../../../shared/features/dig-presets';

type Pt = { x: number; y: number };
type Scalar = string | number | boolean;
export type WaterStepsAttributes = Record<string, Scalar>;

/** A stored feature geometry, as both the web and the server write it. */
export interface WaterStepsGeometry {
    crs: string;
    curveType?: 'bezier' | 'bspline';
    rings: { points: Pt[] }[];
    centerline?: FeatureCenterline;
}

/** What the planner reads of a proposal (WaterStepsProposal, server or generated client type). */
export interface WaterStepsProposalInput {
    bodies: { featureId: string; shape: string; version: number }[];
    pieces: {
        bodyId: string; shape: string; index: number; kind: 'pond' | 'creek'; ring: Pt[];
        levelM: number | null; topM: number | null; bottomM: number | null; areaM2: number; digLevelOffsetM: number | null;
    }[];
    falls: {
        style: 'sill' | 'outlet' | 'cascade'; fromBodyId: string; toBodyId: string; fromPiece: number | null; toPiece: number | null;
        line: Pt[]; at: Pt; flow: Pt; topM: number; bottomM: number; dropM: number; sillM: number | null; forced: boolean;
        /** A cascade's stream width (m). */
        widthM?: number;
        /** The course already has a waterfall here: none is made for it. */
        exists?: boolean;
    }[];
}

/** What the planner reads of an original feature. */
export interface WaterStepsFeatureInput {
    id: string;
    type: string;
    holeId: string | null;
    layer?: 'roughs' | null;
    version: number;
    geometry: WaterStepsGeometry;
    attributes: Record<string, unknown> | null;
}

/** The original feature, kept for its largest piece. */
export interface WaterStepsUpdate {
    featureId: string;
    shape: string;
    /** The version the proposal was made from (Accept refuses a feature changed since). */
    version: number;
    patch: { type: string; geometry: WaterStepsGeometry; attributes: WaterStepsAttributes | null };
}

/** A new feature: another piece of a body, or a waterfall. */
export interface WaterStepsCreate {
    /** `hole_3_23e·2` (a piece: its body's shape and its index) or `fall hole_3_23e·0→1`. */
    label: string;
    type: string;
    holeId: string | null;
    layer: 'roughs' | null;
    geometry: WaterStepsGeometry;
    attributes: WaterStepsAttributes;
}

export interface WaterStepsPlan {
    updates: WaterStepsUpdate[];
    creates: WaterStepsCreate[];
    /** The worst distance of a stored B-spline from its piece's outline (m). */
    maxDeviationM: number;
    /** What the plan could not carry over (a fall without a drop keeps no levels, ...). */
    warnings: string[];
    /** The falls the course already has a waterfall for (no new feature). */
    existing: number;
}

/** The fit follows the piece's outline this closely (m), one control per this many metres, more at the lip's corners. */
export const WATER_PIECE_FIT_TOLERANCE_M = 0.15;
export const WATER_PIECE_METERS_PER_CONTROL = 1.5;
export const WATER_PIECE_MAX_CONTROLS = 256;
const WATER_PIECE_CURVATURE_SHARE = 0.5;
/** The outline is sampled this densely before the fit, so its straight cuts are measured along their length. */
const SAMPLE_M = 0.25;
/** A pond piece's bank above its water (°): the outline is the water's edge, the dig's level the water plane. */
export const WATER_STEPS_BANK_ABOVE_DEG = 45;
/** digLevelOffsetM's range (the terrain generator's). */
export const DIG_LEVEL_OFFSET_LIMIT_M = 3;

/** The pond dig keys a creek piece drops. */
const POND_DIG_KEYS = ['digBankAboveDeg', 'digLevelOffsetM'];
/** The dig profile keys that belong to the other kind's presets when a piece changes kind. */
const PROFILE_DIG_KEYS = ['digPreset', 'digDepthM', 'digBankSlopeDeg'];

/** A closed outline fitted as the smooth B-spline it is stored as. */
export function fitWaterPiece(ring: Pt[]): { controls: Pt[]; maxDeviation: number } {
    const samples = densify(ring, SAMPLE_M);
    let perimeter = 0;
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        perimeter += Math.hypot(b.x - a.x, b.y - a.y);
    }
    const cap = Math.min(WATER_PIECE_MAX_CONTROLS, Math.max(8, Math.round(perimeter / WATER_PIECE_METERS_PER_CONTROL)));
    const fit = fitClosedBspline(samples, WATER_PIECE_FIT_TOLERANCE_M, cap, { curvatureShare: WATER_PIECE_CURVATURE_SHARE });
    if (fit.controls.length < 3 || !fit.controls.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) {
        throw new Error('a piece could not be fitted as a B-spline');
    }
    return { controls: fit.controls.map((p) => ({ x: p.x, y: p.y })), maxDeviation: fit.maxDeviation };
}

/** The compass bearing (° clockwise from north, 0..360) of a flow vector (x east, y north). */
export function flowBearingDeg(flow: Pt): number {
    const deg = (Math.atan2(flow.x, flow.y) * 180) / Math.PI;
    return Math.round((((deg % 360) + 360) % 360) * 10) / 10;
}

/** The feature edits that store a proposal (see the header). Throws when a body's feature is not given. */
export function planWaterSteps(proposal: WaterStepsProposalInput, features: readonly WaterStepsFeatureInput[], opts: { split?: boolean } = {}): WaterStepsPlan {
    const byId = new Map(features.map((f) => [f.id, f]));
    const updates: WaterStepsUpdate[] = [];
    const creates: WaterStepsCreate[] = [];
    const warnings: string[] = [];
    let maxDeviationM = 0;

    for (const body of opts.split ? proposal.bodies : []) {
        const f = byId.get(body.featureId);
        if (!f) throw new Error(`${body.shape} is not loaded on this course`);
        const pieces = proposal.pieces.filter((p) => p.bodyId === body.featureId).sort((a, b) => a.index - b.index);
        if (pieces.length === 0) { warnings.push(`${body.shape}: no water found on the lidar, left as it is`); continue; }
        const keep = pieces.reduce((a, b) => (b.areaM2 > a.areaM2 ? b : a));
        for (const piece of pieces) {
            const type = piece.kind === 'pond' ? 'water' : 'water_creek';
            const attributes = pieceAttributes(f, piece);
            let geometry: WaterStepsGeometry;
            if (pieces.length === 1) {
                geometry = f.geometry;                                      // not cut: the drawn outline stays
            } else {
                const fit = fitWaterPiece(piece.ring);
                maxDeviationM = Math.max(maxDeviationM, fit.maxDeviation);
                geometry = { crs: f.geometry.crs, curveType: 'bspline', rings: [{ points: fit.controls }] };
            }
            if (piece === keep) {
                updates.push({ featureId: f.id, shape: body.shape, version: body.version, patch: { type, geometry, attributes } });
            } else {
                creates.push({ label: `${body.shape}·${piece.index}`, type, holeId: f.holeId, layer: f.layer ?? null, geometry, attributes: attributes ?? {} });
            }
        }
        if (pieces.length > 1 && f.geometry.rings.length > 1) warnings.push(`${body.shape}: its islands (inner rings) are not carried over to the pieces`);
    }

    const shapeOf = new Map(proposal.bodies.map((b) => [b.featureId, b.shape]));
    let existing = 0;
    for (const fall of proposal.falls) {
        if (fall.exists) { existing++; continue; }
        const up = byId.get(fall.fromBodyId);
        if (!up) continue;
        const from = `${shapeOf.get(fall.fromBodyId) ?? '?'}·${fall.fromPiece ?? '?'}`;
        const to = fall.toBodyId === fall.fromBodyId ? `${fall.toPiece ?? '?'}` : `${shapeOf.get(fall.toBodyId) ?? '?'}·${fall.toPiece ?? '?'}`;
        const label = `${fall.style === 'cascade' ? 'cascade' : 'fall'} ${from}→${to}`;
        const geometry = centerlineGeometry(up.geometry.crs, { points: fall.line.map((p) => ({ x: p.x, y: p.y })), widthM: DEFAULT_WATERFALL_WIDTH_M });
        if (!geometry) { warnings.push(`${label}: its ${fall.style === 'cascade' ? 'path' : 'lip'} is too short for a line, left out`); continue; }
        const attributes: WaterStepsAttributes = {
            [WATERFALL_STYLE_ATTRIBUTE]: fall.style,
            [WATERFALL_FLOW_ATTRIBUTE]: flowBearingDeg(fall.flow),
        };
        if (fall.topM > fall.bottomM) {
            attributes[WATERFALL_TOP_ATTRIBUTE] = fall.topM;
            attributes[WATERFALL_BOTTOM_ATTRIBUTE] = fall.bottomM;
        } else {
            warnings.push(`${label}: no drop on the lidar (${fall.topM} -> ${fall.bottomM} m), its levels are read from the ponds at export`);
        }
        if (fall.style === 'sill' && fall.sillM !== null) attributes[WATERFALL_SILL_ATTRIBUTE] = fall.sillM;
        if (fall.style === 'cascade') {
            const width = Number.isFinite(fall.widthM) ? fall.widthM! : DEFAULT_CASCADE_WIDTH_M;
            attributes[WATERFALL_WIDTH_ATTRIBUTE] = Math.round(Math.min(CASCADE_WIDTH_RANGE_M.max, Math.max(CASCADE_WIDTH_RANGE_M.min, width)) * 100) / 100;
        }
        creates.push({
            label, type: WATERFALL_TYPE, holeId: up.holeId, layer: null,
            geometry: geometry as WaterStepsGeometry, attributes,
        });
    }
    return { updates, creates, maxDeviationM: Math.round(maxDeviationM * 1000) / 1000, warnings, existing };
}

/** A piece's attributes: the original's scalars, with the pond's dig settings or without them for a creek. */
function pieceAttributes(f: WaterStepsFeatureInput, piece: WaterStepsProposalInput['pieces'][number]): WaterStepsAttributes | null {
    const out: WaterStepsAttributes = {};
    for (const [k, v] of Object.entries(f.attributes ?? {})) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    }
    const wasPond = f.type === 'water';
    if (piece.kind === 'pond') {
        // A creek's bed profile (depth, banks) is not a pond's.
        if (!wasPond) for (const k of PROFILE_DIG_KEYS) delete out[k];
        const preset = out.digPreset;
        out.digPreset = typeof preset === 'string' && preset in WATER_DIG_PRESETS ? preset : DEFAULT_WATER_DIG_PRESET;
        out.digBankAboveDeg = WATER_STEPS_BANK_ABOVE_DEG;
        const offset = Math.max(-DIG_LEVEL_OFFSET_LIMIT_M, Math.min(DIG_LEVEL_OFFSET_LIMIT_M, piece.digLevelOffsetM ?? 0));
        if (Math.abs(offset) >= 0.01) out.digLevelOffsetM = Math.round(offset * 100) / 100;
        else delete out.digLevelOffsetM;
        return out;
    }
    for (const k of POND_DIG_KEYS) delete out[k];
    if (wasPond) {
        for (const k of PROFILE_DIG_KEYS) delete out[k];
    } else if (typeof out.digPreset === 'string' && !(out.digPreset in CREEK_DIG_PRESETS)) {
        delete out.digPreset;
    }
    return Object.keys(out).length > 0 ? out : f.attributes === null ? null : {};
}

/** The closed ring sampled at most `step` apart along every edge. */
function densify(ring: Pt[], step: number): Pt[] {
    const out: Pt[] = [];
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
        for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
    }
    return out;
}
