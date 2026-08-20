import { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionTitleService } from '@deepseek-ai/dsh-session-title'
import { installModelSelection, type ModelSelection } from '@deepseek-ai/dsh-agent'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import '@deepseek-ai/dsh-workspace'
import { KInterval } from './k-interval.ts'
import { reIndexEvents } from './re-index.ts'
import { turnRules, seqRules } from './rules.ts'

// Host plugin for the /klip command: extract KInterval turn ranges from the
// current session and merge them into a new session.
export const name = 'dsh-klip'

export const inject = ['commands', 'agents', 'sessions', 'workspaceRegistry', 'agentPresets']

// Register the global /klip command.
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'klip',
    description: 'Extract the selected turn ranges into one new session',
    input: { hint: '<KInterval> (1-based turns), e.g. 1..3,7' },
    handler: (invocation) => executeKlip(ctx, invocation),
  })
}

/**
 * Compose the child session from the source's agent preset, mirroring the host
 * API proxy's `fork` RPC (dsh-host-apiproxy lib/types/api-proxy.js, composeAgent).
 *
 * The child must run under the same composition the seeded history was produced
 * with — otherwise the tool schemas and prompt sections the model sees change,
 * and composing nothing would leave the child with no tools at all. The preset
 * id is resolved BEFORE the session exists (the session boundary snapshots
 * `meta` into the header synchronously); the composition is actually mounted in
 * `setup`, where a failure rolls the whole creation back.
 *
 * Note klip's child id and seed length differ from the host fork by design: the
 * id is klip-generated and `seedLength` covers only the cut turn ranges.
 */
function composeChild(source: Session, ctx: Context): {
  meta: Record<string, string>
  setup: ((agentCtx: Context) => Promise<void>) | undefined
} {
  const presets = ctx.get('agentPresets') as {
    resolve(presetId: string): Promise<{ id: string }>
    mount(agentCtx: Context, presetId: string): Promise<void>
  } | undefined
  // Resolve from the log, not the header alone, mirroring api-proxy: a session
  // that switched preset while blank ran its turns under the newer composition.
  const presetId = resolveSessionPreset(source)
  if (presets === undefined || presetId === undefined) {
    return { meta: {}, setup: undefined }
  }
  return {
    meta: { agentPreset: presetId },
    setup: async (agentCtx) => {
      // Mirror api-proxy's installSelection: couple a session-local model
      // selection derived from the logged request header (falling back to the
      // runtime default when the child has not issued a request yet).
      const agent = (agentCtx as unknown as { agent?: { session: Session } }).agent
      let picked: ModelSelection | undefined
      const selection = {
        get current(): ModelSelection | undefined {
          if (picked !== undefined) return picked
          const config = agent?.session.requestHeader()?.config
          if (config === undefined) return undefined
          return {
            provider: config.provider,
            model: config.model,
            ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
          }
        },
        set current(next: ModelSelection | undefined) { picked = next },
        // Populated by installModelSelection's prompt-assembly listener.
        assembled: undefined as ModelSelection | undefined,
      }
      installModelSelection(agentCtx, selection)
      await presets.mount(agentCtx, presetId)
    },
  }
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
  const composition = composeChild(source, ctx)
  try {
    const child = await ctx.agents.create({
      sessionId: SessionId(childId),
      seed,
      meta: {
        ...cwd !== undefined ? { cwd } : {},
        parentSession: source.id,
        seedLength: seed.length,
        ...composition.meta,
      },
      agentOptions,
      setup: composition.setup,
    })

    // Title the new session "KLIP <source title>" so it is easy to tell apart
    // from the source. Both the title service and the source's title are
    // optional; when either is absent the child keeps its auto-generated title.
    const titleService = ctx.get('sessionTitle')
    const sourceTitle = titleService?.get(source)?.title
    if (sourceTitle !== undefined) {
      titleService?.rename(child.agent.session, `KLIP ${sourceTitle}`)
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

