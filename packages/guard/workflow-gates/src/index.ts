/**
 * Franklin's gates, enforced in the harness instead of promised in a rule file.
 *
 * Ports `~/workflow/scripts/gate/*.sh` onto `tools/pre-execute`, so an install,
 * an outbound draft, or a start on paid work is stopped **before** it runs.
 * The policy itself stays in those scripts — one source of truth, readable and
 * testable on its own.
 *
 * Three gates:
 *
 * - **G-WF1 install** — every package install needs a recorded approval in
 *   `~/.dsh/agent/install-approvals.json`.
 * - **G-WF2 send** — nothing leaves from an unapproved draft.
 * - **G-WF3 task** — no paid client work before the 50% deposit is confirmed.
 *
 * Unlike pi's `tool_call` hook, this covers every tool, not only `bash`: a
 * shell tool and any future exec tool are both inspected.
 *
 * @module @deepseek-ai/dsh-guard-workflow-gates
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

const run = promisify(execFile)

/** Cordis plugin name used by loader diagnostics. */
export const name = 'workflow-gates'

/** The tool registry whose dispatch this plugin inspects. */
export const inject = ['tools']

/** Where the gate scripts live; overridable for a different checkout. */
const GATE_DIR = `${process.env.HOME ?? ''}/workflow/scripts/gate`

/**
 * Cheap pre-filters. A hit runs the script; a miss costs nothing.
 * Kept deliberately loose: the script is the authority, this only decides
 * whether asking it is worth a process.
 */
const INSTALL_HINT =
  /(pkg|apt|apt-get|dpkg)\s+(install|add)|npm\s+(install|i|add)\b|yarn\s+add|pnpm\s+(i|install|add)\b|pip3?\s+install|cargo\s+install|gem\s+install|go\s+install|pi\s+install|npx\s+[a-z@]|(curl|wget)[^|]*\|\s*(sh|bash)\b/
const SEND_HINT = /send-draft\.sh\s+(check|send)/
const TASK_HINT = /start-task\.sh\s+check/

/** One gate script outcome. */
interface GateResult {
  readonly ok: boolean
  readonly output: string
}

/**
 * Run one gate script and read its verdict.
 * @param script - file name under {@link GATE_DIR}.
 * @param args - argv passed to the script after its path.
 * @returns whether the script exited clean, plus its combined output.
 */
async function runGate(script: string, args: string[]): Promise<GateResult> {
  try {
    const { stdout, stderr } = await run('bash', [`${GATE_DIR}/${script}`, ...args], { timeout: 10_000 })
    return { ok: true, output: `${stdout}${stderr}`.trim() }
  } catch (error) {
    const failure = error as { code?: number, stdout?: string, stderr?: string, message?: string }
    // A non-zero exit is a verdict; a spawn failure is a broken gate and must
    // fail closed for installs rather than silently allowing.
    const output = `${failure.stdout ?? ''}${failure.stderr ?? failure.message ?? ''}`.trim()
    return { ok: false, output: output === '' ? 'gate script failed to run' : output }
  }
}

/**
 * Read the shell command out of a tool call. `bash` and compatibles take
 * `command`; anything else has no command to inspect.
 * @param exec - the dispatch about to run.
 * @returns the command string, or undefined when this call carries none.
 */
function commandOf(exec: ToolExecution): string | undefined {
  const args = exec.arguments
  if (typeof args !== 'object' || args === null) return undefined
  const command = (args as { command?: unknown }).command
  return typeof command === 'string' && command !== '' ? command : undefined
}

/**
 * Deny with a reason the model can act on.
 * @param reason - what was blocked and why.
 * @returns a `deny` decision.
 */
function deny(reason: string): PreToolDecision {
  return { kind: 'deny', reason }
}

/**
 * Inspect every dispatch and block the three gated actions.
 */
export function apply(ctx: Context): void {
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const command = commandOf(exec)
    if (command === undefined) return next()

    if (INSTALL_HINT.test(command)) {
      const gate = await runGate('safe-install.sh', ['check', command])
      if (!gate.ok) return deny(`[G-WF1] install blocked — permission not recorded. ${gate.output}`)
    }

    if (SEND_HINT.test(command)) {
      const draft = /send-draft\.sh\s+\w+\s+['"]?([^'"\s]+)/.exec(command)?.[1]
      if (draft !== undefined) {
        const gate = await runGate('send-draft.sh', ['check', draft])
        if (!gate.ok) return deny(`[G-WF2] send blocked — draft not approved. ${gate.output}`)
      }
    }

    if (TASK_HINT.test(command)) {
      const note = /start-task\.sh\s+check\s+['"]?([^'"\s]+)/.exec(command)?.[1]
      if (note !== undefined) {
        const gate = await runGate('start-task.sh', ['check', note])
        if (!gate.ok) return deny(`[G-WF3] task blocked — 50% not confirmed. ${gate.output}`)
      }
    }

    return next()
  })
}
