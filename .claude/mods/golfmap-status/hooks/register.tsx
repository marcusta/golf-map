// A pane beside the chat for building golf courses: the sessions waiting for
// an answer and what each asks, the programs the build leans on, and each
// course's checklist on its way to GSPro. `/course-status` opens it.
//
// Where it reads:
//   - sessions: the ends of this project's transcripts (`~/.claude/projects/<project>*/`),
//     through helpers/waiting-sessions.ts, only the files that changed
//   - shaping workers: `GET http://127.0.0.1:<8766-8785>/status`; Unity editors:
//     `%LOCALAPPDATA%/GolfMapBridge/bridge-<pid>.json`, then the bridge's `/status`;
//     GSPro, Arborist, GreenKeeper: `tasklist`
//   - courses: `bun scripts/course-progress.ts all --json` in the golf-map repo
//
// Reading is slow on purpose: sessions every 15 s, machines every 20 s, the
// courses every 10 minutes (Refresh reads them at once). While GSPro or
// GreenKeeper runs, a flyover or a round may be measured: sessions and
// machines slow to once a minute or two and the courses wait for Refresh.
//
// Every session loads this folder through `CLAUDE_CODE_PLUGIN_DIRS` in the env
// block of `~/.claude/settings.json`; an edit reaches a session when it starts.
// Check an edit with the Claude Code the desktop app runs
// (`%LOCALAPPDATA%/Claude-Data/claude_*/claude-code/<version>/*/claude.exe plugin
// validate|test <this folder>`): an older `claude` on PATH refuses the state helpers.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CourseProgress, CourseStep, Machine, MachineState, StepState, WaitingSession } from '../types'
import { appRows, clock, coursesOf, editorRow, isMeasuring, processesOf, waitingList, workerRow, type Report } from './describe'

type Engine = EngineInterface

const PANE = 'golfmap-status'
const TITLE = 'Course status'
const COMMAND = 'course-status'

const waiting = atom({ plugin: 'golfmap-status', key: 'waiting' } as const, [])
const machines = atom({ plugin: 'golfmap-status', key: 'machines' } as const, [])
const courses = atom({ plugin: 'golfmap-status', key: 'courses' } as const, [])
const coursesReadAt = atom({ plugin: 'golfmap-status', key: 'coursesReadAt' } as const, null)
const coursesError = atom({ plugin: 'golfmap-status', key: 'coursesError' } as const, null)
const isReadingCourses = atom({ plugin: 'golfmap-status', key: 'isReadingCourses' } as const, false)
const openCourse = atom({ plugin: 'golfmap-status', key: 'openCourse' } as const, null)
const dismissed = atom({ plugin: 'golfmap-status', key: 'dismissed' } as const, {})

const TICK_MS = 15_000
const EVERY = { sessions: 15_000, machines: 20_000, courses: 10 * 60_000 }
const MEASURING = { sessions: 60_000, machines: 120_000 }
/** Transcripts untouched for longer than this are not read. */
const RECENT_MS = 3 * 24 * 3600_000
const WORKER_PORTS = Array.from({ length: 20 }, (_, i) => 8766 + i)

/** Where things are on this machine, read when the session starts. */
type Places = {
  /** The Claude config folder (`~/.claude`). */
  claudeDir: string
  /** The session's project folder (the golf-map repo). */
  root: string
  /** The project's transcript folders are named this (the root, every other character a `-`), worktrees after it. */
  projectsPrefix: string
  bridgeDir: string | null
  /** This session's transcript, left out of the waiting list. */
  ownSession: string
}

// The module's own: a reload starts them over, which only means every read is due.
let at: Places | null = null
let helper = ''
let withCourses = false
let measuring = false
let isTicking = false
const last = { sessions: 0, machines: 0, courses: 0 }
/** What the helper last said of each transcript, by the size and mtime it had then. */
const seen = new Map<string, { size: number; mtimeMs: number; report: Report | null }>()

