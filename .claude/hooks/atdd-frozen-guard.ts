#!/usr/bin/env bun
/**
 * atdd-frozen-guard — PreToolUse hook that blocks edits to FROZEN acceptance
 * tests during the ATDD build phase.
 *
 * The /atdd skill writes `.claude/atdd-frozen.json` when Marcus approves a
 * feature's acceptance tests:
 *
 *   { "feature": "apply aim point", "paths": ["e2e/tests/04-apply-aim.spec.ts"] }
 *
 * While that file exists, any Edit/Write/NotebookEdit targeting one of the
 * listed paths is denied — so a green/refactor agent cannot weaken a frozen
 * test to fake a pass. Delete `.claude/atdd-frozen.json` (or run the unfreeze
 * step) once the build is done and the feature is merged.
 *
 * Wire-up (project settings.json):
 *   "hooks": { "PreToolUse": [ { "matcher": "Edit|Write|NotebookEdit",
 *     "hooks": [ { "type": "command",
 *       "command": "bun run .claude/hooks/atdd-frozen-guard.ts" } ] } ] }
 *
 * Contract: reads the hook JSON payload on stdin. To BLOCK, it exits 2 with the
 * reason on stderr (the widely-supported PreToolUse block convention). Any other
 * situation exits 0 and allows the call.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function read(fd: number): string {
  try {
    return readFileSync(fd, 'utf8')
  } catch {
    return ''
  }
}

function main(): number {
  const raw = read(0)
  if (!raw.trim()) return 0

  let payload: any
  try {
    payload = JSON.parse(raw)
  } catch {
    return 0 // can't parse → don't get in the way
  }

  const tool: string = payload.tool_name || payload.toolName || ''
  if (!/^(Edit|Write|NotebookEdit|MultiEdit)$/.test(tool)) return 0

  const input = payload.tool_input || payload.toolInput || {}
  const target: string = input.file_path || input.notebook_path || input.filePath || ''
  if (!target) return 0

  const cwd: string = payload.cwd || process.cwd()

  // Load the frozen manifest, if any.
  let frozen: { feature?: string; paths?: string[] }
  try {
    frozen = JSON.parse(readFileSync(resolve(cwd, '.claude/atdd-frozen.json'), 'utf8'))
  } catch {
    return 0 // no active freeze
  }
  const paths = Array.isArray(frozen.paths) ? frozen.paths : []
  if (!paths.length) return 0

  const targetAbs = resolve(cwd, target)
  const hit = paths.find((p) => targetAbs === resolve(cwd, p) || targetAbs.endsWith('/' + p))
  if (!hit) return 0

  process.stderr.write(
    `BLOCKED: "${hit}" is a FROZEN acceptance test for "${frozen.feature ?? 'the current feature'}".\n` +
      `The ATDD contract is to make this test pass by changing production code, not by editing the test.\n` +
      `If the test itself is genuinely wrong, stop and raise it with Marcus — do not edit it. ` +
      `To lift the freeze, remove .claude/atdd-frozen.json.\n`,
  )
  return 2
}

process.exit(main())
