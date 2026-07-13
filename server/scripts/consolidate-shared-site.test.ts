import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { consolidateSharedSite, type ConsolidateOptions } from './consolidate-shared-site';

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): { options: ConsolidateOptions; dbPath: string; canonicalTiles: string; duplicateTiles: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'golf-map-site-consolidation-'));
    roots.push(root);
    const dbPath = path.join(root, 'app.sqlite');
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE sites (id TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE courses (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, site_id TEXT, version INTEGER NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE course_assets (
            id TEXT PRIMARY KEY, site_id TEXT, kind TEXT NOT NULL, meta_json TEXT
        );
        CREATE TABLE map_build_jobs (id TEXT PRIMARY KEY, site_id TEXT);
        INSERT INTO sites VALUES ('canonical-site', 'Landeryd'), ('duplicate-site', 'Landeryd duplicate');
        INSERT INTO courses VALUES
            ('canonical-course', 'Masters', 'canonical-site', 5, '2000-01-01T00:00:00Z'),
            ('duplicate-course', 'Classic', 'duplicate-site', 3, '2000-01-01T00:00:00Z');
        INSERT INTO course_assets VALUES
            ('canonical-manifest', 'canonical-site', 'tile_manifest', '{"bounds":[1,2]}'),
            ('canonical-ortho', 'canonical-site', 'ortho_cog', NULL),
            ('duplicate-manifest', 'duplicate-site', 'tile_manifest', '{ "bounds": [1, 2] }'),
            ('duplicate-ortho', 'duplicate-site', 'ortho_cog', NULL);
    `);
    db.close();

    const tilesRoot = path.join(root, 'tiles');
    const canonicalTiles = path.join(tilesRoot, 'canonical-site');
    const duplicateTiles = path.join(tilesRoot, 'duplicate-site');
    fs.mkdirSync(canonicalTiles, { recursive: true });
    fs.writeFileSync(path.join(canonicalTiles, 'marker'), 'canonical');
    fs.symlinkSync(canonicalTiles, duplicateTiles, 'dir');

    return {
        dbPath,
        canonicalTiles,
        duplicateTiles,
        options: {
            dbPath,
            dataDir: root,
            canonicalCourseId: 'canonical-course',
            duplicateCourseId: 'duplicate-course',
            canonicalSiteId: 'canonical-site',
            duplicateSiteId: 'duplicate-site',
            apply: false,
        },
    };
}

describe('consolidateSharedSite', () => {
    test('dry-run validates but changes neither database nor filesystem', () => {
        const setup = fixture();
        const result = consolidateSharedSite(setup.options);
        expect(result.applied).toBe(false);
        expect(fs.lstatSync(setup.duplicateTiles).isSymbolicLink()).toBe(true);

        const db = new Database(setup.dbPath, { readonly: true });
        expect(db.query('SELECT site_id, version FROM courses WHERE id = ?').get('duplicate-course'))
            .toEqual({ site_id: 'duplicate-site', version: 3 });
        expect((db.query('SELECT COUNT(*) AS count FROM sites').get() as { count: number }).count).toBe(2);
        db.close();
    });

    test('apply repoints and versions the course, removes duplicate metadata and only unlinks the symlink', () => {
        const setup = fixture();
        const result = consolidateSharedSite({ ...setup.options, apply: true });
        expect(result.applied).toBe(true);
        expect(fs.existsSync(setup.duplicateTiles)).toBe(false);
        expect(fs.readFileSync(path.join(setup.canonicalTiles, 'marker'), 'utf8')).toBe('canonical');

        const db = new Database(setup.dbPath, { readonly: true });
        const course = db.query('SELECT site_id, version, updated_at FROM courses WHERE id = ?')
            .get('duplicate-course') as { site_id: string; version: number; updated_at: string };
        expect(course.site_id).toBe('canonical-site');
        expect(course.version).toBe(4);
        expect(course.updated_at).not.toBe('2000-01-01T00:00:00Z');
        expect(db.query('SELECT id FROM sites WHERE id = ?').get('duplicate-site')).toBeNull();
        expect(db.query('SELECT id FROM course_assets WHERE site_id = ?').all('duplicate-site')).toEqual([]);
        expect(db.query('SELECT id FROM course_assets WHERE site_id = ?').all('canonical-site')).toHaveLength(2);
        db.close();
    });

    test('refuses a real duplicate directory and leaves it untouched', () => {
        const setup = fixture();
        fs.unlinkSync(setup.duplicateTiles);
        fs.mkdirSync(setup.duplicateTiles);
        fs.writeFileSync(path.join(setup.duplicateTiles, 'must-survive'), 'safe');

        expect(() => consolidateSharedSite({ ...setup.options, apply: true }))
            .toThrow('duplicate tile path must be a symlink');
        expect(fs.readFileSync(path.join(setup.duplicateTiles, 'must-survive'), 'utf8')).toBe('safe');

        const db = new Database(setup.dbPath, { readonly: true });
        expect(db.query('SELECT site_id, version FROM courses WHERE id = ?').get('duplicate-course'))
            .toEqual({ site_id: 'duplicate-site', version: 3 });
        db.close();
    });
});
