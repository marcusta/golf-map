import { sql, type Kysely } from 'kysely';

/**
 * A tee set's place in GSPro, kept apart from what the club calls it:
 *
 * - `course_tee_sets.gspro_tee`: which of GreenKeeper's eight tee types
 *   (Black, White, Green, Blue, Yellow, Red, Junior, Par3) the set is
 *   exported as; null = not in GSPro. Until now the export guessed it from
 *   the set's name and colour, which stops working once a set is called
 *   "57". Existing sets get what that guess gave them (the first set of a
 *   course to claim a type keeps it), so the export is unchanged.
 * - `course_tee_sets.gspro_only`: the set exists for GSPro alone (a Junior
 *   or Par3 set the club does not have) and stays out of the course guide.
 *   `tees.gspro_only` carries it on each tee, kept in step by
 *   `TeeSetsService` like the set's name and colour, so readers of `tees`
 *   that never see the sets (iOS, a published bundle) can leave them out.
 */
const ALIASES: Record<string, string> = {
    black: 'Black', championship: 'Black', tiger: 'Black',
    white: 'White', men: 'White', mens: 'White',
    green: 'Green',
    blue: 'Blue',
    yellow: 'Yellow',
    red: 'Red', ladies: 'Red', women: 'Red',
    junior: 'Junior', juniors: 'Junior', kids: 'Junior',
    par3: 'Par3', 'par 3': 'Par3',
};

async function hasColumn(db: Kysely<any>, table: string, column: string): Promise<boolean> {
    const { rows } = await sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`.execute(db);
    return rows.some(r => r.name === column);
}

export async function up(db: Kysely<any>): Promise<void> {
    await db.transaction().execute(async (trx) => {
        if (!await hasColumn(trx, 'course_tee_sets', 'gspro_only')) {
            await trx.schema.alterTable('course_tee_sets')
                .addColumn('gspro_only', 'integer', col => col.notNull().defaultTo(0)).execute();
        }
        if (!await hasColumn(trx, 'tees', 'gspro_only')) {
            await trx.schema.alterTable('tees')
                .addColumn('gspro_only', 'integer', col => col.notNull().defaultTo(0)).execute();
        }
        if (await hasColumn(trx, 'course_tee_sets', 'gspro_tee')) return;
        await trx.schema.alterTable('course_tee_sets').addColumn('gspro_tee', 'text').execute();

        const sets = await trx.selectFrom('course_tee_sets').select(['id', 'course_id', 'name', 'color'])
            .orderBy('course_id').orderBy('sort_order').orderBy('name').execute();
        const claimed = new Set<string>();
        for (const set of sets) {
            const type = [set.name, set.color].map(raw => ALIASES[(raw ?? '').trim().toLowerCase()]).find(Boolean);
            if (!type || claimed.has(`${set.course_id}/${type}`)) continue;
            claimed.add(`${set.course_id}/${type}`);
            await trx.updateTable('course_tee_sets').set({ gspro_tee: type }).where('id', '=', set.id).execute();
        }
    });
}
