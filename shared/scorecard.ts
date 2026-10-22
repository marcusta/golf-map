// A club's scorecard as text: par, stroke index and each tee set's hole lengths,
// plus the sets' course ratings and slopes. ScorecardService reads it for the
// Furniture mode's "Scorecard" step and `bun run scorecard`; the lengths then
// place the tees (shared/features/tee-placement.ts).
//
// What it reads, pasted from a PDF, a web page or a spreadsheet:
//   - holes across:  `Hål 1 2 … 9 Ut 10 … 18 In Tot` / `Par 5 4 …` / `Hcp 5 13 …` / `Gul 57 463 294 …`
//   - holes down:    `Hål Par Hcp Vit Gul …` then one row per hole `1 5 5 478 463 …`
//   - JSON:          {"unit": "m", "holes": [{"number": 1, "par": 5, "index": 5}],
//                     "sets": [{"name": "Gul", "lengths": [463, 294, …], "ratingMen": 71.5, "slopeMen": 135}]}
//   - rating lines:  `Gul herr 71,5/135 dam 77,5/139`, `Röd CR 72.3 slope 129 dam`
// Cells split on tabs, `;` or `|`, else on spaces (a set's name may then hold its
// tee number: `Gul 57`). Total columns (Ut, In, Tot …) are left out: by the hole
// header when there is one, else by the par row (a par over 6 is a total).
// Lengths are metres unless the text says yards (or `unit` does).

export type ScorecardUnit = 'm' | 'yd';

export interface ScorecardSet {
    /** The set as the card names it: `Gul 57`, `Vit`, `61`. */
    label: string;
    /** Its colour in English (`yellow`) when the label names one. */
    color: string | null;
    /** The tee number in the label (Swedish cards: the length in hundreds of metres), e.g. 57. */
    teeNumber: number | null;
    /** Metres by hole number. */
    lengthsM: Record<number, number>;
    totalM: number;
    ratingMen: number | null;
    slopeMen: number | null;
    ratingWomen: number | null;
    slopeWomen: number | null;
}

export interface Scorecard {
    unit: ScorecardUnit;
    /** Hole numbers in card order. */
    holes: number[];
    par: Record<number, number>;
    strokeIndex: Record<number, number>;
    sets: ScorecardSet[];
    /** What was read but looks wrong, or left out. */
    warnings: string[];
}

export const YARD_M = 0.9144;

/** Colour words on Swedish and English cards -> the English name the app's sets use. */
const COLOURS: Record<string, string> = {
    vit: 'white', vita: 'white', white: 'white',
    gul: 'yellow', gula: 'yellow', yellow: 'yellow',
    blå: 'blue', blåa: 'blue', bla: 'blue', blue: 'blue',
    röd: 'red', röda: 'red', rod: 'red', red: 'red',
    grön: 'green', gröna: 'green', gron: 'green', green: 'green',
    svart: 'black', svarta: 'black', black: 'black',
    orange: 'orange', guld: 'gold', gold: 'gold', silver: 'silver',
    lila: 'purple', purple: 'purple', rosa: 'pink', pink: 'pink',
};

const HOLE_WORDS = new Set(['hål', 'hal', 'hole', 'holes', 'nr', 'hålnr', 'hålnummer', 'no', '#']);
const TOTAL_WORDS = new Set(['ut', 'in', 'out', 'tot', 'total', 'totalt', 'sum', 'summa', 'fram', 'bak', 'front', 'back']);
const PAR_RE = /^par\b/i;
const INDEX_RE = /^(hcp|hcp-?index|index|si|s\.i\.?|slag|slagindex|handicap|stroke\s*index)\b/i;
const WOMEN_WORDS = new Set(['dam', 'damer', 'women', 'woman', 'ladies', 'lady', 'kvinnor']);
const MEN_WORDS = new Set(['herr', 'herrar', 'men', 'man', 'män']);
const hasWord = (text: string, set: Set<string>) => words(text).some((w) => set.has(w));

