import { expect, test } from 'bun:test';
import * as path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnDetached } from './detached-process';

async function scratch(): Promise<string> {
    return mkdtemp(path.join(tmpdir(), 'detached-'));
}

test('a detached process gets the environment, writes both streams to the log and reports its exit code', async () => {
    const dir = await scratch();
    const log = path.join(dir, 'run.log');
    const script = 'console.log("secret=" + process.env.DETACH_SECRET); console.error("to stderr"); process.exit(3)';
    const proc = await spawnDetached([process.execPath, '-e', script], {
        cwd: dir, env: { ...process.env, DETACH_SECRET: 's3cret' }, log, pollMs: 100,
    });
    expect(proc.pid).toBeGreaterThan(0);
    expect(await proc.exited()).toBe(3);
    const text = await readFile(log, 'utf8');
    expect(text).toContain('secret=s3cret');
    expect(text).toContain('to stderr');
}, 30_000);

test.if(process.platform === 'win32')('on Windows it is created by WMI, so it is in no job of whoever started it', async () => {
    const dir = await scratch();
    const proc = await spawnDetached([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
        cwd: dir, env: { ...process.env }, log: path.join(dir, 'run.log'), pollMs: 100,
    });
    try {
        const ps = Bun.spawnSync(['powershell.exe', '-NoProfile', '-Command',
            `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${proc.pid}"; (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)").Name`]);
        expect(ps.stdout.toString().trim()).toBe('WmiPrvSE.exe');
    } finally {
        await proc.kill();
    }
    // kill() waits until it is gone.
    expect(() => process.kill(proc.pid, 0)).toThrow();
}, 30_000);
