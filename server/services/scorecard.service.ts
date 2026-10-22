// A club's scorecard into the course (Furniture mode's "Scorecard", `bun run scorecard`):
// par and stroke index per hole, each tee set's length per hole (`tee_set_lengths`,
// which the tees are then placed by: TeePlacementService) and the sets' course
// ratings and slopes. The card is text or JSON (shared/scorecard.ts reads it).
//
// The card's sets are matched to the course's: by name, then by colour (`Gul 57`
// is the course's Yellow), then - for a set the card names by number only, `57` -
// by length (the set whose placed tees stand at its lengths, hole by hole); the
// rest become new sets. `map` overrides that per card label. Propose writes
// nothing; accept writes what differs, leaving what the card does not say alone.
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../db/schema';
import { NotFoundError } from '@basics/core/server/auth';
import { parseScorecard, setKey, type ScorecardSet, type ScorecardUnit } from '../../shared/scorecard';
import { teeLength } from '../../shared/features/tee-placement';
import type { TeeSetsService } from './tee-sets.service';
import type { TeePlacementService, PlacementCourse } from './tee-placement.service';

/** A placed tee this close to the card's length (metres, or this share of it) agrees with it. */
const LENGTH_MATCH_M = 5;
const LENGTH_MATCH = 0.03;
/** The share of a set's tees that must agree for a card set named by number to be that set. */
const LENGTH_AGREE = 0.8;
/** Card lengths this close to the stored ones are the same. */
const SAME_M = 0.5;
/** The set the v1 importer's single tee per hole is in (server/db/import.ts). */
const V1_DEFAULT_SET = 'default';

export interface ScorecardInput {
    text: string;
    /** Lengths in metres or yards; omitted = what the text says (yards when it says so). */
    unit?: ScorecardUnit;
    /** A card label onto the course's tee set id, or `new`, over the automatic match. */
    map?: { label: string; teeSetId: string }[];
}

/** One of the card's sets and where it goes. */
export interface ScorecardSetMatch {
    label: string;
    /** The course's set it goes to; null = a new set named `name`. */
    teeSetId: string | null;
    name: string;
    color: string | null;
    matchedBy: 'map' | 'name' | 'colour' | 'length' | 'new';
    totalM: number;
    /** Holes with a length on the card. */
    holes: number;
    /** Of those, how many differ from the stored length (all of them for a new set). */
    lengthsChanged: number;
    ratingMen: number | null;
    slopeMen: number | null;
    ratingWomen: number | null;
    slopeWomen: number | null;
    /** The card has a rating or slope the set does not. */
    ratingsChanged: boolean;
}

export interface ScorecardHole {
    number: number;
    /** Null = the course has no such hole (left out). */
    holeId: string | null;
    par: number | null;
    parWas: number | null;
    strokeIndex: number | null;
    strokeIndexWas: number | null;
}

export interface ScorecardProposal {
    courseId: string;
    unit: ScorecardUnit;
    holes: ScorecardHole[];
    sets: ScorecardSetMatch[];
    warnings: string[];
    counts: { holes: number; parChanged: number; indexChanged: number; newSets: number; lengthsChanged: number; ratingsChanged: number };
}

export interface ScorecardResult {
    dryRun: boolean;
    setsCreated: number;
    lengthsWritten: number;
    holesChanged: number;
    ratingsWritten: number;
}

/** The lengths the course holds now. */
export interface StoredScorecard {
    courseId: string;
    sets: { teeSetId: string; name: string; color: string | null; totalM: number; lengths: { holeNumber: number; lengthM: number }[] }[];
}

export class ScorecardService {
    constructor(private deps: { db: Kysely<Database>; teeSets: TeeSetsService; teePlacement: TeePlacementService }) {}