/** The English colour a label names, or null. */
export function colourOf(label: string): string | null {
    for (const word of words(label)) {
        const c = COLOURS[word];
        if (c) return c;
    }
    return null;
}

/** The tee number in a label (`Gul 57` -> 57, `61` -> 61), or null. */
export function teeNumberOf(label: string): number | null {
    const m = /(?:^|\D)(\d{2})(?:\D|$)/.exec(label);
    return m ? Number(m[1]) : null;
}

/** A set name compared loosely: lower case, the gender words and tee number left out. */
export function setKey(label: string): string {
    return words(label).filter((w) => !/^\d+$/.test(w) && w !== 'tee' && w !== 'tees' && !MEN_WORDS.has(w) && !WOMEN_WORDS.has(w)).join(' ');
}

function words(label: string): string[] {
    return label.toLowerCase().split(/[^\p{L}\d#]+/u).filter(Boolean);
}

/** `73,4` -> 73.4; null for anything else. */
function num(cell: string): number | null {
    const t = cell.trim().replace(',', '.');
    return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}

const isInt = (cell: string) => /^\d+$/.test(cell.trim());

/** Read a scorecard from pasted text or JSON. Throws when there is nothing to read. */
export function parseScorecard(text: string, opts: { unit?: ScorecardUnit } = {}): Scorecard {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('The scorecard is empty');
    if (trimmed.startsWith('{')) return fromJson(trimmed, opts.unit);
    const unit: ScorecardUnit = opts.unit ?? (/\b(yards?|yds?)\b/i.test(trimmed) ? 'yd' : 'm');
    const warnings: string[] = [];
    // Thousands written with a (narrow) no-break space: `6 055` -> `6055`.
    const lines = trimmed.split(/\r?\n/).map((l) => l.replace(/(\d)[  ](?=\d{3}\b)/g, '$1').trim())
        .filter((l) => l && !/^[|\-\s:+]+$/.test(l));

    const ratings: RatingLine[] = [];
    const table: string[][] = [];
    for (const line of lines) {
        const r = ratingLine(line);
        if (r) ratings.push(r);
        else table.push(cells(line));
    }
    const card = isDown(table) ? readDown(table, warnings) : readAcross(table, warnings);
    const sets = card.sets.map(({ label, values }) => toSet(label, values, unit));
    for (const r of ratings) {
        let set = sets.find((s) => setKey(s.label) === setKey(r.label)) ?? sets.find((s) => s.color !== null && s.color === colourOf(r.label));
        if (!set) {
            set = toSet(r.label, {}, unit);
            sets.push(set);
        }
        if (r.men) { set.ratingMen = r.men.rating; set.slopeMen = r.men.slope; }
        if (r.women) { set.ratingWomen = r.women.rating; set.slopeWomen = r.women.slope; }
    }
    return check({ unit, holes: card.holes, par: card.par, strokeIndex: card.strokeIndex, sets, warnings });
}

/** A row's cells: tabs, `;` or `|` when the line has them, else words with a name's words kept together. */
function cells(line: string): string[] {
    if (/[\t;|]/.test(line)) return line.split(/[\t;|]/).map((c) => c.trim()).filter((c, i, all) => c || (i > 0 && i < all.length - 1));
    const tokens = line.split(/\s+/);
    // A one-digit token before a three-digit one in a row of lengths is a thousands split (`5 666`).
    const values = tokens.map(num).filter((v): v is number => v !== null);
    const lengths = values.length > 0 && values.sort((a, b) => a - b)[Math.floor(values.length / 2)]! >= 50;
    const merged: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i]!, next = tokens[i + 1];
        if (lengths && /^\d$/.test(t) && next && /^\d{3}$/.test(next) && i > 0 && num(tokens[i - 1]!) !== null) {
            merged.push(t + next);
            i++;
        } else merged.push(t);
    }
    return merged;
}

