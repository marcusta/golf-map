import type { Kysely } from 'kysely';

/**
 * Nothing. On 2026-10-18 this briefly added `courses.opcd_svg_creeks` (a
 * per-course switch keeping creeks out of the GSPro SVG) on one dev database
 * before it was committed; a width rule in the exporter replaced it the same
 * day (`gspro.py` CREEK_MIN_WIDTH_M), and 037 drops the column where it ran.
 * Kept so a database that recorded this migration still finds it.
 */
export async function up(_db: Kysely<any>): Promise<void> {}