async function places($: Engine): Promise<Places> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const profile = await $.env.get('USERPROFILE')
  const home = await $.env.get('HOME')
  const local = await $.env.get('LOCALAPPDATA')
  const root = await $.session.root()

  return {
    claudeDir: config ?? `${profile ?? home ?? ''}/.claude`,
    root,
    projectsPrefix: root.replace(/[^A-Za-z0-9]/g, '-'),
    bridgeDir: local ? `${local}/GolfMapBridge` : null,
    ownSession: await $.session.id(),
  }
}

/** `work`, or `fallback` once `ms` have passed or it failed. */
async function within<T>($: Engine, ms: number, work: Promise<T>, fallback: T): Promise<T> {
  let timer: { cancel: () => void } | undefined
  const late = new Promise<T>(resolve => {
    timer = $.clock.after(ms, () => resolve(fallback))
  })
  try {
    return await Promise.race([work.catch(() => fallback), late])
  } finally {
    timer?.cancel()
  }
}

async function getJson($: Engine, url: string, headers?: Record<string, string>): Promise<any> {
  const res = await within($, 2000, $.http.fetch(url, { headers }), null)
  try {
    return res ? JSON.parse(res.text) : null
  } catch {
    return null
  }
}

async function readWaiting($: Engine, where: Places): Promise<WaitingSession[]> {
  const now = await $.clock.now()
  const projects = `${where.claudeDir}/projects`
  const folders = (await $.fs.list(projects)).filter(one => one.kind === 'dir' && one.name.startsWith(where.projectsPrefix))
  const files: Array<{ path: string; size: number; mtimeMs: number }> = []
  for (const folder of folders) {
    for (const one of await $.fs.list(`${projects}/${folder.name}`)) {
      if (one.kind !== 'file' || !one.name.endsWith('.jsonl')) continue
      if (one.name === `${where.ownSession}.jsonl` || now - one.mtimeMs > RECENT_MS) continue
      files.push({ path: `${projects}/${folder.name}/${one.name}`, size: one.size, mtimeMs: one.mtimeMs })
    }
  }

  const changed = files.filter(file => {
    const was = seen.get(file.path)

    return !was || was.size !== file.size || was.mtimeMs !== file.mtimeMs
  })
  if (changed.length > 0) {
    const ran = await $.process.run(['bun', helper], { stdin: changed.map(file => file.path).join('\n'), timeoutMs: 30_000 })
    if (ran.exitCode !== 0) throw new Error(`waiting-sessions: ${ran.stderr.trim().split(/\r?\n/).at(-1) ?? ran.exitCode}`)
    const out = JSON.parse(ran.stdout) as Record<string, Report | { error: string }>
    for (const file of changed) {
      const one = out[file.path]
      seen.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, report: one && !('error' in one) ? one : null })
    }
  }
  const live = new Set(files.map(file => file.path))
  for (const path of [...seen.keys()]) if (!live.has(path)) seen.delete(path)

  return waitingList([...seen].map(([path, one]) => [path, one.report]))
}

async function readMachines($: Engine, where: Places, procs: Map<string, number[]>): Promise<Machine[]> {
  const unityPids = new Set(procs.get('unity.exe') ?? [])
  const names = where.bridgeDir ? await $.fs.list(where.bridgeDir).catch(() => []) : []
  const bridges: Array<{ pid: number; port: number; token: string; projectName: string }> = []
  for (const one of names.filter(entry => /^bridge-\d+\.json$/.test(entry.name))) {
    const info = await $.fs.read(`${where.bridgeDir}/${one.name}`).then(JSON.parse, () => null)
    // A file whose Unity is gone is the editor's leftover (the bridge's own listing deletes it).
    if (info && (procs.size === 0 || unityPids.has(Number(info.pid)))) bridges.push(info)
  }
  const bridgePorts = new Set(bridges.map(one => Number(one.port)))

  const [workers, editors] = await Promise.all([
    Promise.all(WORKER_PORTS.filter(port => !bridgePorts.has(port))
      .map(async port => ({ port, body: await getJson($, `http://127.0.0.1:${port}/status`) }))),
    Promise.all(bridges.map(async one => editorRow(Number(one.pid), String(one.projectName ?? '?'),
      (await getJson($, `http://127.0.0.1:${one.port}/status`, { 'X-Bridge-Token': String(one.token) }))?.result ?? null))),
  ])
  const shaping = workers.filter(one => one.body?.format === 'golfmap-shaping-worker-v1').map(one => workerRow(one.port, one.body))

  return [
    ...(shaping.length ? shaping : [{ id: 'shaping', label: 'Shaping', state: 'off', text: 'no worker' } as Machine]),
    ...(editors.length ? editors : [{ id: 'unity', label: 'Unity', state: 'off', text: 'no editor open' } as Machine]),
    ...appRows(procs),
  ]
}