interface Read {
    holes: number[];
    par: Record<number, number>;
    strokeIndex: Record<number, number>;
    sets: { label: string; values: Record<number, number> }[];
}

/** A hole header's first cell: `Hål`, `Hole`, `Hål/Hole`, `#`. */
function isHoleWord(cell: string): boolean {
    const w = words(cell);
    return w.length > 0 && w.every((x) => HOLE_WORDS.has(x));
}

/** Holes down the rows: a header `Hål Par Hcp Vit …` (mostly words), then `1 5 5 478 …`. */
function isDown(table: string[][]): boolean {
    const header = table.find((row) => isHoleWord(row[0]!));
    if (!header || header.length < 3) return false;
    const rest = header.slice(1);
    return rest.filter((c) => num(c) === null).length > rest.filter((c) => num(c) !== null).length;
}

function readDown(table: string[][], warnings: string[]): Read {
    const headerAt = table.findIndex((row) => isHoleWord(row[0]!));
    // Words with the tee number after them: `Vit 61 Gul 57` -> `Vit 61`, `Gul 57`.
    const header: string[] = [];
    for (const c of table[headerAt]!.slice(1)) {
        if (num(c) !== null && header.length && num(header[header.length - 1]!) === null && !/\d/.test(header[header.length - 1]!)) header[header.length - 1] += ` ${c}`;
        else header.push(c);
    }
    const out: Read = { holes: [], par: {}, strokeIndex: {}, sets: [] };
    const parCol = header.findIndex((c) => PAR_RE.test(c));
    const indexCol = header.findIndex((c) => INDEX_RE.test(c));
    const setCols = header.map((c, i) => ({ c, i })).filter(({ c, i }) => i !== parCol && i !== indexCol && !TOTAL_WORDS.has(c.toLowerCase()));
    out.sets = setCols.map(({ c }) => ({ label: c, values: {} }));
    for (const row of table.slice(headerAt + 1)) {
        if (!isInt(row[0]!)) continue; // Ut / In / Tot rows
        const hole = Number(row[0]);
        const values = row.slice(1);
        out.holes.push(hole);
        const at = (i: number) => (i >= 0 && i < values.length ? num(values[i]!) : null);
        const par = at(parCol), index = at(indexCol);
        if (par !== null) out.par[hole] = par;
        if (index !== null) out.strokeIndex[hole] = index;
        setCols.forEach(({ i }, k) => {
            const v = at(i);
            if (v !== null) out.sets[k]!.values[hole] = v;
        });
    }
    if (!out.holes.length) warnings.push('No hole rows under the header');
    return out;
}

/** Holes across the columns: the hole header (or the par row) says which columns are holes. */
function readAcross(table: string[][], warnings: string[]): Read {
    const headerRow = table.find((row) => isHoleWord(row[0]!));
    const rows = table.filter((row) => row !== headerRow).map(splitRow).filter((r) => r.values.some((v) => v !== null));
    const parRow = rows.find((r) => PAR_RE.test(r.label));
    // Which value positions are holes, and their numbers.
    let columns: (number | null)[];
    if (headerRow) {
        columns = headerRow.slice(1).map((c) => (isInt(c) && Number(c) >= 1 && Number(c) <= 36 ? Number(c) : null));
    } else if (parRow) {
        let n = 0;
        columns = parRow.values.map((v) => (v === null || v >= 7 ? null : ++n));
        warnings.push('No hole header: holes numbered 1.. from the par row');
    } else {
        let n = 0;
        columns = totalsBySum(rows[0]?.values ?? []).map((isTotal) => (isTotal ? null : ++n));
        warnings.push('No hole header and no par row: holes numbered 1.. in order, totals found by their sums');
    }
    const width = columns.length;
    const out: Read = { holes: columns.filter((c): c is number => c !== null), par: {}, strokeIndex: {}, sets: [] };
    let parDone = false, indexDone = false;
    for (const row of rows) {
        // Numbers beyond the hole columns at the front belong to the name (`Gul 57`, or a set named `61`).
        const extra = Math.max(0, row.values.length - width);
        const label = [row.label, ...row.raw.slice(0, extra)].join(' ').trim();
        const byHole: Record<number, number> = {};
        row.values.slice(extra).forEach((v, i) => {
            const hole = columns[i];
            if (hole != null && v !== null) byHole[hole] = v;
        });
        if (PAR_RE.test(label)) {
            if (!parDone) Object.assign(out.par, byHole);
            parDone = true;
        } else if (INDEX_RE.test(label)) {
            if (!indexDone) Object.assign(out.strokeIndex, byHole);
            indexDone = true;
        } else if (label && Object.keys(byHole).length) {
            out.sets.push({ label, values: byHole });
        } else if (Object.keys(byHole).length) {
            warnings.push(`A row without a name left out (${row.raw.slice(0, 4).join(' ')} …)`);
        }
    }
    return out;
}

