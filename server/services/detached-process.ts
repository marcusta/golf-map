// Start a long-running process that outlives whoever started it.
//
// On Windows a child of Claude (a Bash call, or a dev server started from the
// app) lives in the app's job object, and closing the app kills the whole job:
// the shaping worker died with it and its 40-60 min load was lost. A process
// that WMI creates (Win32_Process.Create) has WmiPrvSE as its parent and is in
// no job, so it survives the app, the server and the shell. Elsewhere a plain
// spawn with unref() is enough.
//
// The command runs under `cmd /c`, which appends its two streams to `log` and
// then one line `[exited <code>]`, read back as the exit code. The environment
// goes to WMI through PowerShell's own environment, never a command line,
// where every process list would show a token.
import { closeSync, openSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

export interface DetachedProcess {
    pid: number;
    /** Still running (a cheap check; nothing is kept polling). */
    alive(): boolean;
    /** Once it is gone: its exit code, or null when that is not known. */
    exitCode(): Promise<number | null>;
    /** Waits until it is gone (polls on Windows while awaited), then its exit code. */
    exited(): Promise<number | null>;
    /** Ends the process (and on Windows what it started) and waits for it. */
    kill(): Promise<void>;
}

export interface DetachedOptions {
    cwd: string;
    env: Record<string, string | undefined>;
    /** Both streams are appended here. */
    log: string;
    /** How often exited() checks a Windows process (default 1 s). */
    pollMs?: number;
}

const EXIT_LINE = /\[exited (-?\d+)\]\s*$/;

export async function spawnDetached(cmd: string[], opts: DetachedOptions): Promise<DetachedProcess> {
    return process.platform === 'win32' ? spawnOutsideJob(cmd, opts) : spawnUnref(cmd, opts);
}

function spawnUnref(cmd: string[], opts: DetachedOptions): DetachedProcess {
    const fd = openSync(opts.log, 'a');
    let proc: ReturnType<typeof Bun.spawn>;
    try {
        proc = Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env, stdin: 'ignore', stdout: fd, stderr: fd });
    } finally {
        closeSync(fd);   // the child holds its own copy
    }
    proc.unref();
    return {
        pid: proc.pid,
        alive: () => proc.exitCode === null && proc.signalCode === null,
        exitCode: async () => proc.exitCode,
        exited: () => proc.exited,
        kill: async () => { proc.kill(); await proc.exited; },
    };
}

// Reads the spec from its own environment, drops it, and hands WMI the rest.
const CREATE_PS = `
$s = $env:GOLFMAP_DETACH | ConvertFrom-Json
Remove-Item env:GOLFMAP_DETACH
$envs = [string[]](Get-ChildItem env: | ForEach-Object { "$($_.Name)=$($_.Value)" })
$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; EnvironmentVariables = $envs }
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $s.commandLine; CurrentDirectory = $s.cwd; ProcessStartupInformation = $si }
"$($r.ReturnValue) $($r.ProcessId)"
`;

/**
 * One argument as the program's argv parser reads it (CommandLineToArgvW):
 * quoted, `"` as `\"`, and the backslashes before a quote doubled. cmd itself
 * only sees quoted stretches, so `& > |` inside a plain path stay literal;
 * `%` and `!` are not escaped (no such paths here).
 */
export function quoteArg(arg: string): string {
    return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

export function windowsCommandLine(cmd: string[], log: string): string {
    const run = cmd.map(quoteArg).join(' ');
    // /s strips the outer quotes; /v:on expands !ERRORLEVEL! after the command, not when the line is read.
    return `cmd.exe /d /v:on /s /c "${run} >> ${quoteArg(log)} 2>&1 & echo [exited !ERRORLEVEL!] >> ${quoteArg(log)}"`;
}

async function spawnOutsideJob(cmd: string[], opts: DetachedOptions): Promise<DetachedProcess> {
    const spec = JSON.stringify({ commandLine: windowsCommandLine(cmd, opts.log), cwd: opts.cwd });
    const ps = Bun.spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', CREATE_PS], {
        env: { ...opts.env, GOLFMAP_DETACH: spec }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(ps.stdout).text(), new Response(ps.stderr).text(), ps.exited]);
    const m = /^(\d+) (\d+)\s*$/m.exec(out);
    if (code !== 0 || !m || m[1] !== '0') {
        throw new Error(`Could not start ${cmd[0]} outside the job (Win32_Process.Create ${m ? `returned ${m[1]}` : 'failed'}): ${(err || out).trim()}`);
    }
    const pid = Number(m[2]);
    const pollMs = opts.pollMs ?? 1000;
    const exitCode = () => exitCodeFrom(opts.log);
    // Polled only while someone waits: an idle timer would keep a CLI that started the worker from exiting
    // (and Bun never fires an unref'd one while the loop is otherwise idle).
    const exited = async (): Promise<number | null> => {
        while (alive(pid)) await Bun.sleep(pollMs);
        return exitCode();
    };
    return {
        pid,
        alive: () => alive(pid),
        exitCode,
        exited,
        kill: async () => {
            Bun.spawnSync(['taskkill', '/PID', String(pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore' });
            await exited();
        },
    };
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function exitCodeFrom(log: string): Promise<number | null> {
    try {
        const m = EXIT_LINE.exec(await readFile(log, 'utf8'));
        return m ? Number(m[1]) : null;
    } catch {
        return null;
    }
}