async function refreshCourses($: Engine) {
  if (!at || (await read($, isReadingCourses))) return
  await update($, isReadingCourses, () => true)
  last.courses = await $.clock.now()
  try {
    const ran = await $.process.run(['bun', 'scripts/course-progress.ts', 'all', '--json'], { cwd: at.root, timeoutMs: 300_000 })
    if (ran.exitCode !== 0) throw new Error(ran.stderr.trim().split(/\r?\n/).at(-1) || `course-progress exited ${ran.exitCode}`)
    const list = coursesOf(ran.stdout)
    await update($, courses, () => list)
    await update($, coursesError, () => null)
  } catch (error) {
    await update($, coursesError, () => String((error as Error).message ?? error))
  } finally {
    const readAt = last.courses
    await update($, coursesReadAt, () => readAt)
    await update($, isReadingCourses, () => false)
  }
}

async function tick($: Engine) {
  if (!at || isTicking) return
  isTicking = true
  try {
    const now = await $.clock.now()
    if (now - last.machines >= (measuring ? MEASURING.machines : EVERY.machines)) {
      last.machines = now
      const ran = await within($, 10_000, $.process.run(['tasklist', '/fo', 'csv', '/nh'], { timeoutMs: 10_000 }), null)
      const procs = processesOf(ran?.exitCode === 0 ? ran.stdout : '')
      measuring = isMeasuring(procs)
      const list = await readMachines($, at, procs)
      await update($, machines, () => list)
    }
    if (now - last.sessions >= (measuring ? MEASURING.sessions : EVERY.sessions)) {
      last.sessions = now
      const list = await readWaiting($, at)
      const hidden = await read($, dismissed)
      await update($, waiting, () => list)
      const count = list.filter(one => one.kind !== 'tool' && hidden[one.file] !== one.since).length
      $.ui.status(count ? `${count} waiting for you` : undefined)
    }
    if (withCourses && !measuring && now - last.courses >= EVERY.courses) void refreshCourses($)
  } catch (error) {
    $.ui.log(`course-status: ${String((error as Error).message ?? error)}`)
  } finally {
    isTicking = false
  }
}

// --- Drawing ---

const STEP: Record<StepState, { glyph: string; color: string }> = {
  done: { glyph: '✓', color: 'success' },
  stale: { glyph: '!', color: 'warning' },
  todo: { glyph: '○', color: 'inactive' },
  failed: { glyph: '✕', color: 'error' },
  blocked: { glyph: '⊘', color: 'inactive' },
}

const MACHINE: Record<MachineState, string> = { ok: 'success', busy: 'warning', warn: 'error', off: 'inactive' }

