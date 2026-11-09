/**
 * Franklin's claim gate, fired by the event that creates the claim.
 *
 * The turn is not over when the model stops writing: a listener here can call
 * `agent.steer()`, which forces another step before the turn ends. That is the
 * veto this gate uses - the answer is checked against the tool output produced in
 * the same turn, and an unbacked claim comes straight back to the model to correct
 * while the user is still in the turn.
 *
 * Nothing polls and nothing is timed: one turn closes, one verdict lands.
 *
 * @module @deepseek-ai/dsh-guard-claim-gate
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'

const run = promisify(execFile)

/** Cordis plugin name used by loader diagnostics. */
export const name = 'claim-gate'

/** The agent loop and tool registry this gate observes. */
export const inject = ['agents', 'tools']

/** Marks the correction message this gate injects. */
const CORRECTION_SOURCE: MessageSource = { kind: 'system-prompt' }

/** The deterministic checker and the budget one check may take. */
const CHECKER = join(process.env.HOME ?? '', 'your-setup', 'scripts', 'checks', 'response-gate.mjs')
const TIMEOUT_MS = 120_000

/** Forced corrections per agent per turn before the gate gives up and logs. */
const MAX_CORRECTIONS = 2

/** What one turn has produced so far: the answer and its evidence. */
export interface TurnSoFar {
  message: string
  toolText: string
}

/**
 * Run the checker against one accumulated turn.
 * @param turn - the answer and the tool output from the same turn.
 * @returns the correction text when a claim is unbacked, else undefined.
 */
async function check(turn: TurnSoFar): Promise<string | undefined> {
  const folder = mkdtempSync(join(tmpdir(), 'claim-gate-'))
  const file = join(folder, 'turn.json')
  writeFileSync(file, JSON.stringify(turn))
  try {
    await run('node', [CHECKER, '--turn-json', file], { timeout: TIMEOUT_MS })
    return undefined
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    // Exit 1 is a verdict. Exit 3 means the input was unreadable, which must never
    // be mistaken for a clean turn.
    if (failure.code === 1) return (failure.stdout ?? '').trim()
    if (failure.code === 3) return 'claim gate could not read this turn: ' + (failure.stderr ?? '').trim()
    return undefined
  }
}

/**
 * Gate every turn at its stopping boundary.
 */
export function apply(ctx: Context): void {
  const turns = new WeakMap<object, TurnSoFar>()
  const corrections = new WeakMap<object, number>()

  const current = (agent: Agent): TurnSoFar => {
    const existing = turns.get(agent)
    if (existing !== undefined) return existing
    const fresh: TurnSoFar = { message: '', toolText: '' }
    turns.set(agent, fresh)
    return fresh
  }

  // The answer as it is written. An end frame carries no text, so the text deltas
  // are the source; a start frame marks a fresh attempt and resets the buffer.
  ctx.on('agent/assistant-stream', (payload: { agent: Agent; frame: AssistantStreamFrame }) => {
    const frame = payload.frame
    if (frame.type === 'start') { current(payload.agent).message = ''; return }
    if (frame.type !== 'chunk') return
    const chunk = frame.chunk as { type?: string; text?: string }
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      current(payload.agent).message += chunk.text
    }
  })

  // The evidence produced inside the same turn: the settled result the model saw.
  ctx.on('tools/post-execute', async (exec: ToolExecution, result: ToolExecutionResult, next): Promise<PostToolDecision> => {
    if (exec.agent !== undefined) {
      const content = (result as { content?: readonly { type?: string; text?: string }[] }).content ?? []
      const settled = content.map(part => part.text ?? '').join('\n')
      // A write's own path is the evidence for "I edited X"; the result text alone
      // rarely names the file.
      const target = (exec.arguments as { file_path?: unknown } | undefined)?.file_path
      const path = typeof target === 'string' ? target + '\n' : ''
      current(exec.agent).toolText += path + settled + '\n'
    }
    // This gate observes; it never changes another plugin's verdict.
    return next()
  })

  ctx.on('agent/turn-stopping', async ({ agent }): Promise<void> => {
    // A child's answer is composed into the parent's, which is gated there.
    if (agent.session.header.origin === 'subagent') return
    const turn = turns.get(agent)
    if (turn === undefined || turn.message.trim() === '') return
    const correction = await check(turn)
    turns.delete(agent)
    if (correction === undefined) return

    const seen = corrections.get(agent) ?? 0
    if (seen >= MAX_CORRECTIONS) {
      ctx.logger.warn('claim-gate: %d corrections already forced this turn, stopping', seen)
      return
    }
    corrections.set(agent, seen + 1)
    // Steering at the stopping boundary makes the loop observe pending input and
    // run another step, so the model corrects before the turn ends.
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: 'Claim gate: ' + correction }],
      source: CORRECTION_SOURCE,
    }))
  })
}