    /** The card read and matched to the course: what accept would change. Writes nothing. */
    async propose(courseId: string, input: ScorecardInput): Promise<ScorecardProposal> {
        const card = parseScorecard(input.text, { unit: input.unit });
        const { db } = this.deps;
        const course = await this.deps.teePlacement.load(courseId);
        const holeRows = await db.selectFrom('holes').select(['id', 'number', 'par', 'stroke_index'])
            .where('course_id', '=', courseId).where('drawing_group_name', 'is', null).execute();
        const holeByNumber = new Map(holeRows.map((h) => [h.number, h]));
        const setRows = await db.selectFrom('course_tee_sets').selectAll().where('course_id', '=', courseId).execute();
        const warnings = [...card.warnings];

        const holes: ScorecardHole[] = card.holes.map((number) => {
            const row = holeByNumber.get(number);
            return {
                number, holeId: row?.id ?? null,
                par: card.par[number] ?? null, parWas: row?.par ?? null,
                strokeIndex: card.strokeIndex[number] ?? null, strokeIndexWas: row?.stroke_index ?? null,
            };
        });
        const missing = holes.filter((h) => !h.holeId).map((h) => h.number);
        if (missing.length) warnings.push(`Not on the course, left out: hole ${missing.join(', ')}`);

        const taken = new Set<string>();
        const sets = card.sets.map((s) => {
            const match = matchSet(s, setRows, course, holeByNumber, input.map?.find((m) => m.label === s.label)?.teeSetId, taken);
            if (match.teeSetId) taken.add(match.teeSetId);
            else if (match.clash) warnings.push(`${s.label}: ${match.clash} is already another of the card's sets; it becomes a new set`);
            const row = setRows.find((r) => r.id === match.teeSetId);
            const stored = course.sets.find((c) => c.id === match.teeSetId)?.lengths ?? new Map<string, number>();
            const onCourse = Object.entries(s.lengthsM).filter(([n]) => holeByNumber.has(Number(n)));
            const lengthsChanged = onCourse.filter(([n, m]) => {
                const was = stored.get(holeByNumber.get(Number(n))!.id);
                return was === undefined || Math.abs(was - m) > SAME_M;
            }).length;
            const ratingsChanged = !row
                ? [s.ratingMen, s.slopeMen, s.ratingWomen, s.slopeWomen].some((v) => v !== null)
                : (s.ratingMen !== null && s.ratingMen !== row.rating_men) || (s.slopeMen !== null && s.slopeMen !== row.slope_men)
                    || (s.ratingWomen !== null && s.ratingWomen !== row.rating_women) || (s.slopeWomen !== null && s.slopeWomen !== row.slope_women);
            return {
                label: s.label, teeSetId: match.teeSetId, name: row?.name ?? newSetName(s), color: row ? row.color : s.color,
                matchedBy: match.by, totalM: s.totalM, holes: onCourse.length, lengthsChanged,
                ratingMen: s.ratingMen, slopeMen: s.slopeMen, ratingWomen: s.ratingWomen, slopeWomen: s.slopeWomen, ratingsChanged,
            } satisfies ScorecardSetMatch;
        });
        // A new set's name must be free on the course (and among the card's other new sets).
        const names = new Set(setRows.map((r) => r.name.toLowerCase()));
        for (const s of sets.filter((x) => !x.teeSetId)) {
            let name = names.has(s.name.toLowerCase()) ? s.label : s.name;
            for (let n = 2; names.has(name.toLowerCase()); n++) name = `${s.label} (${n})`;
            s.name = name;
            names.add(name.toLowerCase());
        }
        return {
            courseId, unit: card.unit, holes, sets, warnings,
            counts: {
                holes: holes.filter((h) => h.holeId).length,
                parChanged: holes.filter((h) => h.holeId && h.par !== null && h.par !== h.parWas).length,
                indexChanged: holes.filter((h) => h.holeId && h.strokeIndex !== null && h.strokeIndex !== h.strokeIndexWas).length,
                newSets: sets.filter((s) => !s.teeSetId).length,
                lengthsChanged: sets.reduce((n, s) => n + s.lengthsChanged, 0),
                ratingsChanged: sets.filter((s) => s.ratingsChanged).length,
            },
        };
    }

    /** Write the card: new sets, then par, stroke index, lengths and ratings in one transaction. */
    async accept(courseId: string, input: ScorecardInput & { dryRun?: boolean }): Promise<ScorecardResult> {
        const proposal = await this.propose(courseId, input);
        const card = parseScorecard(input.text, { unit: input.unit });
        const result: ScorecardResult = {
            dryRun: !!input.dryRun,
            setsCreated: proposal.counts.newSets,
            lengthsWritten: proposal.counts.lengthsChanged,
            holesChanged: proposal.holes.filter((h) => h.holeId && ((h.par !== null && h.par !== h.parWas) || (h.strokeIndex !== null && h.strokeIndex !== h.strokeIndexWas))).length,
            ratingsWritten: proposal.counts.ratingsChanged,
        };
        if (input.dryRun) return result;

        // New sets first (TeeSetsService gives them their order and GSPro tee type), outside the transaction.
        const setIds = new Map<string, string>();
        for (const s of proposal.sets) {
            setIds.set(s.label, s.teeSetId ?? (await this.deps.teeSets.create({ courseId, name: s.name, color: s.color })).id);
        }
        const holeId = new Map(proposal.holes.filter((h) => h.holeId).map((h) => [h.number, h.holeId!]));
        await this.deps.db.transaction().execute(async (trx) => {
            for (const h of proposal.holes) {
                if (!h.holeId) continue;
                const set: Record<string, unknown> = {};
                if (h.par !== null && h.par !== h.parWas) set.par = h.par;
                if (h.strokeIndex !== null && h.strokeIndex !== h.strokeIndexWas) set.stroke_index = h.strokeIndex;
                if (Object.keys(set).length) {
                    await trx.updateTable('holes').set({ ...set, version: sql`version + 1`, updated_at: sql`(datetime('now'))` })
                        .where('id', '=', h.holeId).execute();
                }
            }
            for (const s of card.sets) {
                const teeSetId = setIds.get(s.label)!;
                for (const [n, m] of Object.entries(s.lengthsM)) {
                    const hole = holeId.get(Number(n));
                    if (!hole) continue;
                    await trx.insertInto('tee_set_lengths').values({ tee_set_id: teeSetId, hole_id: hole, length_m: m })
                        .onConflict((oc) => oc.columns(['tee_set_id', 'hole_id']).doUpdateSet({ length_m: m, updated_at: sql`(datetime('now'))` }))
                        .execute();
                }
                const ratings: Record<string, number> = {};
                if (s.ratingMen !== null) ratings.rating_men = s.ratingMen;
                if (s.slopeMen !== null) ratings.slope_men = s.slopeMen;
                if (s.ratingWomen !== null) ratings.rating_women = s.ratingWomen;
                if (s.slopeWomen !== null) ratings.slope_women = s.slopeWomen;
                if (Object.keys(ratings).length && proposal.sets.find((p) => p.label === s.label)?.ratingsChanged) {
                    await trx.updateTable('course_tee_sets').set({ ...ratings, version: sql`version + 1`, updated_at: sql`(datetime('now'))` })
                        .where('id', '=', teeSetId).execute();
                }
            }
        });
        return result;
    }

