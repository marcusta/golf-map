/** A session whose last turn left something for the person to answer. */
export type WaitingSession = {
  /** The transcript file. */
  file: string
  /** The app's own id (`local_…`), when the app's session list names it. */
  appId: string | null
  title: string
  /**
   * question: a question dialog is open; ask: the turn ended on a next-step
   * question; offer: a new-session card waits; tool: a tool call has no result
   * yet (running, or waiting for permission); text: the reply ends on a question.
   */
  kind: 'question' | 'ask' | 'offer' | 'tool' | 'text'
  text: string
  options: string[]
  isBlocked: boolean
  /** ISO time of the row that asked. */
  since: string | null
}

export type MachineState = 'ok' | 'busy' | 'off' | 'warn'

/** One program the course build leans on: the shaping worker, Unity, GSPro, Arborist. */
export type Machine = { id: string; label: string; state: MachineState; text: string }

/**
 * done: nothing left; stale: done, then something changed; todo: not done
 * yet; failed: ran and found errors; blocked: cannot run now (`detail` says why).
 */
export type StepState = 'done' | 'stale' | 'todo' | 'failed' | 'blocked'

/** One row of a course's checklist, as `bun run course:progress -- --json` prints it. */
export type CourseStep = {
  id: string
  label: string
  state: StepState
  /** One short line: what changed, what is missing, a count. */
  detail: string | null
  /** The step a person must do next, when there is one. */
  manual: string | null
}

export type CourseProgress = { id: string; name: string; steps: CourseStep[] }

declare module 'claude-code' {
  interface PluginState {
    'golfmap-status': {
      waiting: WaitingSession[]
      machines: Machine[]
      courses: CourseProgress[]
      /** Epoch ms of the last course read, null before the first. */
      coursesReadAt: number | null
      /** Why the last course read failed, null when it went through. */
      coursesError: string | null
      isReadingCourses: boolean
      /** The course whose checklist is unfolded. */
      openCourse: string | null
      /** Questions put away with ×: transcript file -> the `since` of the question hidden. */
      dismissed: Record<string, string>
    }
  }
}
