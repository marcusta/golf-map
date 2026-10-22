import { describe, expect, test } from 'bun:test';
import { parseScorecard, colourOf, setKey, teeNumberOf, YARD_M } from './scorecard';

// Vreta Kloster's 18 holes as GolfPass prints them: yards, the tees by number, Out/In/Total columns.
const GOLFPASS = [
    'Hole\t1\t2\t3\t4\t5\t6\t7\t8\t9\tOut\t10\t11\t12\t13\t14\t15\t16\t17\t18\tIn\tTotal',
    '61\t523\t355\t167\t419\t526\t412\t173\t390\t404\t3369\t388\t300\t472\t188\t416\t556\t173\t355\t405\t3253\t6622',
    '57\t506\t322\t167\t387\t525\t412\t149\t362\t367\t3197\t372\t265\t472\t163\t376\t513\t157\t327\t353\t2998\t6195',
    'Par\t5\t4\t3\t4\t5\t4\t3\t4\t4\t36\t4\t4\t5\t3\t4\t5\t3\t4\t4\t36\t72',
    'Handicap\t5\t13\t11\t9\t15\t3\t7\t1\t17\t\t4\t12\t16\t14\t2\t8\t10\t18\t6\t\t',
    'Lengths in yards',
].join('\n');

describe('reading a scorecard', () => {
    test('holes across with Out/In/Total columns, tees named by number, yards', () => {
        const card = parseScorecard(GOLFPASS);
        expect(card.unit).toBe('yd');
        expect(card.holes).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
        expect(card.par[1]).toBe(5);
        expect(card.par[18]).toBe(4);
        expect(card.strokeIndex[8]).toBe(1);
        expect(card.strokeIndex[18]).toBe(6);
        expect(card.sets.map((s) => s.label)).toEqual(['61', '57']);
        const white = card.sets[0]!;
        expect(white.teeNumber).toBe(61);
        expect(white.lengthsM[1]).toBeCloseTo(523 * YARD_M, 1);
        // The Out/In/Total columns are not holes.
        expect(Object.keys(white.lengthsM)).toHaveLength(18);
        expect(white.totalM).toBe(Math.round(6622 * YARD_M));
        expect(card.warnings).toEqual([]);
    });

    test('a Swedish card copied as words: the tee number stays in the name, thousands split by a space', () => {
        const text = [
            'Hål 1 2 3 4 5 6 7 8 9 Ut',
            'Par 5 4 3 4 5 4 3 4 4 36',
            'Hcp 5 13 11 9 15 3 7 1 17',
            'Gul 57 463 294 153 354 480 377 136 331 336 2 924',
            'Röd 48 399 260 133 319 384 319 111 287 283 2 495',
        ].join('\n');
        const card = parseScorecard(text);
        expect(card.unit).toBe('m');
        expect(card.holes).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect(card.sets.map((s) => s.label)).toEqual(['Gul 57', 'Röd 48']);
        expect(card.sets[0]).toMatchObject({ color: 'yellow', teeNumber: 57, totalM: 2924 });
        expect(card.sets[1]!.lengthsM[9]).toBe(283);
        expect(card.strokeIndex[9]).toBe(17);
    });

    test('no hole header: the par row says which columns are totals', () => {
        const text = [
            'Par;3;4;5;12;4;4;3;11;23',
            'Vit;150;360;480;990;340;390;170;900;1890',
        ].join('\n');
        const card = parseScorecard(text);
        expect(card.holes).toEqual([1, 2, 3, 4, 5, 6]);
        expect(card.sets[0]!.lengthsM).toEqual({ 1: 150, 2: 360, 3: 480, 4: 340, 5: 390, 6: 170 });
        expect(card.warnings).toContain('No hole header: holes numbered 1.. from the par row');
    });

    test('holes down the rows, with rating lines for both genders', () => {
        const text = [
            'Hål\tPar\tHcp\tVit\tGul\tRöd',
            '1\t5\t5\t478\t463\t399',
            '2\t4\t13\t325\t294\t260',
            '3\t3\t11\t153\t153\t133',
            'Ut\t12\t\t956\t910\t792',
            'Vit herr 73,4/139',
            'Gul herr 71,5/135 dam 77,5/139',
            'Röd CR 72.3 slope 129 dam',
        ].join('\n');
        const card = parseScorecard(text);
        expect(card.holes).toEqual([1, 2, 3]);
        expect(card.par).toEqual({ 1: 5, 2: 4, 3: 3 });
        expect(card.sets.map((s) => s.label)).toEqual(['Vit', 'Gul', 'Röd']);
        expect(card.sets[0]).toMatchObject({ ratingMen: 73.4, slopeMen: 139, ratingWomen: null });
        expect(card.sets[1]).toMatchObject({ ratingMen: 71.5, slopeMen: 135, ratingWomen: 77.5, slopeWomen: 139 });
        expect(card.sets[2]).toMatchObject({ ratingMen: null, ratingWomen: 72.3, slopeWomen: 129, totalM: 792 });
    });

    test('JSON from a script or an AI reading the PDF', () => {
        const card = parseScorecard(JSON.stringify({
            unit: 'm',
            holes: [{ number: 1, par: 4, index: 2 }, { number: 2, par: 3, index: 1 }],
            sets: [{ name: 'Blå', lengths: [340, 150], ratingMen: 70.1, slopeMen: 128 }],
        }));
        expect(card.holes).toEqual([1, 2]);
        expect(card.strokeIndex).toEqual({ 1: 2, 2: 1 });
        expect(card.sets[0]).toMatchObject({ label: 'Blå', color: 'blue', lengthsM: { 1: 340, 2: 150 }, slopeMen: 128 });
    });

    test('what looks wrong is warned about, not dropped', () => {
        const card = parseScorecard(['Hål 1 2 3', 'Par 4 9 3', 'Hcp 1 1 2', 'Gul 350 12 -'].join('\n'));
        expect(card.warnings).toEqual([
            'Hole 2: par 9?',
            'Stroke index 1 on holes 1 and 2',
            'Gul: lengths out of range on hole 2',
            'Gul: no length on hole 3',
        ]);
    });

    test('nothing to read is an error', () => {
        expect(() => parseScorecard('  ')).toThrow('The scorecard is empty');
        expect(() => parseScorecard('Gul och Röd tees')).toThrow('No holes found on the scorecard');
    });
});

describe('set names', () => {
    test('colours, tee numbers and the loose key', () => {
        expect(colourOf('Gul 57')).toBe('yellow');
        expect(colourOf('Vita tees')).toBe('white');
        expect(colourOf('61')).toBeNull();
        expect(teeNumberOf('Gul 57')).toBe(57);
        expect(teeNumberOf('Junior')).toBeNull();
        expect(setKey('Röd (48) dam')).toBe('röd');
        expect(setKey('Yellow tees')).toBe('yellow');
    });
});
