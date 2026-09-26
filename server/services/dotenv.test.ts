import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import * as path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseDotenv, envWithDotenvFallback } from './dotenv';

describe('parseDotenv', () => {
    test('parses KEY=VALUE lines, strips quotes, skips comments/blank lines', () => {
        const parsed = parseDotenv('# comment\n\nLANTMATERIET_USER=alice\nLANTMATERIET_PASS="s3cret=x"\nBROKEN\n');
        expect(parsed).toEqual({ LANTMATERIET_USER: 'alice', LANTMATERIET_PASS: 's3cret=x' });
    });

    test('handles CRLF line endings', () => {
        expect(parseDotenv('A=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' });
    });
});

describe('envWithDotenvFallback', () => {
    const KEYS = ['PUBLISH_URL', 'PUBLISH_TOKEN'] as const;
    let dir: string;
    let serverEnv: string;
    let rootEnv: string;
    const missing = () => path.join(dir, 'nope.env');

    beforeAll(() => {
        dir = mkdtempSync(path.join(tmpdir(), 'golf-map-dotenv-'));
        serverEnv = path.join(dir, 'server.env');
        rootEnv = path.join(dir, 'root.env');
        writeFileSync(serverEnv, 'PUBLISH_URL=https://server-file\n');
        writeFileSync(rootEnv, 'PUBLISH_URL=https://root-file\r\nPUBLISH_TOKEN=root-token\r\n');
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    test('the process env wins over every file', () => {
        const env = { PUBLISH_URL: 'https://env', PUBLISH_TOKEN: 'env-token' };
        expect(envWithDotenvFallback(KEYS, { env, files: [serverEnv, rootEnv] })).toEqual(env);
    });

    test('each key comes from the first file that sets it', () => {
        expect(envWithDotenvFallback(KEYS, { env: {}, files: [serverEnv, rootEnv] }))
            .toEqual({ PUBLISH_URL: 'https://server-file', PUBLISH_TOKEN: 'root-token' });
    });

    test('keys only in the root file are found when server/.env is absent (Windows layout)', () => {
        expect(envWithDotenvFallback(KEYS, { env: {}, files: [missing(), rootEnv] }))
            .toEqual({ PUBLISH_URL: 'https://root-file', PUBLISH_TOKEN: 'root-token' });
    });

    test('a key set nowhere stays undefined', () => {
        expect(envWithDotenvFallback(KEYS, { env: {}, files: [missing(), serverEnv] }))
            .toEqual({ PUBLISH_URL: 'https://server-file' });
    });
});