const BLANK = new Set(['-', '–', '—', '']);

/** A row's name (the cells before its first number) and the values after it (`-` = none). */
function splitRow(row: string[]): { label: string; raw: string[]; values: (number | null)[] } {
    const first = row.findIndex((c) => num(c) !== null);
    if (first === -1) return { label: row.join(' '), raw: [], values: [] };
    let raw = row.slice(first);
    // Words after the numbers (a unit, a note) are not values.
    while (raw.length && num(raw[raw.length - 1]!) === null) raw = raw.slice(0, -1);
    return { label: row.slice(0, first).join(' '), raw, values: raw.map((c) => (BLANK.has(c.trim()) ? null : num(c))) };
}

/** Which values are totals: one equal to the sum of the run before it (three or more holes), or of all holes. */
function totalsBySum(values: (number | null)[]): boolean[] {
    const out: boolean[] = [];
    let run: number[] = [];
    let all = 0;
    for (const v of values) {
        const sum = run.reduce((a, b) => a + b, 0);
        if (v !== null && ((run.length >= 3 && Math.abs(v - sum) < 0.5) || (run.length === 0 && out.length > 3 && Math.abs(v - all) < 0.5))) {
            out.push(true);
            run = [];
        } else {
            out.push(false);
            if (v !== null) { run.push(v); all += v; }
        }
    }
    return out;
}

interface RatingLine {
    label: string;
    men: { rating: number; slope: number } | null;
    women: { rating: number; slope: number } | null;
}

/** `Gul herr 71,5/135 dam 77,5/139` or `Röd CR 72.3 slope 129 dam`; null for a line that holds no rating. */
function ratingLine(line: string): RatingLine | null {
    const pair = /(?:cr\s*)?(\d{2}[.,]\d)\s*(?:\/|slope|sl\.?)\s*(\d{2,3})\b/gi;
    const hits = [...line.matchAll(pair)];
    if (!hits.length) return null;
    const out: RatingLine = { label: '', men: null, women: null };
    let cursor = 0;
    for (const m of hits) {
        const before = line.slice(cursor, m.index);
        const after = line.slice(m.index! + m[0].length).split(/\d/)[0] ?? '';
        const value = { rating: Number(m[1]!.replace(',', '.')), slope: Number(m[2]) };
        const women = hasWord(before.split(/\s+/).slice(-2).join(' '), WOMEN_WORDS) || (hits.length === 1 && hasWord(after, WOMEN_WORDS));
        if (!out.label) {
            out.label = before.split(/[\s:,]+/).filter((w) => {
                const k = w.toLowerCase();
                return w && k !== 'cr' && k !== 'course' && k !== 'rating' && !MEN_WORDS.has(k) && !WOMEN_WORDS.has(k);
            }).join(' ');
        }
        if (women) out.women = value;
        else out.men = value;
        cursor = m.index! + m[0].length;
    }
    return out.label ? out : null;
}