    /** The lengths the course's sets hold, in set and hole order. */
    async get(courseId: string): Promise<StoredScorecard> {
        const course = await this.deps.teePlacement.load(courseId);
        const numberOf = new Map(course.holes.map((h) => [h.id, h.number]));
        return {
            courseId,
            sets: course.sets.filter((s) => s.lengths.size).map((s) => {
                const lengths = [...s.lengths.entries()].filter(([id]) => numberOf.has(id))
                    .map(([id, lengthM]) => ({ holeNumber: numberOf.get(id)!, lengthM })).sort((a, b) => a.holeNumber - b.holeNumber);
                return { teeSetId: s.id, name: s.name, color: s.color, totalM: Math.round(lengths.reduce((t, l) => t + l.lengthM, 0)), lengths };
            }),
        };
    }
}

type SetRow = { id: string; name: string; color: string | null };

/** Which of the course's sets a card set is: the map's word, its name, its colour, then its length. */
function matchSet(
    s: ScorecardSet, rows: SetRow[], course: PlacementCourse, holeByNumber: Map<number, { id: string }>,
    mapped: string | undefined, taken: Set<string>,
): { teeSetId: string | null; by: ScorecardSetMatch['matchedBy']; clash?: string } {
    if (mapped === 'new') return { teeSetId: null, by: 'map' };
    if (mapped) {
        if (!rows.some((r) => r.id === mapped)) throw new NotFoundError(`Tee set ${mapped} is not one of this course's`);
        return { teeSetId: mapped, by: 'map' };
    }
    const free = (r: SetRow) => !taken.has(r.id);
    const key = setKey(s.label);
    const byName = key ? rows.find((r) => setKey(r.name) === key) : undefined;
    const byColour = s.color ? rows.find((r) => (r.color ?? '').toLowerCase() === s.color || setKey(r.name) === s.color) : undefined;
    for (const [hit, by] of [[byName, 'name'], [byColour, 'colour']] as const) {
        if (hit && free(hit)) return { teeSetId: hit.id, by };
        if (hit) return { teeSetId: null, by: 'new', clash: hit.name };
    }
    // A card set named by colour that the course does not have is a new set.
    if (s.color) return { teeSetId: null, by: 'new' };
    // By length (a set named by number, `57`): the set whose placed tees stand at the card's lengths, hole by hole
    // (a total alone matched Vreta's GSPro Par3 set to the orange 37 tees). Never the v1 import's one tee per hole
    // ("default"), which stands wherever it was clicked.
    let best: { id: string; agree: number; off: number } | null = null;
    for (const r of rows.filter((x) => free(x) && x.name.toLowerCase() !== V1_DEFAULT_SET)) {
        let holes = 0, agree = 0, off = 0;
        for (const [n, m] of Object.entries(s.lengthsM)) {
            const hole = course.holes.find((h) => h.id === holeByNumber.get(Number(n))?.id);
            const tee = hole?.tees.find((t) => t.teeSetId === r.id);
            const len = hole && tee ? teeLength(hole.geo, tee.xy) : null;
            if (len === null) continue;
            holes++;
            off += Math.abs(len - m);
            if (Math.abs(len - m) <= Math.max(LENGTH_MATCH_M, LENGTH_MATCH * m)) agree++;
        }
        if (holes < Math.max(1, Object.keys(s.lengthsM).length / 2) || agree < LENGTH_AGREE * holes) continue;
        if (!best || agree / holes > best.agree || (agree / holes === best.agree && off / holes < best.off)) best = { id: r.id, agree: agree / holes, off: off / holes };
    }
    return best ? { teeSetId: best.id, by: 'length' } : { teeSetId: null, by: 'new' };
}

/** A new set's name: its colour in English (as GSPro's tee types are), else the card's label. */
function newSetName(s: ScorecardSet): string {
    return s.color ? s.color[0]!.toUpperCase() + s.color.slice(1) : s.label;
}
