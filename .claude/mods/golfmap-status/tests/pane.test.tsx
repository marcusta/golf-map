import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// The machine beneath the mod, answered from memory: a golf-map checkout, two
// transcripts in its project folder (one that asks, this session's own), one
// too old to read, a shaping worker, a Unity editor, Arborist running, and a
// course whose checklist has three steps.
const NOW = Date.parse('2026-10-22T12:00:00Z')
const HOME = 'C:/Users/m'
const ROOT = 'D:/golf-map'
const PROJECT = `${HOME}/.claude/projects/D--golf-map`
const ASKING = `${PROJECT}/asking.jsonl`
const BRIDGES = `${HOME}/AppData/Local/GolfMapBridge`

const file = (name: string, mtimeMs: number) => ({ name, kind: 'file' as const, size: 10, mtimeMs, isLink: false })
const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
const ran = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
/** The engine hands a hook paths in the platform's spelling (`C:\Users\...` here). */
const norm = (path: unknown) => String(path ?? '').replace(/\\/g, '/')
const answered = (body: object) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })

const COURSE = {
  id: 'vreta-1',
  name: 'Vreta',
  steps: [
    { id: 'setup', label: 'Course set up', state: 'done', detail: '18 holes', manual: null },
    { id: 'terrain', label: 'Terrain', state: 'stale', detail: '71 changes (terrain edits)', manual: null },
    { id: 'check', label: 'Course check', state: 'todo', detail: 'never run', manual: 'bun run course:check -- Vreta' },
  ],
}

/** What the mod logged (a read that failed). */
const logs: string[] = []

/** Every call the mod makes on `$` beneath it; `read` collects the transcripts the helper was handed. */
function machine(on: On, read: string[]) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { USERPROFILE: HOME, LOCALAPPDATA: `${HOME}/AppData/Local` })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', (_, e) => {
    logs.push(JSON.stringify(e))

    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 'own' }))
  on('command.register', () => ({ value: { command: 'course-status' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.exists', (_, e) => ({ value: norm(e.path) === `${ROOT}/scripts/course-progress.ts` }))
  on('fs.list', (_, e) => {
    const path = norm(e.path)
    if (path === `${HOME}/.claude/projects`) return { value: [dir('D--golf-map'), dir('C--elsewhere')] }
    if (path === PROJECT) {
      return { value: [file('asking.jsonl', NOW - 60_000), file('own.jsonl', NOW), file('old.jsonl', NOW - 5 * 24 * 3600_000)] }
    }
    if (path === BRIDGES) return { value: [file('bridge-100.json', NOW)] }

    return { value: [] }
  })
  on('fs.read', (_, e) => ({
    value: norm(e.path) === `${BRIDGES}/bridge-100.json`
      ? JSON.stringify({ pid: 100, port: 8765, token: 'tok', projectName: 'vreta_v4_2025_12_02' })
      : '',
  }))
  on('http.fetch', (_, e) => {
    if (e.url === 'http://127.0.0.1:8766/status') {
      return answered({ format: 'golfmap-shaping-worker-v1', state: 'ready', phase: null, layersDir: 'D:\\golf-map\\docs\\gspro\\ombergs-golfklubb\\shaping' })
    }
    if (e.url === 'http://127.0.0.1:8765/status' && e.init?.headers?.['X-Bridge-Token'] === 'tok') {
      return answered({ ok: true, result: { compiling: false, updating: false, scenes: [{ dirty: false }] } })
    }

    return { deny: 'connection refused' }
  })
  on('process.run', (_, e) => {
    if (e.argv[0] === 'tasklist') return ran('"Unity.exe","100","Console","1","9 K"\r\n"Arborist.exe","200","Console","1","9 K"\r\n')
    if (String(e.argv[1]).endsWith('waiting-sessions.ts')) {
      const paths = String(e.init?.stdin ?? '').split('\n').filter(Boolean)
      read.push(...paths)

      return ran(JSON.stringify(Object.fromEntries(paths.map(path => [path, {
        title: 'Kodgranskning: diken',
        waiting: {
          kind: 'ask', text: 'Ska jag bygga bäckbäddarna på Vreta nu?', options: ['Bygg bäddarna nu', 'Vänta på murarna'],
          isBlocked: true, since: new Date(NOW - 60_000).toISOString(),
        },
      }]))))
    }
    if (e.argv[1] === 'scripts/course-progress.ts' && norm(e.init?.cwd) === ROOT) return ran(JSON.stringify({ courses: [COURSE] }))

    return { value: { exitCode: 1, stdout: '', stderr: 'unexpected command', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  return clock
}

/** What a drawn tree shows: a Text's strings run together, a Box's children one a line, a Button's label when it has no children. */
function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (!node || typeof node !== 'object') return ''
  const one = node as { type?: string; props?: { label?: unknown }; children?: unknown[] }
  const children = one.children ?? []
  if (children.length === 0) return typeof one.props?.label === 'string' ? one.props.label : ''

  return children.map(textOf).join(one.type === 'Box' ? '\n' : '')
}

const PANE = {
  plugin: 'golfmap-status',
  component: 'Pane',
  requestId: 'golfmap-status',
  props: {
    title: 'Course status',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane shows what waits, the machines and the courses, on ${surface}`, async ($, on) => {
    const read: string[] = []
    const clock = machine(on, read)
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(1000)

    const ui = await $.ui.mount({ ...PANE, surface })
    const shown = textOf(await ui.drawn())
    expect(logs).toEqual([])
    expect(read).toEqual([ASKING])
    for (const words of [
      'Waiting for you · 1', 'Kodgranskning: diken', 'Ska jag bygga bäckbäddarna på Vreta nu?', 'Bygg bäddarna nu · Vänta på murarna',
      'ombergs-golfklubb :8766 ready', 'vreta · idle', 'Arborist', 'running', 'GSPro', 'closed', 'Vreta', '1/3',
    ]) expect(shown).toContain(words)
    expect(shown).not.toContain('71 changes')
    await ui.unmount()
  })

  test(`a course unfolds to its checklist and × puts a question away, on ${surface}`, async ($, on) => {
    const clock = machine(on, [])
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(1000)

    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'open-vreta-1' })
    let shown = textOf(await ui.drawn())
    for (const words of ['Terrain', '71 changes (terrain edits)', 'Course check', 'then: ', 'bun run course:check -- Vreta']) expect(shown).toContain(words)

    await ui.press({ key: `x-${ASKING}` })
    shown = textOf(await ui.drawn())
    expect(shown).toContain('No session is waiting.')
    expect(shown).not.toContain('bäckbäddarna')
    await ui.unmount()
  })
}