function toSet(label: string, values: Record<number, number>, unit: ScorecardUnit): ScorecardSet {
    const lengthsM: Record<number, number> = {};
    for (const [hole, v] of Object.entries(values)) lengthsM[Number(hole)] = Math.round((unit === 'yd' ? v * YARD_M : v) * 10) / 10;
    return {
        label, color: colourOf(label), teeNumber: teeNumberOf(label), lengthsM,
        totalM: Math.round(Object.values(lengthsM).reduce((a, b) => a + b, 0)),
        ratingMen: null, slopeMen: null, ratingWomen: null, slopeWomen: null,
    };
}

function fromJson(text: string, unitOpt: ScorecardUnit | undefined): Scorecard {
    let raw: {
        unit?: string;
        holes?: { number: number; par?: number; index?: number; strokeIndex?: number }[];
        sets?: { name?: string; label?: string; lengths?: number[] | Record<string, number>; ratingMen?: number; slopeMen?: number; ratingWomen?: number; slopeWomen?: number }[];
    };
    try {
        raw = JSON.parse(text);
    } catch (e) {
        throw new Error(`The scorecard is not valid JSON: ${(e as Error).message}`);
    }
    const unit: ScorecardUnit = unitOpt ?? (raw.unit === 'yd' || raw.unit === 'yards' ? 'yd' : 'm');
    const holes = (raw.holes ?? []).map((h) => h.number);
    const par: Record<number, number> = {}, strokeIndex: Record<number, number> = {};
    for (const h of raw.holes ?? []) {
        if (h.par != null) par[h.number] = h.par;
        const si = h.strokeIndex ?? h.index;
        if (si != null) strokeIndex[h.number] = si;
    }
    const sets = (raw.sets ?? []).map((s) => {
        const label = (s.name ?? s.label ?? '').trim();
        const values: Record<number, number> = {};
        if (Array.isArray(s.lengths)) s.lengths.forEach((v, i) => { if (v != null) values[holes[i] ?? i + 1] = v; });
        else for (const [k, v] of Object.entries(s.lengths ?? {})) values[Number(k)] = v;
        const set = toSet(label, values, unit);
        set.ratingMen = s.ratingMen ?? null; set.slopeMen = s.slopeMen ?? null;
        set.ratingWomen = s.ratingWomen ?? null; set.slopeWomen = s.slopeWomen ?? null;
        return set;
    });
    const allHoles = holes.length ? holes : [...new Set(sets.flatMap((s) => Object.keys(s.lengthsM).map(Number)))].sort((a, b) => a - b);
    return check({ unit, holes: allHoles, par, strokeIndex, sets, warnings: [] });
}

/** Warnings for what does not look like a card: lengths out of range, pars, a stroke index used twice. */
function check(card: Scorecard): Scorecard {
    const w = card.warnings;
    if (!card.holes.length) throw new Error('No holes found on the scorecard');
    if (!card.sets.some((s) => Object.keys(s.lengthsM).length)) w.push('No tee lengths found');
    for (const [hole, p] of Object.entries(card.par)) if (p < 3 || p > 6) w.push(`Hole ${hole}: par ${p}?`);
    const seen = new Map<number, number>();
    for (const [hole, si] of Object.entries(card.strokeIndex)) {
        if (seen.has(si)) w.push(`Stroke index ${si} on holes ${seen.get(si)} and ${hole}`);
        seen.set(si, Number(hole));
    }
    for (const s of card.sets) {
        if (!s.label) w.push('A tee set without a name');
        const odd = Object.entries(s.lengthsM).filter(([, m]) => m < 30 || m > 750).map(([h]) => h);
        if (odd.length) w.push(`${s.label}: lengths out of range on hole ${odd.join(', ')}`);
        const missing = card.holes.filter((h) => s.lengthsM[h] === undefined);
        if (Object.keys(s.lengthsM).length && missing.length) w.push(`${s.label}: no length on hole ${missing.join(', ')}`);
    }
    return card;
}
