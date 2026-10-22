// Turning what the machine answered into the pane's rows: plain functions of
// plain data. The reading itself is in register.tsx, where `$` is.
import type { CourseProgress, Machine, WaitingSession } from '../types'

/** What helpers/waiting-sessions.ts says of one transcript. */
export type Report = {
  title: string | null
  waiting: Omit<WaitingSession, 'file' | 'appId' | 'title'> | null
}

/** Blocked questions first, then the open dialogs and cards, then the rest; a running tool last. */
function rank(one: WaitingSession) {
  if (one.kind === 'tool') return 3
  if (one.isBlocked) return 0

  return one.kind === 'question' || one.kind === 'offer' ? 1 : 2
}

export function waitingList(reports: Iterable<[string, Report | null]>): WaitingSession[] {
  const list: WaitingSession[] = []
  for (const [file, report] of reports) {
    if (!report?.waiting || !report.title) continue
    list.push({ file, appId: null, title: report.title, ...report.waiting })
  }

  return list.sort((a, b) => rank(a) - rank(b) || (b.since ?? '').localeCompare(a.since ?? ''))
}

/** `tasklist /fo csv /nh` -> image name (lower case) -> pids. */
export function processesOf(csv: string): Map<string, number[]> {
  const procs = new Map<string, number[]>()
  for (const line of csv.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line)
    if (!m) continue
    const name = m[1]!.toLowerCase()
    procs.set(name, [...(procs.get(name) ?? []), Number(m[2])])
  }

  return procs
}

/** GSPro or GreenKeeper is up: a flyover or a round may be measured, so the pane keeps quiet. */
export const isMeasuring = (procs: Map<string, number[]>) => procs.has('gspro.exe') || procs.has('greenkeeper.exe')

const minutes = (seconds: number) => (seconds < 90 ? `${Math.round(seconds)} s` : `${Math.round(seconds / 60)} min`)

/** A shaping worker's `GET /status` (golfmap-shaping-worker-v1). */
export function workerRow(port: number, body: any): Machine {
  const parts = String(body.layersDir ?? '').split(/[\\/]/)
  const course = parts.at(-1) === 'shaping' ? parts.at(-2) : String(body.blend ?? '').split(/[\\/]/).at(-1)
  const job = body.job?.state === 'running' ? body.job : null
  const doing = job ? ` · ${job.phase ?? job.kind ?? 'job'} ${minutes(Number(job.seconds ?? 0))}` : body.phase ? ` · ${body.phase}` : ''
  const state = body.state === 'error' ? 'warn' : body.state === 'ready' && !job ? 'ok' : 'busy'

  return { id: `shaping-${port}`, label: 'Shaping', state, text: `${course ?? '?'} :${port} ${body.state}${doing}` }
}

/** A Unity editor's bridge `GET /status` result, null when it did not answer. */
export function editorRow(pid: number, projectName: string, status: any): Machine {
  const id = `unity-${pid}`
  const name = projectName.split('_')[0]
  if (!status) return { id, label: 'Unity', state: 'busy', text: `${name} · not answering (a build, or reloading)` }
  if (status.busy) return { id, label: 'Unity', state: 'busy', text: `${name} · ${status.busy.command} ${minutes(Number(status.busy.seconds ?? 0))}` }
  if (status.compiling || status.updating) return { id, label: 'Unity', state: 'busy', text: `${name} · ${status.compiling ? 'compiling' : 'importing'}` }
  if ((status.scenes ?? []).some((scene: any) => scene.dirty)) return { id, label: 'Unity', state: 'warn', text: `${name} · unsaved scene` }

  return { id, label: 'Unity', state: 'ok', text: `${name} · idle` }
}

const APPS = [
  { id: 'gspro', label: 'GSPro', image: 'gspro.exe' },
  { id: 'arborist', label: 'Arborist', image: 'arborist.exe' },
  { id: 'greenkeeper', label: 'GreenKeeper', image: 'greenkeeper.exe' },
] as const

export function appRows(procs: Map<string, number[]>): Machine[] {
  if (procs.size === 0) return []

  return APPS.map(app => (procs.has(app.image)
    ? { id: app.id, label: app.label, state: 'ok', text: 'running' }
    : { id: app.id, label: app.label, state: 'off', text: 'closed' }))
}

/** `bun scripts/course-progress.ts all --json`'s answer: its last line. */
export function coursesOf(stdout: string): CourseProgress[] {
  const last = stdout.trim().split(/\r?\n/).at(-1) ?? '{}'

  return (JSON.parse(last) as { courses?: CourseProgress[] }).courses ?? []
}

/** `10:14` today, `21/10 12:38` before. */
export function clock(iso: string | null, now: number): string {
  if (!iso) return ''
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`

  return new Date(now).toDateString() === d.toDateString() ? time : `${d.getDate()}/${d.getMonth() + 1} ${time}`
}
