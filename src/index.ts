import { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionTitleService } from '@deepseek-ai/dsh-session-title'
import '@deepseek-ai/dsh-workspace'
import { KInterval } from './k-interval.ts'
import { reIndexEvents } from './re-index.ts'
import { turnRules, seqRules } from './rules.ts'

// Host plugin for the /klip command: extract KInterval turn ranges from the
// current session and merge them into a new session.
export const name = 'dsh-klip'

export const inject = ['commands', 'agents', 'sessions', 'workspaceRegistry']

// Register the global /klip command.
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'klip',
    description: 'Extract the selected turn ranges into one new session',
    input: { hint: '<KInterval> (1-based turns), e.g. 1..3,7' },
    handler: (invocation) => executeKlip(ctx, invocation),
  })
}

async function executeKlip(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const source = invocation.agent.session
  const events = source.events
  const cwd = source.header.cwd

  const turnCount = events.findLast(e => e.type === 'turn/end')?.data.turn ?? 0
  if (turnCount <= 0) return { kind: 'error', text: 'No turns to split.' }

  const raw = invocation.rawInput.trim()
  if (raw.length === 0) return { kind: 'error', text: 'Usage: /klip <KInterval>, e.g. /klip ..3, 5, 7.., -10..-5, not 2' }

  let kInterval: KInterval
  let intervals: { s: number; e: number }[]
  try {
    kInterval = KInterval.from_string(raw)
    intervals = kInterval.instantiate(turnCount)
  } catch (error) {
    return { kind: 'error', text: `Invalid KInterval: ${String(error)}` }
  }
  if (intervals.length === 0) return { kind: 'error', text: 'No intervals matched any turn.' }

  // Extract the selected ranges and re-index them into a seed: seq contiguous
  // from 0, turn dense from 1..N. reIndexEvents is pure and deep-copies internally.
  let seed: SessionEvent[]
  try {
    seed = reIndexEvents(events, kInterval, { turnRules, seqRules })
  } catch (error) {
    return { kind: 'error', text: `Failed to re-index events: ${String(error)}` }
  }
  if (seed.length === 0) return { kind: 'error', text: 'No events in the selected range.' }

  const agentOptions = {
    ...invocation.agent.options.provider !== undefined ? { provider: invocation.agent.options.provider } : {},
    ...invocation.agent.options.model !== undefined ? { model: invocation.agent.options.model } : {},
  }

  const childId = `session-klip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  try {
    const child = await ctx.agents.create({
      sessionId: SessionId(childId),
      seed,
      meta: {
        ...cwd !== undefined ? { cwd } : {},
        seedLength: seed.length,
      },
      agentOptions,
    })

    // Title the new session "KLIP <source title>" so it is easy to tell apart
    // from the source. The title service is optional: when the profile lacks it
    // (or the source has no title yet) the child keeps its auto-generated title.
    const titleService: SessionTitleService | undefined = ctx.get('sessionTitle')
    if (titleService !== undefined) {
      const sourceTitle = titleService.get(source)?.title
      if (sourceTitle !== undefined) titleService.rename(child.agent.session, `KLIP ${sourceTitle}`)
    }

    await ctx.sessions.flush(child.agent.session)

    // Attach the new session to the source session's workspace; skip when the
    // source belongs to no workspace (it stays ungrouped).
    const workspace = ctx.workspaceRegistry.list().find(w => w.sessionIds.includes(source.id))
    if (workspace !== undefined) await workspace.attachSession(SessionId(childId))
  } catch (error) {
    return { kind: 'error', text: `Failed to create session: ${String(error)}` }
  }

  return { kind: 'success', text: `Created new session ${childId} with ${intervals.length} interval(s).` }
}

