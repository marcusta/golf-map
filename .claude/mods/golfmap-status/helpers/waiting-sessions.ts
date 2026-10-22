// Reads the end of Claude Code transcripts and prints, as JSON, what each
// session's last turn left for the person to answer.
//
//   bun waiting-sessions.ts <transcript.jsonl>...
//   bun waiting-sessions.ts < paths.txt        (one path a line)
//
// The answer is one JSON object on stdout, keyed by the path as given. A
// session that asks nothing maps to `waiting: null`.

type Row = Record<string, any>

type Waiting = {
  // question: an AskUserQuestion dialog is open
  // ask:      the turn ended with a next-step question (wrap_up's `ask`)
  // offer:    a start_session card waits for "New session" / "Do it here"
  // tool:     a tool call has no result yet (running, or waiting for permission)
  // text:     the turn ended on a question in its closing text
  kind: 'question' | 'ask' | 'offer' | 'tool' | 'text'
  text: string
  options: string[]
  isBlocked: boolean
  since: string | null
}

type Report = {
  sessionId: string | null
  title: string | null
  cwd: string | null
  entrypoint: string | null
  waiting: Waiting | null
}

const TAIL_STEPS = [512 * 1024, 2 * 1024 * 1024, 8 * 1024 * 1024]

async function tailRows(path: string, size: number, bytes: number) {
  const start = Math.max(0, size - bytes)
  const text = await Bun.file(path).slice(start, size).text()
  const lines = text.split('\n')
  if (start > 0) lines.shift()
  const rows: Row[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch {}
  }

  return { rows, isWhole: start === 0 }
}

function blocks(row: Row): Row[] {
  const content = row.message?.content

  return Array.isArray(content) ? content : []
}

// Every row of a turn carries the promptId of what started it: the person's
// prompt, another session's message or a task notification.
function hasPrompt(row: Row) {
  return row.type === 'user' && typeof row.promptId === 'string'
}

function lastQuestion(text: string) {
  const trimmed = text.trim()
  if (!trimmed.endsWith('?')) return null
  const sentences = trimmed.split(/(?<=[.!?])\s+/)

  return sentences.at(-1) ?? trimmed
}

function judge(rows: Row[]): Waiting | null {
  const promptId = rows.findLast(hasPrompt)?.promptId
  const start = rows.findIndex(row => hasPrompt(row) && row.promptId === promptId)
  const turn = rows.slice(start + 1)

  const queue = turn.filter(row => row.type === 'queue-operation').at(-1)
  if (queue?.operation === 'enqueue') return null

  const uses = new Map<string, { block: Row; row: Row }>()
  const answered = new Set<string>()
  let wrapUp: { block: Row; row: Row } | null = null
  let lastAssistant: Row | null = null
  let closingText = ''
  for (const row of turn) {
    if (row.type === 'assistant') {
      lastAssistant = row
      for (const block of blocks(row)) {
        if (block.type === 'tool_use') {
          uses.set(block.id, { block, row })
          closingText = ''
          if (block.name === 'mcp__ccd_turn__wrap_up') wrapUp = { block, row }
        } else if (block.type === 'text') {
          closingText = block.text
        }
      }
    } else if (row.type === 'user') {
      for (const block of blocks(row)) {
        if (block.type === 'tool_result') answered.add(block.tool_use_id)
      }
    }
  }

  const pending = [...uses.entries()].filter(([id]) => !answered.has(id))
  const question = pending.find(([, use]) => use.block.name === 'AskUserQuestion')
  if (question) {
    const asked: Row[] = question[1].block.input?.questions ?? []

    return {
      kind: 'question',
      text: asked.map(one => one.question).join(' / '),
      options: asked.flatMap(one => (one.options ?? []).map((option: Row) => option.label)),
      isBlocked: true,
      since: question[1].row.timestamp ?? null,
    }
  }
  const offer = pending.find(([, use]) => use.block.name === 'mcp__ccd_session__start_session')
  if (offer) {
    return {
      kind: 'offer',
      text: offer[1].block.input?.title ?? 'A new session',
      options: ['New session', 'Do it here'],
      isBlocked: true,
      since: offer[1].row.timestamp ?? null,
    }
  }
  const tool = pending.at(-1)
  if (tool) {
    return {
      kind: 'tool',
      text: tool[1].block.name,
      options: [],
      isBlocked: false,
      since: tool[1].row.timestamp ?? null,
    }
  }

  if (lastAssistant?.message?.stop_reason !== 'end_turn') return null
  const ask = wrapUp?.block.input
  if (ask?.ask) {
    return {
      kind: 'ask',
      text: ask.ask,
      options: (ask.actions ?? []).map((action: Row) => action.label ?? action.action).filter(Boolean),
      isBlocked: ask.blocked === true,
      since: wrapUp!.row.timestamp ?? null,
    }
  }
  const asked = lastQuestion(closingText)
  if (asked) {
    return { kind: 'text', text: asked, options: [], isBlocked: false, since: lastAssistant.timestamp ?? null }
  }

  return null
}

async function report(path: string): Promise<Report> {
  const size = Bun.file(path).size
  let rows: Row[] = []
  for (const bytes of TAIL_STEPS) {
    const tail = await tailRows(path, size, bytes)
    rows = tail.rows
    if (tail.isWhole || rows.some(hasPrompt)) break
  }
  const title = rows.filter(row => row.type === 'custom-title').at(-1)?.customTitle
    ?? rows.filter(row => row.type === 'last-prompt').at(-1)?.lastPrompt?.slice(0, 60)
    ?? null
  const placed = rows.filter(row => row.cwd !== undefined).at(-1)

  return {
    sessionId: rows.find(row => typeof row.sessionId === 'string')?.sessionId ?? null,
    title,
    cwd: placed?.cwd ?? null,
    entrypoint: placed?.entrypoint ?? null,
    waiting: judge(rows),
  }
}

const paths = process.argv.length > 2
  ? process.argv.slice(2)
  : (await Bun.stdin.text()).split(/\r?\n/).filter(Boolean)
const out: Record<string, Report | { error: string }> = {}
for (const path of paths) {
  try {
    out[path] = await report(path)
  } catch (error) {
    out[path] = { error: String(error) }
  }
}
process.stdout.write(JSON.stringify(out))