const glyphOf = (one: WaitingSession) => (one.kind === 'tool' ? '⋯' : one.kind === 'offer' ? '+' : '?')
const colorOf = (one: WaitingSession) => (one.kind === 'tool' ? 'inactive' : one.isBlocked ? 'warning' : 'suggestion')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    at = await places($)
    helper = `${$.plugin.root}/helpers/waiting-sessions.ts`
    withCourses = await $.fs.exists(`${at.root}/scripts/course-progress.ts`)
    const kept = await $.store.get('dismissed')
    if (kept && typeof kept === 'object') await update($, dismissed, () => kept as Record<string, string>)
    await $.command.register({ name: COMMAND, description: 'Show the course status pane: waiting sessions, machines, course checklists' })
    void $.ui.open({ id: PANE, title: TITLE })
    $.clock.every(TICK_MS, () => void tick($))
    $.clock.after(1000, () => void tick($))

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    last.sessions = 0
    last.machines = 0
    void tick($)
    if (withCourses) void refreshCourses($)

    return { text: 'Course status pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    const hidden = await read($, dismissed)
    const asking = (await read($, waiting)).filter(one => hidden[one.file] !== one.since)
    const running = await read($, machines)
    const list = await read($, courses)
    const readAt = await read($, coursesReadAt)
    const error = await read($, coursesError)
    const reading = await read($, isReadingCourses)
    const open = await read($, openCourse)

    const hide = (one: WaitingSession) => async () => {
      const kept = await update($, dismissed, map => ({ ...map, [one.file]: one.since ?? '' }))
      await $.store.set('dismissed', kept)
    }
    const toggle = (one: CourseProgress) => () => update($, openCourse, id => (id === one.id ? null : one.id))

    const question = (one: WaitingSession) => (
      <Box key={`w-${one.file}`} flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text>
            <Text color={colorOf(one)}>{glyphOf(one)}</Text> {one.title}
          </Text>
          <Box flexDirection="row" gap={1}>
            <Text dimColor>{clock(one.since, now)}</Text>
            <Button key={`x-${one.file}`} plain dimColor label="×" onPress={hide(one)} />
          </Box>
        </Box>
        <Text dimColor>{one.kind === 'tool' ? `${one.text} has no result yet (running, or asking permission)` : one.text}</Text>
        {one.options.length > 0 ? <Text dimColor size="caption">{one.options.join(' · ')}</Text> : null}
      </Box>
    )

    const machine = (one: Machine) => (
      <Text>
        <Text color={MACHINE[one.state]}>●</Text> {one.label} <Text dimColor>{one.text}</Text>
      </Text>
    )

    const stepRow = (one: CourseStep) => (
      <Box flexDirection="column">
        <Text>
          <Text color={STEP[one.state].color}>{STEP[one.state].glyph}</Text> {one.label}
          {one.detail ? <Text dimColor>  {one.detail}</Text> : null}
        </Text>
        {one.manual && one.state !== 'done' ? <Text dimColor size="caption">   then: {one.manual}</Text> : null}
      </Box>
    )

    const course = (one: CourseProgress) => {
      const done = one.steps.filter(s => s.state === 'done').length
      const isOpen = open === one.id

      return (
        <Box key={`c-${one.id}`} flexDirection="column">
          <Button key={`open-${one.id}`} plain onPress={toggle(one)}>
            {isOpen ? '▾' : '▸'} {one.name} <Text dimColor>{done}/{one.steps.length}</Text>
          </Button>
          <Text>
            {one.steps.map(s => (
              <Text color={STEP[s.state].color}>■</Text>
            ))}
          </Text>
          {isOpen ? <Box flexDirection="column">{one.steps.map(stepRow)}</Box> : null}
        </Box>
      )
    }

    const asked = asking.filter(one => one.kind !== 'tool').length

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text weight="semibold">Waiting for you{asked ? ` · ${asked}` : ''}</Text>
          {asking.length === 0 ? <Text dimColor>No session is waiting.</Text> : asking.map(question)}
        </Box>
        <Box flexDirection="column">
          <Text weight="semibold">Machines</Text>
          {running.length === 0 ? <Text dimColor>Reading…</Text> : running.map(machine)}
        </Box>
        {withCourses ? (
          <Box flexDirection="column">
            <Box flexDirection="row" justifyContent="space-between">
              <Text weight="semibold">Courses</Text>
              <Box flexDirection="row" gap={1}>
                <Text dimColor>{reading ? 'reading…' : readAt ? clock(new Date(readAt).toISOString(), now) : ''}</Text>
                {reading ? null : <Button key="refresh" plain label="Refresh" onPress={() => void refreshCourses($)} />}
              </Box>
            </Box>
            {error ? <Text color="error">{error}</Text> : null}
            {list.length === 0 && !error ? <Text dimColor>{reading ? 'Reading the courses…' : 'Not read yet.'}</Text> : list.map(course)}
          </Box>
        ) : null}
      </Box>
    )
  })
}
