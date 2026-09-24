import { describe, expect, test } from 'bun:test';
import { singleFlight } from './photos-jobs';

describe('singleFlight', () => {
    test('skips a call while one runs and logs errors instead of throwing', async () => {
        let release: () => void = () => {};
        let runs = 0;
        const run = singleFlight('test job', async () => {
            runs++;
            await new Promise<void>((r) => (release = r));
        });
        const first = run();
        expect(await run()).toBe(false);
        release();
        expect(await first).toBe(true);
        expect(runs).toBe(1);

        const failing = singleFlight('failing job', async () => {
            throw new Error('boom');
        });
        expect(await failing()).toBe(true);
        expect(await failing()).toBe(true);
    });
});
