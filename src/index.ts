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

// Host plugin for the /klip command: cut KInterval turn ranges out of the
// current session and merge them into a new session.
export const name = 'dsh-klip'

export const inject = ['commands', 'agents', 'sessions', 'workspaceRegistry', 'agentPresets']

export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'klip',
    description: 'Extract the selected turn ranges into one new session',
    input: { hint: '<KInterval> (1-based turns), e.g. 1..3, -2.., not 2' },
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
  let intervals: { s: number; e: number }[] // for error test and display only
  try {
    kInterval = KInterval.from_string(raw)
    intervals = kInterval.instantiate(turnCount)
  } catch (error) {
    return { kind: 'error', text: `Invalid KInterval: ${String(error)}` }
  }
  if (intervals.length === 0) return { kind: 'error', text: 'No intervals matched any turn.' }

  // Cut at klip's own command/run: it is appended before this handler runs but
  // attributed to the last completed turn, while its matching `command/done`
  // lands only in the source afterwards. So it and everything after it (other
  // open-turn events) must not leak into the seed.
  const ownRun = events.findLastIndex(e => e.type === 'command/run' && e.data.commandId === invocation.commandId)
  const cutSource = ownRun === -1 ? events : events.slice(0, ownRun)

  // reIndexEvents is pure; it deep-copies internally.
  let seed: SessionEvent[]
  try {
    seed = reIndexEvents(cutSource, kInterval, { turnRules, seqRules })
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

    // Name the child "KLIP <source title>"; both the service and the source
    // title are optional, so absent ones fall back to the auto-generated title.
    const titleService = ctx.get('sessionTitle')
    const sourceTitle = titleService?.get(source)?.title
    if (sourceTitle !== undefined) {
      titleService?.rename(child.agent.session, `KLIP ${sourceTitle}`)
    }

    await ctx.sessions.flush(child.agent.session)

    // Attach to the source's workspace, if any.
    const workspace = ctx.workspaceRegistry.list().find(w => w.sessionIds.includes(source.id))
    if (workspace !== undefined) await workspace.attachSession(SessionId(childId))
  } catch (error) {
    return { kind: 'error', text: `Failed to create session: ${String(error)}` }
  }

  return { kind: 'success', text: `Created new session ${childId} with ${intervals.length} interval(s).` }
}

// Compose the child from the source's agent preset, mirroring the host API
// proxy's `fork` RPC (dsh-host-apiproxy lib/types/api-proxy.js, composeAgent):
// the child must run under the same tool schemas and prompt sections the seeded
// history was produced with. The preset id is resolved before the session
// exists (meta is snapshotted into the header synchronously); the composition
// mounts in `setup`, where a failure rolls the whole creation back. Klip's
// child id and seed length differ from the host fork by design.
function composeChild(source: Session, ctx: Context): {
  meta: Record<string, string>
  setup: ((agentCtx: Context) => Promise<void>) | undefined
} {
  const presets = ctx.get('agentPresets') as {
    resolve(presetId: string): Promise<{ id: string }>
    mount(agentCtx: Context, presetId: string): Promise<void>
  } | undefined
  // Resolve from the log, not the header alone (a session that switched preset
  // while blank ran its turns under the newer composition).
  const presetId = resolveSessionPreset(source)
  if (presets === undefined || presetId === undefined) {
    return { meta: {}, setup: undefined }
  }
  return {
    meta: { agentPreset: presetId },
    setup: async (agentCtx) => {
      // Mirror api-proxy's installSelection: couple a session-local model
      // selection derived from the logged request header (falling back to the
      // runtime default before the child issues its first request).
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
